import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { IngestError, registerUploadedBlob, sha256Hex } from "./media.ts";
import { supabaseStore } from "../storage.ts";

const blobDir = mkdtempSync(join(tmpdir(), "ie-upload-test-"));
afterAll(() => rmSync(blobDir, { recursive: true, force: true }));

/** Put bytes where a direct upload would have left them; returns the key. */
function uploaded(bytes: Uint8Array): string {
  const key = `${ulid()}/call.webm`;
  mkdirSync(join(blobDir, key.split("/")[0]!), { recursive: true });
  writeFileSync(join(blobDir, key), bytes);
  return key;
}

async function seedUser() {
  const db = await openTestDb();
  const userId = ulid();
  await db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'U', 'member', ?)").run(userId, `${userId}@tallyhall.com`, nowIso());
  return { db, userId };
}

describe("registerUploadedBlob", () => {
  const bytes = new TextEncoder().encode("twelve bytes");

  test("records the asset with the stored object's real size", async () => {
    const { db, userId } = await seedUser();
    const key = uploaded(bytes);
    const a = await registerUploadedBlob(db, "audio", { key, filename: "call.webm", contentType: "audio/webm", sizeBytes: bytes.length, sha256: sha256Hex(bytes) }, userId, { blobDir });
    expect(a.size_bytes).toBe(12);
    expect(a.storage_ref).toBe(key);
  });

  test("a size that differs from the declared one is deleted and refused", async () => {
    const { db, userId } = await seedUser();
    const key = uploaded(bytes);
    const err = await registerUploadedBlob(db, "audio", { key, filename: "call.webm", contentType: "audio/webm", sizeBytes: 5, sha256: sha256Hex(bytes) }, userId, { blobDir }).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).status).toBe(400);
    expect(existsSync(join(blobDir, key))).toBe(false);
    expect(await db.query("SELECT COUNT(*) AS n FROM media_assets").get()).toEqual({ n: 0 });
  });

  test("a key cannot be registered twice (replay)", async () => {
    const { db, userId } = await seedUser();
    const key = uploaded(bytes);
    const upload = { key, filename: "call.webm", contentType: "audio/webm", sizeBytes: bytes.length, sha256: sha256Hex(bytes) };
    await registerUploadedBlob(db, "audio", upload, userId, { blobDir });
    const err = await registerUploadedBlob(db, "audio", upload, userId, { blobDir }).catch((e) => e);
    expect((err as IngestError).status).toBe(409);
  });

  test("a key the server never issued is refused", async () => {
    const { db, userId } = await seedUser();
    const err = await registerUploadedBlob(db, "audio", { key: "../../etc/passwd", filename: "x", contentType: null, sizeBytes: 1, sha256: "a".repeat(64) }, userId, { blobDir }).catch((e) => e);
    expect((err as IngestError).status).toBe(400);
  });
});

describe("Supabase bucket limits", () => {
  test("creates the bucket with a size limit and MIME list, or updates an existing one", async () => {
    const calls: Array<{ url: string; method: string; body: any }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/bucket") && init.method === "POST") return new Response('{"message":"The resource already exists"}', { status: 409 });
      if (url.includes("/bucket/") && init.method === "PUT") return new Response('{"message":"ok"}');
      return new Response(JSON.stringify({ url: "/object/upload/sign/b/k?token=t" }));
    }) as unknown as typeof fetch;
    const store = supabaseStore({ url: "https://x.supabase.co", key: "k", bucket: "b", fetchImpl, maxBytes: 1234 });
    await store.signedUploadUrl(`${ulid()}/a.webm`);
    expect(calls[0]!.body).toMatchObject({ public: false, file_size_limit: 1234 });
    expect(calls[0]!.body.allowed_mime_types).toContain("audio/*");
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.body).toMatchObject({ file_size_limit: 1234 });
    expect(store.maxBytes).toBe(1234);
  });
});

describe("media_assets storage_ref", () => {
  test("is unique (purged markers excepted)", async () => {
    const { db, userId } = await seedUser();
    const insert = (id: string, ref: string) =>
      db.query(
        `INSERT INTO media_assets (id, kind, storage_backend, storage_ref, filename, sha256, uploaded_by, created_at)
         VALUES (?, 'audio', 'local', ?, 'a.webm', 'x', ?, ?)`,
      ).run(id, ref, userId, nowIso());
    await insert(ulid(), "K/a.webm");
    const err = await insert(ulid(), "K/a.webm").then(() => null, (e) => e);
    expect((err as { code?: string }).code).toBe("23505");
    await insert(ulid(), "[purged]");
    await insert(ulid(), "[purged]"); // many purged rows are fine
  });
});

describe("orphan upload sweep", () => {
  test("deletes old unregistered uploads; keeps registered, recent and export files", async () => {
    const { localStore, sweepOrphanUploads, ulidTime } = await import("../storage.ts");
    const dir = mkdtempSync(join(tmpdir(), "ie-sweep-"));
    try {
      const store = localStore(dir);
      const { db, userId } = await seedUser();
      const now = Date.parse("2026-11-04T12:00:00Z");
      const old = ulid(now - 2 * 86_400_000);
      const fresh = ulid(now - 3_600_000);
      expect(ulidTime(old)).toBe(now - 2 * 86_400_000);
      const put = (k: string) => store.put(k, new TextEncoder().encode("x"), null);
      await put(`${old}/orphan.webm`);
      await put(`${old}/kept.webm`);
      await put(`${fresh}/in-progress.webm`);
      await put("exports/e.csv");
      await db.query(
        `INSERT INTO media_assets (id, kind, storage_backend, storage_ref, filename, sha256, uploaded_by, created_at)
         VALUES (?, 'audio', 'local', ?, 'kept.webm', 'x', ?, ?)`,
      ).run(ulid(), `${old}/kept.webm`, userId, nowIso());

      expect(await sweepOrphanUploads(db, store, now)).toBe(1);
      expect(existsSync(join(dir, old, "orphan.webm"))).toBe(false);
      expect(existsSync(join(dir, old, "kept.webm"))).toBe(true);
      expect(existsSync(join(dir, fresh, "in-progress.webm"))).toBe(true);
      expect(existsSync(join(dir, "exports", "e.csv"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
