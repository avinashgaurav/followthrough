import type { Database } from "bun:sqlite";
import { nowIso } from "../db.ts";
import { ulid } from "../ids.ts";

/**
 * Release body parser (SPEC.md section 6).
 *
 * Real XYZ/XYZ release notes follow a stable shape with drift:
 * H2 sections (Features / Fixes / Enhancements / Technical details), one H3
 * per customer-facing entry, <details> blocks for technical entries, a
 * uniformly indented variant (v1.18.0), a single-entry patch (v1.17.4), and
 * a baseline mega-doc with no classifiable sections (v1.0.0).
 */

export type SectionType = "feature" | "fix" | "technical" | "baseline" | "other";
export type EntryFlag = "flag_gated" | "internal_only" | "shadow" | "advisory" | "reverted";

export interface ParsedEntry {
  section_type: SectionType;
  title: string;
  body_md: string;
  /** 'XYZ' | 'XYZ Day' | 'XYZ / XYZ Day' | 'unspecified' */
  product_area: string;
  /** PR numbers referenced as #N. Format-validated only, not checked against GitHub. */
  pr_refs: number[];
  flags: EntryFlag[];
}

// ------------------------------------------------------------- normalization

/**
 * Normalize a raw release body:
 * - unify line endings
 * - drop "**Full Changelog**" trailer lines
 * - strip uniform leading indentation (the v1.18.0 case: every non-empty
 *   line is indented by the same amount)
 * - collapse multi-space markdown headers ("##  Feature" -> "## Feature")
 */
