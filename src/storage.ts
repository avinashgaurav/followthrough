import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { env } from "./config.ts";
import { ulid } from "./ids.ts";

/**
 * Blob storage for recordings, transcript files and CSV exports.
 *
 * - "supabase": a private Supabase Storage bucket over its REST API. Used when
 *   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set (the Vercel deployment).
 *   Downloads are short-lived signed URLs, and browsers upload large audio
 *   straight to a signed upload URL, so files never pass through a function
 *   (Vercel caps request bodies at 4.5 MB).
 * - "local": a directory on disk (BLOB_DIR). Used in tests and local dev.
 *
 * Keys are always relative ("<ulid>/<name>", "exports/<id>.csv"), recorded in
 * media_assets.storage_ref next to storage_backend.
 */

export type StorageBackend = "local" | "supabase";

export interface BlobStore {
  backend: StorageBackend;
  /** Largest object the store accepts, or null for no store-level limit. */
  maxBytes: number | null;
  put(key: string, bytes: Uint8Array, contentType: string | null): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  /** The stored object's real size in bytes, or null if it does not exist. */
  objectSize(key: string): Promise<number | null>;
  /** Entries directly under a folder ("" = top level): files and sub-folders. */
  list(prefix: string): Promise<Array<{ name: string; folder: boolean }>>;
  remove(keys: string[]): Promise<void>;
  /** A URL the browser can download from, or null when the caller must stream bytes. */
  signedDownloadUrl(key: string, filename: string, ttlSeconds?: number): Promise<string | null>;
  /** A URL the browser can PUT the file to, or null when uploads must go through the API. */
  signedUploadUrl(key: string): Promise<string | null>;
}

export const BUCKET = process.env.STORAGE_BUCKET || "followthrough";

/**
 * Per-file limit for the Supabase bucket. Supabase's free plan caps every file
 * at 50 MB project-wide and refuses a bucket limit above that; on a paid plan
 * raise the project limit, then STORAGE_MAX_BYTES.
 */
export function storageMaxBytes(): number {
  const n = Number(process.env.STORAGE_MAX_BYTES ?? 50 * 1024 * 1024);
  return n > 0 ? n : 50 * 1024 * 1024;
}

/** What the bucket accepts; Supabase enforces both at upload time. */
export const ALLOWED_MIME_TYPES = ["audio/*", "video/*", "text/*", "image/*", "application/octet-stream"];

