import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import type { AuthedUser } from "../auth.ts";
import { createMeeting } from "../ingest/service.ts";
import { getBlobPath, type MediaAsset } from "../ingest/media.ts";
import { syncInsightFts } from "../insights/search.ts";
import { handlePurgeMeeting, purgeMeeting } from "./service.ts";

const blobDir = mkdtempSync(join(tmpdir(), "ie-retention-test-"));
afterAll(() => rmSync(blobDir, { recursive: true, force: true }));

function seedAdmin(db: Database): AuthedUser {
  const id = ulid();
  db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'Admin', 'admin', ?)").run(
    id,
    `admin-${id.slice(-4)}@xyz.com`,
    nowIso(),
  );
  return { id, email: `admin-${id.slice(-4)}@xyz.com`, name: "Admin", role: "admin" };
}

function seedClient(db: Database, name = "Acme"): string {
  const id = ulid();
  db.query("INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)").run(id, name, nowIso());
  return id;
}

interface Fixture {
  db: Database;
  admin: AuthedUser;
  clientId: string;
  meetingId: string;
  insightId: string;
  mentionId: string;
  otherMeetingId: string;
  otherMentionId: string;
  assetIds: string[];
}

const QUOTE = "we desperately need the cost report by region";

/** Meeting with audio + transcript file (two blobs), an extraction run, a finalized insight, and a mention in a second meeting. */
async function buildFixture(): Promise<Fixture> {
  const db = openTestDb();
  const admin = seedAdmin(db);
  const clientId = seedClient(db);
  const t = nowIso();

  const created = await createMeeting(
    db,
    admin,
    {
      client_id: clientId,
      meeting_date: "2026-06-01",
      title: "QBR call",
      source: "manual",
      transcriptFile: {
        filename: "qbr.txt",
        contentType: "text/plain",
        bytes: new TextEncoder().encode(`Client CTO: ${QUOTE}. Thanks all.`),
      },
      audioFile: {
        filename: "qbr.webm",
        contentType: "audio/webm",
        bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]),
      },
    },
    { blobDir },
  );
  const meetingId = created.meeting.id;
  const transcriptId = created.transcript_id!;
  const assetIds = [created.audio_asset_id!, created.transcript_asset_id!];

  // extraction provenance chain: insight -> extraction_run -> transcript
  const runId = ulid();
  db.query(
    `INSERT INTO extraction_runs (id, meeting_id, transcript_id, llm_model, prompt_version, status, started_at, finished_at)
     VALUES (?, ?, ?, 'mock', 'v1', 'succeeded', ?, ?)`,
  ).run(runId, meetingId, transcriptId, t, t);

  const insightId = ulid();
  db.query(
    `INSERT INTO insights (id, meeting_id, client_id, extraction_run_id, item_type, track, title,
                           body_original, body_current, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'feature_request', 'engineering', 'Cost report by region', 'b', 'b', 'finalized', ?, ?)`,
  ).run(insightId, meetingId, clientId, runId, t, t);

  const mentionId = ulid();
  db.query(
    `INSERT INTO insight_mentions (id, insight_id, meeting_id, client_id, quote, speaker, char_start, char_end, created_at)
     VALUES (?, ?, ?, ?, ?, 'Client CTO', 12, 58, ?)`,
  ).run(mentionId, insightId, meetingId, clientId, QUOTE, t);

  // the same ask repeated in a later meeting: that quote must survive this purge
  const otherMeetingId = ulid();
  db.query(
    "INSERT INTO meetings (id, client_id, seq, meeting_date, created_at) VALUES (?, ?, 2, '2026-06-05', ?)",
  ).run(otherMeetingId, clientId, t);
  const otherMentionId = ulid();
  db.query(
    `INSERT INTO insight_mentions (id, insight_id, meeting_id, client_id, quote, speaker, char_start, char_end, created_at)
     VALUES (?, ?, ?, ?, 'still waiting on the region report', 'Client CTO', 5, 40, ?)`,
  ).run(otherMentionId, insightId, otherMeetingId, clientId, t);

  // search caches that must stop serving purged content
  db.query("INSERT INTO fts_transcripts (content, meeting_id, content_rowid) VALUES (?, ?, ?)").run(
    `Client CTO: ${QUOTE}. Thanks all.`,
    meetingId,
    transcriptId,
  );
  syncInsightFts(db, insightId);

  return { db, admin, clientId, meetingId, insightId, mentionId, otherMeetingId, otherMentionId, assetIds };
}

