import type { Database } from "bun:sqlite";
import { nowIso } from "../db.ts";
import { ulid, insightHandle } from "../ids.ts";
import { appendEvent } from "../events.ts";
import { syncInsightFts } from "../insights/search.ts";
import { DEFAULT_MODEL, type LLM } from "../llm/provider.ts";
import {
  buildQuoteMatcher,
  chunkTranscript,
  cleanTranscript,
  type QuoteMatch,
} from "./segment.ts";
import {
  CLUSTER_SYSTEM_PROMPT,
  ClusterResponseSchema,
  DEDUP_SYSTEM_PROMPT,
  DedupResponseSchema,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionResponseSchema,
  PROMPT_VERSION,
  VERIFIER_SYSTEM_PROMPT,
  VerifierResponseSchema,
  clusterUserPrompt,
  dedupUserPrompt,
  extractionUserPrompt,
  verifierUserPrompt,
  type ExtractedItem,
  type ItemType,
} from "./prompts.ts";

/**
 * Multi-pass extraction pipeline (SPEC.md section 5):
 * clean -> chunk -> typed extraction -> citation gate -> verifier -> dedup -> persist.
 * Re-runs are additive and idempotent: a quote already recorded as a mention for
 * this client (any insight state, including rejected/finalized) is never re-inserted,
 * so re-extraction cannot duplicate or resurrect.
 */

export type ExtractionErrorCode =
  | "meeting_not_found"
  | "meeting_deleted"
  | "consent_missing"
  | "no_transcript"
  | "already_running"
  | "already_extracted"
  | "quote_not_found";

