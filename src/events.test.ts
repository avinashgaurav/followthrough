import { describe, expect, test } from "bun:test";
import { openTestDb, nowIso } from "./db.ts";
import { appendEvent, transitionInsight, TransitionError, canTransition } from "./events.ts";
import { ulid } from "./ids.ts";

function seedInsight(db: ReturnType<typeof openTestDb>) {
  const userId = ulid();
  const clientId = ulid();
  const meetingId = ulid();
  const insightId = ulid();
  const t = nowIso();
  db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, 'member', ?)",
  ).run(userId, `u-${userId}@xyz.com`, "Test User", t);
  db.query("INSERT INTO clients (id, name, created_at) VALUES (?, 'Acme', ?)").run(clientId, t);
  db.query(
    "INSERT INTO meetings (id, client_id, seq, meeting_date, uploaded_by, created_at) VALUES (?, ?, 1, ?, ?, ?)",
  ).run(meetingId, clientId, t, userId, t);
  db.query(
    `INSERT INTO insights (id, meeting_id, client_id, item_type, title, body_original, body_current, created_at, updated_at)
     VALUES (?, ?, ?, 'feature_request', 'Test', 'orig', 'orig', ?, ?)`,
  ).run(insightId, meetingId, clientId, t, t);
  return { db, userId, clientId, meetingId, insightId };
}

describe("events table", () => {
  test("is append-only: updates and deletes abort", () => {
    const db = openTestDb();
    appendEvent(db, { actorUserId: null, entityType: "x", entityId: "1", eventType: "t.e" });
    expect(() => db.exec("UPDATE events SET event_type = 'hacked'")).toThrow();
    expect(() => db.exec("DELETE FROM events")).toThrow();
  });

  test("idempotency key dedupes system events", () => {
    const db = openTestDb();
    const a = appendEvent(db, { actorUserId: null, entityType: "release", entityId: "r1", eventType: "release.fetched", idempotencyKey: "rel-1" });
    const b = appendEvent(db, { actorUserId: null, entityType: "release", entityId: "r1", eventType: "release.fetched", idempotencyKey: "rel-1" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });
});

describe("insight state machine", () => {
  test("happy path extracted -> closed records milestones", () => {
    const { db, userId, insightId } = seedInsight(openTestDb());
    const admin = { id: userId, role: "admin" as const };
    transitionInsight(db, { insightId, to: "triaged", actor: admin });
    transitionInsight(db, { insightId, to: "finalized", actor: admin });
    transitionInsight(db, { insightId, to: "ticketed", actor: admin });
    transitionInsight(db, { insightId, to: "shipped", actor: admin });
    transitionInsight(db, { insightId, to: "client_notified", actor: admin });
    transitionInsight(db, { insightId, to: "closed", actor: admin });

    const m = db.query("SELECT * FROM insight_milestones WHERE insight_id = ?").get(insightId) as Record<string, string | null>;
    expect(m.finalized_at).toBeTruthy();
    expect(m.ticketed_at).toBeTruthy();
    expect(m.shipped_at).toBeTruthy();
    expect(m.notified_at).toBeTruthy();
    expect(m.closed_at).toBeTruthy();
  });

  test("illegal jumps are blocked", () => {
    const { db, userId, insightId } = seedInsight(openTestDb());
    const admin = { id: userId, role: "admin" as const };
    expect(() => transitionInsight(db, { insightId, to: "shipped", actor: admin })).toThrow(TransitionError);
    expect(() => transitionInsight(db, { insightId, to: "client_notified", actor: admin })).toThrow(TransitionError);
  });

  test("rejected requires a reason", () => {
    const { db, userId, insightId } = seedInsight(openTestDb());
    const admin = { id: userId, role: "admin" as const };
    expect(() => transitionInsight(db, { insightId, to: "rejected", actor: admin })).toThrow(/reason/);
    transitionInsight(db, { insightId, to: "rejected", actor: admin, payload: { reason: "duplicate noise" } });
  });

  test("merged requires a target and records it", () => {
    const seeded = seedInsight(openTestDb());
    const { db, userId, insightId, meetingId, clientId } = seeded;
    const admin = { id: userId, role: "admin" as const };
    expect(() => transitionInsight(db, { insightId, to: "merged", actor: admin })).toThrow(/merged_into/);

    const survivorId = ulid();
    const t = nowIso();
    db.query(
      `INSERT INTO insights (id, meeting_id, client_id, item_type, title, body_original, body_current, created_at, updated_at)
       VALUES (?, ?, ?, 'feature_request', 'Canonical', 'orig', 'orig', ?, ?)`,
    ).run(survivorId, meetingId, clientId, t, t);

    transitionInsight(db, { insightId, to: "merged", actor: admin, payload: { merged_into: survivorId } });
    const row = db.query("SELECT merged_into_insight_id FROM insights WHERE id = ?").get(insightId) as { merged_into_insight_id: string };
    expect(row.merged_into_insight_id).toBe(survivorId);

    // merging into a nonexistent insight is rejected by the schema
    const ghostId = ulid();
    db.query(
      `INSERT INTO insights (id, meeting_id, client_id, item_type, title, body_original, body_current, created_at, updated_at)
       VALUES (?, ?, ?, 'complaint', 'Another', 'orig', 'orig', ?, ?)`,
    ).run(ghostId, meetingId, clientId, t, t);
    expect(() =>
      transitionInsight(db, { insightId: ghostId, to: "merged", actor: admin, payload: { merged_into: "DOES-NOT-EXIST" } }),
    ).toThrow();
  });

  test("non-admin demotion of finalized insight is blocked", () => {
    const { db, userId, insightId } = seedInsight(openTestDb());
    const member = { id: userId, role: "member" as const };
    // member with no assignment can triage (who: any)
    transitionInsight(db, { insightId, to: "triaged", actor: member });
    // but finalize requires assignee or admin, and nobody is assigned
    expect(() => transitionInsight(db, { insightId, to: "finalized", actor: member })).toThrow(/not allowed/);
  });

  test("terminal states have no exits", () => {
    expect(canTransition("rejected", "triaged")).toBeNull();
    expect(canTransition("merged", "extracted")).toBeNull();
  });
});
