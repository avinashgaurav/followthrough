import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../db.ts";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { MockLLM, setLLM } from "../llm/provider.ts";
import {
  ServiceError,
  generateDrafts,
  listDrafts,
  markCopied,
  confirmSent,
  closeInsight,
} from "./service.ts";

afterEach(() => setLLM(null));

interface Seeded {
  db: Database;
  adminId: string;
  assigneeId: string;
  insightId: string;
  clientA: string; // external, has a contact with email
  clientB: string; // external, no contacts
  clientI: string; // internal, must be skipped
  contactA: string;
}

async function seed(state = "shipped"): Promise<Seeded> {
  const db = await openTestDb();
  const t = nowIso();
  const adminId = ulid();
  const assigneeId = ulid();
  const clientA = ulid();
  const clientB = ulid();
  const clientI = ulid();
  const contactA = ulid();
  const meetingA = ulid();
  const meetingB = ulid();
  const insightId = ulid();

  await db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'Admin', 'admin', ?)").run(
    adminId, `a-${adminId}@tallyhall.com`, t,
  );
  await db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'Assignee', 'member', ?)").run(
    assigneeId, `m-${assigneeId}@tallyhall.com`, t,
  );
  await db.query("INSERT INTO clients (id, name, is_internal, created_at) VALUES (?, 'Acme', 0, ?)").run(clientA, t);
  await db.query("INSERT INTO clients (id, name, is_internal, created_at) VALUES (?, 'Globex', 0, ?)").run(clientB, t);
  await db.query("INSERT INTO clients (id, name, is_internal, created_at) VALUES (?, 'Acme Internal', 1, ?)").run(clientI, t);
  await db.query(
    "INSERT INTO client_contacts (id, client_id, name, email, created_at) VALUES (?, ?, 'Priya N', 'priya@acme.com', ?)",
  ).run(contactA, clientA, t);
  // a contact without an email must not be picked
  await db.query(
    "INSERT INTO client_contacts (id, client_id, name, email, created_at) VALUES (?, ?, 'No Email', NULL, ?)",
  ).run(ulid(), clientB, t);

  await db.query(
    "INSERT INTO meetings (id, client_id, seq, meeting_date, created_at) VALUES (?, ?, 1, '2026-04-02', ?)",
  ).run(meetingA, clientA, t);
  await db.query(
    "INSERT INTO meetings (id, client_id, seq, meeting_date, created_at) VALUES (?, ?, 1, '2026-04-15', ?)",
  ).run(meetingB, clientB, t);

  await db.query(
    `INSERT INTO insights (id, meeting_id, client_id, item_type, track, title, body_original, body_current,
                           state, assignee_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 'feature_request', 'engineering', 'Scheduled RDS shutdown',
             'orig', 'Non production RDS instances now shut down on schedule.', ?, ?, ?, ?)`,
  ).run(insightId, meetingA, clientA, state, assigneeId, t, t);

  for (const clientId of [clientA, clientB, clientI]) {
    await db.query(
      "INSERT INTO insight_requesters (insight_id, client_id, first_requested_at, last_requested_at) VALUES (?, ?, ?, ?)",
    ).run(insightId, clientId, t, t);
  }
  await db.query(
    `INSERT INTO insight_mentions (id, insight_id, meeting_id, client_id, quote, speaker, created_at)
     VALUES (?, ?, ?, ?, 'we burn money every night on idle databases', 'Priya', ?)`,
  ).run(ulid(), insightId, meetingA, clientA, t);
  await db.query(
    `INSERT INTO insight_mentions (id, insight_id, meeting_id, client_id, quote, speaker, created_at)
     VALUES (?, ?, ?, ?, 'can we get auto shutdown for staging', 'Wes', ?)`,
  ).run(ulid(), insightId, meetingB, clientB, t);

  await db.query(
    `INSERT INTO completion_evidence (id, insight_id, kind, url, confidence, status, created_at)
     VALUES (?, ?, 'asset_published', 'https://tallyhall.com/changelog/v1.20.0', 100, 'confirmed', ?)`,
  ).run(ulid(), insightId, t);

  return { db, adminId, assigneeId, insightId, clientA, clientB, clientI, contactA };
}

function mockEmails(n: number): MockLLM {
  const mock = new MockLLM();
  for (let i = 0; i < n; i++) {
    mock.enqueue({ subject: `It is live (draft ${i + 1})`, body_md: `Body ${i + 1}` });
  }
  setLLM(mock);
  return mock;
}