export class ExtractionError extends Error {
  constructor(
    public readonly code: ExtractionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ExtractionResult {
  runId: string;
  created: number;
  mentionsAdded: number;
  droppedCitations: number;
  droppedVerifier: number;
}

interface MeetingRow {
  id: string;
  client_id: string;
  consent_confirmed: number;
  deleted_at: string | null;
}

interface TranscriptRow {
  id: string;
  content: string;
}

interface Candidate {
  item: ExtractedItem;
  match: QuoteMatch;
}

function loadMeeting(db: Database, meetingId: string): MeetingRow {
  const meeting = db
    .query("SELECT id, client_id, consent_confirmed, deleted_at FROM meetings WHERE id = ?")
    .get(meetingId) as MeetingRow | null;
  if (!meeting) throw new ExtractionError("meeting_not_found", `Meeting not found: ${meetingId}`);
  if (meeting.deleted_at) throw new ExtractionError("meeting_deleted", "Meeting has been deleted");
  return meeting;
}

function latestTranscript(db: Database, meetingId: string): TranscriptRow | null {
  return db
    .query(
      "SELECT id, content FROM transcripts WHERE meeting_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(meetingId) as TranscriptRow | null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function quoteAlreadyRecorded(db: Database, clientId: string, verbatim: string): boolean {
  return !!db
    .query("SELECT 1 FROM insight_mentions WHERE client_id = ? AND quote = ? LIMIT 1")
    .get(clientId, verbatim);
}

function insertMention(
  db: Database,
  opts: {
    insightId: string;
    meetingId: string;
    clientId: string;
    quote: string;
    speaker: string | null;
    charStart: number | null;
    charEnd: number | null;
    now: string;
  },
): string {
  const id = ulid();
  db.query(
    `INSERT INTO insight_mentions (id, insight_id, meeting_id, client_id, quote, speaker, char_start, char_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.insightId,
    opts.meetingId,
    opts.clientId,
    opts.quote,
    opts.speaker,
    opts.charStart,
    opts.charEnd,
    opts.now,
  );
  return id;
}

function upsertRequester(db: Database, insightId: string, clientId: string, now: string): void {
  db.query(
    `INSERT INTO insight_requesters (insight_id, client_id, first_requested_at, last_requested_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(insight_id, client_id) DO UPDATE SET last_requested_at = excluded.last_requested_at`,
  ).run(insightId, clientId, now, now);
}

function insertNewInsight(
  db: Database,
  opts: {
    meetingId: string;
    clientId: string;
    extractionRunId: string | null;
    itemType: ItemType;
    title: string;
    body: string;
    aiConfidence: "high" | "medium" | "low" | null;
    quote: string | null;
    speaker: string | null;
    charStart: number | null;
    charEnd: number | null;
    actorUserId: string;
    now: string;
    aiSuggested?: { track?: string | null; owner?: string | null; assignee?: string | null };
  },
): string {
  const insightId = ulid();
  const suggested = opts.aiSuggested && (opts.aiSuggested.track || opts.aiSuggested.owner || opts.aiSuggested.assignee)
    ? JSON.stringify(opts.aiSuggested)
    : null;
  db.query(
    `INSERT INTO insights (id, meeting_id, client_id, extraction_run_id, item_type, title,
                           body_original, body_current, state, ai_confidence, ai_suggested_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'extracted', ?, ?, ?, ?)`,
  ).run(
    insightId,
    opts.meetingId,
    opts.clientId,
    opts.extractionRunId,
    opts.itemType,
    opts.title,
    opts.body,
    opts.body,
    opts.aiConfidence,
    suggested,
    opts.now,
    opts.now,
  );
  if (opts.quote !== null) {
    insertMention(db, {
      insightId,
      meetingId: opts.meetingId,
      clientId: opts.clientId,
      quote: opts.quote,
      speaker: opts.speaker,
      charStart: opts.charStart,
      charEnd: opts.charEnd,
      now: opts.now,
    });
  }
  upsertRequester(db, insightId, opts.clientId, opts.now);
  // fromState null -> 'extracted' so the insight_milestones view gets extracted_at.
  appendEvent(db, {
    actorUserId: opts.actorUserId,
    entityType: "insight",
    entityId: insightId,
    eventType: "insight.state_changed",
    toState: "extracted",
    payload: opts.extractionRunId
      ? { run_id: opts.extractionRunId, handle: insightHandle(insightId) }
      : { source: "manual", handle: insightHandle(insightId) },
  });
  if (opts.itemType === "action_item_ours") {
    db.query(
      `INSERT INTO action_items (id, meeting_id, insight_id, description, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
    ).run(ulid(), opts.meetingId, insightId, opts.body, opts.now);
  }
  return insightId;
}

/**
 * Recovery sweep: a crash or server restart mid-extraction leaves the run row
 * 'running' forever, which permanently blocks the meeting via the
 * already_running guard. Fail any run older than the threshold. Run at startup
 * and periodically.
 */
export function failStaleExtractionRuns(db: Database, maxAgeMinutes = 30): number {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const stale = db
    .query("SELECT id, meeting_id FROM extraction_runs WHERE status = 'running' AND started_at < ?")
    .all(cutoff) as Array<{ id: string; meeting_id: string }>;
  for (const run of stale) {
    db.query(
      "UPDATE extraction_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
    ).run(`abandoned: still running after ${maxAgeMinutes} minutes (probable crash/restart)`, nowIso(), run.id);
    appendEvent(db, {
      actorUserId: null,
      entityType: "extraction_run",
      entityId: run.id,
      eventType: "extraction.failed",
      payload: { meeting_id: run.meeting_id, error: "abandoned run swept at startup" },
    });
  }
  return stale.length;
}

export async function runExtraction(
  db: Database,
  llm: LLM,
  meetingId: string,
  actorUserId: string,
  opts: { force?: boolean } = {},
): Promise<ExtractionResult> {
  const meeting = loadMeeting(db, meetingId);
  if (!meeting.consent_confirmed) {
    throw new ExtractionError("consent_missing", "Consent not confirmed; processing is blocked");
  }
  const transcript = latestTranscript(db, meetingId);
  if (!transcript) throw new ExtractionError("no_transcript", "Meeting has no transcript");

  // Guard against concurrent and accidental re-runs (a timed-out client retry
  // must not spawn a second run that the dedup pass cannot see).
  const running = db
    .query("SELECT id FROM extraction_runs WHERE meeting_id = ? AND status = 'running' LIMIT 1")
    .get(meetingId);
  if (running) throw new ExtractionError("already_running", "An extraction is already running for this meeting");
  if (!opts.force) {
    const done = db
      .query("SELECT id FROM extraction_runs WHERE meeting_id = ? AND status = 'succeeded' LIMIT 1")
      .get(meetingId);
    if (done) {
      throw new ExtractionError(
        "already_extracted",
        "This meeting was already extracted. Re-run explicitly to extract again.",
      );
    }
  }

  const runId = ulid();
  db.query(
    `INSERT INTO extraction_runs (id, meeting_id, transcript_id, llm_model, prompt_version, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
  ).run(runId, meetingId, transcript.id, DEFAULT_MODEL, PROMPT_VERSION, nowIso());

  try {
    return await execute(db, llm, meeting, transcript, runId, actorUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.query("UPDATE extraction_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(
      message,
      nowIso(),
      runId,
    );
    appendEvent(db, {
      actorUserId,
      entityType: "extraction_run",
      entityId: runId,
      eventType: "extraction.failed",
      payload: { meeting_id: meetingId, error: message },
    });
    throw err;
  }
}

async function execute(
  db: Database,
  llm: LLM,
  meeting: MeetingRow,
  transcript: TranscriptRow,
  runId: string,
  actorUserId: string,
): Promise<ExtractionResult> {
  const cleaned = cleanTranscript(transcript.content);
  const chunks = chunkTranscript(cleaned);
  const findQuote = buildQuoteMatcher(cleaned);

  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  const addUsage = (u: { tokensIn: number; tokensOut: number; costUsd: number }): void => {
    tokensIn += u.tokensIn;
    tokensOut += u.tokensOut;
    costUsd += u.costUsd;
  };

  let droppedCitations = 0;
  let droppedVerifier = 0;
  const survivors: Candidate[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const ext = await llm.completeJSON({
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: extractionUserPrompt(chunk.text, i, chunks.length),
      schema: ExtractionResponseSchema,
    });
    addUsage(ext);

    // Citation gate: no citation, no insight. The quote must be an exact
    // substring of the FULL cleaned transcript after whitespace normalization.
    const cited: Candidate[] = [];
    for (const item of ext.data.items) {
      const match = findQuote(item.quote);
      if (!match) {
        droppedCitations++;
        continue;
      }
      cited.push({ item, match });
    }
    if (cited.length === 0) continue;

    // Verifier judge: one call per chunk, batching its surviving items.
    const ver = await llm.completeJSON({
      system: VERIFIER_SYSTEM_PROMPT,
      prompt: verifierUserPrompt(
        cited.map((c, index) => ({
          index,
          item_type: c.item.item_type,
          title: c.item.title,
          body: c.item.body,
          quote: c.item.quote,
          speaker: c.item.speaker,
        })),
        chunk.text,
      ),
      schema: VerifierResponseSchema,
    });
    addUsage(ver);
    // Missing verdict defaults to keep: the citation gate already passed and
    // the verifier is strictly a drop filter.
    const dropped = new Set(ver.data.verdicts.filter((v) => !v.keep).map((v) => v.index));
    cited.forEach((c, index) => {
      if (dropped.has(index)) droppedVerifier++;
      else survivors.push(c);
    });
  }

  // Re-run idempotency + within-run dedup on the exact verbatim quote.
  // Checked against insight_mentions for this client across ALL states, so a
  // re-run never duplicates an open ask or resurrects a rejected/finalized one.
  const seenQuotes = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of survivors) {
    if (seenQuotes.has(c.match.verbatim)) continue;
    seenQuotes.add(c.match.verbatim);
    if (quoteAlreadyRecorded(db, meeting.client_id, c.match.verbatim)) continue;
    deduped.push(c);
  }

  // Within-run clustering: overlapping chunks restate the same ask in different
  // words, which exact-quote dedup cannot catch. Cluster the candidates against
  // each other so one insight is created per distinct ask; the other members of
  // a cluster become extra mentions (the "said it N times" signal) on it.
  const fresh: Candidate[] = [];
  const extraMentions = new Map<number, Candidate[]>(); // fresh index -> sibling candidates
  if (deduped.length > 1) {
    try {
      const cl = await llm.completeJSON({
        system: CLUSTER_SYSTEM_PROMPT,
        prompt: clusterUserPrompt(
          deduped.map((c, index) => ({
            index,
            item_type: c.item.item_type,
            title: c.item.title,
            body: c.item.body,
          })),
        ),
        schema: ClusterResponseSchema,
      });
      addUsage(cl);
      const assigned = new Set<number>();
      for (const group of cl.data.clusters) {
        const valid = group.filter((i) => i >= 0 && i < deduped.length && !assigned.has(i));
        if (valid.length === 0) continue;
        valid.forEach((i) => assigned.add(i));
        const repIdx = valid[0]!;
        const freshIdx = fresh.length;
        fresh.push(deduped[repIdx]!);
        const siblings = valid.slice(1).map((i) => deduped[i]!);
        if (siblings.length > 0) extraMentions.set(freshIdx, siblings);
      }
      // Any candidate the model forgot to place becomes its own insight.
      deduped.forEach((c, i) => {
        if (!assigned.has(i)) fresh.push(c);
      });
    } catch (err) {
      console.warn("within-run clustering failed; using exact-quote dedup only:", err);
      fresh.push(...deduped);
    }
  } else {
    fresh.push(...deduped);
  }

  // Dedup pass against the client's open insights. Skipped when there is
  // nothing to match on either side (no LLM call, all candidates are new).
  const openInsights = db
    .query(
      `SELECT id, item_type, title, body_current FROM insights
       WHERE client_id = ? AND state NOT IN ('closed','rejected','merged')
       ORDER BY created_at`,
    )
    .all(meeting.client_id) as Array<{ id: string; item_type: string; title: string; body_current: string }>;

  const matchByIndex = new Map<number, string>();
  if (fresh.length > 0 && openInsights.length > 0) {
    const dd = await llm.completeJSON({
      system: DEDUP_SYSTEM_PROMPT,
      prompt: dedupUserPrompt(
        fresh.map((c, candidate_index) => ({
          candidate_index,
          item_type: c.item.item_type,
          title: c.item.title,
          body: c.item.body,
          quote: c.item.quote,
        })),
        openInsights.map((o) => ({
          id: o.id,
          item_type: o.item_type,
          title: o.title,
          body: o.body_current,
        })),
      ),
      schema: DedupResponseSchema,
    });
    addUsage(dd);
    const openIds = new Set(openInsights.map((o) => o.id));
    for (const m of dd.data.matches) {
      // Trust boundary: only accept indexes and ids we actually presented.
      if (m.candidate_index < 0 || m.candidate_index >= fresh.length) continue;
      if (!openIds.has(m.existing_insight_id)) continue;
      matchByIndex.set(m.candidate_index, m.existing_insight_id);
    }
  }

  let created = 0;
  let mentionsAdded = 0;
  const touchedInsightIds: string[] = [];
  const persist = db.transaction(() => {
    const now = nowIso();
    fresh.forEach((c, index) => {
      const existingId = matchByIndex.get(index);
      if (existingId) {
        touchedInsightIds.push(existingId);
        // Recurring ask: attach a mention, never duplicate the insight.
        const mentionId = insertMention(db, {
          insightId: existingId,
          meetingId: meeting.id,
          clientId: meeting.client_id,
          quote: c.match.verbatim,
          speaker: c.item.speaker,
          charStart: c.match.charStart,
          charEnd: c.match.charEnd,
          now,
        });
        upsertRequester(db, existingId, meeting.client_id, now);
        db.query("UPDATE insights SET priority = priority + 1, updated_at = ? WHERE id = ?").run(
          now,
          existingId,
        );
        appendEvent(db, {
          actorUserId,
          entityType: "insight",
          entityId: existingId,
          eventType: "insight.mention_added",
          payload: { meeting_id: meeting.id, mention_id: mentionId, run_id: runId, quote: c.match.verbatim },
        });
        mentionsAdded++;
      } else {
        const newId = insertNewInsight(db, {
          meetingId: meeting.id,
          clientId: meeting.client_id,
          extractionRunId: runId,
          itemType: c.item.item_type,
          title: c.item.title,
          body: c.item.body,
          aiConfidence: c.item.confidence,
          quote: c.match.verbatim,
          speaker: c.item.speaker,
          charStart: c.match.charStart,
          charEnd: c.match.charEnd,
          actorUserId,
          now,
          aiSuggested: {
            track: c.item.suggested_track ?? null,
            owner: c.item.suggested_owner ?? null,
            assignee: c.item.suggested_assignee ?? null,
          },
        });
        touchedInsightIds.push(newId);
        created++;
        // Cluster siblings: same ask restated elsewhere in the call -> extra
        // mentions on this insight, not separate cards.
        for (const sib of extraMentions.get(index) ?? []) {
          insertMention(db, {
            insightId: newId,
            meetingId: meeting.id,
            clientId: meeting.client_id,
            quote: sib.match.verbatim,
            speaker: sib.item.speaker,
            charStart: sib.match.charStart,
            charEnd: sib.match.charEnd,
            now,
          });
          mentionsAdded++;
        }
      }
    });

    const coverage = [
      plural(chunks.length, "chunk"),
      plural(droppedCitations, "citation failure"),
      plural(droppedVerifier, "verifier drop"),
    ].join(", ");
    db.query(
      `UPDATE extraction_runs
       SET status = 'succeeded', tokens_in = ?, tokens_out = ?, cost_usd = ?, coverage_note = ?, finished_at = ?
       WHERE id = ?`,
    ).run(tokensIn, tokensOut, costUsd, coverage, now, runId);
    db.query("UPDATE meetings SET status = 'extracted' WHERE id = ?").run(meeting.id);
    appendEvent(db, {
      actorUserId,
      entityType: "extraction_run",
      entityId: runId,
      eventType: "extraction.completed",
      payload: {
        meeting_id: meeting.id,
        insight_count: created,
        mentions_added: mentionsAdded,
        dropped_citations: droppedCitations,
        dropped_verifier: droppedVerifier,
      },
    });
  });
  persist();
  for (const id of new Set(touchedInsightIds)) syncInsightFts(db, id);

  return { runId, created, mentionsAdded, droppedCitations, droppedVerifier };
}

// ---------------------------------------------------------------- manual add

export interface ManualInsightInput {
  meetingId: string;
  itemType: ItemType;
  title: string;
  body: string;
  quote?: string;
  speaker?: string;
}

/**
 * Human adds an insight the LLM missed (SPEC.md section 5, item 7).
 * Same inserts as an extracted item but extraction_run_id is NULL.
 * A provided quote must verify against the meeting's transcript; without
 * a quote the insight is accepted with no mention row (no offsets exist).
 */
export function manualAddInsight(
  db: Database,
  input: ManualInsightInput,
  actorUserId: string,
): { insightId: string; handle: string } {
  const meeting = loadMeeting(db, input.meetingId);

  let match: QuoteMatch | null = null;
  if (input.quote !== undefined) {
    const transcript = latestTranscript(db, input.meetingId);
    if (!transcript) {
      throw new ExtractionError("no_transcript", "Quote given but the meeting has no transcript");
    }
    match = buildQuoteMatcher(cleanTranscript(transcript.content))(input.quote);
    if (!match) {
      throw new ExtractionError("quote_not_found", "Quote is not a substring of the meeting transcript");
    }
  }

  let insightId = "";
  const persist = db.transaction(() => {
    insightId = insertNewInsight(db, {
      meetingId: meeting.id,
      clientId: meeting.client_id,
      extractionRunId: null,
      itemType: input.itemType,
      title: input.title,
      body: input.body,
      aiConfidence: null,
      quote: match ? match.verbatim : null,
      speaker: input.speaker ?? null,
      charStart: match ? match.charStart : null,
      charEnd: match ? match.charEnd : null,
      actorUserId,
      now: nowIso(),
    });
  });
  persist();
  syncInsightFts(db, insightId);

  return { insightId, handle: insightHandle(insightId) };
}
