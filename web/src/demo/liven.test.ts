// Run by the root `bun test`; excluded from the web tsconfig (no bun types there).
import { describe, expect, test } from "bun:test";
import recorded from "./fixtures.json";
import { liven, type DemoFixtures } from "./liven";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-03T10:00:00.000Z");
const fx = recorded as DemoFixtures;
const out = liven(fx, NOW);
const body = (path: string) => out.responses[path]!.body as Record<string, any>;

function instants(node: unknown, acc: string[] = []): string[] {
  if (typeof node === "string" && /^\d{4}-\d{2}-\d{2}T/.test(node)) acc.push(node);
  else if (Array.isArray(node)) node.forEach((v) => instants(v, acc));
  else if (node && typeof node === "object") Object.values(node).forEach((v) => instants(v, acc));
  return acc;
}

describe("liven (static demo timestamps)", () => {
  test("the recording itself is squashed into minutes, which is why this exists", () => {
    const ms = instants(fx.responses).map(Date.parse);
    expect(Math.max(...ms) - Math.min(...ms)).toBeLessThan(DAY);
  });

  test("meetings land 21, 14 and 7 days before today, a week apart as recorded", () => {
    const dates = body("/api/meetings").meetings.map((m: any) => m.meeting_date).sort();
    expect(dates).toEqual(["2026-10-13", "2026-10-20", "2026-10-27"]);
  });

  test("insight ages vary instead of all reading today", () => {
    const ages = new Set(body("/api/insights").insights.map((i: any) => i.age_days));
    expect(ages.size).toBeGreaterThan(2);
    expect(Math.max(...ages)).toBeGreaterThanOrEqual(14);
    expect(Math.min(...ages)).toBeGreaterThanOrEqual(1);
  });

  test("insights are created on their own meeting's date, never before it", () => {
    for (const row of body("/api/queue").to_review as any[]) {
      expect(row.created_at.slice(0, 10)).toBe(row.meeting_date);
    }
  });

  test("nothing is in the future and every insight timeline keeps its order", () => {
    for (const t of instants(out.responses)) expect(Date.parse(t)).toBeLessThanOrEqual(NOW);
    for (const [path, r] of Object.entries(out.responses)) {
      const timeline = (r.body as any)?.timeline;
      if (!/^\/api\/insights\/[^/]+$/.test(path) || !Array.isArray(timeline)) continue;
      const at = timeline.map((e: any) => e.occurred_at);
      expect(at).toEqual([...at].sort());
      expect(Date.parse(at[0])).toBeGreaterThanOrEqual(Date.parse((r.body as any).created_at));
    }
  });

  test("shipped and client-told events come days after the meeting", () => {
    const tl = body("/api/insights/01M51V7KPNZTXJKWCMRMJ1WWKQ").timeline as any[];
    const shipped = Date.parse(tl.find((e) => e.to_state === "shipped").occurred_at);
    const told = Date.parse(tl.find((e) => e.to_state === "client_notified").occurred_at);
    expect(shipped).toBeGreaterThan(Date.parse("2026-10-13") + 7 * DAY);
    expect(told).toBeGreaterThan(shipped);
    expect(NOW - told).toBeGreaterThan(DAY);
    expect(NOW - told).toBeLessThan(2 * DAY);
  });

  test("dates and ages written into prose follow the shift", () => {
    for (const old of ["2026-09-25", "2026-10-02", "2026-10-09", "2026-10-16"]) {
      expect(JSON.stringify(out.responses).includes(old)).toBe(false);
      expect(JSON.stringify(out.ask).includes(old)).toBe(false);
    }
    expect(JSON.stringify(out)).not.toMatch(/, 0d old\)/);
    expect(body("/api/digest/preview").markdown).toStartWith("# Weekly digest (2026-11-03)");
    expect(body("/api/clients/01M51V62JSEC6ZCSVXQGDBAW5V/brief").markdown).toContain("Latest meeting on record: 2026-10-13");
  });

  test("stuck items and WIP aging are recomputed from the new ages", () => {
    const overview = body("/api/metrics/overview");
    expect(overview.stuck_items.length).toBeGreaterThan(0);
    const extracted = overview.wip_aging.find((g: any) => g.state === "extracted");
    expect(extracted.age_buckets["0-3d"]).toBe(0);
  });

  test("is deterministic and leaves the recorded fixtures untouched", () => {
    const before = JSON.stringify(recorded);
    expect(JSON.stringify(liven(fx, NOW))).toBe(JSON.stringify(out));
    expect(JSON.stringify(recorded)).toBe(before);
  });
});
