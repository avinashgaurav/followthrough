import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { route, json } from "../router.ts";
import { getDb } from "../db.ts";
import { env } from "../config.ts";
import { generateCsvExport } from "./service.ts";

const ExportBody = z.object({
  client_id: z.string().min(1).optional(),
});

route("POST", "/api/exports/csv", "user", async (req, user) => {
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {}; // empty body = all clients
  }
  const parsed = ExportBody.safeParse(raw ?? {});
  if (!parsed.success) return json({ error: "invalid body", issues: parsed.error.issues }, 400);

  const db = getDb();
  if (parsed.data.client_id) {
    const exists = db.query("SELECT id FROM clients WHERE id = ?").get(parsed.data.client_id);
    if (!exists) return json({ error: "client not found" }, 404);
  }

  const result = generateCsvExport(db, {
    clientId: parsed.data.client_id ?? null,
    requestedBy: user!.id,
  });
  return json(
    {
      id: result.export_id,
      row_count: result.row_count,
      filename: result.filename,
      download_url: `/api/exports/${result.export_id}/download`,
    },
    201,
  );
});

route("GET", "/api/exports", "user", () => {
  const rows = getDb()
    .query(
      `SELECT x.id, x.client_id, c.name AS client_name, x.requested_by,
              u.name AS requested_by_name, x.row_count, x.created_at,
              a.filename, a.size_bytes
       FROM csv_exports x
       LEFT JOIN clients c ON c.id = x.client_id
       LEFT JOIN users u ON u.id = x.requested_by
       LEFT JOIN media_assets a ON a.id = x.asset_id
       ORDER BY x.created_at DESC, x.id DESC`,
    )
    .all();
  return json({ exports: rows });
});

route("GET", "/api/exports/:id/download", "user", (_req, _user, params) => {
  const row = getDb()
    .query(
      `SELECT a.storage_ref, a.filename FROM csv_exports x
       JOIN media_assets a ON a.id = x.asset_id
       WHERE x.id = ?`,
    )
    .get(params.id!) as { storage_ref: string; filename: string } | null;
  if (!row) return json({ error: "export not found" }, 404);

  const path = join(env.BLOB_DIR, row.storage_ref);
  if (!existsSync(path)) return json({ error: "export file missing" }, 410);
  return new Response(Bun.file(path), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${row.filename}"`,
    },
  });
});
