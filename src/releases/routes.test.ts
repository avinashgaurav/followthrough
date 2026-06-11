import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { MockLLM } from "../llm/provider.ts";
import { ulid } from "../ids.ts";
import { nowIso } from "../db.ts";
import {
  MatchActionError,
  confirmMatch,
  rejectMatch,
  runPollPipeline,
} from "./routes.ts";
import type { FetchLike } from "./poller.ts";
import { seed, makeInsight, makeRelease, entry, fixtureGitHubRelease, type Seeded } from "./test-helpers.ts";

function insightState(db: Database, id: string): string {
  return (db.query("SELECT state FROM insights WHERE id = ?").get(id) as { state: string }).state;
}

function proposeMatch(
  s: Seeded,
  insightId: string,
  opts: { confidence?: number; verdict?: string } = {},
): { matchId: string; entryId: string } {
  const { entryIds } = makeRelease(s.db, {
    tag: `v9.${Math.floor(Math.random() * 1_000_000)}`,
    githubId: Math.floor(Math.random() * 1_000_000_000),
    entries: [entry()],
  });
  const matchId = ulid();
  s.db
    .query(
      `INSERT INTO release_matches
         (id, release_entry_id, insight_id, confidence, method, verdict, evidence_quotes_json, rationale, status, created_at)
       VALUES (?, ?, ?, ?, 'llm', ?, '["Dashboards now support dark mode"]', 'test', 'proposed', ?)`,
    )
    .run(matchId, entryIds[0]!, insightId, opts.confidence ?? 80, opts.verdict ?? "full", nowIso());
  return { matchId, entryId: entryIds[0]! };
}

describe("confirmMatch", () => {
  test("assignee confirm ships a ticketed insight with confirmed 100-confidence evidence", () => {
    const s = seed();
    const insightId = makeInsight(s, { state: "ticketed", track: "engineering", assignee: s.alice.id });
    const { matchId } = proposeMatch(s, insightId);

    const match = confirmMatch(s.db, { matchId, actor: s.alice });
    expect(match.status).toBe("confirmed");
    expect(match.decided_by).toBe(s.alice.id);
    expect(match.decided_at).not.toBeNull();

    const evidence = s.db
      .query("SELECT * FROM completion_evidence WHERE insight_id = ?")
      .all(insightId) as Array<{
      kind: string;
      ref_match_id: string;
      confidence: number;
      status: string;
      confirmed_by: string;
      confirmed_at: string | null;
    }>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.kind).toBe("release_match");
    expect(evidence[0]!.ref_match_id).toBe(matchId);
    expect(evidence[0]!.confidence).toBe(100);
    expect(evidence[0]!.status).toBe("confirmed");
    expect(evidence[0]!.confirmed_by).toBe(s.alice.id);
    expect(evidence[0]!.confirmed_at).not.toBeNull();

    expect(insightState(s.db, insightId)).toBe("shipped");

    const eventTypes = (
      s.db
        .query("SELECT event_type FROM events WHERE event_type IN ('match.confirmed','evidence.confirmed','insight.state_changed') ORDER BY id")
        .all() as Array<{ event_type: string }>
    ).map((e) => e.event_type);
    expect(eventTypes).toEqual(["match.confirmed", "evidence.confirmed", "insight.state_changed"]);
  });

  test("ships a finalized insight on the no-ticket path", () => {
    const s = seed();
    const insightId = makeInsight(s, { state: "finalized", track: "product_polish", assignee: s.alice.id });
    const { matchId } = proposeMatch(s, insightId);
    confirmMatch(s.db, { matchId, actor: s.admin });
    expect(insightState(s.db, insightId)).toBe("shipped");
  });

  test("a non-assignee member is rejected with 403", () => {
    const s = seed();
    const insightId = makeInsight(s, { state: "ticketed", assignee: s.alice.id });
    const { matchId } = proposeMatch(s, insightId);
    expect(() => confirmMatch(s.db, { matchId, actor: s.bob })).toThrow(MatchActionError);
    try {
      confirmMatch(s.db, { matchId, actor: s.bob });
    } catch (err) {
      expect((err as MatchActionError).status).toBe(403);
    }
    expect(insightState(s.db, insightId)).toBe("ticketed");
    expect(
      (s.db.query("SELECT COUNT(*) AS n FROM completion_evidence").get() as { n: number }).n,
    ).toBe(0);
  });

  test("confirm is idempotent: a second confirm adds no evidence", () => {
    const s = seed();
    const insightId = makeInsight(s, { state: "ticketed", assignee: s.alice.id });
    const { matchId } = proposeMatch(s, insightId);
    confirmMatch(s.db, { matchId, actor: s.alice });
    const again = confirmMatch(s.db, { matchId, actor: s.alice });
    expect(again.status).toBe("confirmed");
    expect(
      (s.db.query("SELECT COUNT(*) AS n FROM completion_evidence").get() as { n: number }).n,
    ).toBe(1);
  });

  test("an insight already shipped just gets the confirmed evidence, no transition", () => {
    const s = seed();
    const insightId = makeInsight(s, { state: "shipped", assignee: s.alice.id });
    const { matchId } = proposeMatch(s, insightId);
    const match = confirmMatch(s.db, { matchId, actor: s.alice });
    expect(match.status).toBe("confirmed");
    expect(insightState(s.db, insightId)).toBe("shipped");
    expect(
      (s.db
        .query("SELECT COUNT(*) AS n FROM events WHERE event_type = 'insight.state_changed'")
        .get() as { n: number }).n,
    ).toBe(0);
  });

  test("404 on unknown match; 409 when confirming a rejected match", () => {
    const s = seed();
    const insightId = makeInsight(s, { state: "ticketed", assignee: s.alice.id });
    const { matchId } = proposeMatch(s, insightId);

    try {
      confirmMatch(s.db, { matchId: "missing", actor: s.admin });
      expect.unreachable();
    } catch (err) {
      expect((err as MatchActionError).status).toBe(404);
    }

    rejectMatch(s.db, { matchId, reason: "wrong feature", actor: s.alice });
    try {
      confirmMatch(s.db, { matchId, actor: s.alice });
      expect.unreachable();
    } catch (err) {
      expect((err as MatchActionError).status).toBe(409);
    }
  });

  test("rolls back the confirm when the insight cannot transition", () => {
    const s = seed();
    const insightId = makeInsight(s, { state: "triaged", assignee: s.alice.id });
    const { matchId } = proposeMatch(s, insightId);
    expect(() => confirmMatch(s.db, { matchId, actor: s.alice })).toThrow();
    const row = s.db
      .query("SELECT status FROM release_matches WHERE id = ?")
      .get(matchId) as { status: string };
    expect(row.status).toBe("proposed"); // transaction rolled back
    expect(
      (s.db.query("SELECT COUNT(*) AS n FROM completion_evidence").get() as { n: number }).n,
    ).toBe(0);
  });
});

