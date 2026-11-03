import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../db.ts";
import { openTestDb, nowIso } from "../db.ts";
import { ulid, insightHandle } from "../ids.ts";
import { MockLLM, setLLM } from "../llm/provider.ts";
import { writableRepos } from "../config.ts";
import { createIssue, GitHubApiError, type FetchLike } from "./github.ts";
import {
  HttpError,
  draftTicket,
  getTicket,
  listTicketsForInsight,
  markRaised,
  createDirect,
  markStaleDrafts,
  ticketFooter,
} from "./service.ts";

const ALLOWED_REPO = writableRepos()[0]!;

interface Seeded {
  db: Database;
  adminId: string;
  assigneeId: string;
  otherId: string;
  insightId: string;
}

async function seed(overrides: { state?: string; track?: string | null } = {}): Promise<Seeded> {
  const db = await openTestDb();
  const t = nowIso();
  const adminId = ulid();
  const assigneeId = ulid();
  const otherId = ulid();
  const insightId = ulid();
  const c1 = ulid();
  const c2 = ulid();
  const m1 = ulid();
  const m2 = ulid();

  const addUser = db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)");
  await addUser.run(adminId, `admin-${adminId}@tallyhall.com`, "Admin", "admin", t);
  await addUser.run(assigneeId, `dev-${assigneeId}@tallyhall.com`, "Dev", "member", t);
  await addUser.run(otherId, `other-${otherId}@tallyhall.com`, "Other", "member", t);

  const addClient = db.query("INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)");
  await addClient.run(c1, "Acme Corp", t);
  await addClient.run(c2, "Globex", t);

  const addMeeting = db.query(
    "INSERT INTO meetings (id, client_id, seq, meeting_date, created_at) VALUES (?, ?, 1, ?, ?)",
  );
  await addMeeting.run(m1, c1, "2026-05-01", t);
  await addMeeting.run(m2, c2, "2026-05-15", t);

  await db.query(
    `INSERT INTO insights (id, meeting_id, client_id, item_type, track, title, body_original, body_current,
                           state, assignee_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 'feature_request', ?, 'SSO support', 'llm draft', 'Clients need SAML SSO before security reviews.',
             ?, ?, ?, ?)`,
  ).run(
    insightId,
    m1,
    c1,
    overrides.track === undefined ? "engineering" : overrides.track,
    overrides.state ?? "finalized",
    assigneeId,
    t,
    t,
  );

  const addMention = db.query(
    "INSERT INTO insight_mentions (id, insight_id, meeting_id, client_id, quote, speaker, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  await addMention.run(ulid(), insightId, m1, c1, "We really need SSO before the security review", "Dana Vargas", t);
  await addMention.run(ulid(), insightId, m2, c2, "single sign on is blocking our rollout", "Lee Park", t);

  const addRequester = db.query(
    "INSERT INTO insight_requesters (insight_id, client_id, first_requested_at, last_requested_at) VALUES (?, ?, ?, ?)",
  );
  await addRequester.run(insightId, c1, "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z");
  await addRequester.run(insightId, c2, "2026-05-15T00:00:00Z", "2026-05-15T00:00:00Z");

  return { db, adminId, assigneeId, otherId, insightId };
}

async function insertDraft(db: Database, insightId: string, createdBy: string, draftedAt = nowIso()): Promise<string> {
  const id = ulid();
  await db.query(
    `INSERT INTO tickets (id, insight_id, draft_title, draft_body_md, state, created_by, drafted_at)
     VALUES (?, ?, 'Add SSO', ?, 'draft', ?, ?)`,
  ).run(id, insightId, `Problem\n\n${ticketFooter(insightId, ["Acme Corp"])}\n`, createdBy, draftedAt);
  return id;
}

async function insightState(db: Database, insightId: string): Promise<string> {
  return (await db.query("SELECT state FROM insights WHERE id = ?").get(insightId) as { state: string }).state;
}

async function ticketEvents(db: Database, ticketId: string, eventType: string): Promise<Array<Record<string, unknown>>> {
  return await db
    .query("SELECT * FROM events WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = ?")
    .all(ticketId, eventType) as Array<Record<string, unknown>>;
}

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { fn, calls };
}

