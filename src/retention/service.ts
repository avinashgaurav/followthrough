import type { Database } from "bun:sqlite";
import { existsSync, rmSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { json } from "../router.ts";
import { nowIso } from "../db.ts";
import { appendEvent } from "../events.ts";
import type { AuthedUser } from "../auth.ts";
import { getBlobPath, type MediaAsset } from "../ingest/media.ts";
import type { MeetingRow } from "../ingest/service.ts";
import { syncInsightFts } from "../insights/search.ts";

/**
 * Retention purge (SPEC.md section 10). Admin-only deletion path for a
 * meeting's raw material: transcript rows, verbatim quotes, and media blobs
 * are destroyed; the meeting row is soft-deleted (deleted_at) so sequence
 * numbers and references stay intact; insights survive anonymized so
 * finalized or shipped work is never lost; the events trail survives by
 * design (the table is physically append-only).
 */

const PURGED = "[purged]";

const PurgeBodySchema = z.object({ reason: z.string().min(1).optional() });

export interface PurgeResult {
  meeting_id: string;
  already_purged: boolean;
  transcripts_deleted: number;
  quotes_purged: number;
  assets_purged: number;
  insights_kept: number;
}

/** Media assets belonging to a meeting: the audio FK plus any asset ids recorded in its meeting.uploaded event payload. */
function meetingAssets(db: Database, meeting: MeetingRow): MediaAsset[] {
  const ids = new Set<string>();
  if (meeting.audio_asset_id) ids.add(meeting.audio_asset_id);
  const events = db
    .query(
      `SELECT payload_json FROM events
       WHERE entity_type = 'meeting' AND entity_id = ? AND event_type = 'meeting.uploaded'`,
    )
    .all(meeting.id) as { payload_json: string | null }[];
  for (const e of events) {
    if (!e.payload_json) continue;
    try {
      const p = JSON.parse(e.payload_json) as Record<string, unknown>;
      if (typeof p.audio_asset_id === "string") ids.add(p.audio_asset_id);
      if (typeof p.transcript_asset_id === "string") ids.add(p.transcript_asset_id);
    } catch {
      // malformed payload: skip, never block a purge on bad JSON
    }
  }
  if (ids.size === 0) return [];
  const placeholders = [...ids].map(() => "?").join(",");
  return db
    .query(`SELECT * FROM media_assets WHERE id IN (${placeholders})`)
    .all(...ids) as MediaAsset[];
}

export function purgeMeeting(
  db: Database,
  actor: { id: string },
  meetingId: string,
  reason?: string,
  opts: { blobDir?: string } = {},
): PurgeResult | null {
  const meeting = db.query("SELECT * FROM meetings WHERE id = ?").get(meetingId) as MeetingRow | null;
  if (!meeting) return null;
  if (meeting.deleted_at) {
    return {
      meeting_id: meetingId,
      already_purged: true,
      transcripts_deleted: 0,
      quotes_purged: 0,
      assets_purged: 0,
      insights_kept: 0,
    };
  }

  const assets = meetingAssets(db, meeting).filter((a) => a.storage_ref !== PURGED);
  // resolve disk paths BEFORE storage_ref is overwritten in the transaction
  const blobPaths = assets
    .filter((a) => a.storage_backend === "local")
    .map((a) => getBlobPath(a, opts.blobDir));

  const affectedInsights = db
    .query("SELECT DISTINCT insight_id FROM insight_mentions WHERE meeting_id = ?")
    .all(meetingId) as { insight_id: string }[];

  // counted up front: .changes is unreliable inside transactions that also
  // touch FTS5 virtual tables (shadow-table writes pollute the counter)
  const transcriptsDeleted = (
    db.query("SELECT COUNT(*) AS n FROM transcripts WHERE meeting_id = ?").get(meetingId) as { n: number }
  ).n;
  const quotesPurged = (
    db
      .query("SELECT COUNT(*) AS n FROM insight_mentions WHERE meeting_id = ? AND quote != ?")
      .get(meetingId, PURGED) as { n: number }
  ).n;
  const t = nowIso();

  const tx = db.transaction(() => {
    // soft delete: list/detail queries filter on deleted_at IS NULL
    db.query("UPDATE meetings SET deleted_at = ? WHERE id = ?").run(t, meetingId);

    // transcripts: hard delete. extraction_runs reference transcripts (NOT NULL
    // FK) and insights reference extraction_runs, so detach insights from their
    // runs first (NULL extraction_run_id is the schema's "manual" marker), then
    // drop the runs, then the transcript rows themselves.
    db.query("UPDATE insights SET extraction_run_id = NULL WHERE meeting_id = ?").run(meetingId);
    db.query("DELETE FROM extraction_runs WHERE meeting_id = ?").run(meetingId);
    db.query("DELETE FROM transcripts WHERE meeting_id = ?").run(meetingId);
    db.query("DELETE FROM fts_transcripts WHERE meeting_id = ?").run(meetingId);

    // quotes: UPDATE, not DELETE, so mention counts and insight provenance survive
    db.query(
      "UPDATE insight_mentions SET quote = ?, char_start = NULL, char_end = NULL WHERE meeting_id = ?",
    ).run(PURGED, meetingId);

    // media: mark unusable; the blob file disappears from disk after commit
    for (const a of assets) {
      db.query("UPDATE media_assets SET status = 'failed', storage_ref = ? WHERE id = ?").run(
        PURGED,
        a.id,
      );
    }

    appendEvent(db, {
      actorUserId: actor.id,
      entityType: "meeting",
      entityId: meetingId,
      eventType: "meeting.purged",
      payload: {
        ...(reason ? { reason } : {}),
        transcripts_deleted: transcriptsDeleted,
        quotes_purged: quotesPurged,
        assets_purged: assets.length,
      },
    });

    // search index must not keep serving the purged quotes
    for (const i of affectedInsights) syncInsightFts(db, i.insight_id);
  });
  tx();

  // disk deletion after the durable record of the purge exists; a failure here
  // is logged and the file is orphaned (re-running the purge will not resurrect
  // anything, and storage_ref no longer points at it)
  for (const path of blobPaths) {
    try {
      rmSync(path, { force: true });
      const parent = dirname(path);
      if (existsSync(parent)) {
        try {
          rmdirSync(parent); // only succeeds when empty: each asset has its own dir
        } catch {
          // non-empty or shared dir: leave it
        }
      }
    } catch (err) {
      console.warn(`retention: could not remove blob file ${path}:`, err);
    }
  }

  const insightsKept = db
    .query("SELECT COUNT(*) AS n FROM insights WHERE meeting_id = ?")
    .get(meetingId) as { n: number };

  return {
    meeting_id: meetingId,
    already_purged: false,
    transcripts_deleted: transcriptsDeleted,
    quotes_purged: quotesPurged,
    assets_purged: assets.length,
    insights_kept: insightsKept.n,
  };
}

export async function handlePurgeMeeting(
  db: Database,
  user: AuthedUser,
  meetingId: string,
  req: Request,
  opts: { blobDir?: string } = {},
): Promise<Response> {
  let reason: string | undefined;
  const raw = await req.text();
  if (raw.trim() !== "") {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "Request body must be valid JSON" }, 400);
    }
    const parsed = PurgeBodySchema.safeParse(body);
    if (!parsed.success) return json({ error: "Invalid request", issues: parsed.error.issues }, 400);
    reason = parsed.data.reason;
  }

  const result = purgeMeeting(db, user, meetingId, reason, opts);
  if (!result) return json({ error: "Meeting not found" }, 404);
  return json(result);
}
