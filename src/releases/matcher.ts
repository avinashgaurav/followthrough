import type { Database } from "bun:sqlite";
import { z } from "zod";
import { nowIso } from "../db.ts";
import { ulid, insightHandle } from "../ids.ts";
import { appendEvent } from "../events.ts";
import type { LLM } from "../llm/provider.ts";

/**
 * Release-to-insight matcher (SPEC.md section 6). LLM semantic match is the
 * primary v1 path. One judge call per open insight, with all of the release's
 * customer-facing entries as candidates. Every evidence quote is verified as
 * a substring of the entry text; matches with zero surviving quotes are
 * discarded. Matches land as 'proposed' and are never auto-confirmed: a human
 * click is the only path to 100 confidence.
 */

export const MatchResponseSchema = z.object({
  matches: z.array(
    z.object({
      entry_index: z.number().int().min(0),
      verdict: z.enum(["full", "partial", "none"]),
      evidence_quotes: z.array(z.string()),
      rationale: z.string(),
    }),
  ),
});

export interface CandidateEntry {
  id: string;
  section_type: string;
  title: string;
  body_md: string;
  flags: string[];
}

/**
 * Confidence policy: full -> 80, partial -> 50. An entry that ships dark
 * (any gating flag: flag_gated / internal_only / shadow / advisory /
 * reverted) caps at 50, because it must never trigger a "your feature
 * shipped" email. A technical-details entry caps at 60.
 */
export function confidenceFor(
  verdict: "full" | "partial",
  entry: Pick<CandidateEntry, "section_type" | "flags">,
): number {
  let confidence = verdict === "full" ? 80 : 50;
  if (entry.section_type === "technical") confidence = Math.min(confidence, 60);
  if (entry.flags.length > 0) confidence = Math.min(confidence, 50);
  return confidence;
}

const SYSTEM_PROMPT = `You are matching a client-requested product insight against the entries of one software release of XYZ, a cloud cost optimization platform.

Decide for each candidate entry whether it ships the insight:
- "full": the entry clearly delivers what the insight asks for.
- "partial": the entry delivers a meaningful part of it (a sub-requirement).
- "none": unrelated or too weak to claim.

Rules:
- evidence_quotes must be VERBATIM substrings copied exactly from the entry title or body, character for character. Do not paraphrase, trim words mid-sentence, or fix typos. Quotes that are not exact substrings are discarded programmatically.
- Only quote text that actually supports the verdict.
- Return at most one match object per entry_index.
- When nothing matches, return an empty matches array or "none" verdicts.`;

function buildPrompt(
  insight: { id: string; title: string; body_current: string; track: string | null },
  releaseTag: string,
  entries: CandidateEntry[],
): string {
  const candidates = entries
    .map((e, i) => {
      const flagNote = e.flags.length > 0 ? ` [gating flags: ${e.flags.join(", ")}]` : "";
      return `[${i}] (${e.section_type}${flagNote}) ${e.title}\n${e.body_md}`;
    })
    .join("\n\n---\n\n");
  return `INSIGHT ${insightHandle(insight.id)} (track: ${insight.track ?? "unset"})
Title: ${insight.title}
Details: ${insight.body_current}

RELEASE ${releaseTag} CANDIDATE ENTRIES:

${candidates}

Which entries, if any, ship this insight? Use entry_index values from the brackets above.`;
}

interface InsightRow {
  id: string;
  title: string;
  body_current: string;
  state: string;
  track: string | null;
}

export interface MatchRunResult {
  releaseId: string;
  insightsConsidered: number;
  entriesConsidered: number;
  proposed: number;
}

/**
 * Match one release against all open insights (finalized or ticketed, on the
 * engineering or product_polish tracks). Idempotent per (entry, insight)
 * pair: re-running never duplicates a proposal.
 */
