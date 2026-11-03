import type { Database } from "../db.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { env } from "../config.ts";
import { nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { hostedMode } from "../config.ts";
import { currentWorkspaceId } from "../hosted/tenancy.ts";
import { storeFor, type BlobStore } from "../storage.ts";

/**
 * Blob storage behind the media_assets abstraction (SPEC.md section 9).
 * Bytes live in the blob store (src/storage.ts: Supabase Storage when deployed,
 * local disk in tests); storage_ref is always a relative key.
 */

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export type MediaKind = "audio" | "video" | "transcript_file" | "screenshot" | "csv" | "other";

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  storage_backend: "local" | "s3" | "supabase";
  storage_ref: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  sha256: string;
  uploaded_by: string | null;
  status: "uploading" | "uploaded" | "failed";
  created_at: string;
}

export const MAX_BLOB_BYTES = 500 * 1024 * 1024;
export const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

/** Upload size caps (SPEC.md section 17). Throws IngestError(413) when exceeded. */
export function assertSizeOk(kind: MediaKind, byteLength: number): void {
  if (byteLength > MAX_BLOB_BYTES) {
    throw new IngestError("File exceeds the 500MB upload limit", 413);
  }
  if (kind === "transcript_file" && byteLength > MAX_TRANSCRIPT_BYTES) {
    throw new IngestError("Transcript text files are capped at 10MB", 413);
  }
}

/** Basename only; separators, traversal dots, and control characters stripped. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : "file";
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface SaveBlobInput {
  kind: MediaKind;
  filename: string;
  contentType: string | null;
  bytes: Uint8Array;
  uploadedBy: string | null;
}

/** A fresh storage key for an upload: "<ulid>/<sanitized name>". */
/**
 * Hosted mode files each workspace's uploads under its id ("<ws>/<ulid>/<name>")
 * and only accepts keys under the caller's own prefix, so a key from another
 * workspace can never be attached to a meeting here.
 */
export function newBlobKey(filename: string): string {
  const ws = hostedMode() ? currentWorkspaceId() : null;
  return `${ws ? `${ws}/` : ""}${ulid()}/${sanitizeFilename(filename)}`;
}

const ULID_PART = "[0-9A-HJKMNP-TV-Z]{26}";
const BLOB_KEY = new RegExp(`^${ULID_PART}\\/[^/]+$`);

/** Whether a client-supplied upload key may be used by the current request. */
export function blobKeyAllowed(key: string): boolean {
  const ws = hostedMode() ? currentWorkspaceId() : null;
  if (!ws) return BLOB_KEY.test(key);
  return key.startsWith(`${ws}/`) && BLOB_KEY.test(key.slice(ws.length + 1));
}

async function insertAsset(
  db: Database,
  store: BlobStore,
  row: { id?: string; kind: MediaKind; key: string; filename: string; contentType: string | null; size: number; sha: string; uploadedBy: string | null },
): Promise<MediaAsset> {
  const id = row.id ?? ulid();
  try {
    await db.query(
      `INSERT INTO media_assets (id, kind, storage_backend, storage_ref, filename, content_type,
                                 size_bytes, sha256, uploaded_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?)`,
    ).run(id, row.kind, store.backend, row.key, row.filename, row.contentType, row.size, row.sha, row.uploadedBy, nowIso());
  } catch (err) {
    // uq_media_assets_storage_ref: two requests raced to register the same upload.
    if (err && typeof err === "object" && (err as { code?: unknown }).code === "23505") {
      throw new IngestError("That upload was already used. Upload the file again.", 409);
    }
    throw err;
  }
  return (await db.query("SELECT * FROM media_assets WHERE id = ?").get(id)) as MediaAsset;
}

/**
 * Store bytes in the blob store and insert the media_assets row. Bytes are
 * treated as opaque binary; nothing is decoded here.
 */
