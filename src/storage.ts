import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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
  put(key: string, bytes: Uint8Array, contentType: string | null): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  remove(keys: string[]): Promise<void>;
  /** A URL the browser can download from, or null when the caller must stream bytes. */
  signedDownloadUrl(key: string, filename: string, ttlSeconds?: number): Promise<string | null>;
  /** A URL the browser can PUT the file to, or null when uploads must go through the API. */
  signedUploadUrl(key: string): Promise<string | null>;
}

export const BUCKET = process.env.STORAGE_BUCKET || "followthrough";

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
  const path = (key: string) => {
    assertSafeKey(key);
    const p = join(dir, key);
    if (!resolve(p).startsWith(resolve(dir) + sep)) throw new Error(`Invalid storage key: ${key}`);
    return p;
  };
  return {
    backend: "local",
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
  opts: { url?: string; key?: string; bucket?: string; fetchImpl?: typeof fetch } = {},
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
  let bucketReady: Promise<void> | null = null;
  const ensureBucket = () =>
    (bucketReady ??= (async () => {
      const res = await doFetch(`${base}/bucket`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ id: bucket, name: bucket, public: false }),
      });
      // 409 / "already exists" is the normal case after the first deploy.
      if (!res.ok && res.status !== 409) {
        const text = await res.text();
        if (!/already exists|Duplicate/i.test(text)) {
          bucketReady = null;
          throw new Error(`Could not create storage bucket "${bucket}": ${res.status} ${text.slice(0, 200)}`);
        }
      }
    })());
  const fail = async (what: string, res: Response) => {
    throw new Error(`Storage ${what} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
  return {
    backend: "supabase",
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
      const res = await doFetch(`${base}/object/info/${bucket}/${enc(key)}`, { headers: auth });
      return res.ok;
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
