import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { nowIso, openTestDb } from "../db.ts";
import { appendEvent } from "../events.ts";
import { insightHandle, ulid } from "../ids.ts";
import {
  aiQuality,
  captureVolume,
  clientBrief,
  funnel,
  perClientClosedLoop,
  perPerson,
  stageTats,
  stuckItems,
  themeDemand,
  wipAndAging,
} from "./queries.ts";
import { isoWeek } from "./utils.ts";

const D = (day: string) => `${day}T00:00:00.000Z`;

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

function seedMeeting(
  db: Database,
  clientId: string,
  seq: number,
  date: string,
  source = "manual",
): string {
  const id = ulid();
  db.query(
    "INSERT INTO meetings (id, client_id, seq, meeting_date, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, clientId, seq, date, source, date);
  return id;
}

function seedInsight(
  db: Database,
  opts: {
    meetingId: string;
    clientId: string;
    title?: string;
    track?: string | null;
    state?: string;
    createdAt?: string;
    bodyOriginal?: string;
    bodyCurrent?: string;
    runId?: string | null;
    assignee?: string | null;
    finalizedBy?: string | null;
  },
): string {
  const id = ulid();
  const t = opts.createdAt ?? nowIso();
  db.query(
    `INSERT INTO insights (id, meeting_id, client_id, extraction_run_id, item_type, track, title,
                           body_original, body_current, state, assignee_user_id, finalized_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'feature_request', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.meetingId,
    opts.clientId,
    opts.runId ?? null,
    opts.track ?? null,
    opts.title ?? "An ask",
    opts.bodyOriginal ?? "orig",
    opts.bodyCurrent ?? "orig",
    opts.state ?? "extracted",
    opts.assignee ?? null,
    opts.finalizedBy ?? null,
    t,
    t,
  );
  return id;
}

/** Append state_changed events with explicit timestamps and sync the cached state. */
function walk(db: Database, insightId: string, actor: string, steps: Array<[string, string]>): void {
  let prev: string | undefined;
  for (const [state, at] of steps) {
    appendEvent(db, {
      actorUserId: actor,
      entityType: "insight",
      entityId: insightId,
      eventType: "insight.state_changed",
      fromState: prev,
      toState: state,
      occurredAt: at,
    });
    prev = state;
  }
  const last = steps[steps.length - 1];
  if (last) db.query("UPDATE insights SET state = ? WHERE id = ?").run(last[0], insightId);
}

describe("stageTats", () => {
  test("exact stage durations per track, including end-to-end from meeting.uploaded", () => {
    const db = openTestDb();
    const u = seedUser(db);
    const c = seedClient(db, "Acme");
    const m = seedMeeting(db, c, 1, D("2026-06-01"));
    appendEvent(db, {
      actorUserId: u,
      entityType: "meeting",
      entityId: m,
      eventType: "meeting.uploaded",
      occurredAt: D("2026-06-01"),
    });

    const eng = seedInsight(db, { meetingId: m, clientId: c, track: "engineering", createdAt: D("2026-06-01") });
    walk(db, eng, u, [
      ["extracted", D("2026-06-01")],
      ["triaged", D("2026-06-02")],
      ["finalized", D("2026-06-03")],
      ["ticketed", D("2026-06-05")], // exactly 2.0 days after finalized
      ["shipped", D("2026-06-08")],
      ["client_notified", D("2026-06-09")],
    ]);

    const mkt = seedInsight(db, { meetingId: m, clientId: c, track: "marketing", createdAt: D("2026-06-01") });
    walk(db, mkt, u, [
      ["extracted", D("2026-06-01")],
      ["triaged", D("2026-06-01")],
      ["finalized", D("2026-06-02")],
      ["shipped", D("2026-06-04")],
    ]);

    const tats = stageTats(db);
    const engRow = tats.find((t) => t.track === "engineering")!;
    expect(engRow.extracted_to_finalized.avg).toBe(2);
    expect(engRow.finalized_to_ticketed.avg).toBe(2);
    expect(engRow.finalized_to_ticketed.median).toBe(2);
    expect(engRow.finalized_to_ticketed.p90).toBe(2);
    expect(engRow.finalized_to_ticketed.n).toBe(1);
    expect(engRow.ticketed_to_shipped.avg).toBe(3);
    expect(engRow.shipped_to_notified.avg).toBe(1);
    expect(engRow.end_to_end.avg).toBe(8); // uploaded 06-01 -> notified 06-09
    expect(engRow.finalized_to_shipped.n).toBe(0); // ticketed path excluded from non-ticket TAT

    const mktRow = tats.find((t) => t.track === "marketing")!;
    expect(mktRow.finalized_to_shipped.avg).toBe(2);
    expect(mktRow.finalized_to_ticketed.n).toBe(0);
  });
});

describe("funnel", () => {
  test("cohorts by ISO week of extracted_at with counts and percentages", () => {
    const db = openTestDb();
    const u = seedUser(db);
    const c = seedClient(db, "Acme");
    const m = seedMeeting(db, c, 1, D("2026-06-01"));

    const a = seedInsight(db, { meetingId: m, clientId: c, createdAt: D("2026-06-01") });
    walk(db, a, u, [
      ["extracted", D("2026-06-01")],
      ["triaged", D("2026-06-02")],
      ["finalized", D("2026-06-03")],
      ["ticketed", D("2026-06-04")],
      ["shipped", D("2026-06-05")],
    ]);
    const b = seedInsight(db, { meetingId: m, clientId: c, createdAt: D("2026-06-02") });
    walk(db, b, u, [
      ["extracted", D("2026-06-02")],
      ["triaged", D("2026-06-03")],
      ["finalized", D("2026-06-04")],
    ]);
    const cc = seedInsight(db, { meetingId: m, clientId: c, createdAt: D("2026-06-03") });
    walk(db, cc, u, [["extracted", D("2026-06-03")]]);

    const week = isoWeek(D("2026-06-01"));
    const cohorts = funnel(db);
    const row = cohorts.find((r) => r.week === week)!;
    expect(row.cohort).toBe(3);
    expect(row.counts.triaged).toBe(2);
    expect(row.counts.finalized).toBe(2);
    expect(row.counts.ticketed).toBe(1);
    expect(row.counts.shipped).toBe(1);
    expect(row.counts.notified).toBe(0);
    expect(row.counts.closed).toBe(0);
    expect(row.pct.finalized).toBe(66.7);
    expect(row.pct.shipped).toBe(33.3);
  });
});

describe("stuckItems", () => {
  test("respects per-state thresholds", () => {
    const db = openTestDb();
    const u = seedUser(db, "Asha");
    const c = seedClient(db, "Acme");
    const m = seedMeeting(db, c, 1, D("2026-06-01"));
    const now = new Date(D("2026-06-10"));

    const stale = seedInsight(db, { meetingId: m, clientId: c, title: "Stale ask", assignee: u });
    walk(db, stale, u, [["extracted", D("2026-06-06")]]); // 4d > 3d threshold

    const fresh = seedInsight(db, { meetingId: m, clientId: c, title: "Fresh ask" });
    walk(db, fresh, u, [["extracted", D("2026-06-08")]]); // 2d, under threshold

    const ticketed = seedInsight(db, { meetingId: m, clientId: c, title: "In flight" });
    walk(db, ticketed, u, [["ticketed", D("2026-05-31")]]); // 10d, under 21d default

    const stuck = stuckItems(db, undefined, now);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.insight_id).toBe(stale);
    expect(stuck[0]!.state).toBe("extracted");
    expect(stuck[0]!.days_in_state).toBe(4);
    expect(stuck[0]!.assignee).toBe("Asha");
    expect(stuck[0]!.handle).toBe(insightHandle(stale));

    // custom thresholds replace the defaults
    const custom = stuckItems(db, { ticketed: 5 }, now);
    expect(custom).toHaveLength(1);
    expect(custom[0]!.insight_id).toBe(ticketed);
    expect(custom[0]!.days_in_state).toBe(10);
  });
});

describe("wipAndAging", () => {
  test("groups open insights by state/track with age buckets; excludes terminal states", () => {
    const db = openTestDb();
    const u = seedUser(db);
    const c = seedClient(db, "Acme");
    const m = seedMeeting(db, c, 1, D("2026-06-01"));
    const now = new Date(D("2026-06-10"));

    const open5d = seedInsight(db, { meetingId: m, clientId: c, track: "engineering" });
    walk(db, open5d, u, [["extracted", D("2026-06-05")]]); // 5d -> 4-7d bucket
    const open1d = seedInsight(db, { meetingId: m, clientId: c, track: "engineering" });
    walk(db, open1d, u, [["extracted", D("2026-06-09")]]); // 1d -> 0-3d bucket
    const gone = seedInsight(db, { meetingId: m, clientId: c, track: "engineering" });
    walk(db, gone, u, [["rejected", D("2026-06-01")]]);

    const groups = wipAndAging(db, now);
    const g = groups.find((x) => x.state === "extracted" && x.track === "engineering")!;
    expect(g.count).toBe(2);
    expect(g.age_buckets["0-3d"]).toBe(1);
    expect(g.age_buckets["4-7d"]).toBe(1);
    expect(groups.find((x) => x.state === "rejected")).toBeUndefined();
  });
});

describe("perPerson", () => {
  test("attributes finalized to finalized_by, ticketed/confirms/copies to event actors, per ISO week", () => {
    const db = openTestDb();
    const finisher = seedUser(db, "Finisher");
    const actor = seedUser(db, "Actor");
    const c = seedClient(db, "Acme");
    const m = seedMeeting(db, c, 1, D("2026-06-01"));

    const ins = seedInsight(db, { meetingId: m, clientId: c, finalizedBy: finisher });
    walk(db, ins, actor, [
      ["finalized", D("2026-06-02")],
      ["ticketed", D("2026-06-03")],
    ]);
    appendEvent(db, {
      actorUserId: actor,
      entityType: "completion_evidence",
      entityId: ulid(),
      eventType: "evidence.confirmed",
      occurredAt: D("2026-06-04"),
    });
    appendEvent(db, {
      actorUserId: actor,
      entityType: "email_draft",
      entityId: ulid(),
      eventType: "email.copied",
      occurredAt: D("2026-06-04"),
    });
    appendEvent(db, {
      actorUserId: actor,
      entityType: "email_draft",
      entityId: ulid(),
      eventType: "email.copied",
      occurredAt: D("2026-06-05"),
    });

    const week = isoWeek(D("2026-06-02"));
    const rows = perPerson(db);
    const finRow = rows.find((r) => r.user_id === finisher && r.week === week)!;
    expect(finRow.finalized).toBe(1);
    expect(finRow.ticketed).toBe(0);

    const actRow = rows.find((r) => r.user_id === actor && r.week === week)!;
    expect(actRow.finalized).toBe(0); // finalize credit goes to finalized_by
    expect(actRow.ticketed).toBe(1);
    expect(actRow.evidence_confirms).toBe(1);
    expect(actRow.email_copies).toBe(2);
    expect(actRow.name).toBe("Actor");
  });
});

describe("perClientClosedLoop", () => {
  test("closed-loop rate and median finalized->notified days", () => {
    const db = openTestDb();
    const u = seedUser(db);
    const c = seedClient(db, "Acme");
    const m = seedMeeting(db, c, 1, D("2026-06-01"));

    const looped = seedInsight(db, { meetingId: m, clientId: c });
    walk(db, looped, u, [
      ["finalized", D("2026-06-01")],
      ["shipped", D("2026-06-03")],
      ["client_notified", D("2026-06-04")], // 3 days after finalized
    ]);
    const pending = seedInsight(db, { meetingId: m, clientId: c });
    walk(db, pending, u, [["finalized", D("2026-06-02")]]);

    const rows = perClientClosedLoop(db);
    const row = rows.find((r) => r.client_id === c)!;
    expect(row.finalized).toBe(2);
    expect(row.notified).toBe(1);
    expect(row.closed_loop_pct).toBe(50);
    expect(row.median_days_finalized_to_notified).toBe(3);
  });
});

describe("themeDemand", () => {
  test("counts tags over finalized+ insights with distinct clients and track mix", () => {
    const db = openTestDb();
    const u = seedUser(db);
    const cA = seedClient(db, "Acme");
    const cB = seedClient(db, "Beta");
    const mA = seedMeeting(db, cA, 1, D("2026-06-01"));
    const mB = seedMeeting(db, cB, 1, D("2026-06-01"));

    const tagId = ulid();
    db.query("INSERT INTO tags (id, name) VALUES (?, 'sso')").run(tagId);

    const insA = seedInsight(db, { meetingId: mA, clientId: cA, track: "engineering", state: "finalized" });
    const insB = seedInsight(db, { meetingId: mB, clientId: cB, track: "marketing", state: "shipped" });
    const insOpen = seedInsight(db, { meetingId: mA, clientId: cA, track: "engineering", state: "extracted" });
    for (const ins of [insA, insB, insOpen]) {
      db.query("INSERT INTO insight_tags (insight_id, tag_id, applied_by, applied_at) VALUES (?, ?, ?, ?)").run(
        ins,
        tagId,
        u,
        nowIso(),
      );
    }

    const rows = themeDemand(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tag).toBe("sso");
    expect(rows[0]!.count).toBe(2); // extracted insight not counted
    expect(rows[0]!.distinct_clients).toBe(2);
    expect(rows[0]!.track_mix).toEqual({ engineering: 1, marketing: 1 });
  });
});

describe("aiQuality", () => {
  test("discard rate, edit-distance ratio, routing note", () => {
    const db = openTestDb();
    const u = seedUser(db);
    const c = seedClient(db, "Acme");
    const m = seedMeeting(db, c, 1, D("2026-06-01"));
    const transcriptId = ulid();
    db.query(
      "INSERT INTO transcripts (id, meeting_id, content, source, created_at) VALUES (?, ?, 'hello', 'uploaded', ?)",
    ).run(transcriptId, m, nowIso());
    const runId = ulid();
    db.query(
      "INSERT INTO extraction_runs (id, meeting_id, transcript_id, llm_model, prompt_version) VALUES (?, ?, ?, 'mock', 'v1')",
    ).run(runId, m, transcriptId);

    const kept = seedInsight(db, {
      meetingId: m,
      clientId: c,
      runId,
      bodyOriginal: "hello world",
      bodyCurrent: "hello world!", // levenshtein 1 over max length 12
    });
    walk(db, kept, u, [["finalized", D("2026-06-03")]]);
    const discarded = seedInsight(db, { meetingId: m, clientId: c, runId });
    walk(db, discarded, u, [["rejected", D("2026-06-02")]]);

    const q = aiQuality(db);
    expect(q.extracted_from_runs).toBe(2);
    expect(q.rejected_from_runs).toBe(1);
    expect(q.discard_rate).toBe(0.5);
    expect(q.edit_distance_sample).toBe(1);
    expect(q.mean_edit_distance_ratio).toBe(0.083); // 1/12 rounded
    expect(q.routing_correction_rate).toBe(0);
    expect(q.routing_correction_note).toBe("ai_suggested_json not yet populated");
  });
});

describe("captureVolume", () => {
  test("meetings per week by source plus weekly activity counters", () => {
    const db = openTestDb();
    const u = seedUser(db);
    const c = seedClient(db, "Acme");
    const m1 = seedMeeting(db, c, 1, D("2026-06-01"), "manual");
    appendEvent(db, {
      actorUserId: u,
      entityType: "meeting",
      entityId: m1,
      eventType: "meeting.uploaded",
      occurredAt: D("2026-06-01"),
    });
    seedMeeting(db, c, 2, D("2026-06-02"), "zoom"); // no event: falls back to created_at

    appendEvent(db, { actorUserId: u, entityType: "email_draft", entityId: ulid(), eventType: "email.copied", occurredAt: D("2026-06-03") });
    appendEvent(db, { actorUserId: u, entityType: "ticket", entityId: ulid(), eventType: "ticket.raised", occurredAt: D("2026-06-03") });
    appendEvent(db, { actorUserId: u, entityType: "completion_evidence", entityId: ulid(), eventType: "evidence.confirmed", occurredAt: D("2026-06-04") });

    const week = isoWeek(D("2026-06-01"));
    const vol = captureVolume(db);
    expect(vol.meetings_per_week).toContainEqual({ week, source: "manual", count: 1 });
    expect(vol.meetings_per_week).toContainEqual({ week, source: "zoom", count: 1 });
    const activity = vol.activity_per_week.find((r) => r.week === week)!;
    expect(activity.emails_copied).toBe(1);
    expect(activity.tickets_raised).toBe(1);
    expect(activity.evidence_confirms).toBe(1);
  });
});

describe("clientBrief", () => {
  test("renders open asks, shipped since last meeting, follow-ups owed; no em-dashes", () => {
    const db = openTestDb();
    const u = seedUser(db);
    const c = seedClient(db, "Acme");
    const m = seedMeeting(db, c, 1, D("2026-06-01"));
    const now = new Date(D("2026-06-10"));

    const open = seedInsight(db, { meetingId: m, clientId: c, title: "Faster exports" });
    walk(db, open, u, [["finalized", D("2026-06-04")]]);

    const shipped = seedInsight(db, { meetingId: m, clientId: c, title: "SSO support" });
    walk(db, shipped, u, [
      ["finalized", D("2026-06-02")],
      ["shipped", D("2026-06-05")],
    ]);
    const evId = ulid();
    db.query(
      `INSERT INTO completion_evidence (id, insight_id, kind, url, confidence, status, confirmed_by, confirmed_at, created_at)
       VALUES (?, ?, 'asset_published', 'https://xyz.com/changelog/sso', 100, 'confirmed', ?, ?, ?)`,
    ).run(evId, shipped, u, nowIso(), nowIso());

    const md = clientBrief(db, c, now)!;
    expect(md).toContain("# Pre-call brief: Acme");
    expect(md).toContain("## Open asks");
    expect(md).toContain("## Shipped since last meeting");
    expect(md).toContain("## Follow-ups owed");
    expect(md).toContain(`${insightHandle(open)} Faster exports (finalized, 6d old)`);
    expect(md).toContain(`${insightHandle(shipped)} SSO support (shipped 2026-06-05)`);
    expect(md).toContain("https://xyz.com/changelog/sso");
    expect(md).toContain("shipped, email not yet sent");
    expect(md).not.toContain("—"); // brand rule: no em-dashes

    expect(clientBrief(db, "nope", now)).toBeNull();
  });
});
