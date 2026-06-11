import type { Database } from "bun:sqlite";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "../config.ts";
import { nowIso } from "../db.ts";
import { appendEvent } from "../events.ts";
import { insightHandle, ulid } from "../ids.ts";

/**
 * Zoho-shaped CSV export (SPEC.md section 13). One row per (insight,
 * requesting client); rejected/merged insights excluded. The stable Insight ID
 * column lets repeated Zoho imports dedupe.
 */

export const CSV_COLUMNS = [
  "Account Name",
  "Contact Email",
  "Note Title",
  "Note Content",
  "Insight ID",
  "Status",
  "Track",
  "Tags",
  "First Requested",
  "Last Requested",
  "Shipped At",
  "Evidence URL",
] as const;

/** RFC 4180 escaping: quote fields containing commas, quotes, or newlines. */
export function csvEscape(field: string): string {
  if (/[",\r\n]/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

export function toCsv(rows: string[][]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  return lines.join("\r\n") + "\r\n";
}

interface ExportRow {
  insight_id: string;
  title: string;
  body_current: string;
  state: string;
  track: string | null;
  account_name: string;
  contact_email: string | null;
  tags: string | null;
  first_requested_at: string;
  last_requested_at: string;
  shipped_at: string | null;
  evidence_url: string | null;
}

/**
 * One row per (insight, requesting client). Requesters come from
 * insight_requesters; the origin client is included as a requester even when
 * the insights module has not written its requester row yet.
 */
export function buildExportRows(db: Database, clientId: string | null): string[][] {
  const rows = db
    .query(
      `WITH targets AS (
         SELECT r.insight_id, r.client_id, r.first_requested_at, r.last_requested_at
         FROM insight_requesters r
         UNION ALL
         SELECT i.id, i.client_id, i.created_at, i.created_at
         FROM insights i
         WHERE NOT EXISTS (
           SELECT 1 FROM insight_requesters r2
           WHERE r2.insight_id = i.id AND r2.client_id = i.client_id
         )
       )
       SELECT i.id AS insight_id, i.title, i.body_current, i.state, i.track,
              c.name AS account_name,
              (SELECT cc.email FROM client_contacts cc
                WHERE cc.client_id = t.client_id AND cc.email IS NOT NULL
                ORDER BY cc.created_at, cc.id LIMIT 1) AS contact_email,
              (SELECT GROUP_CONCAT(tg.name, ', ')
                 FROM insight_tags itg JOIN tags tg ON tg.id = itg.tag_id
                WHERE itg.insight_id = i.id) AS tags,
              t.first_requested_at, t.last_requested_at,
              m.shipped_at,
              (SELECT ce.url FROM completion_evidence ce
                WHERE ce.insight_id = i.id AND ce.status = 'confirmed' AND ce.url IS NOT NULL
                ORDER BY ce.created_at LIMIT 1) AS evidence_url
       FROM targets t
       JOIN insights i ON i.id = t.insight_id
       JOIN clients c ON c.id = t.client_id
       LEFT JOIN insight_milestones m ON m.insight_id = i.id
       WHERE i.state NOT IN ('rejected','merged')
         AND ($client IS NULL OR t.client_id = $client)
       ORDER BY i.created_at, i.id, c.name`,
    )
    .all({ $client: clientId }) as ExportRow[];

  return rows.map((r) => [
    r.account_name,
    r.contact_email ?? "",
    r.title,
    r.body_current,
    insightHandle(r.insight_id),
    r.state,
    r.track ?? "",
    r.tags ?? "",
    r.first_requested_at,
    r.last_requested_at,
    r.shipped_at ?? "",
    r.evidence_url ?? "",
  ]);
}

export interface ExportResult {
  export_id: string;
  asset_id: string;
  row_count: number;
  storage_ref: string;
  filename: string;
  csv: string;
}

export function generateCsvExport(
  db: Database,
  opts: { clientId?: string | null; requestedBy: string | null; blobDir?: string },
): ExportResult {
  const clientId = opts.clientId ?? null;
  const dataRows = buildExportRows(db, clientId);
  const csv = toCsv(dataRows);

  const exportId = ulid();
  const assetId = ulid();
  const storageRef = `exports/${exportId}.csv`;
  const filename = clientId ? `insights-${clientId}-${exportId}.csv` : `insights-all-${exportId}.csv`;

  // Atomic write: tmp file in the same directory, then rename.
  const blobDir = opts.blobDir ?? env.BLOB_DIR;
  const finalPath = join(blobDir, "exports", `${exportId}.csv`);
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp-${ulid()}`;
  writeFileSync(tmpPath, csv, "utf8");
  renameSync(tmpPath, finalPath);

  const sha256 = new Bun.CryptoHasher("sha256").update(csv).digest("hex");
  const sizeBytes = new TextEncoder().encode(csv).length;
  const t = nowIso();

  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO media_assets (id, kind, storage_backend, storage_ref, filename, content_type,
                                 size_bytes, sha256, uploaded_by, status, created_at)
       VALUES (?, 'csv', 'local', ?, ?, 'text/csv', ?, ?, ?, 'uploaded', ?)`,
    ).run(assetId, storageRef, filename, sizeBytes, sha256, opts.requestedBy, t);
    db.query(
      `INSERT INTO csv_exports (id, client_id, requested_by, filter_json, row_count, asset_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(exportId, clientId, opts.requestedBy, JSON.stringify({ client_id: clientId }), dataRows.length, assetId, t);
    appendEvent(db, {
      actorUserId: opts.requestedBy,
      entityType: "csv_export",
      entityId: exportId,
      eventType: "export.csv_generated",
      payload: { client_id: clientId, row_count: dataRows.length },
    });
  });
  tx();

  return {
    export_id: exportId,
    asset_id: assetId,
    row_count: dataRows.length,
    storage_ref: storageRef,
    filename,
    csv,
  };
}