export function normalizeBody(raw: string): string {
  let lines = raw.replace(/\r\n/g, "\n").split("\n");
  lines = lines.filter((l) => !/^\*\*Full Changelog\*\*/.test(l.trim()));

  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent < minIndent) minIndent = indent;
    if (minIndent === 0) break;
  }
  if (minIndent > 0 && minIndent !== Infinity) {
    lines = lines.map((l) => l.slice(minIndent));
  }
  lines = lines.map((l) => l.replace(/^(#{1,6})[ \t]+/, "$1 ").replace(/[ \t]+$/, ""));
  return lines.join("\n");
}

// ---------------------------------------------------------- section handling

interface RawSection {
  header: string;
  content: string;
}

function splitH2Sections(text: string): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^## (.+)$/);
    if (m?.[1]) {
      if (current) sections.push(current);
      current = { header: m[1].trim(), content: "" };
    } else if (current) {
      current.content += line + "\n";
    }
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Fuzzy header classifier. Vocabulary observed across real releases:
 * Feature / Features / Enhancement / Enhancements / New Features &
 * Enhancements / What's New -> feature; Fix / Fixes / What's Fixed -> fix;
 * Technical details -> technical.
 */
export function classifySectionHeader(header: string): SectionType {
  const h = header
    .toLowerCase()
    .replace(/[^a-z0-9&' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (h.includes("technical")) return "technical";
  if (/\bfix/.test(h)) return "fix";
  if (/\bfeature/.test(h) || /\benhancement/.test(h) || h.includes("what's new")) return "feature";
  return "other";
}

function splitH3Entries(content: string): Array<{ title: string; body: string }> {
  const out: Array<{ title: string; body: string }> = [];
  let current: { title: string; body: string } | null = null;
  for (const line of content.split("\n")) {
    const m = line.match(/^### (.+)$/);
    if (m?.[1]) {
      if (current) out.push(current);
      current = { title: m[1].trim(), body: "" };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) out.push(current);
  return out.map((e) => ({ title: e.title, body: e.body.trim() }));
}

const DETAILS_RE = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g;

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

// --------------------------------------------------------------- entry parts

const PRODUCT_AREA_RE =
  /^(XYZ\s*\/\s*XYZ Day|XYZ Day\s*\/\s*XYZ|XYZ|XYZ Day)\s*[—–-]\s*/i;

export function detectProductArea(title: string): string {
  const m = title.match(PRODUCT_AREA_RE);
  if (!m?.[1]) return "unspecified";
  const raw = m[1].toLowerCase();
  if (raw.includes("/")) return "XYZ / XYZ Day";
  return raw === "xyz day" ? "XYZ Day" : "XYZ";
}

export function extractPrRefs(text: string): number[] {
  const refs = new Set<number>();
  for (const m of text.matchAll(/#(\d{1,6})\b/g)) refs.add(Number(m[1]));
  return [...refs].sort((a, b) => a - b);
}

/**
 * Gating / revert language. XYZ demonstrably ships dark: an entry that
 * is flag-gated, internal-only, shadow-mode, advisory, or reverted must never
 * be treated as customer-reachable proof of shipping (matcher caps to 50).
 */
const FLAG_RULES: Array<{ re: RegExp; flag: EntryFlag }> = [
  { re: /flag[- ]gated/, flag: "flag_gated" },
  { re: /\bbehind\b/, flag: "flag_gated" },
  { re: /\bgated\b/, flag: "flag_gated" },
  { re: /internal admin/, flag: "internal_only" },
  { re: /not customer[- ]reachable/, flag: "internal_only" },
  { re: /\bshadow\b/, flag: "shadow" },
  { re: /\badvisory\b/, flag: "advisory" },
  { re: /reverted by/, flag: "reverted" },
  { re: /net effect is zero/, flag: "reverted" },
];

export function detectFlags(text: string): EntryFlag[] {
  const lower = text.toLowerCase();
  const flags: EntryFlag[] = [];
  for (const rule of FLAG_RULES) {
    if (rule.re.test(lower) && !flags.includes(rule.flag)) flags.push(rule.flag);
  }
  return flags;
}

function makeEntry(sectionType: SectionType, title: string, body: string): ParsedEntry {
  const combined = title + "\n" + body;
  return {
    section_type: sectionType,
    title: title.trim(),
    body_md: body.trim(),
    product_area: detectProductArea(title.trim()),
    pr_refs: extractPrRefs(combined),
    flags: detectFlags(combined),
  };
}

// -------------------------------------------------------------------- parser

export function parseRelease(bodyMd: string, tagName: string): ParsedEntry[] {
  const text = normalizeBody(bodyMd);
  const entries: ParsedEntry[] = [];

  for (const section of splitH2Sections(text)) {
    const type = classifySectionHeader(section.header);
    if (type === "other") continue;

    if (type === "technical") {
      let found = false;
      for (const m of section.content.matchAll(DETAILS_RE)) {
        entries.push(makeEntry("technical", stripHtmlTags(m[1] ?? ""), (m[2] ?? "").trim()));
        found = true;
      }
      if (!found) {
        const h3s = splitH3Entries(section.content);
        for (const e of h3s) entries.push(makeEntry("technical", e.title, e.body));
        if (h3s.length === 0 && section.content.trim() !== "") {
          entries.push(makeEntry("technical", section.header, section.content.trim()));
        }
      }
      continue;
    }

    // customer-facing section: each H3 = one entry
    const h3s = splitH3Entries(section.content);
    for (const e of h3s) entries.push(makeEntry(type, e.title, e.body));
    if (h3s.length === 0 && section.content.trim() !== "") {
      // section with prose/bullets but no H3 headers: one entry for the section
      entries.push(makeEntry(type, section.header, section.content.trim()));
    }
  }

  // v1.0.0-style baseline doc: nothing classified -> the whole body is one entry
  if (entries.length === 0) {
    const h1 = text.match(/^# (.+)$/m)?.[1]?.trim();
    entries.push(makeEntry("baseline", h1 ?? tagName, text.trim()));
  }

  return entries;
}

// ------------------------------------------------------------------- persist

/** Insert parsed entries for a release. Returns the new entry ids in order. */
export function persistEntries(db: Database, releaseId: string, entries: ParsedEntry[]): string[] {
  const ids: string[] = [];
  const insert = db.query(
    `INSERT INTO release_entries (id, release_id, section_type, title, body_md, product_area, pr_refs_json, flags_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const e of entries) {
      const id = ulid();
      insert.run(
        id,
        releaseId,
        e.section_type,
        e.title,
        e.body_md,
        e.product_area,
        JSON.stringify(e.pr_refs),
        JSON.stringify(e.flags),
        nowIso(),
      );
      ids.push(id);
    }
  });
  tx();
  return ids;
}
