import { describe, expect, test } from "bun:test";
import { formatHtml, type ShippedItem } from "./page.ts";

const item = (over: Partial<ShippedItem>): ShippedItem => ({
  title: "A request",
  state: "shipped",
  item_type: "feature_request",
  asked_at: null,
  shipped_at: null,
  ...over,
});

describe("share page (you asked → shipped)", () => {
  test("renders per-item turnaround and a median headline", () => {
    const shipped = [
      item({ title: "Faster export", asked_at: "2026-05-01T00:00:00Z", shipped_at: "2026-05-10T00:00:00Z" }), // 9d
      item({ title: "SUBTEXT: tagging fix", asked_at: "2026-05-01T00:00:00Z", shipped_at: "2026-05-06T00:00:00Z" }), // 5d
    ];
    const html = formatHtml("Acme", shipped, ["A pending thing"]);
    expect(html).toContain("We shipped 2 requests");
    expect(html).toContain("7 days"); // median of 9 and 5 → 7
    expect(html).toContain("9 days");
    expect(html).toContain("Asked");
    expect(html).toContain("tagging fix");
    expect(html).not.toContain("SUBTEXT:"); // prefix stripped
    expect(html).toContain("In progress");
    expect(html).toContain("A pending thing");
  });

  test("shipped item without dates shows no day count, no median", () => {
    const html = formatHtml("Acme", [item({ title: "Thing", asked_at: null, shipped_at: null })], []);
    expect(html).toContain("We shipped 1 request");
    expect(html).not.toContain("days from when you asked");
    expect(html).not.toContain("In progress"); // no in-flight list
  });

  test("nothing shipped → in-flight headline", () => {
    const html = formatHtml("Acme", [], []);
    expect(html).toContain("in flight");
  });

  test("escapes client name and titles (no XSS)", () => {
    const html = formatHtml("<b>x</b>", [item({ title: "<script>alert(1)</script>", shipped_at: "2026-05-10T00:00:00Z" })], []);
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;b&gt;");
  });
});
