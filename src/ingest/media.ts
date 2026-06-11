import type { Database } from "bun:sqlite";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { env } from "../config.ts";
import { nowIso } from "../db.ts";
import { ulid } from "../ids.ts";

/**
 * Blob storage behind the media_assets abstraction (SPEC.md section 9).
 * v1 backend is local disk; storage_ref is always a relative key so an S3
 * migration is a per-row backend flip.
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
  storage_backend: "local" | "s3";
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
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export interface SaveBlobInput {
  kind: MediaKind;
  filename: string;
  contentType: string | null;
  bytes: Uint8Array;
  uploadedBy: string | null;
}

/**
 * Write bytes to the blob dir atomically (tmp file then rename) and insert the
 * media_assets row. Bytes are treated as opaque binary; nothing is decoded here.
 */
export async function saveBlob(
  db: Database,
  input: SaveBlobInput,
  opts: { blobDir?: string } = {},
): Promise<MediaAsset> {
  assertSizeOk(input.kind, input.bytes.byteLength);

  const blobDir = opts.blobDir ?? env.BLOB_DIR;
  const id = ulid();
  const safeName = sanitizeFilename(input.filename);
  const storageRef = `${id}/${safeName}`;
  const finalPath = join(blobDir, storageRef);
  // belt and braces: the sanitized key must resolve inside the blob dir
  if (!resolve(finalPath).startsWith(resolve(blobDir) + sep)) {
    throw new IngestError("Invalid filename", 400);
  }

  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.${ulid().slice(-8)}.tmp`;
  await Bun.write(tmpPath, input.bytes);
  renameSync(tmpPath, finalPath);

  const sha = sha256Hex(input.bytes);
  db.query(
    `INSERT INTO media_assets (id, kind, storage_backend, storage_ref, filename, content_type,
                               size_bytes, sha256, uploaded_by, status, created_at)
     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, 'uploaded', ?)`,
  ).run(
    id,
    input.kind,
    storageRef,
    safeName,
    input.contentType,
    input.bytes.byteLength,
    sha,
    input.uploadedBy,
    nowIso(),
  );
  return db.query("SELECT * FROM media_assets WHERE id = ?").get(id) as MediaAsset;
}

/** Absolute filesystem path for a local asset. */
export function getBlobPath(
  asset: Pick<MediaAsset, "storage_backend" | "storage_ref">,
  blobDir: string = env.BLOB_DIR,
): string {
  if (asset.storage_backend !== "local") {
    throw new IngestError(`Unsupported storage backend: ${asset.storage_backend}`, 500);
  }
  return join(blobDir, asset.storage_ref);
}
