import type { Database } from "../db.ts";
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
  extractionSystemPrompt,
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
import { isInstructionToTool } from "./guards.ts";

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
  /** Items whose quote was an instruction aimed at the tool (prompt injection). */
  droppedInjection: number;
}

interface MeetingRow {
  id: string;
  client_id: string;
  consent_confirmed: number;
  attendees_json: string | null;
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

async function loadMeeting(db: Database, meetingId: string): Promise<MeetingRow> {
  const meeting = await db
    .query("SELECT id, client_id, consent_confirmed, attendees_json, deleted_at FROM meetings WHERE id = ?")
    .get(meetingId) as MeetingRow | null;
  if (!meeting) throw new ExtractionError("meeting_not_found", `Meeting not found: ${meetingId}`);
  if (meeting.deleted_at) throw new ExtractionError("meeting_deleted", "Meeting has been deleted");
  return meeting;
}

async function latestTranscript(db: Database, meetingId: string): Promise<TranscriptRow | null> {
  return await db
    .query(
      "SELECT id, content FROM transcripts WHERE meeting_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(meetingId) as TranscriptRow | null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Turn meetings.attendees_json into a short labelled list for the extractor, so
 *  it can map speaker labels to client-vs-ours. Empty string when none/malformed. */
function formatAttendees(attendeesJson: string | null): string | undefined {
  if (!attendeesJson) return undefined;
  try {
    const arr = JSON.parse(attendeesJson) as Array<{ name?: string; email?: string; side?: string }>;
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    const lines = arr
      .map((a) => {
        const who = a.name || a.email;
        if (!who) return null;
        const side = a.side === "internal" ? "our team" : a.side === "client" ? "client" : "unknown side";
        return `- ${who} (${side})`;
      })
      .filter(Boolean);
    return lines.length ? lines.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

async function quoteAlreadyRecorded(db: Database, clientId: string, verbatim: string): Promise<boolean> {
  return !!await db
    .query("SELECT 1 FROM insight_mentions WHERE client_id = ? AND quote = ? LIMIT 1")
    .get(clientId, verbatim);
}

async function insertMention(
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
): Promise<string> {
  const id = ulid();
  await db.query(
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

async function upsertRequester(db: Database, insightId: string, clientId: string, now: string): Promise<void> {
  await db.query(
    `INSERT INTO insight_requesters (insight_id, client_id, first_requested_at, last_requested_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(insight_id, client_id) DO UPDATE SET last_requested_at = excluded.last_requested_at`,
  ).run(insightId, clientId, now, now);
}

async function insertNewInsight(
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
    side?: string | null;
    sentiment?: string | null;
    intent?: string | null;
  },
): Promise<string> {
  const insightId = ulid();
  const suggested = opts.aiSuggested && (opts.aiSuggested.track || opts.aiSuggested.owner || opts.aiSuggested.assignee)
    ? JSON.stringify(opts.aiSuggested)
    : null;
  await db.query(
    `INSERT INTO insights (id, meeting_id, client_id, extraction_run_id, item_type, title,
                           body_original, body_current, state, ai_confidence, ai_suggested_json,
                           side, sentiment, intent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'extracted', ?, ?, ?, ?, ?, ?, ?)`,
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
    opts.side ?? null,
    opts.sentiment ?? null,
    opts.intent ?? null,
    opts.now,
    opts.now,
  );
  if (opts.quote !== null) {
    await insertMention(db, {
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
  await upsertRequester(db, insightId, opts.clientId, opts.now);
  // fromState null -> 'extracted' so the insight_milestones view gets extracted_at.
  await appendEvent(db, {
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
    await db.query(
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
/**
 * A run can never outlive its function (300s on Vercel), so anything still
 * 'running' after STALE_RUN_MINUTES (default 10) was cut off.
 */
export function staleRunMinutes(): number {
  const n = Number(process.env.STALE_RUN_MINUTES ?? 10);
  return n > 0 ? n : 10;
}

export async function failStaleExtractionRuns(db: Database, maxAgeMinutes = 30): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const stale = await db
    .query("SELECT id, meeting_id FROM extraction_runs WHERE status = 'running' AND started_at < ?")
    .all(cutoff) as Array<{ id: string; meeting_id: string }>;
  for (const run of stale) {
    await db.query(
      "UPDATE extraction_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
    ).run(`abandoned: still running after ${maxAgeMinutes} minutes (probable crash/restart)`, nowIso(), run.id);
    await appendEvent(db, {
      actorUserId: null,
      entityType: "extraction_run",
      entityId: run.id,
      eventType: "extraction.failed",
      payload: { meeting_id: run.meeting_id, error: "abandoned run swept at startup" },
    });
  }
  return stale.length;
}

/** Postgres unique_violation (23505), from postgres.js or PGlite. */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "23505";
}

export async function runExtraction(
  db: Database,
  llm: LLM,
  meetingId: string,
  actorUserId: string,
  opts: { force?: boolean } = {},
): Promise<ExtractionResult> {
  const meeting = await loadMeeting(db, meetingId);
  if (!meeting.consent_confirmed) {
    throw new ExtractionError("consent_missing", "Consent not confirmed; processing is blocked");
  }
  const transcript = await latestTranscript(db, meetingId);
  if (!transcript) throw new ExtractionError("no_transcript", "Meeting has no transcript");

  // A run cut off by the function time limit would block the meeting until the
  // daily sweep; clear such runs first.
  await failStaleExtractionRuns(db, staleRunMinutes());
  // Guard against concurrent and accidental re-runs (a timed-out client retry
  // must not spawn a second run that the dedup pass cannot see).
  const running = await db
    .query("SELECT id FROM extraction_runs WHERE meeting_id = ? AND status = 'running' LIMIT 1")
    .get(meetingId);
  if (running) throw new ExtractionError("already_running", "An extraction is already running for this meeting");
  if (!opts.force) {
    const done = await db
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
  try {
    await db.query(
      `INSERT INTO extraction_runs (id, meeting_id, transcript_id, llm_model, prompt_version, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    ).run(runId, meetingId, transcript.id, DEFAULT_MODEL, PROMPT_VERSION, nowIso());
  } catch (err) {
    // A concurrent request won the race past the check above (unique index on running runs).
    if (isUniqueViolation(err)) {
      throw new ExtractionError("already_running", "An extraction is already running for this meeting");
    }
    throw err;
  }

  try {
    return await execute(db, llm, meeting, transcript, runId, actorUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query("UPDATE extraction_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(
      message,
      nowIso(),
      runId,
    );
    await appendEvent(db, {
      actorUserId,
      entityType: "extraction_run",
      entityId: runId,
      eventType: "extraction.failed",
      payload: { meeting_id: meetingId, error: message },
    });
    throw err;
  }
}

/** Chunks processed at once in passes 1-2. Tests pin 1 (MockLLM replays in call order). */
function extractConcurrency(): number {
  const n = Number(process.env.EXTRACT_CONCURRENCY ?? 4);
  return Number.isInteger(n) && n > 0 ? n : 4;
}

/** fn(0..count-1) with at most `limit` in flight; results in index order. */
async function mapLimit<T>(count: number, limit: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const i = next++;
      results[i] = await fn(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return results;
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
  const attendees = formatAttendees(meeting.attendees_json);

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
  let droppedInjection = 0;
  const survivors: Candidate[] = [];

  // Pass 1 + 2 per chunk (extract, then verify that chunk's cited items). Chunks
  // run EXTRACT_CONCURRENCY at a time so long meetings fit a serverless
  // function's time limit; results merge in chunk order, so output is the same
  // as a sequential run.
  const perChunk = async (i: number) => {
    const chunk = chunks[i]!;
    const out = { survivors: [] as Candidate[], citations: 0, verifier: 0, injection: 0, usage: [] as Array<{ tokensIn: number; tokensOut: number; costUsd: number }> };
    const ext = await llm.completeJSON({
      system: extractionSystemPrompt(),
      prompt: extractionUserPrompt(chunk.text, i, chunks.length, attendees),
      schema: ExtractionResponseSchema,
    });
    out.usage.push(ext);

    // Citation gate: no citation, no insight. The quote must be an exact
    // substring of the FULL cleaned transcript after whitespace normalization.
    const cited: Candidate[] = [];
    for (const item of ext.data.items) {
      // Injection guard: a quote that instructs the tool is never an insight,
      // whatever the model made of it. See guards.ts.
      if (isInstructionToTool(item.quote)) {
        out.injection++;
        continue;
      }
      const match = findQuote(item.quote);
      if (!match) {
        out.citations++;
        continue;
      }
      cited.push({ item, match });
    }
    if (cited.length === 0) return out;

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
    out.usage.push(ver);
    // Missing verdict defaults to keep: the citation gate already passed and
    // the verifier is strictly a drop filter.
    const dropped = new Set(ver.data.verdicts.filter((v) => !v.keep).map((v) => v.index));
    cited.forEach((c, index) => {
      if (dropped.has(index)) out.verifier++;
      else out.survivors.push(c);
    });
    return out;
  };
  const perChunkResults = await mapLimit(chunks.length, extractConcurrency(), perChunk);
  for (const r of perChunkResults) {
    r.usage.forEach(addUsage);
    droppedCitations += r.citations;
    droppedVerifier += r.verifier;
    droppedInjection += r.injection;
    survivors.push(...r.survivors);
  }

  // Re-run idempotency + within-run dedup on the exact verbatim quote.
  // Checked against insight_mentions for this client across ALL states, so a
  // re-run never duplicates an open ask or resurrects a rejected/finalized one.
  const seenQuotes = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of survivors) {
    if (seenQuotes.has(c.match.verbatim)) continue;
    seenQuotes.add(c.match.verbatim);
    if (await quoteAlreadyRecorded(db, meeting.client_id, c.match.verbatim)) continue;
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
  const openInsights = await db
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
  const persist = () => db.transaction(async () => {
    const now = nowIso();
    for (const [index, c] of fresh.entries()) {
      const existingId = matchByIndex.get(index);
      if (existingId) {
        touchedInsightIds.push(existingId);
        // Recurring ask: attach a mention, never duplicate the insight.
        const mentionId = await insertMention(db, {
          insightId: existingId,
          meetingId: meeting.id,
          clientId: meeting.client_id,
          quote: c.match.verbatim,
          speaker: c.item.speaker,
          charStart: c.match.charStart,
          charEnd: c.match.charEnd,
          now,
        });
        await upsertRequester(db, existingId, meeting.client_id, now);
        await db.query("UPDATE insights SET priority = priority + 1, updated_at = ? WHERE id = ?").run(
          now,
          existingId,
        );
        await appendEvent(db, {
          actorUserId,
          entityType: "insight",
          entityId: existingId,
          eventType: "insight.mention_added",
          payload: { meeting_id: meeting.id, mention_id: mentionId, run_id: runId, quote: c.match.verbatim },
        });
        mentionsAdded++;
      } else {
        const newId = await insertNewInsight(db, {
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
          side: c.item.side ?? null,
          sentiment: c.item.sentiment ?? null,
          intent: c.item.intent ?? null,
        });
        touchedInsightIds.push(newId);
        created++;
        // Cluster siblings: same ask restated elsewhere in the call -> extra
        // mentions on this insight, not separate cards.
        for (const sib of extraMentions.get(index) ?? []) {
          await insertMention(db, {
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
    }

    const coverage = [
      plural(chunks.length, "chunk"),
      plural(droppedCitations, "citation failure"),
      plural(droppedVerifier, "verifier drop"),
      ...(droppedInjection > 0 ? [plural(droppedInjection, "injection guard drop")] : []),
    ].join(", ");
    await db.query(
      `UPDATE extraction_runs
       SET status = 'succeeded', tokens_in = ?, tokens_out = ?, cost_usd = ?, coverage_note = ?, finished_at = ?
       WHERE id = ?`,
    ).run(tokensIn, tokensOut, costUsd, coverage, now, runId);
    await db.query("UPDATE meetings SET status = 'extracted' WHERE id = ?").run(meeting.id);
    await appendEvent(db, {
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
        dropped_injection: droppedInjection,
      },
    });
  });
  await persist();
  for (const id of new Set(touchedInsightIds)) await syncInsightFts(db, id);

  return { runId, created, mentionsAdded, droppedCitations, droppedVerifier, droppedInjection };
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
export async function manualAddInsight(
  db: Database,
  input: ManualInsightInput,
  actorUserId: string,
): Promise<{ insightId: string; handle: string }> {
  const meeting = await loadMeeting(db, input.meetingId);

  let match: QuoteMatch | null = null;
  if (input.quote !== undefined) {
    const transcript = await latestTranscript(db, input.meetingId);
    if (!transcript) {
      throw new ExtractionError("no_transcript", "Quote given but the meeting has no transcript");
    }
    match = buildQuoteMatcher(cleanTranscript(transcript.content))(input.quote);
    if (!match) {
      throw new ExtractionError("quote_not_found", "Quote is not a substring of the meeting transcript");
    }
  }

  let insightId = "";
  const persist = () => db.transaction(async () => {
    insightId = await insertNewInsight(db, {
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
  await persist();
  await syncInsightFts(db, insightId);

  return { insightId, handle: insightHandle(insightId) };
}
