import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { route, json } from "../router.ts";
import { getDb, nowIso } from "../db.ts";
import { appendEvent } from "../events.ts";
import { ulid } from "../ids.ts";
import { env } from "../config.ts";
import { sttAvailable, transcribeAudio, type TranscribeOpts } from "./whisper.ts";
import { cleanTranscript } from "../extract/segment.ts";
import { syncTranscriptFts } from "../insights/search.ts";

/**
 * STT routes (SPEC.md section 2 step 2): meeting audio to transcript via
 * local whisper.cpp. States: uploaded -> transcribing -> transcribed |
 * transcription_failed. Retry = call the route again after a failure; the
 * route resets a transcription_failed meeting back through transcribing.
 */

const QUALITY_FLAG = "machine_no_diarization";

interface MeetingRow {
  id: string;
  status: string;
  audio_asset_id: string | null;
}

interface AssetRow {
  storage_backend: string;
  storage_ref: string;
}

/**
 * Core transcription flow, separated from route registration so tests can run
 * it against openTestDb() with a stubbed runner (opts.runner / opts.which).
 */
export async function transcribeMeeting(
  db: Database,
  meetingId: string,
  actor: { id: string },
  opts: TranscribeOpts = {},
): Promise<Response> {
  const meeting = db
    .query("SELECT id, status, audio_asset_id FROM meetings WHERE id = ? AND deleted_at IS NULL")
    .get(meetingId) as MeetingRow | null;
  if (!meeting) return json({ error: "Meeting not found." }, 404);
  if (!meeting.audio_asset_id) {
    return json({ error: "Meeting has no audio asset. Upload audio first or paste a transcript." }, 400);
  }
  const existing = db
    .query("SELECT id FROM transcripts WHERE meeting_id = ? LIMIT 1")
    .get(meetingId) as { id: string } | null;
  if (existing) {
    return json({ error: "Meeting already has a transcript. Transcription is blocked.", transcript_id: existing.id }, 409);
  }
  if (meeting.status === "transcribing") {
    return json({ error: "Transcription already in progress for this meeting." }, 409);
  }

  const asset = db
    .query("SELECT storage_backend, storage_ref FROM media_assets WHERE id = ?")
    .get(meeting.audio_asset_id) as AssetRow | null;
  if (!asset) return json({ error: "Audio asset record is missing for this meeting." }, 500);
  if (asset.storage_backend !== "local") {
    return json({ error: `Local transcription supports the local storage backend only (got ${asset.storage_backend}).` }, 400);
  }
  const audioPath = join(env.BLOB_DIR, asset.storage_ref);

  // Covers both the fresh path (uploaded -> transcribing) and the retry path
  // (transcription_failed -> transcribing).
  db.query("UPDATE meetings SET status = 'transcribing' WHERE id = ?").run(meetingId);

  try {
    const text = await transcribeAudio(audioPath, opts);
    const transcriptId = ulid();
    db.transaction(() => {
      db.query(
        `INSERT INTO transcripts (id, meeting_id, content, raw_content, quality_flag, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'stt', ?)`,
      ).run(transcriptId, meetingId, cleanTranscript(text), text, QUALITY_FLAG, nowIso());
      syncTranscriptFts(db, transcriptId);
      db.query("UPDATE meetings SET status = 'transcribed' WHERE id = ?").run(meetingId);
      appendEvent(db, {
        actorUserId: actor.id,
        entityType: "meeting",
        entityId: meetingId,
        eventType: "meeting.transcript_added",
        payload: { via: "whisper", transcript_id: transcriptId, quality_flag: QUALITY_FLAG },
      });
    })();
    return json({
      ok: true,
      meeting_id: meetingId,
      transcript_id: transcriptId,
      status: "transcribed",
      quality_flag: QUALITY_FLAG,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.transaction(() => {
      db.query("UPDATE meetings SET status = 'transcription_failed' WHERE id = ?").run(meetingId);
      appendEvent(db, {
        actorUserId: actor.id,
        entityType: "meeting",
        entityId: meetingId,
        eventType: "meeting.transcription_failed",
        payload: { error: message },
      });
    })();
    return json({ error: message }, 500);
  }
}

/** Shape: { ok: boolean, missing: string[] }. Used by the upload UI preflight. */
export function sttStatus(): Response {
  return json(sttAvailable());
}

route("POST", "/api/meetings/:id/transcribe", "user", (_req, user, params) =>
  transcribeMeeting(getDb(), params.id ?? "", { id: user!.id }),
);

route("GET", "/api/stt/status", "user", () => sttStatus());
