import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "../db.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { DEEPGRAM_MISSING, sttStatus, transcribeMeeting, type TranscribeOpts } from "./routes.ts";

const TRANSCRIPT_TEXT = "Client asked for SSO support on the admin app.";

let db: Database;
let scratchDir: string;
let savedKey: string | undefined;
const userId = ulid();
const clientId = ulid();

/** A Deepgram stub: a paragraphs transcript, or the given HTTP failure. */
function deepgram(opts: { text?: string; status?: number } = {}): TranscribeOpts {
  const fetchImpl = (async () =>
    opts.status
      ? new Response("upstream failure", { status: opts.status })
      : new Response(
          JSON.stringify({ results: { channels: [{ alternatives: [{ paragraphs: { transcript: opts.text ?? TRANSCRIPT_TEXT } }] }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch;
  return { fetchImpl, deepgramKey: "test-key", blobDir: scratchDir };
}

async function makeMeeting(opts: { withAudio?: boolean; status?: string } = {}): Promise<string> {
  const { withAudio = true, status = "uploaded" } = opts;
  let assetId: string | null = null;
  if (withAudio) {
    assetId = ulid();
    await db.query(
      `INSERT INTO media_assets (id, kind, storage_backend, storage_ref, filename, sha256, uploaded_by, created_at)
       VALUES (?, 'audio', 'local', ?, 'call.webm', ?, ?, ?)`,
    ).run(assetId, `${assetId}/call.webm`, `sha-${assetId}`, userId, nowIso());
    mkdirSync(join(scratchDir, assetId), { recursive: true });
    writeFileSync(join(scratchDir, assetId, "call.webm"), "fake-audio-bytes");
  }
  const meetingId = ulid();
  await db.query(
    `INSERT INTO meetings (id, client_id, seq, meeting_date, audio_asset_id, status, uploaded_by, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM meetings WHERE client_id = ?), ?, ?, ?, ?, ?)`,
  ).run(meetingId, clientId, clientId, "2026-06-10", assetId, status, userId, nowIso());
  return meetingId;
}

async function meetingStatus(id: string): Promise<string> {
  return (await db.query("SELECT status FROM meetings WHERE id = ?").get(id) as { status: string }).status;
}

async function eventsFor(id: string, type: string): Promise<Array<{ payload: Record<string, unknown> }>> {
  const rows = await db
    .query("SELECT payload_json FROM events WHERE entity_type = 'meeting' AND entity_id = ? AND event_type = ?")
    .all(id, type) as Array<{ payload_json: string | null }>;
  return rows.map((r) => ({ payload: r.payload_json ? JSON.parse(r.payload_json) : {} }));
}

beforeEach(async () => {
  savedKey = process.env.DEEPGRAM_API_KEY;
  db = await openTestDb();
  await db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, 'tester@tallyhall.com', 'Tester', 'member', ?)",
  ).run(userId, nowIso());
  await db.query("INSERT INTO clients (id, name, created_by, created_at) VALUES (?, 'Acme', ?, ?)").run(
    clientId,
    userId,
    nowIso(),
  );
  scratchDir = mkdtempSync(join(tmpdir(), "ie-stt-routes-"));
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env.DEEPGRAM_API_KEY;
  else process.env.DEEPGRAM_API_KEY = savedKey;
  await db.close();
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("POST /api/meetings/:id/transcribe (transcribeMeeting)", () => {
  test("happy path: transcript row, status flip, transcript_added event", async () => {
    const meetingId = await makeMeeting();
    const res = await transcribeMeeting(db, meetingId, { id: userId }, deepgram());

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe("transcribed");
    expect(body.quality_flag).toBe("ok");

    const transcript = await db
      .query("SELECT id, content, raw_content, quality_flag, source FROM transcripts WHERE meeting_id = ?")
      .get(meetingId) as Record<string, string>;
    expect(transcript.content).toBe(TRANSCRIPT_TEXT);
    expect(transcript.raw_content).toBe(TRANSCRIPT_TEXT);
    expect(transcript.quality_flag).toBe("ok");
    expect(transcript.source).toBe("stt");
    expect(body.transcript_id).toBe(transcript.id);

    expect(await meetingStatus(meetingId)).toBe("transcribed");

    const events = await eventsFor(meetingId, "meeting.transcript_added");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.via).toBe("deepgram");
    expect(events[0]!.payload.transcript_id).toBe(transcript.id);
  });

  test("no Deepgram key: 503 actionable error, meeting untouched", async () => {
    delete process.env.DEEPGRAM_API_KEY;
    const meetingId = await makeMeeting();
    const res = await transcribeMeeting(db, meetingId, { id: userId }, { blobDir: scratchDir });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(DEEPGRAM_MISSING);
    expect(await meetingStatus(meetingId)).toBe("uploaded");
  });

  test("Deepgram failure: 500, status transcription_failed, failure event", async () => {
    const meetingId = await makeMeeting();
    const res = await transcribeMeeting(db, meetingId, { id: userId }, deepgram({ status: 502 }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("transcription_failed");
    expect(body.error).not.toContain("Deepgram error"); // provider detail is not echoed

    expect(await meetingStatus(meetingId)).toBe("transcription_failed");
    const failures = await eventsFor(meetingId, "meeting.transcription_failed");
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.payload.error)).toContain("Deepgram error 502");
    expect(await db.query("SELECT COUNT(*) AS n FROM transcripts WHERE meeting_id = ?").get(meetingId)).toEqual({ n: 0 });
  });

  test("retry after failure succeeds (status reset through transcribing)", async () => {
    const meetingId = await makeMeeting({ status: "transcription_failed" });
    const res = await transcribeMeeting(db, meetingId, { id: userId }, deepgram());
    expect(res.status).toBe(200);
    expect(await meetingStatus(meetingId)).toBe("transcribed");
  });

  test("blocked when a transcript already exists", async () => {
    const meetingId = await makeMeeting();
    await db.query(
      "INSERT INTO transcripts (id, meeting_id, content, source, created_at) VALUES (?, ?, 'pasted text', 'pasted', ?)",
    ).run(ulid(), meetingId, nowIso());

    const res = await transcribeMeeting(db, meetingId, { id: userId }, deepgram());

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("already has a transcript");
    expect(await meetingStatus(meetingId)).toBe("uploaded"); // untouched
    expect(await eventsFor(meetingId, "meeting.transcription_failed")).toHaveLength(0);
  });

  test("blocked while a transcription is already in progress", async () => {
    const meetingId = await makeMeeting({ status: "transcribing" });
    const res = await transcribeMeeting(db, meetingId, { id: userId }, deepgram());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("already in progress");
  });

  test("meeting without audio asset: 400", async () => {
    const meetingId = await makeMeeting({ withAudio: false });
    const res = await transcribeMeeting(db, meetingId, { id: userId });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("no audio asset");
  });

  test("unknown meeting: 404", async () => {
    const res = await transcribeMeeting(db, "01NOPE", { id: userId });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/stt/status", () => {
  test("reports whether Deepgram is configured", async () => {
    const res = sttStatus();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { ok: unknown; missing: unknown };
    expect(typeof body.ok).toBe("boolean");
    expect(Array.isArray(body.missing)).toBe(true);
    for (const m of body.missing as unknown[]) expect(typeof m).toBe("string");
  });
});