export async function matchRelease(db: Database, llm: LLM, releaseId: string): Promise<MatchRunResult> {
  const release = db
    .query("SELECT id, tag_name FROM releases WHERE id = ?")
    .get(releaseId) as { id: string; tag_name: string } | null;
  if (!release) throw new Error(`Release not found: ${releaseId}`);

  const entryRows = db
    .query(
      `SELECT id, section_type, title, body_md, flags_json
       FROM release_entries
       WHERE release_id = ? AND section_type != 'technical'
       ORDER BY rowid`,
    )
    .all(releaseId) as Array<{
    id: string;
    section_type: string;
    title: string;
    body_md: string | null;
    flags_json: string | null;
  }>;
  const entries: CandidateEntry[] = entryRows.map((r) => ({
    id: r.id,
    section_type: r.section_type,
    title: r.title,
    body_md: r.body_md ?? "",
    flags: r.flags_json ? (JSON.parse(r.flags_json) as string[]) : [],
  }));

  const insights = db
    .query(
      `SELECT id, title, body_current, state, track
       FROM insights
       WHERE state IN ('finalized','ticketed') AND track IN ('engineering','product_polish')
       ORDER BY created_at, rowid`,
    )
    .all() as InsightRow[];

  const result: MatchRunResult = {
    releaseId,
    insightsConsidered: insights.length,
    entriesConsidered: entries.length,
    proposed: 0,
  };
  if (entries.length === 0 || insights.length === 0) return result;

  const dupCheck = db.query(
    "SELECT id FROM release_matches WHERE release_entry_id = ? AND insight_id = ?",
  );
  const raisedTicket = db.query(
    "SELECT id FROM tickets WHERE insight_id = ? AND state = 'raised' ORDER BY raised_at DESC LIMIT 1",
  );

  for (const insight of insights) {
    let matches: z.infer<typeof MatchResponseSchema>["matches"];
    try {
      const res = await llm.completeJSON({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(insight, release.tag_name, entries),
        schema: MatchResponseSchema,
      });
      matches = res.data.matches;
    } catch (err) {
      console.warn(`release matcher: judge call failed for insight ${insight.id}:`, err);
      continue;
    }

    const seenEntryIdx = new Set<number>();
    for (const m of matches) {
      if (m.verdict === "none") continue;
      const entry = entries[m.entry_index];
      if (!entry || seenEntryIdx.has(m.entry_index)) continue;
      seenEntryIdx.add(m.entry_index);

      // Grounding rule: every quote must be a verbatim substring of the
      // entry's title+body. Unverified quotes are dropped; a match with no
      // surviving quote is discarded outright.
      const haystack = `${entry.title}\n${entry.body_md}`;
      const verified = m.evidence_quotes.filter((q) => q.trim().length > 0 && haystack.includes(q));
      if (verified.length === 0) continue;

      if (dupCheck.get(entry.id, insight.id)) continue; // already proposed/decided

      const confidence = confidenceFor(m.verdict, entry);
      const ticket =
        insight.state === "ticketed"
          ? (raisedTicket.get(insight.id) as { id: string } | null)
          : null;
      const matchId = ulid();
      const tx = db.transaction(() => {
        db.query(
          `INSERT INTO release_matches
             (id, release_entry_id, insight_id, ticket_id, confidence, method, verdict,
              evidence_quotes_json, rationale, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'llm', ?, ?, ?, 'proposed', ?)`,
        ).run(
          matchId,
          entry.id,
          insight.id,
          ticket?.id ?? null,
          confidence,
          m.verdict,
          JSON.stringify(verified),
          m.rationale,
          nowIso(),
        );
        appendEvent(db, {
          actorUserId: null, // system
          entityType: "match",
          entityId: matchId,
          eventType: "match.proposed",
          payload: {
            insight_id: insight.id,
            insight_handle: insightHandle(insight.id),
            release_id: releaseId,
            release_tag: release.tag_name,
            release_entry_id: entry.id,
            entry_title: entry.title,
            verdict: m.verdict,
            confidence,
            evidence_quotes: verified,
          },
        });
      });
      tx();
      result.proposed++;
    }
  }
  return result;
}
