import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { sttStatus, transcribeMeeting } from "./routes.ts";
import type { Runner, WhichFn } from "./whisper.ts";

const FAKE_FFMPEG = "/fake/bin/ffmpeg";
const FAKE_WHISPER = "/fake/bin/whisper-cli";
const whichAll: WhichFn = (cmd) => (cmd === "ffmpeg" ? FAKE_FFMPEG : FAKE_WHISPER);
const whichFfmpegOnly: WhichFn = (cmd) => (cmd === "ffmpeg" ? FAKE_FFMPEG : null);

const TRANSCRIPT_TEXT = "Client asked for SSO support on the admin app.";

let db: Database;
let scratchDir: string;
let fakeModel: string;
let savedBinEnv: string | undefined;
const userId = ulid();
const clientId = ulid();

function stubRunner(text = TRANSCRIPT_TEXT): Runner {
  return async (cmd) => {
    if (cmd[0] === FAKE_WHISPER) {
      writeFileSync(`${cmd[cmd.indexOf("-of") + 1]}.txt`, `${text}\n`);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function makeMeeting(opts: { withAudio?: boolean; status?: string } = {}): string {
  const { withAudio = true, status = "uploaded" } = opts;
  let assetId: string | null = null;
  if (withAudio) {
    assetId = ulid();
    db.query(
      `INSERT INTO media_assets (id, kind, storage_backend, storage_ref, filename, sha256, uploaded_by, created_at)
       VALUES (?, 'audio', 'local', ?, 'call.webm', ?, ?, ?)`,
    ).run(assetId, `audio/${assetId}.webm`, `sha-${assetId}`, userId, nowIso());
  }
  const meetingId = ulid();
  db.query(
    `INSERT INTO meetings (id, client_id, seq, meeting_date, audio_asset_id, status, uploaded_by, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM meetings WHERE client_id = ?), ?, ?, ?, ?, ?)`,
  ).run(meetingId, clientId, clientId, "2026-06-10", assetId, status, userId, nowIso());
  return meetingId;
}

function meetingStatus(id: string): string {
  return (db.query("SELECT status FROM meetings WHERE id = ?").get(id) as { status: string }).status;
}

function eventsFor(id: string, type: string): Array<{ payload: Record<string, unknown> }> {
  const rows = db
    .query("SELECT payload_json FROM events WHERE entity_type = 'meeting' AND entity_id = ? AND event_type = ?")
    .all(id, type) as Array<{ payload_json: string | null }>;
  return rows.map((r) => ({ payload: r.payload_json ? JSON.parse(r.payload_json) : {} }));
}

beforeEach(() => {
  savedBinEnv = process.env.WHISPER_CPP_PATH;
  delete process.env.WHISPER_CPP_PATH;
  db = openTestDb();
  db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, 'tester@xyz.com', 'Tester', 'member', ?)",
  ).run(userId, nowIso());
  db.query("INSERT INTO clients (id, name, created_by, created_at) VALUES (?, 'Acme', ?, ?)").run(
    clientId,
    userId,
    nowIso(),
  );
  scratchDir = mkdtempSync(join(tmpdir(), "ie-stt-routes-"));
  fakeModel = join(scratchDir, "model.bin");
  writeFileSync(fakeModel, "fake");
});

afterEach(() => {
  if (savedBinEnv === undefined) delete process.env.WHISPER_CPP_PATH;
  else process.env.WHISPER_CPP_PATH = savedBinEnv;
  db.close();
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("POST /api/meetings/:id/transcribe (transcribeMeeting)", () => {
  test("happy path: transcript row, status flip, transcript_added event", async () => {
    const meetingId = makeMeeting();
    const res = await transcribeMeeting(db, meetingId, { id: userId }, {
      runner: stubRunner(),
      which: whichAll,
      model: fakeModel,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe("transcribed");
    expect(body.quality_flag).toBe("machine_no_diarization");

    const transcript = db
      .query("SELECT id, content, raw_content, quality_flag, source FROM transcripts WHERE meeting_id = ?")
      .get(meetingId) as Record<string, string>;
    expect(transcript.content).toBe(TRANSCRIPT_TEXT);
    expect(transcript.raw_content).toBe(TRANSCRIPT_TEXT);
    expect(transcript.quality_flag).toBe("machine_no_diarization");
    expect(transcript.source).toBe("stt");
    expect(body.transcript_id).toBe(transcript.id);

    expect(meetingStatus(meetingId)).toBe("transcribed");

    const events = eventsFor(meetingId, "meeting.transcript_added");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.via).toBe("whisper");
    expect(events[0]!.payload.transcript_id).toBe(transcript.id);
  });

  test("missing whisper binary: 500 actionable error, status transcription_failed, failure event", async () => {
    const meetingId = makeMeeting();
    const res = await transcribeMeeting(db, meetingId, { id: userId }, {
      runner: stubRunner(),
      which: whichFfmpegOnly, // ffmpeg present, whisper binary absent
      model: fakeModel,
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("whisper.cpp binary not found");
    expect(body.error).toContain("Run: bash scripts/setup-whisper.sh");

    expect(meetingStatus(meetingId)).toBe("transcription_failed");
    const failures = eventsFor(meetingId, "meeting.transcription_failed");
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.payload.error)).toContain("setup-whisper.sh");
    expect(db.query("SELECT COUNT(*) AS n FROM transcripts WHERE meeting_id = ?").get(meetingId)).toEqual({ n: 0 });
  });

  test("retry after failure succeeds (status reset through transcribing)", async () => {
    const meetingId = makeMeeting({ status: "transcription_failed" });
    const res = await transcribeMeeting(db, meetingId, { id: userId }, {
      runner: stubRunner(),
      which: whichAll,
      model: fakeModel,
    });
    expect(res.status).toBe(200);
    expect(meetingStatus(meetingId)).toBe("transcribed");
  });

  test("blocked when a transcript already exists", async () => {
    const meetingId = makeMeeting();
    db.query(
      "INSERT INTO transcripts (id, meeting_id, content, source, created_at) VALUES (?, ?, 'pasted text', 'pasted', ?)",
    ).run(ulid(), meetingId, nowIso());

    const res = await transcribeMeeting(db, meetingId, { id: userId }, {
      runner: stubRunner(),
      which: whichAll,
      model: fakeModel,
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("already has a transcript");
    expect(meetingStatus(meetingId)).toBe("uploaded"); // untouched
    expect(eventsFor(meetingId, "meeting.transcription_failed")).toHaveLength(0);
  });

  test("blocked while a transcription is already in progress", async () => {
    const meetingId = makeMeeting({ status: "transcribing" });
    const res = await transcribeMeeting(db, meetingId, { id: userId }, {
      runner: stubRunner(),
      which: whichAll,
      model: fakeModel,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("already in progress");
  });

  test("meeting without audio asset: 400", async () => {
    const meetingId = makeMeeting({ withAudio: false });
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
  test("returns the sttAvailable shape", async () => {
    const res = sttStatus();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { ok: unknown; missing: unknown };
    expect(typeof body.ok).toBe("boolean");
    expect(Array.isArray(body.missing)).toBe(true);
    for (const m of body.missing as unknown[]) expect(typeof m).toBe("string");
  });
});
