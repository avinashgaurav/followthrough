import { describe, expect, test } from "bun:test";
import { nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { rebuildFts, syncInsightFts, searchAll, ftsQueryFromUserInput } from "./search.ts";
import { updateBody, triageInsight } from "./service.ts";
import { seed, makeInsight, addMention } from "./test-helpers.ts";

function addTranscript(db: ReturnType<typeof seed>["db"], meetingId: string, content: string): string {
  const id = ulid();
  db.query(
    "INSERT INTO transcripts (id, meeting_id, content, source, created_at) VALUES (?, ?, ?, 'uploaded', ?)",
  ).run(id, meetingId, content, nowIso());
  return id;
}

describe("ftsQueryFromUserInput", () => {
  test("quotes tokens and strips FTS5 operators and punctuation", () => {
    expect(ftsQueryFromUserInput("export button")).toBe('"export" "button"');
    expect(ftsQueryFromUserInput('weird "quotes" AND (paren*')).toBe('"weird" "quotes" "AND" "paren"');
    expect(ftsQueryFromUserInput("!!! ---")).toBeNull();
  });
});

describe("rebuild + search", () => {
  test("finds an insight by mention quote text after rebuild", () => {
    const s = seed();
    const id = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      title: "Export improvements",
      body: "Customers want CSV export",
    });
    addMention(s.db, id, s.meetingAcme1, s.acme, "the export button is greyed out on the billing page");

    const counts = rebuildFts(s.db);
    expect(counts.insights).toBe(1);

    const res = searchAll(s.db, "greyed billing", {});
    expect(res.insights).toHaveLength(1);
    expect(res.insights[0]!.id).toBe(id);
    expect(res.insights[0]!.handle).toBe(`INS-${id.slice(-6)}`);
    expect(res.insights[0]!.snippet).toContain("[greyed]");
  });

  test("finds transcript matches with meeting context", () => {
    const s = seed();
    addTranscript(s.db, s.meetingGlobex1, "We discussed the kubernetes autoscaler flapping under load.");
    const counts = rebuildFts(s.db);
    expect(counts.transcripts).toBe(1);

    const res = searchAll(s.db, "autoscaler flapping", {});
    expect(res.transcripts).toHaveLength(1);
    expect(res.transcripts[0]!.meeting_id).toBe(s.meetingGlobex1);
    expect(res.transcripts[0]!.client_name).toBe("Globex");
    expect(res.transcripts[0]!.snippet).toContain("[autoscaler]");
  });

  test("filters: client_id narrows both lists; track/state apply to insights and skip transcripts", () => {
    const s = seed();
    const acmeInsight = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      state: "triaged",
      track: "engineering",
      body: "dashboard latency regression",
    });
    makeInsight(s.db, {
      meetingId: s.meetingGlobex1,
      clientId: s.globex,
      state: "extracted",
      track: "marketing",
      body: "dashboard latency complaint from globex",
    });
    addTranscript(s.db, s.meetingAcme1, "long talk about dashboard latency");
    rebuildFts(s.db);

    const all = searchAll(s.db, "dashboard latency", {});
    expect(all.insights).toHaveLength(2);
    expect(all.transcripts).toHaveLength(1);

    const acmeOnly = searchAll(s.db, "dashboard latency", { client_id: s.acme });
    expect(acmeOnly.insights.map((r) => r.id)).toEqual([acmeInsight]);
    expect(acmeOnly.transcripts).toHaveLength(1);

    const globexOnly = searchAll(s.db, "dashboard latency", { client_id: s.globex });
    expect(globexOnly.transcripts).toHaveLength(0);

    const engineering = searchAll(s.db, "dashboard latency", { track: "engineering" });
    expect(engineering.insights.map((r) => r.id)).toEqual([acmeInsight]);
    expect(engineering.transcripts).toHaveLength(0); // track is insight-only

    const triaged = searchAll(s.db, "dashboard latency", { state: "triaged" });
    expect(triaged.insights.map((r) => r.id)).toEqual([acmeInsight]);
  });

  test("no match and empty query return empty results", () => {
    const s = seed();
    rebuildFts(s.db);
    expect(searchAll(s.db, "nonexistent", {}).insights).toHaveLength(0);
    expect(searchAll(s.db, "...", {}).insights).toHaveLength(0);
  });
});

describe("syncInsightFts", () => {
  test("body edit makes new text searchable without a rebuild", () => {
    const s = seed();
    const id = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme, body: "old text" });
    // updateBody calls syncInsightFts internally
    updateBody(s.db, id, s.alice, "now covers terraform drift detection in the scheduler", 1);

    const res = searchAll(s.db, "terraform drift", {});
    expect(res.insights.map((r) => r.id)).toEqual([id]);
  });

  test("triage syncs the row and sync is delete-then-insert (no duplicates)", () => {
    const s = seed();
    const id = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      title: "Webhook retries",
      body: "retry webhooks with backoff",
    });
    triageInsight(s.db, id, s.admin, { track: "engineering" });
    syncInsightFts(s.db, id);
    syncInsightFts(s.db, id);

    const n = s.db.query("SELECT COUNT(*) AS n FROM fts_insights WHERE insight_id = ?").get(id) as {
      n: number;
    };
    expect(n.n).toBe(1);
    expect(searchAll(s.db, "webhook retries", {}).insights.map((r) => r.id)).toEqual([id]);

    // syncing a deleted/unknown insight just removes the row
    syncInsightFts(s.db, "MISSING");
    expect(searchAll(s.db, "webhook retries", {}).insights).toHaveLength(1);
  });
});
