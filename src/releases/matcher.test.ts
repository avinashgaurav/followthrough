import { describe, expect, test } from "bun:test";
import { MockLLM } from "../llm/provider.ts";
import { confidenceFor, matchRelease } from "./matcher.ts";
import { seed, makeInsight, makeRelease, entry } from "./test-helpers.ts";

function minutesAgoIso(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

describe("confidenceFor", () => {
  test("full -> 80, partial -> 50 on a clean customer-facing entry", () => {
    const clean = { section_type: "feature", flags: [] };
    expect(confidenceFor("full", clean)).toBe(80);
    expect(confidenceFor("partial", clean)).toBe(50);
  });

  test("gating flags cap any verdict at 50 (entries that ship dark)", () => {
    const gated = { section_type: "feature", flags: ["flag_gated"] };
    expect(confidenceFor("full", gated)).toBe(50);
    expect(confidenceFor("partial", gated)).toBe(50);
    expect(confidenceFor("full", { section_type: "fix", flags: ["reverted"] })).toBe(50);
    expect(confidenceFor("full", { section_type: "fix", flags: ["internal_only"] })).toBe(50);
  });

  test("technical entries cap at 60; technical plus gated caps at 50", () => {
    expect(confidenceFor("full", { section_type: "technical", flags: [] })).toBe(60);
    expect(confidenceFor("partial", { section_type: "technical", flags: [] })).toBe(50);
    expect(confidenceFor("full", { section_type: "technical", flags: ["shadow"] })).toBe(50);
  });
});

describe("matchRelease", () => {
  const darkModeEntry = entry(); // feature, no flags
  const gatedSsoEntry = entry({
    title: "SAML SSO for enterprise accounts",
    body_md: "SAML SSO is available behind a feature flag for early-access customers.",
    flags: ["flag_gated"],
  });
  const technicalEntry = entry({
    section_type: "technical",
    title: "Dual-write seam in the aggregator store",
    body_md: "Writes go to MySQL and ClickHouse on every ingest.",
  });

  test("verifies quotes, drops fabricated ones, applies gating caps, proposes only", async () => {
    const s = seed();
    const { releaseId, entryIds } = makeRelease(s.db, {
      tag: "v1.21.0",
      githubId: 210,
      entries: [darkModeEntry, gatedSsoEntry, technicalEntry],
    });

    // Distinct created_at values force a deterministic LLM call order.
    const darkInsight = makeInsight(s, {
      title: "Dark mode",
      body: "Acme wants dark mode on the dashboards.",
      state: "finalized",
      track: "product_polish",
      assignee: s.alice.id,
      createdAt: minutesAgoIso(10),
    });
    const ssoInsight = makeInsight(s, {
      title: "SAML SSO",
      body: "Enterprise clients need SAML SSO.",
      state: "ticketed",
      track: "engineering",
      assignee: s.bob.id,
      createdAt: minutesAgoIso(5),
    });

    const llm = new MockLLM();
    // Call 1 (dark mode insight): one verified quote plus one fabricated quote
    // on entry 0; a second candidate with only fabricated quotes that must be
    // discarded; and a 'none' verdict that must be skipped.
    llm.enqueue({
      matches: [
        {
          entry_index: 0,
          verdict: "full",
          evidence_quotes: [
            "Dashboards now support dark mode across all pages",
            "this quote was hallucinated by the model",
          ],
          rationale: "The entry ships exactly the requested dark mode.",
        },
        {
          entry_index: 1,
          verdict: "partial",
          evidence_quotes: ["completely fabricated evidence"],
          rationale: "Should be discarded: no verifiable quote.",
        },
        { entry_index: 2, verdict: "none", evidence_quotes: [], rationale: "Unrelated." },
      ],
    });
    // Call 2 (SSO insight): full match on the flag-gated entry -> capped at 50.
    llm.enqueue({
      matches: [
        {
          entry_index: 1,
          verdict: "full",
          evidence_quotes: ["SAML SSO is available behind a feature flag"],
          rationale: "Ships SSO but only behind a flag.",
        },
      ],
    });

    const result = await matchRelease(s.db, llm, releaseId);
    expect(result.insightsConsidered).toBe(2);
    expect(result.entriesConsidered).toBe(2); // technical entry excluded from candidates
    expect(result.proposed).toBe(2);
    expect(llm.calls).toHaveLength(2); // one judge call per insight

    const rows = s.db
      .query(
        "SELECT insight_id, release_entry_id, verdict, confidence, method, status, evidence_quotes_json FROM release_matches ORDER BY rowid",
      )
      .all() as Array<{
      insight_id: string;
      release_entry_id: string;
      verdict: string;
      confidence: number;
      method: string;
      status: string;
      evidence_quotes_json: string;
    }>;
    expect(rows).toHaveLength(2);

    const dark = rows.find((r) => r.insight_id === darkInsight)!;
    expect(dark.release_entry_id).toBe(entryIds[0]!);
    expect(dark.verdict).toBe("full");
    expect(dark.confidence).toBe(80);
    expect(dark.method).toBe("llm");
    expect(dark.status).toBe("proposed"); // never auto-confirmed
    // fabricated quote dropped, verified quote kept
    expect(JSON.parse(dark.evidence_quotes_json)).toEqual([
      "Dashboards now support dark mode across all pages",
    ]);

    const sso = rows.find((r) => r.insight_id === ssoInsight)!;
    expect(sso.release_entry_id).toBe(entryIds[1]!);
    expect(sso.confidence).toBe(50); // full verdict capped by the gating flag

    // no completion evidence and no shipped insights without a human confirm
    expect(
      (s.db.query("SELECT COUNT(*) AS n FROM completion_evidence").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (s.db.query("SELECT COUNT(*) AS n FROM insights WHERE state = 'shipped'").get() as { n: number }).n,
    ).toBe(0);

    const events = s.db
      .query("SELECT entity_id, actor_user_id, payload_json FROM events WHERE event_type = 'match.proposed' ORDER BY id")
      .all() as Array<{ entity_id: string; actor_user_id: string | null; payload_json: string }>;
    expect(events).toHaveLength(2);
    expect(events[0]!.actor_user_id).toBeNull();
    expect(JSON.parse(events[0]!.payload_json).release_tag).toBe("v1.21.0");
  });

  test("only considers finalized/ticketed insights on engineering or product_polish tracks", async () => {
    const s = seed();
    const { releaseId } = makeRelease(s.db, {
      tag: "v1.21.1",
      githubId: 211,
      entries: [darkModeEntry],
    });
    makeInsight(s, { state: "extracted", track: "engineering" });
    makeInsight(s, { state: "finalized", track: "marketing" });
    makeInsight(s, { state: "shipped", track: "engineering" });
    makeInsight(s, { state: "rejected", track: "product_polish" });

    const llm = new MockLLM(); // empty queue: any call would throw
    const result = await matchRelease(s.db, llm, releaseId);
    expect(result.insightsConsidered).toBe(0);
    expect(result.proposed).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  test("re-running matching never duplicates a proposal", async () => {
    const s = seed();
    const { releaseId } = makeRelease(s.db, {
      tag: "v1.21.2",
      githubId: 212,
      entries: [darkModeEntry],
    });
    makeInsight(s, { state: "finalized", track: "engineering", assignee: s.alice.id });

    const response = {
      matches: [
        {
          entry_index: 0,
          verdict: "full",
          evidence_quotes: ["Dashboards now support dark mode"],
          rationale: "Direct match.",
        },
      ],
    };
    const llm = new MockLLM().enqueue(response).enqueue(response);

    const first = await matchRelease(s.db, llm, releaseId);
    const second = await matchRelease(s.db, llm, releaseId);
    expect(first.proposed).toBe(1);
    expect(second.proposed).toBe(0);
    expect(
      (s.db.query("SELECT COUNT(*) AS n FROM release_matches").get() as { n: number }).n,
    ).toBe(1);
  });

  test("a judge failure on one insight does not abort the batch", async () => {
    const s = seed();
    const { releaseId } = makeRelease(s.db, {
      tag: "v1.21.3",
      githubId: 213,
      entries: [darkModeEntry],
    });
    makeInsight(s, {
      state: "finalized",
      track: "engineering",
      createdAt: minutesAgoIso(10),
    });
    makeInsight(s, {
      title: "Dark mode",
      state: "finalized",
      track: "product_polish",
      createdAt: minutesAgoIso(5),
    });

    // First call returns an unparseable payload (schema violation); second succeeds.
    const llm = new MockLLM()
      .enqueue({ matches: [{ entry_index: "zero", verdict: "huge" }] })
      .enqueue({
        matches: [
          {
            entry_index: 0,
            verdict: "partial",
            evidence_quotes: ["with a per-user toggle"],
            rationale: "Partially covers the ask.",
          },
        ],
      });

    const result = await matchRelease(s.db, llm, releaseId);
    expect(result.proposed).toBe(1);
    const row = s.db
      .query("SELECT confidence, verdict FROM release_matches")
      .get() as { confidence: number; verdict: string };
    expect(row.verdict).toBe("partial");
    expect(row.confidence).toBe(50);
  });

  test("throws for an unknown release id", async () => {
    const s = seed();
    await expect(matchRelease(s.db, new MockLLM(), "nope")).rejects.toThrow(/Release not found/);
  });
});