async function expectHttp(p: Promise<unknown> | (() => unknown), status: number): Promise<HttpError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    return err as HttpError;
  }
  throw new Error(`expected HttpError ${status}, but nothing was thrown`);
}

afterEach(() => setLLM(null));

describe("ticket drafting", () => {
  test("draft embeds hidden marker, footer, requester count, and client names", async () => {
    const { db, assigneeId, insightId } = await seed();
    const mock = new MockLLM().enqueue({ title: "Add SAML SSO", body_md: "Problem: clients need SSO.\n\n- AC: SSO works" });
    setLLM(mock);

    const ticket = await draftTicket(db, { insightId, actor: { id: assigneeId, role: "member" } });

    expect(ticket.state).toBe("draft");
    expect(ticket.draft_title).toBe("Add SAML SSO");
    expect(ticket.draft_body_md).toContain(`<!-- followthrough:${insightHandle(insightId)} -->`);
    expect(ticket.draft_body_md).toContain("---");
    expect(ticket.draft_body_md).toContain("Requested by 2 client(s): Acme Corp, Globex");
    expect(ticket.draft_body_md).toContain(`Followthrough ref: ${insightId}`);
    expect(await ticketEvents(db, ticket.id, "ticket.drafted")).toHaveLength(1);
    expect((await getTicket(db, ticket.id)).id).toBe(ticket.id);
    expect((await listTicketsForInsight(db, insightId)).map((t) => t.id)).toContain(ticket.id);
  });

  test("draft prompt carries verbatim quotes with client names and meeting dates", async () => {
    const { db, assigneeId, insightId } = await seed();
    const mock = new MockLLM().enqueue({ title: "T", body_md: "B" });
    setLLM(mock);

    await draftTicket(db, { insightId, actor: { id: assigneeId, role: "member" } });

    const prompt = mock.calls[0]!.prompt;
    expect(prompt).toContain("We really need SSO before the security review");
    expect(prompt).toContain("Dana Vargas");
    expect(prompt).toContain("Acme Corp");
    expect(prompt).toContain("2026-05-01");
    expect(prompt).toContain("single sign on is blocking our rollout");
    expect(prompt).toContain("Clients need SAML SSO before security reviews.");
  });

  test("guards: missing insight 404, non-finalized state 409, wrong track 409", async () => {
    const { db, assigneeId, insightId } = await seed({ state: "triaged" });
    setLLM(new MockLLM().enqueue({ title: "T", body_md: "B" }));
    const actor = { id: assigneeId, role: "member" as const };

    await expectHttp(draftTicket(db, { insightId: "NOPE", actor }), 404);
    await expectHttp(draftTicket(db, { insightId, actor }), 409);

    const marketing = await seed({ track: "marketing" });
    await expectHttp(
      draftTicket(marketing.db, { insightId: marketing.insightId, actor: { id: marketing.assigneeId, role: "member" } }),
      409,
    );
  });

  test("re-draft is allowed when insight is already ticketed", async () => {
    const { db, assigneeId, insightId } = await seed({ state: "ticketed" });
    setLLM(new MockLLM().enqueue({ title: "T2", body_md: "B2" }));

    const ticket = await draftTicket(db, { insightId, actor: { id: assigneeId, role: "member" } });
    expect(ticket.state).toBe("draft");
  });
});

