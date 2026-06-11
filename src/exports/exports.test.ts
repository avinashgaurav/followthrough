import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nowIso, openTestDb } from "../db.ts";
import { appendEvent } from "../events.ts";
import { insightHandle, ulid } from "../ids.ts";
import { CSV_COLUMNS, csvEscape, generateCsvExport, toCsv } from "./service.ts";

const D = (day: string) => `${day}T00:00:00.000Z`;

const EXPECTED_HEADER =
  "Account Name,Contact Email,Note Title,Note Content,Insight ID,Status,Track,Tags," +
  "First Requested,Last Requested,Shipped At,Evidence URL";

function seedUser(db: Database): string {
  const id = ulid();
  db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'Tester', 'member', ?)",
  ).run(id, `${id}@xyz.com`, nowIso());
  return id;
}

function seedClient(db: Database, name: string): string {
  const id = ulid();
  db.query("INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)").run(id, name, nowIso());
  return id;
}

function seedMeeting(db: Database, clientId: string, seq: number): string {
  const id = ulid();
  db.query(
    "INSERT INTO meetings (id, client_id, seq, meeting_date, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, clientId, seq, D("2026-06-01"), D("2026-06-01"));
  return id;
}

function seedInsight(
  db: Database,
  opts: { meetingId: string; clientId: string; title: string; state?: string; body?: string; createdAt?: string },
): string {
  const id = ulid();
  const t = opts.createdAt ?? nowIso();
  db.query(
    `INSERT INTO insights (id, meeting_id, client_id, item_type, title, body_original, body_current, state, created_at, updated_at)
     VALUES (?, ?, ?, 'feature_request', ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.meetingId, opts.clientId, opts.title, opts.body ?? "body", opts.body ?? "body", opts.state ?? "finalized", t, t);
  return id;
}

function setup() {
  const db = openTestDb();
  const user = seedUser(db);
  const acme = seedClient(db, "Acme");
  const beta = seedClient(db, "Beta");
  db.query(
    "INSERT INTO client_contacts (id, client_id, name, email, created_at) VALUES (?, ?, 'Alice', 'alice@acme.com', ?)",
  ).run(ulid(), acme, nowIso());
  const meeting = seedMeeting(db, acme, 1);

  // canonical insight requested by both clients; title exercises CSV escaping
  const canonical = seedInsight(db, {
    meetingId: meeting,
    clientId: acme,
    title: 'Faster exports, "now"',
    body: "line1\nline2",
    createdAt: D("2026-06-01"),
  });
  db.query(
    "INSERT INTO insight_requesters (insight_id, client_id, first_requested_at, last_requested_at) VALUES (?, ?, ?, ?)",
  ).run(canonical, acme, D("2026-06-01"), D("2026-06-03"));
  db.query(
    "INSERT INTO insight_requesters (insight_id, client_id, first_requested_at, last_requested_at) VALUES (?, ?, ?, ?)",
  ).run(canonical, beta, D("2026-06-02"), D("2026-06-02"));

  const rejected = seedInsight(db, {
    meetingId: meeting,
    clientId: acme,
    title: "Rejected thing",
    state: "rejected",
    createdAt: D("2026-06-02"),
  });

  // origin-only insight: no requester rows, must still export one row for Beta
  const meetingB = seedMeeting(db, beta, 1);
  const originOnly = seedInsight(db, {
    meetingId: meetingB,
    clientId: beta,
    title: "Origin only",
    createdAt: D("2026-06-03"),
  });

  return { db, user, acme, beta, canonical, rejected, originOnly };
}

describe("csvEscape", () => {
  test("quotes fields with commas, quotes, newlines; doubles inner quotes", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });

  test("header line is exactly the Zoho-shaped column list", () => {
    expect(CSV_COLUMNS.join(",")).toBe(EXPECTED_HEADER);
    expect(toCsv([]).split(/\r\n/)[0]).toBe(EXPECTED_HEADER);
  });
});

describe("generateCsvExport", () => {
  test("one row per (insight, requester client); escapes; excludes rejected; logs everything", () => {
    const { db, user, canonical } = setup();
    const blobDir = mkdtempSync(join(tmpdir(), "ie-exports-"));

    const result = generateCsvExport(db, { requestedBy: user, blobDir });

    const lines = result.csv.split(/\r\n/);
    expect(lines[0]).toBe(EXPECTED_HEADER);
    expect(result.row_count).toBe(3); // canonical x2 requesters + origin-only x1
    expect(result.csv).toContain('"Faster exports, ""now"""'); // comma + quote escaping
    expect(result.csv).toContain('"line1\nline2"'); // newline kept inside a quoted field
    expect(result.csv).not.toContain("Rejected thing");
    expect(result.csv).toContain(insightHandle(canonical));
    expect(result.csv).toContain("alice@acme.com");
    expect(result.csv).toContain(D("2026-06-01")); // first requested
    expect(result.csv).toContain(D("2026-06-03")); // last requested

    // file written atomically under <blobDir>/exports/<id>.csv
    const onDisk = readFileSync(join(blobDir, "exports", `${result.export_id}.csv`), "utf8");
    expect(onDisk).toBe(result.csv);

    // bookkeeping rows
    const asset = db.query("SELECT * FROM media_assets WHERE id = ?").get(result.asset_id) as Record<string, unknown>;
    expect(asset.kind).toBe("csv");
    expect(asset.storage_ref).toBe(`exports/${result.export_id}.csv`);
    expect(asset.sha256).toBe(new Bun.CryptoHasher("sha256").update(result.csv).digest("hex"));

    const exportRow = db.query("SELECT * FROM csv_exports WHERE id = ?").get(result.export_id) as Record<string, unknown>;
    expect(exportRow.row_count).toBe(3);
    expect(exportRow.requested_by).toBe(user);
    expect(exportRow.client_id).toBeNull();

    const event = db
      .query("SELECT * FROM events WHERE event_type = 'export.csv_generated' AND entity_id = ?")
      .get(result.export_id) as { payload_json: string; actor_user_id: string };
    expect(event).toBeTruthy();
    expect(event.actor_user_id).toBe(user);
    expect(JSON.parse(event.payload_json)).toEqual({ client_id: null, row_count: 3 });
  });

  test("per-client filter exports only that requester's rows", () => {
    const { db, user, acme, beta } = setup();
    const blobDir = mkdtempSync(join(tmpdir(), "ie-exports-"));

    const forBeta = generateCsvExport(db, { clientId: beta, requestedBy: user, blobDir });
    expect(forBeta.row_count).toBe(2); // canonical (Beta requester) + origin-only
    expect(forBeta.csv).toContain("Origin only");
    expect(forBeta.csv).not.toContain("alice@acme.com");

    const forAcme = generateCsvExport(db, { clientId: acme, requestedBy: user, blobDir });
    expect(forAcme.row_count).toBe(1); // canonical only; rejected excluded
    expect(forAcme.csv).toContain("alice@acme.com");
  });

  test("shipped at and evidence url populate from milestones and confirmed evidence", () => {
    const { db, user, canonical } = setup();
    const blobDir = mkdtempSync(join(tmpdir(), "ie-exports-"));

    appendEvent(db, {
      actorUserId: user,
      entityType: "insight",
      entityId: canonical,
      eventType: "insight.state_changed",
      fromState: "finalized",
      toState: "shipped",
      occurredAt: D("2026-06-07"),
    });
    db.query("UPDATE insights SET state = 'shipped' WHERE id = ?").run(canonical);
    db.query(
      `INSERT INTO completion_evidence (id, insight_id, kind, url, confidence, status, created_at)
       VALUES (?, ?, 'release_match', 'https://github.com/XYZ/XYZ/releases/v1.20.0', 100, 'confirmed', ?)`,
    ).run(ulid(), canonical, nowIso());

    const result = generateCsvExport(db, { requestedBy: user, blobDir });
    expect(result.csv).toContain(D("2026-06-07"));
    expect(result.csv).toContain("https://github.com/XYZ/XYZ/releases/v1.20.0");
  });
});
