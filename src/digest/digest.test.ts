import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { nowIso, openTestDb } from "../db.ts";
import { appendEvent } from "../events.ts";
import { insightHandle, ulid } from "../ids.ts";
import { DIGEST_SECTIONS, buildDigest, maybeSendDigest, sendDigest, type FetchLike } from "./digest.ts";

function seedUser(db: Database, name = "Tester"): string {
  const id = ulid();
  db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, 'member', ?)",
  ).run(id, `${id}@xyz.com`, name, nowIso());
  return id;
}

function seedClient(db: Database, name: string): string {
  const id = ulid();
  db.query("INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)").run(id, name, nowIso());
  return id;
}

function seedMeeting(db: Database, clientId: string, seq: number): string {
  const id = ulid();
  const t = nowIso();
  db.query(
    "INSERT INTO meetings (id, client_id, seq, meeting_date, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, clientId, seq, t, t);
  return id;
}

function seedInsight(
  db: Database,
  opts: { meetingId: string; clientId: string; title: string; track?: string; state?: string; createdAt?: string },
): string {
  const id = ulid();
  const t = opts.createdAt ?? nowIso();
  db.query(
    `INSERT INTO insights (id, meeting_id, client_id, item_type, track, title, body_original, body_current, state, created_at, updated_at)
     VALUES (?, ?, ?, 'feature_request', ?, ?, 'orig', 'orig', ?, ?, ?)`,
  ).run(id, opts.meetingId, opts.clientId, opts.track ?? null, opts.title, opts.state ?? "extracted", t, t);
  return id;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function transition(db: Database, insightId: string, actor: string, to: string, at: string, from?: string): void {
  appendEvent(db, {
    actorUserId: actor,
    entityType: "insight",
    entityId: insightId,
    eventType: "insight.state_changed",
    fromState: from,
    toState: to,
    occurredAt: at,
  });
  db.query("UPDATE insights SET state = ? WHERE id = ?").run(to, insightId);
}

function seedDigestScenario() {
  const db = openTestDb();
  const u = seedUser(db, "Asha");
  const cA = seedClient(db, "Acme");
  const cB = seedClient(db, "Beta");
  const m = seedMeeting(db, cA, 1);

  // new this week + awaiting finalization
  const fresh = seedInsight(db, { meetingId: m, clientId: cA, title: "Fresh ask", track: "engineering", createdAt: daysAgo(1) });
  transition(db, fresh, u, "extracted", daysAgo(1));

  // stuck: extracted 10 days ago (threshold 3)
  const stuck = seedInsight(db, { meetingId: m, clientId: cA, title: "Stuck ask", createdAt: daysAgo(10) });
  transition(db, stuck, u, "extracted", daysAgo(10));

  // shipped 2 days ago with confirmed evidence; still awaiting the client email
  const shipped = seedInsight(db, { meetingId: m, clientId: cA, title: "Shipped ask", createdAt: daysAgo(9) });
  transition(db, shipped, u, "finalized", daysAgo(5));
  transition(db, shipped, u, "shipped", daysAgo(2), "finalized");
  db.query(
    `INSERT INTO completion_evidence (id, insight_id, kind, url, confidence, status, created_at)
     VALUES (?, ?, 'release_match', 'https://github.com/XYZ/XYZ/releases/v1.20.0', 100, 'confirmed', ?)`,
  ).run(ulid(), shipped, nowIso());

  // top ask: requested by two clients
  const popular = seedInsight(db, { meetingId: m, clientId: cA, title: "Popular ask", createdAt: daysAgo(3) });
  for (const c of [cA, cB]) {
    db.query(
      "INSERT INTO insight_requesters (insight_id, client_id, first_requested_at, last_requested_at) VALUES (?, ?, ?, ?)",
    ).run(popular, c, daysAgo(3), daysAgo(1));
  }

  return { db, u, fresh, stuck, shipped, popular };
}

describe("buildDigest", () => {
  test("contains all six section headers and the seeded items; no em-dashes", () => {
    const { db, fresh, stuck, shipped, popular } = seedDigestScenario();
    const md = buildDigest(db);

    for (const header of DIGEST_SECTIONS) expect(md).toContain(header);
    expect(DIGEST_SECTIONS).toHaveLength(6);

    expect(md).toContain(`${insightHandle(fresh)} Fresh ask`);
    expect(md).toContain(`${insightHandle(stuck)} Stuck ask`);
    expect(md).toContain(`${insightHandle(shipped)} Shipped ask`);
    expect(md).toContain("https://github.com/XYZ/XYZ/releases/v1.20.0");
    expect(md).toContain(`${insightHandle(popular)} Popular ask (requested by 2 clients)`);
    expect(md).not.toContain("—"); // brand rule: no em-dashes
  });

  test("empty database still renders every section", () => {
    const db = openTestDb();
    const md = buildDigest(db);
    for (const header of DIGEST_SECTIONS) expect(md).toContain(header);
    expect(md).toContain("None.");
  });
});

describe("sendDigest", () => {
  test("posts {text: markdown} to the webhook and logs digest.sent", async () => {
    const { db } = seedDigestScenario();
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch: FetchLike = async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response("ok");
    };

    const result = await sendDigest(db, fakeFetch, "https://hooks.example.test/digest");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example.test/digest");
    expect(JSON.parse(calls[0]!.body)).toEqual({ text: result.markdown });
    expect(result.delivered).toBe(true);

    const event = db
      .query("SELECT * FROM events WHERE event_type = 'digest.sent'")
      .get() as { payload_json: string; actor_user_id: string | null };
    expect(event).toBeTruthy();
    expect(event.actor_user_id).toBeNull(); // system event
    expect(JSON.parse(event.payload_json)).toEqual({ delivered: true, webhook_configured: true });
  });

  test("no webhook configured: skips the POST but still logs digest.sent", async () => {
    const { db } = seedDigestScenario();
    const calls: string[] = [];
    const fakeFetch: FetchLike = async (url) => {
      calls.push(String(url));
      return new Response("ok");
    };

    const result = await sendDigest(db, fakeFetch, undefined);
    expect(calls).toHaveLength(0);
    expect(result.delivered).toBe(false);
    const count = db
      .query("SELECT COUNT(*) AS n FROM events WHERE event_type = 'digest.sent'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe("maybeSendDigest scheduler window", () => {
  // 2026-06-15 is a Monday; 04:00 UTC = 09:30 Asia/Kolkata.
  const mondayNineIst = new Date("2026-06-15T04:00:00.000Z");

  test("fires inside Monday 09:00-09:59 IST and dedupes per IST day", async () => {
    const { db } = seedDigestScenario();
    const fakeFetch: FetchLike = async () => new Response("ok");

    expect(await maybeSendDigest(db, mondayNineIst, fakeFetch, undefined)).toBe(true);
    // still inside the 09:00-09:59 IST window, same IST day: dedupe must hold
    const nineFortyFiveIst = new Date("2026-06-15T04:15:00.000Z");
    expect(await maybeSendDigest(db, nineFortyFiveIst, fakeFetch, undefined)).toBe(false);

    const count = db
      .query("SELECT COUNT(*) AS n FROM events WHERE event_type = 'digest.sent'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("does not fire outside the window", async () => {
    const { db } = seedDigestScenario();
    const fakeFetch: FetchLike = async () => new Response("ok");

    const mondayTenThirtyIst = new Date("2026-06-15T05:00:00.000Z"); // 10:30 IST
    expect(await maybeSendDigest(db, mondayTenThirtyIst, fakeFetch, undefined)).toBe(false);

    const tuesdayNineIst = new Date("2026-06-16T04:00:00.000Z"); // Tuesday
    expect(await maybeSendDigest(db, tuesdayNineIst, fakeFetch, undefined)).toBe(false);

    const count = db
      .query("SELECT COUNT(*) AS n FROM events WHERE event_type = 'digest.sent'")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});