export async function saveBlob(
  db: Database,
  input: SaveBlobInput,
  opts: { blobDir?: string } = {},
): Promise<MediaAsset> {
  assertSizeOk(input.kind, input.bytes.byteLength);
  const store = storeFor(opts);
  const safeName = sanitizeFilename(input.filename);
  const id = ulid();
  const key = `${id}/${safeName}`;
  try {
    await store.put(key, input.bytes, input.contentType);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Invalid storage key")) throw new IngestError("Invalid filename", 400);
    throw e;
  }
  return insertAsset(db, store, {
    id,
    kind: input.kind,
    key,
    filename: safeName,
    contentType: input.contentType,
    size: input.bytes.byteLength,
    sha: sha256Hex(input.bytes),
    uploadedBy: input.uploadedBy,
  });
}

export interface DirectUpload {
  key: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  sha256: string;
}

/**
 * Record a file the browser already uploaded to a signed URL (see
 * POST /api/uploads). The object must exist under a key this server issued.
 * The sha256 is computed by the browser and only used for duplicate detection.
 */
export async function registerUploadedBlob(
  db: Database,
  kind: MediaKind,
  upload: DirectUpload,
  uploadedBy: string | null,
  opts: { blobDir?: string } = {},
): Promise<MediaAsset> {
  if (!blobKeyAllowed(upload.key)) throw new IngestError("Invalid upload key", 400);
  if (!/^[0-9a-f]{64}$/.test(upload.sha256)) throw new IngestError("Invalid sha256 for the uploaded file", 400);
  assertSizeOk(kind, upload.sizeBytes);
  // A key can back one asset only: no replaying someone else's upload.
  if (await db.query("SELECT 1 FROM media_assets WHERE storage_ref = ?").get(upload.key)) {
    throw new IngestError("That upload was already used. Upload the file again.", 409);
  }
  const store = storeFor(opts);
  const size = await store.objectSize(upload.key);
  if (size === null) throw new IngestError("The uploaded file was not found in storage. Upload it again.", 400);
  // Trust the stored object, not the client's numbers: a size that differs from
  // what was declared, or that breaks a limit, is deleted and refused.
  const tooBig = size > MAX_BLOB_BYTES || (store.maxBytes !== null && size > store.maxBytes);
  if (size !== upload.sizeBytes || tooBig) {
    await store.remove([upload.key]).catch(() => {});
    throw new IngestError(
      tooBig ? "The uploaded file is over the size limit." : "The uploaded file does not match what was declared. Upload it again.",
      400,
    );
  }
  return insertAsset(db, store, {
    kind,
    key: upload.key,
    filename: sanitizeFilename(upload.filename),
    contentType: upload.contentType,
    size,
    sha: upload.sha256,
    uploadedBy,
  });
}

/** The asset's bytes, or null if the object is missing. */
export async function readBlob(
  asset: Pick<MediaAsset, "storage_backend" | "storage_ref">,
  opts: { blobDir?: string } = {},
): Promise<Uint8Array | null> {
  return storeFor(opts).get(asset.storage_ref);
}

/**
 * Serve a stored file: a redirect to a short-lived signed URL when the store
 * supports it (Supabase), otherwise the bytes. Null when the object is missing.
 */
export async function blobResponse(
  asset: Pick<MediaAsset, "storage_backend" | "storage_ref" | "filename" | "content_type">,
  opts: { blobDir?: string } = {},
): Promise<Response | null> {
  const store = storeFor(opts);
  const filename = asset.filename.replace(/["\\\r\n]/g, "");
  const signed = await store.signedDownloadUrl(asset.storage_ref, filename);
  if (signed) return new Response(null, { status: 302, headers: { location: signed, "cache-control": "no-store" } });
  const bytes = await store.get(asset.storage_ref);
  if (!bytes) return null;
  return new Response(bytes as BodyInit, {
    headers: {
      "content-type": asset.content_type ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** Absolute filesystem path for a local asset (tests and local dev). */
export function getBlobPath(
  asset: Pick<MediaAsset, "storage_backend" | "storage_ref">,
  blobDir: string = env.BLOB_DIR,
): string {
  if (asset.storage_backend !== "local") {
    throw new IngestError(`Unsupported storage backend: ${asset.storage_backend}`, 500);
  }
  return join(blobDir, asset.storage_ref);
}