export function supabaseStorageConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Key is relative and stays inside its root: no absolute paths or traversal. */
export function assertSafeKey(key: string): void {
  if (!key || key.startsWith("/") || key.split("/").some((p) => p === ".." || p === "." || p === "")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
}

export function localStore(dir: string = env.BLOB_DIR): BlobStore {
  const dir_ = dir;
  const path = (key: string) => {
    assertSafeKey(key);
    const p = join(dir, key);
    if (!resolve(p).startsWith(resolve(dir) + sep)) throw new Error(`Invalid storage key: ${key}`);
    return p;
  };
  return {
    backend: "local",
    maxBytes: null,
    async put(key, bytes) {
      const p = path(key);
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.${ulid().slice(-8)}.tmp`;
      await Bun.write(tmp, bytes);
      renameSync(tmp, p);
    },
    async get(key) {
      const p = path(key);
      return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
    },
    async exists(key) {
      return existsSync(path(key));
    },
    async objectSize(key) {
      const p = path(key);
      return existsSync(p) ? statSync(p).size : null;
    },
    async list(prefix) {
      const dir = prefix ? path(prefix) : dir_;
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.endsWith(".tmp"))
        .map((e) => ({ name: e.name, folder: e.isDirectory() }));
    },
    async remove(keys) {
      for (const k of keys) rmSync(path(k), { force: true });
    },
    async signedDownloadUrl() {
      return null;
    },
    async signedUploadUrl() {
      return null;
    },
  };
}

export function supabaseStore(
  opts: { url?: string; key?: string; bucket?: string; fetchImpl?: typeof fetch; maxBytes?: number } = {},
): BlobStore {
  const base = (opts.url ?? process.env.SUPABASE_URL ?? "").replace(/\/+$/, "") + "/storage/v1";
  const serviceKey = opts.key ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const bucket = opts.bucket ?? BUCKET;
  const doFetch = opts.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
  const enc = (key: string) => {
    assertSafeKey(key);
    return key.split("/").map(encodeURIComponent).join("/");
  };
  const maxBytes = opts.maxBytes ?? storageMaxBytes();
  const settings = { public: false, file_size_limit: maxBytes, allowed_mime_types: ALLOWED_MIME_TYPES };
  let bucketReady: Promise<void> | null = null;
  // Create the private bucket with its limits, or bring an existing one's limits up to date.
  const ensureBucket = () =>
    (bucketReady ??= (async () => {
      const res = await doFetch(`${base}/bucket`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ id: bucket, name: bucket, ...settings }),
      });
      if (res.ok) return;
      const text = await res.text();
      if (res.status !== 409 && !/already exists|Duplicate/i.test(text)) {
        bucketReady = null;
        throw new Error(`Could not create storage bucket "${bucket}": ${res.status} ${text.slice(0, 200)}`);
      }
      const upd = await doFetch(`${base}/bucket/${bucket}`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!upd.ok) {
        bucketReady = null;
        throw new Error(`Could not update storage bucket "${bucket}": ${upd.status} ${(await upd.text()).slice(0, 200)}`);
      }
    })());
  const objectSize = async (key: string): Promise<number | null> => {
    const res = await doFetch(`${base}/object/info/${bucket}/${enc(key)}`, { headers: auth });
    if (!res.ok) return null;
    const info = (await res.json()) as { size?: unknown; metadata?: { size?: unknown } };
    const size = Number(info.size ?? info.metadata?.size);
    return Number.isFinite(size) ? size : null;
  };
  const fail = async (what: string, res: Response) => {
    throw new Error(`Storage ${what} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
  return {
    backend: "supabase",
    maxBytes,
    async put(key, bytes, contentType) {
      await ensureBucket();
      const res = await doFetch(`${base}/object/${bucket}/${enc(key)}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": contentType || "application/octet-stream", "x-upsert": "true" },
        body: bytes as BodyInit,
      });
      if (!res.ok) await fail("upload", res);
    },
    async get(key) {
      const res = await doFetch(`${base}/object/${bucket}/${enc(key)}`, { headers: auth });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) await fail("download", res);
      return new Uint8Array(await res.arrayBuffer());
    },
    async exists(key) {
      return (await objectSize(key)) !== null;
    },
    objectSize,
    async list(prefix) {
      if (prefix) assertSafeKey(prefix);
      const out: Array<{ name: string; folder: boolean }> = [];
      for (let offset = 0; offset < 10_000; offset += 1000) {
        const res = await doFetch(`${base}/object/list/${bucket}`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
        });
        if (res.status === 404 || res.status === 400) return out; // no bucket yet
        if (!res.ok) await fail("list", res);
        const page = (await res.json()) as Array<{ name: string; id: string | null }>;
        // Folders come back with a null id.
        out.push(...page.map((e) => ({ name: e.name, folder: e.id === null })));
        if (page.length < 1000) break;
      }
      return out;
    },
    async remove(keys) {
      if (keys.length === 0) return;
      keys.forEach(assertSafeKey);
      const res = await doFetch(`${base}/object/${bucket}`, {
        method: "DELETE",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: keys }),
      });
      if (!res.ok) await fail("delete", res);
    },
    async signedDownloadUrl(key, filename, ttlSeconds = 300) {
      const res = await doFetch(`${base}/object/sign/${bucket}/${enc(key)}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: ttlSeconds }),
      });
      if (!res.ok) await fail("signing", res);
      const { signedURL } = (await res.json()) as { signedURL: string };
      return `${base}${signedURL}&download=${encodeURIComponent(filename)}`;
    },
    async signedUploadUrl(key) {
      await ensureBucket();
      const res = await doFetch(`${base}/object/upload/sign/${bucket}/${enc(key)}`, {
        method: "POST",
        headers: auth,
      });
      if (!res.ok) await fail("upload signing", res);
      const { url } = (await res.json()) as { url: string };
      return `${base}${url}`;
    },
  };
}

let store: BlobStore | null = null;

/** The process blob store: Supabase when configured, else BLOB_DIR on disk. */
export function getStore(): BlobStore {
  return (store ??= supabaseStorageConfigured() ? supabaseStore() : localStore());
}

/** The store for an explicit local dir (tests), else the process store. */
export function storeFor(opts: { blobDir?: string } = {}): BlobStore {
  return opts.blobDir ? localStore(opts.blobDir) : getStore();
}

/** Tests and scripts. */
export function setStore(next: BlobStore | null): void {
  store = next;
}

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Creation time (ms) encoded in a ULID's first 10 characters, or null. */
export function ulidTime(id: string): number | null {
  if (!ULID.test(id)) return null;
  let t = 0;
  for (const c of id.slice(0, 10)) t = t * 32 + ENC.indexOf(c);
  return t;
}

/**
 * Delete uploads that were never registered: a browser got a signed URL and
 * uploaded, but no media_assets row points at the object. Only "<ulid>/" upload
 * folders older than maxAgeMs are looked at (the ULID carries its creation
 * time), so an upload in progress is never touched. exports/ is left alone.
 * Runs from the daily cron. Returns how many objects were deleted.
 */
export async function sweepOrphanUploads(
  db: import("./db.ts").Database,
  store: BlobStore = getStore(),
  now: number = Date.now(),
  maxAgeMs = 24 * 3600 * 1000,
  maxFolders = 500,
): Promise<number> {
  const folders = (await store.list(""))
    .filter((e) => e.folder && (ulidTime(e.name) ?? Infinity) < now - maxAgeMs)
    .slice(0, maxFolders);
  let deleted = 0;
  for (const f of folders) {
    const keys = (await store.list(f.name)).filter((e) => !e.folder).map((e) => `${f.name}/${e.name}`);
    if (keys.length === 0) continue;
    const used = (await db
      .query(`SELECT storage_ref FROM media_assets WHERE storage_ref IN (${keys.map(() => "?").join(", ")})`)
      .all(...keys)) as Array<{ storage_ref: string }>;
    const keep = new Set(used.map((r) => r.storage_ref));
    const orphans = keys.filter((k) => !keep.has(k));
    if (orphans.length) {
      await store.remove(orphans);
      deleted += orphans.length;
    }
  }
  return deleted;
}
