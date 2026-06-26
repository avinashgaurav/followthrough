import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { route, json } from "../router.ts";
import { getDb, nowIso } from "../db.ts";
import { appendEvent } from "../events.ts";
import { ulid } from "../ids.ts";
import { env } from "../config.ts";
import { sttAvailable, transcribeAudio, type TranscribeOpts } from "./whisper.ts";
import { deepgramConfigured, transcribeViaDeepgram } from "./deepgram.ts";
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

/** Boosted Deepgram keyterms for every active user's name (full + first name),
 *  so transcription spells team members correctly. */
function userNameKeyterms(db: Database): string[] {
  const rows = db
    .query("SELECT name FROM users WHERE disabled_at IS NULL AND name IS NOT NULL AND TRIM(name) != ''")
    .all() as Array<{ name: string }>;
  const terms = new Set<string>();
  for (const { name } of rows) {
    const full = name.trim();
    terms.add(`${full}:2`);
    const first = full.split(/\s+/)[0];
    if (first && first !== full) terms.add(`${first}:2`);
  }
  return [...terms];
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
  opts: TranscribeOpts & { useDeepgram?: boolean } = {},
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
    // Prefer cloud STT when a Deepgram key is set (the deployed path); otherwise
    // transcribe locally with whisper.cpp. opts.useDeepgram lets tests pin the path.
    const useDeepgram = opts.useDeepgram ?? deepgramConfigured();
    // Auto-boost every active user's name (full + first) so the transcript spells
    // people right (e.g. "Maria" not "Marina") without hand-maintaining them.
    const keyterms = useDeepgram ? userNameKeyterms(db) : [];
    const text = useDeepgram
      ? await transcribeViaDeepgram(audioPath, { keyterms })
      : await transcribeAudio(audioPath, opts);
    // Deepgram diarizes (speaker-labeled), so it's good-quality; local whisper does not.
    const qualityFlag = useDeepgram ? "ok" : QUALITY_FLAG;
    const transcriptId = ulid();
    db.transaction(() => {
      db.query(
        `INSERT INTO transcripts (id, meeting_id, content, raw_content, quality_flag, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'stt', ?)`,
      ).run(transcriptId, meetingId, cleanTranscript(text), text, qualityFlag, nowIso());
      syncTranscriptFts(db, transcriptId);
      db.query("UPDATE meetings SET status = 'transcribed' WHERE id = ?").run(meetingId);
      appendEvent(db, {
        actorUserId: actor.id,
        entityType: "meeting",
        entityId: meetingId,
        eventType: "meeting.transcript_added",
        payload: { via: useDeepgram ? "deepgram" : "whisper", transcript_id: transcriptId, quality_flag: qualityFlag },
      });
    })();
    return json({
      ok: true,
      meeting_id: meetingId,
      transcript_id: transcriptId,
      status: "transcribed",
      quality_flag: qualityFlag,
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

/** Shape: { ok: boolean, missing: string[], provider }. Used by the upload UI preflight.
 *  Deepgram (when configured) satisfies STT on its own; otherwise we report local
 *  whisper availability. */
export function sttStatus(): Response {
  if (deepgramConfigured()) return json({ ok: true, missing: [], provider: "deepgram" });
  return json({ ...sttAvailable(), provider: "whisper" });
}

route("POST", "/api/meetings/:id/transcribe", "user", (_req, user, params) =>
  transcribeMeeting(getDb(), params.id ?? "", { id: user!.id }),
);

route("GET", "/api/stt/status", "user", () => sttStatus());
