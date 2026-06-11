import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../db.ts";
import {
  INBOX_CLIENT_NAME,
  findOrCreateInboxClient,
  findOrCreateSystemUser,
  listPendingFiles,
  scanWatchFolder,
  watchFolderStatus,
} from "./service.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tempDirs(): { dir: string; blobDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ie-watch-test-"));
  roots.push(root);
  return { dir: join(root, "inbox"), blobDir: join(root, "blobs") };
}

/** Create the inbox dir on first use and return the file path inside it. */
function ensureDir(dir: string, filename: string): string {
  mkdirSync(dir, { recursive: true });
  return join(dir, filename);
}

function inboxMeetings(db: Database): Record<string, unknown>[] {
  return db
    .query(
      `SELECT m.* FROM meetings m JOIN clients c ON c.id = m.client_id
       WHERE c.name = ? ORDER BY m.seq`,
    )
    .all(INBOX_CLIENT_NAME) as Record<string, unknown>[];
}

describe("watch folder scan", () => {
  test("txt file becomes a transcribed meeting under the Inbox client", async () => {
    const db = openTestDb();
    const { dir, blobDir } = tempDirs();
    writeFileSync(ensureDir(dir, "standup-notes.txt"), "Client: we really need SSO support.\n");

    const result = await scanWatchFolder(db, { dir, blobDir, seen: new Set() });
    expect(result.created).toBe(1);
    expect(result.errors).toBe(0);

    const meetings = inboxMeetings(db);
    expect(meetings).toHaveLength(1);
    const m = meetings[0]!;
    expect(m.status).toBe("transcribed");
    expect(m.source).toBe("watch_folder");
    expect(m.title).toBe("standup-notes.txt");
    expect(m.consent_confirmed).toBe(1);
    expect(typeof m.meeting_date).toBe("string");
    expect(m.meeting_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const transcript = db
      .query("SELECT content FROM transcripts WHERE meeting_id = ?")
      .get(m.id as string) as { content: string };
    expect(transcript.content).toContain("SSO support");

    // file moved out of the inbox into processed/
    expect(existsSync(join(dir, "standup-notes.txt"))).toBe(false);
    expect(readdirSync(join(dir, "processed"))).toContain("standup-notes.txt");
    expect(listPendingFiles(dir)).toHaveLength(0);
  });

  test("same file content twice is not duplicated", async () => {
    const db = openTestDb();
    const { dir, blobDir } = tempDirs();
    writeFileSync(ensureDir(dir, "call.txt"), "Same call, dropped twice.");
    const first = await scanWatchFolder(db, { dir, blobDir, seen: new Set() });
    expect(first.created).toBe(1);

    // drop the identical bytes again under a different name, fresh seen set so
    // dedup must come from durable state, not process memory
    copyFileSync(join(dir, "processed", "call.txt"), join(dir, "call-copy.txt"));
    const second = await scanWatchFolder(db, { dir, blobDir, seen: new Set() });
    expect(second.created).toBe(0);
    expect(second.duplicates).toBe(1);

    expect(inboxMeetings(db)).toHaveLength(1);
    // the duplicate still leaves the inbox
    expect(listPendingFiles(dir)).toHaveLength(0);
  });

  test("audio file becomes a meeting with status uploaded and a stored blob", async () => {
    const db = openTestDb();
    const { dir, blobDir } = tempDirs();
    writeFileSync(ensureDir(dir, "recording.webm"), new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 9]));

    const result = await scanWatchFolder(db, { dir, blobDir, seen: new Set() });
    expect(result.created).toBe(1);

    const meetings = inboxMeetings(db);
    expect(meetings).toHaveLength(1);
    const m = meetings[0]!;
    expect(m.status).toBe("uploaded");
    expect(m.audio_asset_id).toBeTruthy();
    const asset = db
      .query("SELECT * FROM media_assets WHERE id = ?")
      .get(m.audio_asset_id as string) as Record<string, unknown>;
    expect(asset.kind).toBe("audio");
    expect(asset.content_type).toBe("audio/webm");
    expect(existsSync(join(blobDir, asset.storage_ref as string))).toBe(true);
  });

  test("non-matching files are ignored and stay put", async () => {
    const db = openTestDb();
    const { dir, blobDir } = tempDirs();
    writeFileSync(ensureDir(dir, "notes.pdf"), "%PDF-1.4 not a transcript");
    const result = await scanWatchFolder(db, { dir, blobDir, seen: new Set() });
    expect(result.created).toBe(0);
    expect(inboxMeetings(db)).toHaveLength(0);
    expect(existsSync(join(dir, "notes.pdf"))).toBe(true);
  });

  test("status endpoint data: pending count and processed_today", async () => {
    const db = openTestDb();
    const { dir, blobDir } = tempDirs();
    writeFileSync(ensureDir(dir, "a.txt"), "first call transcript");
    writeFileSync(join(dir, "b.txt"), "second call transcript");
    writeFileSync(join(dir, "ignored.bin"), "not eligible");

    let status = watchFolderStatus(db, dir);
    expect(status.dir).toBe(dir);
    expect(status.pending).toBe(2);
    expect(status.processed_today).toBe(0);

    await scanWatchFolder(db, { dir, blobDir, seen: new Set() });
    status = watchFolderStatus(db, dir);
    expect(status.pending).toBe(0);
    expect(status.processed_today).toBe(2);
  });

  test("inbox client and system user are created once and reused", () => {
    const db = openTestDb();
    const c1 = findOrCreateInboxClient(db);
    const c2 = findOrCreateInboxClient(db);
    expect(c1).toBe(c2);
    const client = db.query("SELECT * FROM clients WHERE id = ?").get(c1) as Record<string, unknown>;
    expect(client.name).toBe(INBOX_CLIENT_NAME);
    expect(client.is_internal).toBe(0);

    const u1 = findOrCreateSystemUser(db);
    const u2 = findOrCreateSystemUser(db);
    expect(u1).toBe(u2);
    const user = db.query("SELECT * FROM users WHERE id = ?").get(u1) as Record<string, unknown>;
    expect(user.code_hash).toBeNull(); // cannot log in
  });
});
