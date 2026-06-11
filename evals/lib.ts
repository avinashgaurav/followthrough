/**
 * Shared library for the extraction eval harness (SPEC.md section 5).
 * Offline only: runs the REAL extraction prompts against a transcript file
 * without ever touching the app database.
 *
 * Used by draft-golden.ts (drafts a case for founder correction) and
 * run-evals.ts (scores predicted vs founder-corrected expected output).
 */

import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { LLM } from "../src/llm/provider.ts";
import {
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionResponseSchema,
  ItemTypeSchema,
  VERIFIER_SYSTEM_PROMPT,
  VerifierResponseSchema,
  extractionUserPrompt,
  verifierUserPrompt,
  type ItemType,
} from "../src/extract/prompts.ts";
import {
  buildQuoteMatcher,
  chunkTranscript,
  cleanTranscript,
} from "../src/extract/segment.ts";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const RAW_DIR = join(REPO_ROOT, "evals", "golden", "raw");
export const CASES_DIR = join(REPO_ROOT, "evals", "golden", "cases");
export const RESULTS_DIR = join(REPO_ROOT, "evals", "results");

export const DRAFT_NOTE = "DRAFT - founder must correct";

// ---------------------------------------------------------------- golden case files

export const ExpectedItemSchema = z.object({
  item_type: ItemTypeSchema,
  title: z.string(),
  body: z.string(),
  quote: z.string(),
});
export type ExpectedItem = z.infer<typeof ExpectedItemSchema>;

export const GoldenCaseSchema = z.object({
  transcript_file: z.string(),
  client_name: z.string(),
  drafted_at_note: z.string().optional(),
  expected_items: z.array(ExpectedItemSchema),
});
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

// ---------------------------------------------------------------- small helpers

/** True when a real provider key is configured (Anthropic direct or OpenRouter). */
export function hasRealLLMKey(): boolean {
  const anthropic = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  const openrouter = (process.env.OPENROUTER_API_KEY ?? "").trim();
  return anthropic !== "" || openrouter !== "";
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "case" : slug;
}

