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
 * Golden-file tests (SPEC.md section 6) pinned on fictional Tallyhall release
 * bodies that reproduce the format quirks: v1.20.0 (details blocks + gating),
 * v1.19.2 (fix-heavy), the uniformly indented v1.18.0, single-entry v1.17.4,
 * baseline v1.0.0, and the 21-entry v1.16.0.
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
    expect(text).toContain("\n### Tallyhall - Receipt preview in mobile approval notifications\n");
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
    ["Why Tallyhall", "other"],
    ["What's in v1.0.0", "other"],
  ] as const)("%s -> %s", (header, expected) => {
    expect(classifySectionHeader(header)).toBe(expected);
  });
});

describe("entry part helpers", () => {
  test("detectProductArea", () => {
    expect(detectProductArea("Tallyhall - Receipt preview in approvals")).toBe("Tallyhall");
    expect(detectProductArea("Tallyhall Mobile - Mileage from trip history")).toBe("Tallyhall Mobile");
    expect(detectProductArea("Tallyhall / Tallyhall Mobile - Push delivery")).toBe(
      "Tallyhall / Tallyhall Mobile",
    );
    expect(detectProductArea("Tallyhall — em-dash prefix still parses")).toBe("Tallyhall");
    expect(detectProductArea("Scheduled exports no longer skipped")).toBe("unspecified");
  });

  test("extractPrRefs dedupes and sorts", () => {
    expect(extractPrRefs("Ships #1031 then #1012, reverted by #1066 (#1012)")).toEqual([
      1012, 1031, 1066,
    ]);
  });

  test("detectFlags covers the gating vocabulary", () => {
    expect(detectFlags("reads are flag-gated for now")).toEqual(["flag_gated"]);
    expect(detectFlags("only in the internal admin app")).toEqual(["internal_only"]);
    expect(detectFlags("running in shadow mode")).toEqual(["shadow"]);
    expect(detectFlags("advisory only, no enforcement")).toEqual(["advisory"]);
    expect(detectFlags("merged and then reverted by #1066, net effect is zero")).toEqual([
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
      "Auto-approval - policy rules for low-risk expenses across cards, mileage & per diem",
    );
    expect(entries[1]!.title).toBe(
      "Reports & Exports - unified cost center picker (values grouped by entity)",
    );
  });

  test("ledger dual-write details block is flag_gated with PR ref 1031", () => {
    const ch = entries.find((e) => e.title.startsWith("Ledger store dual-write"))!;
    expect(ch.section_type).toBe("technical");
    expect(ch.flags).toEqual(["flag_gated"]);
    expect(ch.pr_refs).toEqual([1031]);
  });

  test("Scope & rollback block carries flag_gated + reverted and all PR refs", () => {
    const scope = entries.find((e) => e.title === "Scope & rollback")!;
    expect(scope.flags).toEqual(["flag_gated", "reverted"]);
    expect(scope.pr_refs).toEqual([1012, 1031, 1061, 1063, 1065, 1066, 1069]);
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
      "Split expenses no longer show $0 reimbursable when one line is personal",
    );
    expect(entries[0]!.section_type).toBe("fix");
  });

  test("duplicate-detection entry is advisory-flagged", () => {
    const grav = entries.find((e) => e.title.startsWith("Wider duplicate detection coverage"))!;
    expect(grav.flags).toContain("advisory");
  });
});

describe("golden: v1.18.0 (uniformly indented body)", () => {
  const entries = parse("v1.18.0");

  test("1 feature, 1 fix, 2 technical details blocks", () => {
    expect(entries.map((e) => e.section_type)).toEqual(["feature", "fix", "technical", "technical"]);
  });

  test("product areas parsed from the dash title prefix", () => {
    expect(entries[0]!.title).toBe("Tallyhall - Receipt preview in mobile approval notifications");
    expect(entries[0]!.product_area).toBe("Tallyhall");
    expect(entries[1]!.product_area).toBe("Tallyhall / Tallyhall Mobile");
  });

  test("details summary HTML is stripped", () => {
    expect(entries[2]!.title).toBe("Receipt preview rendering");
    expect(entries[3]!.title).toBe("Push delivery - skip expired device tokens");
  });
});

describe("golden: v1.17.4 (single-entry patch)", () => {
  const entries = parse("v1.17.4");

  test("exactly one fix entry, no flags", () => {
    expect(entries).toHaveLength(1);
    expect(entries[0]!.section_type).toBe("fix");
    expect(entries[0]!.product_area).toBe("Tallyhall");
    expect(entries[0]!.flags).toEqual([]);
    expect(entries[0]!.title).toBe(
      "Tallyhall - Receipts with a zero-tax line are no longer flagged as incomplete",
    );
  });
});

describe("golden: v1.0.0 (baseline mega-doc)", () => {
  const entries = parse("v1.0.0");

  test("collapses to one baseline entry titled from the H1", () => {
    expect(entries).toHaveLength(1);
    expect(entries[0]!.section_type).toBe("baseline");
    expect(entries[0]!.title).toBe("Tallyhall v1.0.0");
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
    expect(drop.pr_refs).toEqual([812, 907]);
  });
});

describe("persistEntries", () => {
  test("writes rows that round-trip the parsed fields", () => {
    const db = openTestDb();
    const releaseId = ulid();
    db.query(
      `INSERT INTO releases (id, repo, github_release_id, tag_name, body_md, published_at, fetched_at)
       VALUES (?, 'tallyhall/app', 1, 'v1.18.0', ?, ?, ?)`,
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