describe("generateDrafts fan-out", () => {
  test("one draft per external requester, none for internal clients", async () => {
    const s = await seed("shipped");
    const mock = mockEmails(2);
    const drafts = await generateDrafts(s.db, {
      insightId: s.insightId,
      actor: { id: s.assigneeId, role: "member" },
    });

    expect(drafts.length).toBe(2);
    const byClient = new Map(drafts.map((d) => [d.client_id, d]));
    expect(byClient.has(s.clientA)).toBe(true);
    expect(byClient.has(s.clientB)).toBe(true);
    expect(byClient.has(s.clientI)).toBe(false);

    expect(byClient.get(s.clientA)!.contact_id).toBe(s.contactA);
    expect(byClient.get(s.clientB)!.contact_id).toBeNull(); // its only contact has no email
    expect(drafts.every((d) => d.version === 1)).toBe(true);

    // prompts are grounded in THIS client's quotes plus the confirmed evidence
    expect(mock.calls.length).toBe(2);
    const promptA = mock.calls.find((c) => c.prompt.includes('client "Acme"'))!.prompt;
    const promptB = mock.calls.find((c) => c.prompt.includes('client "Globex"'))!.prompt;
    expect(promptA).toContain("we burn money every night on idle databases");
    expect(promptA).toContain("2026-04-02");
    expect(promptA).not.toContain("can we get auto shutdown for staging");
    expect(promptA).toContain("https://tallyhall.com/changelog/v1.20.0");
    expect(promptB).toContain("can we get auto shutdown for staging");

    // brand rules live in the stable system prompt
    const system = mock.calls[0]!.system ?? "";
    expect(system).toContain("em-dashes");
    expect(system).toContain("revolutionize");
    expect(mock.calls[1]!.system).toBe(system);

    const events = await s.db
      .query("SELECT entity_id FROM events WHERE event_type = 'email.drafted'")
      .all() as Array<{ entity_id: string }>;
    expect(events.length).toBe(2);
  });

  test("guard: only shipped or client_notified insights get drafts", async () => {
    const s = await seed("finalized");
    mockEmails(0);
    await expect(
      generateDrafts(s.db, { insightId: s.insightId, actor: { id: s.assigneeId, role: "member" } }),
    ).rejects.toThrow(ServiceError);
  });

  test("regenerating creates version 2 and supersedes version 1", async () => {
    const s = await seed("shipped");
    mockEmails(4);
    const first = await generateDrafts(s.db, {
      insightId: s.insightId,
      actor: { id: s.assigneeId, role: "member" },
    });
    const second = await generateDrafts(s.db, {
      insightId: s.insightId,
      actor: { id: s.assigneeId, role: "member" },
    });

    expect(second.every((d) => d.version === 2)).toBe(true);
    expect(second.every((d) => d.superseded_by_id === null)).toBe(true);
    for (const oldDraft of first) {
      const refreshed = await s.db
        .query("SELECT superseded_by_id FROM email_drafts WHERE id = ?")
        .get(oldDraft.id) as { superseded_by_id: string | null };
      const replacement = second.find((d) => d.client_id === oldDraft.client_id)!;
      expect(refreshed.superseded_by_id).toBe(replacement.id);
    }
    expect((await listDrafts(s.db, s.insightId)).length).toBe(4);
  });
});

describe("markCopied", () => {
  test("first copy transitions shipped -> client_notified, second copy just logs", async () => {
    const s = await seed("shipped");
    mockEmails(2);
    const drafts = await generateDrafts(s.db, {
      insightId: s.insightId,
      actor: { id: s.assigneeId, role: "member" },
    });
    const draft = drafts[0]!;
    const actor = { id: s.assigneeId, role: "member" as const };

    const first = await markCopied(s.db, { draftId: draft.id, actor });
    expect(first.transitioned).toBe(true);
    let state = (await s.db.query("SELECT state FROM insights WHERE id = ?").get(s.insightId) as { state: string }).state;
    expect(state).toBe("client_notified");

    const second = await markCopied(s.db, { draftId: draft.id, actor });
    expect(second.transitioned).toBe(false);
    state = (await s.db.query("SELECT state FROM insights WHERE id = ?").get(s.insightId) as { state: string }).state;
    expect(state).toBe("client_notified");

    const copies = await s.db
      .query(
        "SELECT payload_json FROM events WHERE event_type = 'email.copied' AND entity_type = 'email_draft' AND entity_id = ?",
      )
      .all(draft.id) as Array<{ payload_json: string }>;
    expect(copies.length).toBe(2);
    expect(JSON.parse(copies[0]!.payload_json)).toEqual({
      client_id: draft.client_id,
      draft_version: 1,
    });
  });

  test("unknown draft 404s", async () => {
    const s = await seed("shipped");
    await expect(markCopied(s.db, { draftId: "NOPE", actor: { id: s.adminId, role: "admin" } }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("confirmSent", () => {
  test("records the timestamp, optional final text, and the event", async () => {
    const s = await seed("shipped");
    mockEmails(2);
    const drafts = await generateDrafts(s.db, {
      insightId: s.insightId,
      actor: { id: s.assigneeId, role: "member" },
    });
    const updated = await confirmSent(s.db, {
      draftId: drafts[0]!.id,
      finalText: "Hi Priya, the scheduled shutdown is live: https://tallyhall.com/changelog/v1.20.0",
      actor: { id: s.assigneeId, role: "member" },
    });
    expect(updated.sent_confirmed_at).toBeTruthy();
    expect(updated.sent_final_text).toContain("Priya");
    const ev = await s.db
      .query("SELECT id FROM events WHERE event_type = 'email.sent_confirmed' AND entity_id = ?")
      .get(drafts[0]!.id);
    expect(ev).toBeTruthy();
  });
});

describe("closeInsight", () => {
  test("close from shipped without reason fails with a clear 400, with reason succeeds", async () => {
    const s = await seed("shipped");
    const actor = { id: s.assigneeId, role: "member" as const };
    let caught: unknown;
    try {
      await closeInsight(s.db, { insightId: s.insightId, actor });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).status).toBe(400);
    expect((caught as ServiceError).message).toMatch(/reason/);

    await closeInsight(s.db, { insightId: s.insightId, reason: "client churned, no email owed", actor });
    const state = (await s.db.query("SELECT state FROM insights WHERE id = ?").get(s.insightId) as { state: string }).state;
    expect(state).toBe("closed");
  });

  test("close from client_notified needs no reason", async () => {
    const s = await seed("client_notified");
    await closeInsight(s.db, { insightId: s.insightId, actor: { id: s.assigneeId, role: "member" } });
    const state = (await s.db.query("SELECT state FROM insights WHERE id = ?").get(s.insightId) as { state: string }).state;
    expect(state).toBe("closed");
  });
});
