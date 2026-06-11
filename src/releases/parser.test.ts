import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import {
  classifySectionHeader,
  detectFlags,
  detectProductArea,
  extractPrRefs,
  normalizeBody,
  parseRelease,
  persistEntries,
  type ParsedEntry,
} from "./parser.ts";

/**
 * Golden-file tests (SPEC.md section 6) pinned on real XYZ/XYZ release
 * bodies: v1.20.0 (details blocks + gating), v1.19.2 (fix-heavy), the
 * uniformly indented v1.18.0, single-entry v1.17.4, baseline v1.0.0, and the
 * 21-entry v1.16.0.
 */

function fixture(tag: string): { body: string; tagName: string } {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${tag}.json`), "utf8")) as {
    body: string;
    tagName: string;
  };
}

function parse(tag: string): ParsedEntry[] {
  const f = fixture(tag);
  return parseRelease(f.body, f.tagName);
}

describe("normalizeBody", () => {
  test("strips uniform indentation (the v1.18.0 case)", () => {
    const text = normalizeBody(fixture("v1.18.0").body);
    expect(text).toContain("\n## Fixes\n");
    expect(text).toContain("\n### XYZ — Kubernetes node and workload cost breakdown\n");
  });

  test("drops Full Changelog trailer lines", () => {
    const text = normalizeBody(fixture("v1.17.4").body);
    expect(text).not.toContain("**Full Changelog**");
  });

  test("collapses multi-space headers", () => {
    expect(normalizeBody("##  Feature\nbody")).toBe("## Feature\nbody");
  });
});

describe("classifySectionHeader", () => {
  test.each([
    ["Feature", "feature"],
    ["Features", "feature"],
    ["Enhancement", "feature"],
    ["New Features & Enhancements", "feature"],
    ["What's New", "feature"],
    ["Fix", "fix"],
    ["Fixes", "fix"],
    ["What's Fixed", "fix"],
    ["Technical details", "technical"],
    ["Why XYZ", "other"],
    ["What's in v1.0.0", "other"],
  ] as const)("%s -> %s", (header, expected) => {
    expect(classifySectionHeader(header)).toBe(expected);
  });
});

describe("entry part helpers", () => {
  test("detectProductArea", () => {
    expect(detectProductArea("XYZ — Kubernetes cost breakdown")).toBe("XYZ");
    expect(detectProductArea("XYZ Day — Deploy to AWS VMs")).toBe("XYZ Day");
    expect(detectProductArea("XYZ / XYZ Day — GCP onboarding")).toBe("XYZ / XYZ Day");
    expect(detectProductArea("Scheduled starts no longer skipped")).toBe("unspecified");
  });

  test("extractPrRefs dedupes and sorts", () => {
    expect(extractPrRefs("Ships #1655 then #1608, reverted by #1696 (#1608)")).toEqual([
      1608, 1655, 1696,
    ]);
  });

  test("detectFlags covers the gating vocabulary", () => {
    expect(detectFlags("reads are flag-gated for now")).toEqual(["flag_gated"]);
    expect(detectFlags("only in the internal admin app")).toEqual(["internal_only"]);
    expect(detectFlags("running in shadow mode")).toEqual(["shadow"]);
    expect(detectFlags("advisory only, no enforcement")).toEqual(["advisory"]);
    expect(detectFlags("merged and then reverted by #1696, net effect is zero")).toEqual([
      "reverted",
    ]);
    expect(detectFlags("plain customer-facing fix")).toEqual([]);
  });
});

describe("golden: v1.20.0 (features + details blocks + gating)", () => {
  const entries = parse("v1.20.0");

  test("2 feature entries and 6 technical entries", () => {
    expect(entries).toHaveLength(8);
    expect(entries.filter((e) => e.section_type === "feature")).toHaveLength(2);
    expect(entries.filter((e) => e.section_type === "technical")).toHaveLength(6);
  });

  test("feature titles", () => {
    expect(entries[0]!.title).toBe(
      "Auto-remediation — rightsizing / config rule class across AWS, Azure & GCP",
    );
    expect(entries[1]!.title).toBe(
      "Architecture & Cost Reports — unified tag picker (values grouped by key)",
    );
  });

  test("ClickHouse details block is flag_gated with PR ref 1655", () => {
    const ch = entries.find((e) => e.title.startsWith("Aggregator ClickHouse"))!;
    expect(ch.section_type).toBe("technical");
    expect(ch.flags).toEqual(["flag_gated"]);
    expect(ch.pr_refs).toEqual([1655]);
  });

  test("Scope & rollback block carries flag_gated + reverted and all PR refs", () => {
    const scope = entries.find((e) => e.title === "Scope & rollback")!;
    expect(scope.flags).toEqual(["flag_gated", "reverted"]);
    expect(scope.pr_refs).toEqual([1608, 1655, 1681, 1685, 1693, 1696, 1699]);
  });
});

describe("golden: v1.19.2 (fix burst + advisory flag)", () => {
  const entries = parse("v1.19.2");

  test("3 fixes, 2 features, 7 technical", () => {
    expect(entries).toHaveLength(12);
    expect(entries.filter((e) => e.section_type === "fix")).toHaveLength(3);
    expect(entries.filter((e) => e.section_type === "feature")).toHaveLength(2);
    expect(entries.filter((e) => e.section_type === "technical")).toHaveLength(7);
  });

  test("first fix title pinned", () => {
    expect(entries[0]!.title).toBe(
      "Part-time and ephemeral instances no longer show $0 savings on stop/idle recommendations",
    );
    expect(entries[0]!.section_type).toBe("fix");
  });

  test("Graviton rightsizing entry is advisory-flagged", () => {
    const grav = entries.find((e) => e.title.startsWith("Wider rightsizing coverage"))!;
    expect(grav.flags).toContain("advisory");
  });
});

describe("golden: v1.18.0 (uniformly indented body)", () => {
  const entries = parse("v1.18.0");

  test("1 feature, 1 fix, 2 technical details blocks", () => {
    expect(entries.map((e) => e.section_type)).toEqual(["feature", "fix", "technical", "technical"]);
  });

  test("product areas parsed from the em-dash title prefix", () => {
    expect(entries[0]!.title).toBe("XYZ — Kubernetes node and workload cost breakdown");
    expect(entries[0]!.product_area).toBe("XYZ");
    expect(entries[1]!.product_area).toBe("XYZ / XYZ Day");
  });

  test("details summary HTML is stripped", () => {
    expect(entries[2]!.title).toBe("K8s workload cost attribution");
    expect(entries[3]!.title).toBe("GCP onboarding — skip org-scoped roles");
  });
});

describe("golden: v1.17.4 (single-entry patch)", () => {
  const entries = parse("v1.17.4");

  test("exactly one fix entry, no flags", () => {
    expect(entries).toHaveLength(1);
    expect(entries[0]!.section_type).toBe("fix");
    expect(entries[0]!.product_area).toBe("XYZ");
    expect(entries[0]!.flags).toEqual([]);
    expect(entries[0]!.title).toBe(
      "XYZ — Permissions restricted by an Organization policy are no longer flagged as missing",
    );
  });
});

describe("golden: v1.0.0 (baseline mega-doc)", () => {
  const entries = parse("v1.0.0");

  test("collapses to one baseline entry titled from the H1", () => {
    expect(entries).toHaveLength(1);
    expect(entries[0]!.section_type).toBe("baseline");
    expect(entries[0]!.title).toBe("XYZ v1.0.0");
    expect(entries[0]!.body_md.length).toBeGreaterThan(1000);
  });
});

describe("golden: v1.16.0 (large mixed release)", () => {
  const entries = parse("v1.16.0");

  test("5 features, 6 fixes, 10 technical", () => {
    expect(entries).toHaveLength(21);
    expect(entries.filter((e) => e.section_type === "feature")).toHaveLength(5);
    expect(entries.filter((e) => e.section_type === "fix")).toHaveLength(6);
    expect(entries.filter((e) => e.section_type === "technical")).toHaveLength(10);
  });

  test("validated PR refs survive on technical entries", () => {
    const drop = entries.find((e) => e.title.startsWith("Drop legacy"))!;
    expect(drop.pr_refs).toEqual([1409, 1554]);
  });
});

describe("persistEntries", () => {
  test("writes rows that round-trip the parsed fields", () => {
    const db = openTestDb();
    const releaseId = ulid();
    db.query(
      `INSERT INTO releases (id, repo, github_release_id, tag_name, body_md, published_at, fetched_at)
       VALUES (?, 'XYZ/XYZ', 1, 'v1.18.0', ?, ?, ?)`,
    ).run(releaseId, fixture("v1.18.0").body, nowIso(), nowIso());

    const parsed = parse("v1.18.0");
    const ids = persistEntries(db, releaseId, parsed);
    expect(ids).toHaveLength(parsed.length);

    const rows = db
      .query("SELECT * FROM release_entries WHERE release_id = ? ORDER BY rowid")
      .all(releaseId) as Array<{
      id: string;
      section_type: string;
      title: string;
      flags_json: string;
      pr_refs_json: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows.map((r) => r.section_type)).toEqual(parsed.map((e) => e.section_type));
    expect(JSON.parse(rows[0]!.flags_json)).toEqual(parsed[0]!.flags);
    expect(JSON.parse(rows[0]!.pr_refs_json)).toEqual(parsed[0]!.pr_refs);
  });
});