describe("retention purge", () => {
  test("purge removes transcript, blob files, and quotes but keeps insights and events", async () => {
    const f = await buildFixture();
    const paths = f.assetIds.map((id) =>
      getBlobPath(f.db.query("SELECT * FROM media_assets WHERE id = ?").get(id) as MediaAsset, blobDir),
    );
    for (const p of paths) expect(existsSync(p)).toBe(true);

    const result = purgeMeeting(f.db, f.admin, f.meetingId, "client requested deletion", { blobDir });
    expect(result).not.toBeNull();
    expect(result!.already_purged).toBe(false);
    expect(result!.transcripts_deleted).toBe(1);
    expect(result!.quotes_purged).toBe(1);
    expect(result!.assets_purged).toBe(2);
    expect(result!.insights_kept).toBe(1);

    // transcript rows gone, including the FTS mirror
    expect(f.db.query("SELECT COUNT(*) AS n FROM transcripts WHERE meeting_id = ?").get(f.meetingId)).toEqual({ n: 0 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM fts_transcripts WHERE meeting_id = ?").get(f.meetingId)).toEqual({ n: 0 });

    // blob files gone from disk; media rows marked failed with a purged ref
    for (const p of paths) expect(existsSync(p)).toBe(false);
    for (const id of f.assetIds) {
      const a = f.db.query("SELECT status, storage_ref FROM media_assets WHERE id = ?").get(id) as MediaAsset;
      expect(a.status).toBe("failed");
      expect(a.storage_ref).toBe("[purged]");
    }

    // this meeting's quote is anonymized in place: row survives, content does not
    const mention = f.db
      .query("SELECT quote, char_start, char_end FROM insight_mentions WHERE id = ?")
      .get(f.mentionId) as { quote: string; char_start: number | null; char_end: number | null };
    expect(mention.quote).toBe("[purged]");
    expect(mention.char_start).toBeNull();
    expect(mention.char_end).toBeNull();

    // provenance counts survive (UPDATE, not DELETE) and other meetings' quotes are untouched
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM insight_mentions WHERE insight_id = ?").get(f.insightId),
    ).toEqual({ n: 2 });
    const other = f.db
      .query("SELECT quote FROM insight_mentions WHERE id = ?")
      .get(f.otherMentionId) as { quote: string };
    expect(other.quote).toBe("still waiting on the region report");

    // the insight itself survives in its prior state, detached from its extraction run
    const insight = f.db
      .query("SELECT state, extraction_run_id FROM insights WHERE id = ?")
      .get(f.insightId) as { state: string; extraction_run_id: string | null };
    expect(insight.state).toBe("finalized");
    expect(insight.extraction_run_id).toBeNull();

    // search index no longer serves the purged quote
    const fts = f.db
      .query("SELECT quotes FROM fts_insights WHERE insight_id = ?")
      .get(f.insightId) as { quotes: string };
    expect(fts.quotes).not.toContain(QUOTE);
    expect(fts.quotes).toContain("still waiting");

    // meeting is soft-deleted, never hard-deleted
    const meeting = f.db
      .query("SELECT deleted_at FROM meetings WHERE id = ?")
      .get(f.meetingId) as { deleted_at: string | null };
    expect(meeting.deleted_at).not.toBeNull();

    // the event trail survives and the purge itself is recorded
    const uploaded = f.db
      .query("SELECT COUNT(*) AS n FROM events WHERE entity_id = ? AND event_type = 'meeting.uploaded'")
      .get(f.meetingId) as { n: number };
    expect(uploaded.n).toBe(1);
    const purged = f.db
      .query("SELECT payload_json FROM events WHERE entity_id = ? AND event_type = 'meeting.purged'")
      .get(f.meetingId) as { payload_json: string };
    expect(JSON.parse(purged.payload_json).reason).toBe("client requested deletion");
  });

  test("purging twice is safe: second call reports already_purged", async () => {
    const f = await buildFixture();
    purgeMeeting(f.db, f.admin, f.meetingId, undefined, { blobDir });
    const second = purgeMeeting(f.db, f.admin, f.meetingId, undefined, { blobDir });
    expect(second!.already_purged).toBe(true);
    // still exactly one purge event
    const n = f.db
      .query("SELECT COUNT(*) AS n FROM events WHERE entity_id = ? AND event_type = 'meeting.purged'")
      .get(f.meetingId) as { n: number };
    expect(n.n).toBe(1);
  });

  test("handler: 404 for unknown meeting, JSON reason accepted, empty body accepted", async () => {
    const f = await buildFixture();

    const missing = await handlePurgeMeeting(
      f.db,
      f.admin,
      "NOPE",
      new Request("http://localhost/api/meetings/NOPE", { method: "DELETE" }),
      { blobDir },
    );
    expect(missing.status).toBe(404);

    const bad = await handlePurgeMeeting(
      f.db,
      f.admin,
      f.meetingId,
      new Request(`http://localhost/api/meetings/${f.meetingId}`, { method: "DELETE", body: "not json" }),
      { blobDir },
    );
    expect(bad.status).toBe(400);

    const ok = await handlePurgeMeeting(
      f.db,
      f.admin,
      f.meetingId,
      new Request(`http://localhost/api/meetings/${f.meetingId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "GDPR request" }),
      }),
      { blobDir },
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { already_purged: boolean };
    expect(body.already_purged).toBe(false);

    // empty body works too (reason optional) and is idempotent on a purged meeting
    const again = await handlePurgeMeeting(
      f.db,
      f.admin,
      f.meetingId,
      new Request(`http://localhost/api/meetings/${f.meetingId}`, { method: "DELETE" }),
      { blobDir },
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { already_purged: boolean }).already_purged).toBe(true);
  });
});