describe("mark-raised (manual paste-back)", () => {
  test("parses repo and number, stores fields, transitions insight to ticketed", async () => {
    const { db, assigneeId, insightId } = await seed();
    const ticketId = await insertDraft(db, insightId, assigneeId);

    // paste-back may name ANY repo, including tallyhall: the human created the issue
    const ticket = await markRaised(db, {
      ticketId,
      externalUrl: "https://github.com/tallyhall/app/issues/123",
      actor: { id: assigneeId, role: "member" },
    });

    expect(ticket.repo).toBe("tallyhall/app");
    expect(ticket.external_number).toBe(123);
    expect(ticket.external_url).toBe("https://github.com/tallyhall/app/issues/123");
    expect(ticket.create_mode).toBe("manual_paste");
    expect(ticket.state).toBe("raised");
    expect(ticket.raised_at).toBeTruthy();
    expect(await insightState(db, insightId)).toBe("ticketed");

    const events = await ticketEvents(db, ticketId, "ticket.raised");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(String(events[0]!.payload_json)) as Record<string, unknown>;
    expect(payload.repo).toBe("tallyhall/app");
    expect(payload.number).toBe(123);
    expect(payload.mode).toBe("manual_paste");
  });

  test("rejects non-issue URLs with 400 and leaves state untouched", async () => {
    const { db, assigneeId, insightId } = await seed();
    const ticketId = await insertDraft(db, insightId, assigneeId);
    const actor = { id: assigneeId, role: "member" as const };

    const bad = [
      "https://gitlab.com/a/b/issues/1",
      "https://github.com/a/b/pull/7",
      "http://github.com/a/b/issues/1",
      "https://github.com/a/b/issues/1x",
      "https://github.com/a/issues/1",
      "not a url",
    ];
    for (const externalUrl of bad) {
      await expectHttp(() => markRaised(db, { ticketId, externalUrl, actor }), 400);
    }
    expect((await getTicket(db, ticketId)).state).toBe("draft");
    expect(await insightState(db, insightId)).toBe("finalized");
  });

  test("skips insight transition when already ticketed; re-raising same ticket is 409", async () => {
    const { db, assigneeId, insightId } = await seed();
    const actor = { id: assigneeId, role: "member" as const };
    const first = await insertDraft(db, insightId, assigneeId);
    await markRaised(db, { ticketId: first, externalUrl: "https://github.com/acme/app/issues/1", actor });
    expect(await insightState(db, insightId)).toBe("ticketed");

    await expectHttp(
      () => markRaised(db, { ticketId: first, externalUrl: "https://github.com/acme/app/issues/2", actor }),
      409,
    );

    // a second draft against the now-ticketed insight raises without a transition error
    const second = await insertDraft(db, insightId, assigneeId);
    const t2 = await markRaised(db, { ticketId: second, externalUrl: "https://github.com/acme/app/issues/3", actor });
    expect(t2.state).toBe("raised");
    expect(await insightState(db, insightId)).toBe("ticketed");
  });
});