/** Derive a presentable client name from a transcript filename, e.g. "01-BloomNest.txt" -> "BloomNest". */
export function clientNameFromFile(path: string): string {
  const base = basename(path).replace(/\.[^.]*$/, "");
  const words = base
    .replace(/^\d+[-_ ]*/, "")
    .split(/[-_ ]+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return base;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

/** Store repo-internal paths relative to the repo root so cases survive a clone. */
export function toRepoRelative(path: string): string {
  const abs = resolve(path);
  const rel = relative(REPO_ROOT, abs);
  return rel.startsWith("..") ? abs : rel;
}

export function resolveFromRepo(path: string): string {
  return isAbsolute(path) ? path : join(REPO_ROOT, path);
}

// ---------------------------------------------------------------- offline extraction

export interface LLMCallUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface PredictedItem {
  item_type: ItemType;
  title: string;
  body: string;
  /** Exact transcript substring, as resolved by the citation gate. */
  quote: string;
  speaker: string | null;
}

export interface OfflineExtraction {
  cleaned: string;
  chunkCount: number;
  /** Raw items returned by the extraction pass, before any gate. */
  extractedCount: number;
  /** Items whose quote failed the exact-substring citation gate. */
  citationDropped: number;
  /** Items dropped by the verifier judge. */
  verifierDropped: number;
  /** Items whose verbatim quote was already produced earlier in this run. */
  duplicateDropped: number;
  /** What the app pipeline would persist for this transcript. */
  predicted: PredictedItem[];
  usage: LLMCallUsage;
}

/**
 * Mirror of the app extraction pipeline (src/extract/pipeline.ts) minus the
 * database: clean -> chunk -> typed extraction -> citation gate -> verifier
 * -> within-run quote dedup. The citation gate is the SAME exact check the
 * app uses: the quote must be a substring of the cleaned transcript
 * (whitespace runs compare equal to one space, case-sensitive, no fuzziness).
 */
export async function extractOffline(
  llm: LLM,
  rawTranscript: string,
  opts: { verify?: boolean } = {},
): Promise<OfflineExtraction> {
  const verify = opts.verify ?? true;
  const cleaned = cleanTranscript(rawTranscript);
  const chunks = chunkTranscript(cleaned);
  const findQuote = buildQuoteMatcher(cleaned);

  const usage: LLMCallUsage = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  const addUsage = (u: { tokensIn: number; tokensOut: number; costUsd: number }): void => {
    usage.calls++;
    usage.tokensIn += u.tokensIn;
    usage.tokensOut += u.tokensOut;
    usage.costUsd += u.costUsd;
  };

  let extractedCount = 0;
  let citationDropped = 0;
  let verifierDropped = 0;
  let duplicateDropped = 0;
  const predicted: PredictedItem[] = [];
  const seenQuotes = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const ext = await llm.completeJSON({
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: extractionUserPrompt(chunk.text, i, chunks.length),
      schema: ExtractionResponseSchema,
    });
    addUsage(ext);
    extractedCount += ext.data.items.length;

    // Citation gate: no citation, no insight. Identical to the app pipeline.
    const cited: Array<{ item: (typeof ext.data.items)[number]; verbatim: string }> = [];
    for (const item of ext.data.items) {
      const match = findQuote(item.quote);
      if (!match) {
        citationDropped++;
        continue;
      }
      cited.push({ item, verbatim: match.verbatim });
    }
    if (cited.length === 0) continue;

    let kept = cited;
    if (verify) {
      const ver = await llm.completeJSON({
        system: VERIFIER_SYSTEM_PROMPT,
        prompt: verifierUserPrompt(
          cited.map((c, index) => ({
            index,
            item_type: c.item.item_type,
            title: c.item.title,
            body: c.item.body,
            quote: c.item.quote,
            speaker: c.item.speaker,
          })),
          chunk.text,
        ),
        schema: VerifierResponseSchema,
      });
      addUsage(ver);
      // Missing verdict defaults to keep, same as the app pipeline.
      const dropped = new Set(ver.data.verdicts.filter((v) => !v.keep).map((v) => v.index));
      kept = cited.filter((_, index) => {
        if (dropped.has(index)) {
          verifierDropped++;
          return false;
        }
        return true;
      });
    }

    for (const c of kept) {
      if (seenQuotes.has(c.verbatim)) {
        duplicateDropped++;
        continue;
      }
      seenQuotes.add(c.verbatim);
      predicted.push({
        item_type: c.item.item_type,
        title: c.item.title,
        body: c.item.body,
        quote: c.verbatim,
        speaker: c.item.speaker,
      });
    }
  }

  return {
    cleaned,
    chunkCount: chunks.length,
    extractedCount,
    citationDropped,
    verifierDropped,
    duplicateDropped,
    predicted,
    usage,
  };
}

// ---------------------------------------------------------------- matching judge

export const JudgePairsSchema = z.object({
  pairs: z.array(
    z.object({
      predicted_index: z.int(),
      expected_index: z.int().nullable(),
      same_item: z.boolean(),
    }),
  ),
});
export type JudgePairs = z.infer<typeof JudgePairsSchema>;

export const MATCH_JUDGE_SYSTEM_PROMPT = `You compare two lists of intelligence items extracted from the same client meeting transcript: PREDICTED items produced by an extraction pipeline, and EXPECTED items labeled by a human as the correct output.

Pair them up. A predicted item and an expected item are the same item when they capture the same underlying ask, complaint, insight, commitment, or status update, even if the wording, title, type label, or chosen quote differs. Topical similarity alone is not enough: two different asks touching the same feature area are different items.

Return exactly one pair entry per predicted item, in order of predicted_index:
- If it matches an expected item: set expected_index to that item's index and same_item to true.
- If it matches nothing: set expected_index to null and same_item to false.
Each expected item may be used by at most one predicted item; if two predicted items both look like the same expected item, pair the closer one and leave the other unmatched. Never invent indexes.`;

export function matchJudgeUserPrompt(
  predicted: Array<{ item_type: string; title: string; body: string; quote: string }>,
  expected: Array<{ item_type: string; title: string; body: string; quote: string }>,
): string {
  return [
    "PREDICTED items (from the extraction pipeline):",
    JSON.stringify(
      predicted.map((p, predicted_index) => ({ predicted_index, ...p })),
      null,
      2,
    ),
    "",
    "EXPECTED items (human-labeled golden output):",
    JSON.stringify(
      expected.map((e, expected_index) => ({ expected_index, ...e })),
      null,
      2,
    ),
  ].join("\n");
}

// ---------------------------------------------------------------- scoring (pure)

export interface MatchedPair {
  predicted_index: number;
  expected_index: number;
  type_match: boolean;
}

export interface CaseScores {
  expectedCount: number;
  predictedCount: number;
  matched: MatchedPair[];
  /** Expected item indexes the pipeline missed (recall failures). */
  missedExpected: number[];
  /** Predicted item indexes matching nothing expected (precision failures). */
  unmatchedPredicted: number[];
  recall: number | null;
  precision: number | null;
  typeAccuracy: number | null;
}

/**
 * Turn judge pairs into scores. Pure function, no LLM.
 * Trust boundary: only indexes that were actually presented count, each
 * predicted and each expected index at most once (first valid pair wins).
 */
export function scorePairs(
  predicted: Array<{ item_type: string }>,
  expected: Array<{ item_type: string }>,
  pairs: JudgePairs["pairs"],
): CaseScores {
  const usedPredicted = new Set<number>();
  const usedExpected = new Set<number>();
  const matched: MatchedPair[] = [];

  for (const pair of pairs) {
    if (!pair.same_item || pair.expected_index === null) continue;
    const p = pair.predicted_index;
    const e = pair.expected_index;
    if (p < 0 || p >= predicted.length || e < 0 || e >= expected.length) continue;
    if (usedPredicted.has(p) || usedExpected.has(e)) continue;
    usedPredicted.add(p);
    usedExpected.add(e);
    matched.push({
      predicted_index: p,
      expected_index: e,
      type_match: predicted[p]!.item_type === expected[e]!.item_type,
    });
  }

  const missedExpected = expected.map((_, i) => i).filter((i) => !usedExpected.has(i));
  const unmatchedPredicted = predicted.map((_, i) => i).filter((i) => !usedPredicted.has(i));
  const typeCorrect = matched.filter((m) => m.type_match).length;

  return {
    expectedCount: expected.length,
    predictedCount: predicted.length,
    matched,
    missedExpected,
    unmatchedPredicted,
    recall: expected.length === 0 ? null : usedExpected.size / expected.length,
    precision: predicted.length === 0 ? null : usedPredicted.size / predicted.length,
    typeAccuracy: matched.length === 0 ? null : typeCorrect / matched.length,
  };
}
