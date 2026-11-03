import { describe, expect, test } from "bun:test";
import type { Database } from "../db.ts";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { TransitionError } from "../events.ts";
import {
  ServiceError,
  proposeEvidence,
  confirmEvidence,
  rejectEvidence,
  listEvidence,
  type FetchLike,
} from "./service.ts";

const liveFetch: FetchLike = async () => ({ ok: true, status: 200 });
const deadFetch: FetchLike = async () => ({ ok: false, status: 404 });
const throwingFetch: FetchLike = async () => {
  throw new Error("ECONNREFUSED");
};

interface Seeded {
  db: Database;
  adminId: string;
  assigneeId: string;
  otherId: string;
  insightId: string;
}

async function seed(state: string): Promise<Seeded> {
  const db = await openTestDb();
  const t = nowIso();
  const adminId = ulid();
  const assigneeId = ulid();
  const otherId = ulid();
  const clientId = ulid();
  const meetingId = ulid();
  const insightId = ulid();
  await db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'Admin', 'admin', ?)").run(
    adminId, `a-${adminId}@tallyhall.com`, t,
  );
  await db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'Assignee', 'member', ?)").run(
    assigneeId, `m-${assigneeId}@tallyhall.com`, t,
  );
  await db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'Other', 'member', ?)").run(
    otherId, `o-${otherId}@tallyhall.com`, t,
  );
  await db.query("INSERT INTO clients (id, name, created_at) VALUES (?, 'Acme', ?)").run(clientId, t);
  await db.query(
    "INSERT INTO meetings (id, client_id, seq, meeting_date, created_at) VALUES (?, ?, 1, ?, ?)",
  ).run(meetingId, clientId, t, t);
  await db.query(
    `INSERT INTO insights (id, meeting_id, client_id, item_type, title, body_original, body_current,
                           state, assignee_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 'feature_request', 'Dark mode', 'orig', 'polished', ?, ?, ?, ?)`,
  ).run(insightId, meetingId, clientId, state, assigneeId, t, t);
  return { db, adminId, assigneeId, otherId, insightId };
}