describe("create-direct (org safety)", () => {
  test("tallyhall repo returns 403 even with a token set; GitHub is never called", async () => {
    const { db, assigneeId, insightId } = await seed();
    const ticketId = await insertDraft(db, insightId, assigneeId);
    const gh = stubFetch(201, { html_url: "https://github.com/tallyhall/app/issues/9", number: 9 });

    const err = await expectHttp(
      createDirect(db, {
        ticketId,
        repo: "tallyhall/app",
        actor: { id: assigneeId, role: "member" },
        token: "ghp_test_token",
        fetchImpl: gh.fn,
      }),
      403,
    );

    expect(err.message).toContain("tallyhall");
    expect(gh.calls).toHaveLength(0); // the write never reached the network
    expect((await getTicket(db, ticketId)).state).toBe("draft");
    expect(await insightState(db, insightId)).toBe("finalized");
    expect(await ticketEvents(db, ticketId, "ticket.raised")).toHaveLength(0);
  });

  test("non-allowlisted repo is 403 too", async () => {
    const { db, assigneeId, insightId } = await seed();
    const ticketId = await insertDraft(db, insightId, assigneeId);
    const gh = stubFetch(201, {});

    await expectHttp(
      createDirect(db, {
        ticketId,
        repo: "someoneelse/random-repo",
        actor: { id: assigneeId, role: "member" },
        token: "ghp_test_token",
        fetchImpl: gh.fn,
      }),
      403,
    );
    expect(gh.calls).toHaveLength(0);
  });

  test("missing write token is 400 and GitHub is never called", async () => {
    const { db, assigneeId, insightId } = await seed();
    const ticketId = await insertDraft(db, insightId, assigneeId);
    const gh = stubFetch(201, {});

    const err = await expectHttp(
      createDirect(db, {
        ticketId,
        repo: ALLOWED_REPO,
        actor: { id: assigneeId, role: "member" },
        token: undefined,
        fetchImpl: gh.fn,
      }),
      400,
    );
    expect(err.message).toBe("no write token configured");
    expect(gh.calls).toHaveLength(0);
  });

  test("allowlisted repo with stubbed fetch succeeds and stores all fields", async () => {
    const { db, assigneeId, insightId } = await seed();
    const ticketId = await insertDraft(db, insightId, assigneeId);
    const issueUrl = `https://github.com/${ALLOWED_REPO}/issues/42`;
    const gh = stubFetch(201, { html_url: issueUrl, number: 42 });

    const ticket = await createDirect(db, {
      ticketId,
      repo: ALLOWED_REPO,
      actor: { id: assigneeId, role: "member" },
      token: "ghp_test_token",
      fetchImpl: gh.fn,
    });

    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]!.url).toBe(`https://api.github.com/repos/${ALLOWED_REPO}/issues`);
    const init = gh.calls[0]!.init!;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghp_test_token");
    const sent = JSON.parse(String(init.body)) as { title: string; body: string };
    expect(sent.title).toBe("Add SSO");
    expect(sent.body).toContain(`<!-- followthrough:${insightHandle(insightId)} -->`);

    expect(ticket.repo).toBe(ALLOWED_REPO);
    expect(ticket.external_url).toBe(issueUrl);
    expect(ticket.external_number).toBe(42);
    expect(ticket.create_mode).toBe("direct_api");
    expect(ticket.state).toBe("raised");
    expect(ticket.raised_at).toBeTruthy();
    expect(await insightState(db, insightId)).toBe("ticketed");
    expect(await ticketEvents(db, ticketId, "ticket.raised")).toHaveLength(1);
  });

  test("non-assignee member is blocked BEFORE the GitHub call (no orphaned issue)", async () => {
    const { db, otherId, assigneeId, insightId } = await seed();
    const ticketId = await insertDraft(db, insightId, assigneeId);
    const gh = stubFetch(201, { html_url: `https://github.com/${ALLOWED_REPO}/issues/1`, number: 1 });

    await expectHttp(
      createDirect(db, {
        ticketId,
        repo: ALLOWED_REPO,
        actor: { id: otherId, role: "member" },
        token: "ghp_test_token",
        fetchImpl: gh.fn,
      }),
      403,
    );
    expect(gh.calls).toHaveLength(0);
    expect((await getTicket(db, ticketId)).state).toBe("draft");
  });

  test("GitHub non-201 surfaces as GitHubApiError and the ticket stays draft", async () => {
    const { db, assigneeId, insightId } = await seed();
    const ticketId = await insertDraft(db, insightId, assigneeId);
    const gh = stubFetch(422, { message: "Validation Failed" });

    await expect(
      createDirect(db, {
        ticketId,
        repo: ALLOWED_REPO,
        actor: { id: assigneeId, role: "member" },
        token: "ghp_test_token",
        fetchImpl: gh.fn,
      }),
    ).rejects.toBeInstanceOf(GitHubApiError);
    expect((await getTicket(db, ticketId)).state).toBe("draft");
    expect(await insightState(db, insightId)).toBe("finalized");
  });

  test("createIssue itself refuses tallyhall even when called directly (defense in depth)", async () => {
    const gh = stubFetch(201, {});
    await expect(createIssue("tallyhall/app", "t", "b", "ghp_test_token", gh.fn)).rejects.toThrow(/tallyhall/);
    expect(gh.calls).toHaveLength(0);
  });
});

describe("markStaleDrafts", () => {
  test("flips only drafts older than the threshold", async () => {
    const { db, assigneeId, insightId } = await seed();
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const oldDraft = await insertDraft(db, insightId, assigneeId, tenDaysAgo);
    const freshDraft = await insertDraft(db, insightId, assigneeId);
    const raised = await insertDraft(db, insightId, assigneeId, tenDaysAgo);
    await markRaised(db, {
      ticketId: raised,
      externalUrl: "https://github.com/acme/app/issues/5",
      actor: { id: assigneeId, role: "member" },
    });

    const flipped = await markStaleDrafts(db, 7);

    expect(flipped).toEqual([oldDraft]);
    expect((await getTicket(db, oldDraft)).state).toBe("stale");
    expect((await getTicket(db, freshDraft)).state).toBe("draft");
    expect((await getTicket(db, raised)).state).toBe("raised");
    expect(await ticketEvents(db, oldDraft, "ticket.stale")).toHaveLength(1);
    expect(await ticketEvents(db, freshDraft, "ticket.stale")).toHaveLength(0);

    // idempotent: a second run finds nothing
    expect(await markStaleDrafts(db, 7)).toEqual([]);
  });
});
