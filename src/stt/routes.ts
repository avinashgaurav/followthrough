import type { Database } from "../db.ts";
import { route, json } from "../router.ts";
import { getDb, nowIso } from "../db.ts";
import { appendEvent } from "../events.ts";
import { ulid } from "../ids.ts";
import { storeFor } from "../storage.ts";
import { deepgramConfigured, transcribeViaDeepgram, type AudioSource } from "./deepgram.ts";
import { cleanTranscript } from "../extract/segment.ts";
import { syncTranscriptFts } from "../insights/search.ts";

/**
 * STT routes (SPEC.md section 2 step 2): meeting audio to transcript via
 * Deepgram. States: uploaded -> transcribing -> transcribed |
 * transcription_failed. Retry = call the route again after a failure; the
 * route resets a transcription_failed meeting back through transcribing.
 * (Local whisper.cpp was removed with the move to Vercel: functions cannot run
 * native binaries or keep large files on disk.)
 */

export const DEEPGRAM_MISSING =
  "Transcription needs a Deepgram key. Set DEEPGRAM_API_KEY, or paste the transcript instead.";

interface MeetingRow {
  id: string;
  status: string;
  audio_asset_id: string | null;
}

/** Boosted Deepgram keyterms for every active user's name (full + first name),
 *  so transcription spells team members correctly. */
async function userNameKeyterms(db: Database): Promise<string[]> {
  const rows = await db
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
  filename: string;
}

export interface TranscribeOpts {
  fetchImpl?: typeof fetch;
  /** Overrides DEEPGRAM_API_KEY (tests). */
  deepgramKey?: string;
  blobDir?: string;
}

/**
 * Core transcription flow, separated from route registration so tests can run
 * it against openTestDb() with a stubbed Deepgram (opts.fetchImpl).
 */
export async function transcribeMeeting(
  db: Database,
  meetingId: string,
  actor: { id: string },
  opts: TranscribeOpts = {},
): Promise<Response> {
  const meeting = await db
    .query("SELECT id, status, audio_asset_id FROM meetings WHERE id = ? AND deleted_at IS NULL")
    .get(meetingId) as MeetingRow | null;
  if (!meeting) return json({ error: "Meeting not found." }, 404);
  if (!meeting.audio_asset_id) {
    return json({ error: "Meeting has no audio asset. Upload audio first or paste a transcript." }, 400);
  }
  const existing = await db
    .query("SELECT id FROM transcripts WHERE meeting_id = ? LIMIT 1")
    .get(meetingId) as { id: string } | null;
  if (existing) {
    return json({ error: "Meeting already has a transcript. Transcription is blocked.", transcript_id: existing.id }, 409);
  }
  if (meeting.status === "transcribing") {
    return json({ error: "Transcription already in progress for this meeting." }, 409);
  }

  const asset = await db
    .query("SELECT storage_backend, storage_ref, filename FROM media_assets WHERE id = ?")
    .get(meeting.audio_asset_id) as AssetRow | null;
  if (!asset) return json({ error: "Audio asset record is missing for this meeting." }, 500);
  if (!opts.deepgramKey && !deepgramConfigured()) return json({ error: DEEPGRAM_MISSING }, 503);

  // Covers both the fresh path (uploaded -> transcribing) and the retry path
  // (transcription_failed -> transcribing).
  await db.query("UPDATE meetings SET status = 'transcribing' WHERE id = ?").run(meetingId);

  try {
    // Deepgram fetches the recording from a signed URL when the store can sign
    // (Supabase); with local storage the bytes are sent directly.
    const store = storeFor(opts);
    const signed = await store.signedDownloadUrl(asset.storage_ref, asset.filename, 3600);
    let source: AudioSource;
    if (signed) source = { url: signed };
    else {
      const bytes = await store.get(asset.storage_ref);
      if (!bytes) throw new Error("The recording is missing from storage.");
      source = { bytes };
    }
    // Auto-boost every active user's name (full + first) so the transcript spells
    // people right (e.g. "Maria" not "Marina") without hand-maintaining them.
    const keyterms = await userNameKeyterms(db);
    const text = await transcribeViaDeepgram(source, { keyterms, fetchImpl: opts.fetchImpl, key: opts.deepgramKey });
    // Deepgram diarizes (speaker-labeled), so the transcript is good quality.
    const qualityFlag = "ok";
    const transcriptId = ulid();
    await db.transaction(async () => {
      await db.query(
        `INSERT INTO transcripts (id, meeting_id, content, raw_content, quality_flag, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'stt', ?)`,
      ).run(transcriptId, meetingId, cleanTranscript(text), text, qualityFlag, nowIso());
      await syncTranscriptFts(db, transcriptId);
      await db.query("UPDATE meetings SET status = 'transcribed' WHERE id = ?").run(meetingId);
      await appendEvent(db, {
        actorUserId: actor.id,
        entityType: "meeting",
        entityId: meetingId,
        eventType: "meeting.transcript_added",
        payload: { via: "deepgram", transcript_id: transcriptId, quality_flag: qualityFlag },
      });
    });
    return json({
      ok: true,
      meeting_id: meetingId,
      transcript_id: transcriptId,
      status: "transcribed",
      quality_flag: qualityFlag,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.transaction(async () => {
      await db.query("UPDATE meetings SET status = 'transcription_failed' WHERE id = ?").run(meetingId);
      await appendEvent(db, {
        actorUserId: actor.id,
        entityType: "meeting",
        entityId: meetingId,
        eventType: "meeting.transcription_failed",
        payload: { error: message },
      });
    });
    // The provider's detail is in the logs and the failure event, not the response.
    console.error(`transcription failed for meeting ${meetingId}:`, err);
    return json({ error: "Transcription failed. Try again, or paste the transcript.", code: "transcription_failed" }, 500);
  }
}

/** Shape: { ok: boolean, missing: string[], provider }. Used by the upload UI preflight. */
export function sttStatus(): Response {
  if (deepgramConfigured()) return json({ ok: true, missing: [], provider: "deepgram" });
  return json({ ok: false, missing: ["DEEPGRAM_API_KEY"], provider: "deepgram" });
}

route("POST", "/api/meetings/:id/transcribe", "user", (_req, user, params) =>
  transcribeMeeting(getDb(), params.id ?? "", { id: user!.id }),
);

route("GET", "/api/stt/status", "user", () => sttStatus());
