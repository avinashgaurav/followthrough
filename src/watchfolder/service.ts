import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { getDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { sha256Hex } from "../ingest/media.ts";
import { createMeeting, type UploadedFile } from "../ingest/service.ts";

/**
 * Watch-folder ingest (SPEC.md sections 2.1, 9). Every SCAN_INTERVAL_MS the
 * folder at WATCH_DIR (default ./data/inbox) is scanned for dropped transcripts
 * and recordings. Each unseen file becomes a meeting via the exact same code
 * path as manual uploads (ingest createMeeting), filed under the special
 * "Inbox (unsorted)" client for later re-homing. Processed files move to
 * WATCH_DIR/processed/ so the inbox only ever contains pending work.
 *
 * Consent note: files land here because the founder drops them personally,
 * which is the consent act; createMeeting records consent_confirmed = 1.
 */

export const INBOX_CLIENT_NAME = "Inbox (unsorted)";
export const SYSTEM_USER_EMAIL = "watchfolder@system.internal";
export const SCAN_INTERVAL_MS = 60_000;

const TRANSCRIPT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".vtt": "text/vtt",
};

const AUDIO_TYPES: Record<string, string> = {
  ".webm": "audio/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

export function defaultWatchDir(): string {
  return process.env.WATCH_DIR ?? "./data/inbox";
}

export interface ScanOptions {
  dir?: string;
  blobDir?: string;
  /** in-process sha256 dedup set; defaults to a module-level set */
  seen?: Set<string>;
}

export interface ScanResult {
  created: number;
  duplicates: number;
  errors: number;
}

// shas handled by this process (cheap second line of defence; the durable
// dedup is content-addressed in createMeeting via media_assets + events)
const processSeen = new Set<string>();

/** Find or create the no-login system user that watch-folder actions attribute to. */
export function findOrCreateSystemUser(db: Database): string {
  const row = db.query("SELECT id FROM users WHERE email = ?").get(SYSTEM_USER_EMAIL) as
    | { id: string }
    | null;
  if (row) return row.id;
  const id = ulid();
  // code_hash NULL = login permanently disabled for this account
  db.query(
    "INSERT INTO users (id, email, name, role, code_hash, created_at) VALUES (?, ?, 'Watch Folder', 'member', NULL, ?)",
  ).run(id, SYSTEM_USER_EMAIL, nowIso());
  return id;
}

/** Find or create the holding client for unsorted inbox meetings. */
export function findOrCreateInboxClient(db: Database): string {
  const row = db.query("SELECT id FROM clients WHERE name = ?").get(INBOX_CLIENT_NAME) as
    | { id: string }
    | null;
  if (row) return row.id;
  const id = ulid();
  db.query(
    "INSERT INTO clients (id, name, domain, is_internal, created_by, created_at) VALUES (?, ?, NULL, 0, NULL, ?)",
  ).run(id, INBOX_CLIENT_NAME, nowIso());
  return id;
}

function classify(filename: string): { kind: "transcript" | "audio"; contentType: string } | null {
  const ext = extname(filename).toLowerCase();
  if (TRANSCRIPT_TYPES[ext]) return { kind: "transcript", contentType: TRANSCRIPT_TYPES[ext] };
  if (AUDIO_TYPES[ext]) return { kind: "audio", contentType: AUDIO_TYPES[ext] };
  return null;
}

/** Already ingested in a previous run? Content-addressed check against media_assets. */
function shaKnown(db: Database, sha: string): boolean {
  return db.query("SELECT 1 FROM media_assets WHERE sha256 = ? LIMIT 1").get(sha) !== null;
}

/** Move a processed file into dir/processed/, keeping the name unique. */
function moveToProcessed(dir: string, filename: string): void {
  const processedDir = join(dir, "processed");
  mkdirSync(processedDir, { recursive: true });
  let dest = join(processedDir, filename);
  if (existsSync(dest)) dest = join(processedDir, `${ulid().slice(-6)}-${filename}`);
  renameSync(join(dir, filename), dest);
}

/** Files in the watch dir that the scanner would pick up (transcript or audio extensions). */
export function listPendingFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && classify(e.name) !== null)
    .map((e) => e.name)
    .sort();
}

/**
 * One scan pass. Each eligible file becomes a meeting under the Inbox client
 * (or attaches to the existing one when the bytes were seen before), then
 * moves to processed/. Errors leave the file in place for the next pass.
 */
export async function scanWatchFolder(db: Database, opts: ScanOptions = {}): Promise<ScanResult> {
  const dir = opts.dir ?? defaultWatchDir();
  const seen = opts.seen ?? processSeen;
  mkdirSync(join(dir, "processed"), { recursive: true });

  const result: ScanResult = { created: 0, duplicates: 0, errors: 0 };

  for (const filename of listPendingFiles(dir)) {
    const fileKind = classify(filename)!;
    try {
      const path = join(dir, filename);
      const bytes = new Uint8Array(readFileSync(path));
      const sha = sha256Hex(bytes);

      if (seen.has(sha) || shaKnown(db, sha)) {
        result.duplicates += 1;
        moveToProcessed(dir, filename);
        continue;
      }

      const clientId = findOrCreateInboxClient(db);
      const actorId = findOrCreateSystemUser(db);
      const mtime = statSync(path).mtime;
      const meetingDate = mtime.toISOString().slice(0, 10);
      const file: UploadedFile = { filename, contentType: fileKind.contentType, bytes };

      const created = await createMeeting(
        db,
        { id: actorId },
        {
          client_id: clientId,
          meeting_date: meetingDate,
          title: filename,
          source: "watch_folder",
          ...(fileKind.kind === "transcript" ? { transcriptFile: file } : { audioFile: file }),
        },
        opts.blobDir ? { blobDir: opts.blobDir } : {},
      );

      seen.add(sha);
      if (created.duplicate) result.duplicates += 1;
      else result.created += 1;
      moveToProcessed(dir, filename);
    } catch (err) {
      result.errors += 1;
      console.warn(`watch-folder: failed to ingest ${filename}:`, err);
    }
  }
  return result;
}

export interface WatchFolderStatus {
  dir: string;
  pending: number;
  processed_today: number;
}

export function watchFolderStatus(db: Database, dir: string = defaultWatchDir()): WatchFolderStatus {
  const today = nowIso().slice(0, 10);
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM events
       WHERE event_type = 'meeting.uploaded'
         AND payload_json LIKE '%"source":"watch_folder"%'
         AND occurred_at LIKE ? || '%'`,
    )
    .get(today) as { n: number };
  return { dir, pending: listPendingFiles(dir).length, processed_today: row.n };
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the 60s polling loop. Integration (src/server.ts):
 *
 *   import "./watchfolder/routes.ts";              // with the other route modules
 *   import { startWatchFolder } from "./watchfolder/service.ts";
 *   // inside if (import.meta.main), next to startDigestScheduler():
 *   startWatchFolder();
 */
export function startWatchFolder(): void {
  if (timer) return; // idempotent
  const tick = () => {
    scanWatchFolder(getDb()).catch((err) => console.warn("watch-folder scan failed:", err));
  };
  tick();
  timer = setInterval(tick, SCAN_INTERVAL_MS);
}

export function stopWatchFolder(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