describe("proposeEvidence", () => {
  test("live url sets url_verified_at and defaults confidence 90", async () => {
    const { db, assigneeId, insightId } = await seed("finalized");
    const row = await proposeEvidence(db, {
      insightId,
      kind: "asset_published",
      url: "https://tallyhall.com/blog/dark-mode",
      actor: { id: assigneeId, role: "member" },
      fetchImpl: liveFetch,
    });
    expect(row.url_verified_at).toBeTruthy();
    expect(row.confidence).toBe(90);
    expect(row.status).toBe("proposed");
    expect(row.attested_by).toBe(assigneeId);

    const ev = await db
      .query("SELECT * FROM events WHERE event_type = 'evidence.proposed' AND entity_id = ?")
      .get(row.id) as { payload_json: string };
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev.payload_json)).toEqual({
      kind: "asset_published",
      url: "https://tallyhall.com/blog/dark-mode",
    });
  });

  test("dead url proceeds with null url_verified_at and confidence 50", async () => {
    const { db, assigneeId, insightId } = await seed("finalized");
    const row = await proposeEvidence(db, {
      insightId,
      kind: "asset_published",
      url: "https://tallyhall.com/404",
      actor: { id: assigneeId, role: "member" },
      fetchImpl: deadFetch,
    });
    expect(row.url_verified_at).toBeNull();
    expect(row.confidence).toBe(50);
    expect(row.status).toBe("proposed");
  });

  test("network failure on liveness check also proceeds at 50", async () => {
    const { db, assigneeId, insightId } = await seed("ticketed");
    const row = await proposeEvidence(db, {
      insightId,
      kind: "ux_verified_in_prod",
      url: "https://unreachable.invalid/x",
      actor: { id: assigneeId, role: "member" },
      fetchImpl: throwingFetch,
    });
    expect(row.url_verified_at).toBeNull();
    expect(row.confidence).toBe(50);
  });

  test("explicit confidence overrides the default", async () => {
    const { db, assigneeId, insightId } = await seed("finalized");
    const row = await proposeEvidence(db, {
      insightId,
      kind: "manual_attestation",
      confidence: 60,
      actor: { id: assigneeId, role: "member" },
    });
    expect(row.confidence).toBe(60);
    expect(row.url_verified_at).toBeNull();
  });

  test("guards: state must be finalized or ticketed; asset_published needs url; ux needs asset or url", async () => {
    const { db, assigneeId, insightId } = await seed("triaged");
    const actor = { id: assigneeId, role: "member" as const };
    await expect(
      proposeEvidence(db, { insightId, kind: "manual_attestation", actor }),
    ).rejects.toThrow(ServiceError);

    const ok = await seed("finalized");
    await expect(
      proposeEvidence(ok.db, {
        insightId: ok.insightId,
        kind: "asset_published",
        actor: { id: ok.assigneeId, role: "member" },
      }),
    ).rejects.toThrow(/requires a url/);
    await expect(
      proposeEvidence(ok.db, {
        insightId: ok.insightId,
        kind: "ux_verified_in_prod",
        actor: { id: ok.assigneeId, role: "member" },
      }),
    ).rejects.toThrow(/asset_id or url/);
  });

  test("unknown insight is a 404", async () => {
    const { db, assigneeId } = await seed("finalized");
    await expect(
      proposeEvidence(db, {
        insightId: "MISSING",
        kind: "manual_attestation",
        actor: { id: assigneeId, role: "member" },
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("confirmEvidence", () => {
  test("transitions a ticketed insight to shipped with confidence 100", async () => {
    const { db, assigneeId, insightId } = await seed("ticketed");
    const proposed = await proposeEvidence(db, {
      insightId,
      kind: "manual_attestation",
      actor: { id: assigneeId, role: "member" },
    });
    const confirmed = await confirmEvidence(db, {
      evidenceId: proposed.id,
      actor: { id: assigneeId, role: "member" },
    });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confidence).toBe(100);
    expect(confirmed.confirmed_by).toBe(assigneeId);
    expect(confirmed.confirmed_at).toBeTruthy();

    const insight = await db.query("SELECT state FROM insights WHERE id = ?").get(insightId) as {
      state: string;
    };
    expect(insight.state).toBe("shipped");

    const transition = await db
      .query(
        "SELECT to_state FROM events WHERE entity_id = ? AND event_type = 'insight.state_changed' ORDER BY id DESC",
      )
      .get(insightId) as { to_state: string };
    expect(transition.to_state).toBe("shipped");
    const confirmedEvent = await db
      .query("SELECT id FROM events WHERE event_type = 'evidence.confirmed' AND entity_id = ?")
      .get(proposed.id);
    expect(confirmedEvent).toBeTruthy();
  });

  test("non-assignee member cannot confirm but admin can", async () => {
    const { db, adminId, assigneeId, otherId, insightId } = await seed("finalized");
    const proposed = await proposeEvidence(db, {
      insightId,
      kind: "manual_attestation",
      actor: { id: otherId, role: "member" },
    });
    await expect(confirmEvidence(db, { evidenceId: proposed.id, actor: { id: otherId, role: "member" } }),
    ).rejects.toThrow(/assignee or an admin/);
    // proposing user is not the assignee either
    expect(assigneeId).not.toBe(otherId);

    const confirmed = await confirmEvidence(db, {
      evidenceId: proposed.id,
      actor: { id: adminId, role: "admin" },
    });
    expect(confirmed.status).toBe("confirmed");
    const insight = await db.query("SELECT state FROM insights WHERE id = ?").get(insightId) as {
      state: string;
    };
    expect(insight.state).toBe("shipped");
  });

  test("handles any kind: a release_match row from the matcher confirms on an already shipped insight without a transition", async () => {
    const { db, adminId, insightId } = await seed("shipped");
    const evidenceId = ulid();
    await db.query(
      `INSERT INTO completion_evidence (id, insight_id, kind, confidence, status, created_at)
       VALUES (?, ?, 'release_match', 85, 'proposed', ?)`,
    ).run(evidenceId, insightId, nowIso());

    const confirmed = await confirmEvidence(db, {
      evidenceId,
      actor: { id: adminId, role: "admin" },
    });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confidence).toBe(100);
    const insight = await db.query("SELECT state FROM insights WHERE id = ?").get(insightId) as {
      state: string;
    };
    expect(insight.state).toBe("shipped"); // unchanged, row simply confirmed
  });

  test("confirm is idempotent and a bad insight state rolls everything back", async () => {
    const { db, adminId, assigneeId, insightId } = await seed("finalized");
    const proposed = await proposeEvidence(db, {
      insightId,
      kind: "manual_attestation",
      actor: { id: assigneeId, role: "member" },
    });
    await confirmEvidence(db, { evidenceId: proposed.id, actor: { id: adminId, role: "admin" } });
    const again = await confirmEvidence(db, {
      evidenceId: proposed.id,
      actor: { id: adminId, role: "admin" },
    });
    expect(again.status).toBe("confirmed");

    // a second proposed row whose insight has regressed to a non-shippable state
    const strayId = ulid();
    await db.query(
      `INSERT INTO completion_evidence (id, insight_id, kind, confidence, status, created_at)
       VALUES (?, ?, 'manual_attestation', 50, 'proposed', ?)`,
    ).run(strayId, insightId, nowIso());
    await db.query("UPDATE insights SET state = 'triaged' WHERE id = ?").run(insightId);
    await expect(confirmEvidence(db, { evidenceId: strayId, actor: { id: adminId, role: "admin" } }),
    ).rejects.toThrow(TransitionError);
    const stray = await db
      .query("SELECT status FROM completion_evidence WHERE id = ?")
      .get(strayId) as { status: string };
    expect(stray.status).toBe("proposed"); // transaction rolled back
  });
});

describe("rejectEvidence / listEvidence", () => {
  test("reject sets status and appends the event", async () => {
    const { db, assigneeId, insightId } = await seed("finalized");
    const proposed = await proposeEvidence(db, {
      insightId,
      kind: "manual_attestation",
      actor: { id: assigneeId, role: "member" },
    });
    const rejected = await rejectEvidence(db, {
      evidenceId: proposed.id,
      reason: "screenshot does not show the fix",
      actor: { id: assigneeId, role: "member" },
    });
    expect(rejected.status).toBe("rejected");
    const ev = await db
      .query("SELECT payload_json FROM events WHERE event_type = 'evidence.rejected' AND entity_id = ?")
      .get(proposed.id) as { payload_json: string };
    expect(JSON.parse(ev.payload_json).reason).toMatch(/screenshot/);

    const rows = await listEvidence(db, insightId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("rejected");
  });

  test("listEvidence 404s on unknown insight", async () => {
    const { db } = await seed("finalized");
    await expect(listEvidence(db, "NOPE")).rejects.toThrow(/not found/i);
  });
});