describe("rejectMatch", () => {
  test("records the decision and reason without touching the insight", () => {
    const s = seed();
    const insightId = makeInsight(s, { state: "ticketed", assignee: s.alice.id });
    const { matchId } = proposeMatch(s, insightId);

    const match = rejectMatch(s.db, { matchId, reason: "entry covers a different module", actor: s.bob });
    expect(match.status).toBe("rejected");
    expect(match.decided_by).toBe(s.bob.id);
    expect(match.decided_at).not.toBeNull();
    expect(insightState(s.db, insightId)).toBe("ticketed");

    const ev = s.db
      .query("SELECT payload_json FROM events WHERE event_type = 'match.rejected'")
      .get() as { payload_json: string };
    expect(JSON.parse(ev.payload_json).reason).toBe("entry covers a different module");
  });

  test("409 when rejecting a confirmed match", () => {
    const s = seed();
    const insightId = makeInsight(s, { state: "ticketed", assignee: s.alice.id });
    const { matchId } = proposeMatch(s, insightId);
    confirmMatch(s.db, { matchId, actor: s.alice });
    try {
      rejectMatch(s.db, { matchId, reason: "changed my mind", actor: s.alice });
      expect.unreachable();
    } catch (err) {
      expect((err as MatchActionError).status).toBe(409);
    }
  });
});

describe("runPollPipeline", () => {
  const stub =
    (payload: unknown): FetchLike =>
    async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });

  test("polls, parses, matches, and reports counts; second run is a no-op", async () => {
    const s = seed();
    makeInsight(s, {
      title: "K8s workload cost split",
      body: "Acme wants to see which namespace and deployment drives cluster spend.",
      state: "ticketed",
      track: "engineering",
      assignee: s.alice.id,
    });

    const payload = [fixtureGitHubRelease("v1.18.0", 180)];
    const llm = new MockLLM().enqueue({
      matches: [
        {
          entry_index: 0,
          verdict: "full",
          evidence_quotes: ["per-workload cost for every cluster"],
          rationale: "Ships the requested workload cost breakdown.",
        },
      ],
    });

    const counts = await runPollPipeline(s.db, llm, stub(payload));
    expect(counts).toEqual({
      fetched: 1,
      new_releases: 1,
      new_entries: 4, // 1 feature + 1 fix + 2 technical
      matches_proposed: 1,
    });
    expect(llm.calls).toHaveLength(1);
    // candidates exclude the technical entries
    expect(llm.calls[0]!.prompt).toContain("[0]");
    expect(llm.calls[0]!.prompt).toContain("[1]");
    expect(llm.calls[0]!.prompt).not.toContain("[2]");

    // poller idempotency: nothing new, no LLM calls, no new matches
    const counts2 = await runPollPipeline(s.db, llm, stub(payload));
    expect(counts2).toEqual({ fetched: 1, new_releases: 0, new_entries: 0, matches_proposed: 0 });
    expect(llm.calls).toHaveLength(1);
    expect(
      (s.db.query("SELECT COUNT(*) AS n FROM release_matches").get() as { n: number }).n,
    ).toBe(1);
  });
});
