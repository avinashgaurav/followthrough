#!/usr/bin/env bun
/**
 * Score the extraction prompts against the founder-corrected golden set
 * (SPEC.md section 5).
 *
 *   bun run evals/run-evals.ts [--only <name>] [--no-verify]
 *
 * For each evals/golden/cases/*.json: re-run the real extraction pipeline
 * (offline, no app database) on the case's transcript, then score predicted
 * vs expected:
 *   citation validity  fraction of raw extracted quotes that are exact
 *                      substrings of the transcript (the app's citation gate)
 *   recall             expected items the pipeline found
 *   precision          predicted items that match some expected item
 *   type accuracy      matched pairs with the same item_type
 * Matching is one LLM judge call per case. Prints a per-case table plus an
 * overall summary and writes evals/results/<run-iso>.json.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PROMPT_VERSION } from "../src/extract/prompts.ts";
import { DEFAULT_MODEL, getLLM, type LLM } from "../src/llm/provider.ts";
import {
  CASES_DIR,
  GoldenCaseSchema,
  JudgePairsSchema,
  MATCH_JUDGE_SYSTEM_PROMPT,
  RESULTS_DIR,
  extractOffline,
  hasRealLLMKey,
  matchJudgeUserPrompt,
  resolveFromRepo,
  scorePairs,
} from "./lib.ts";

export interface CaseResult {
  case_file: string;
  client_name: string;
  transcript_file: string;
  still_draft: boolean;
  chunk_count: number;
  extracted_count: number;
  citation_dropped: number;
  verifier_dropped: number;
  duplicate_dropped: number;
  expected_count: number;
  predicted_count: number;
  citation_validity: number | null;
  recall: number | null;
  precision: number | null;
  type_accuracy: number | null;
  matched: Array<{
    predicted_title: string;
    expected_title: string;
    predicted_type: string;
    expected_type: string;
    type_match: boolean;
  }>;
  missed_expected: string[];
  unmatched_predicted: string[];
  cost_usd: number;
  error?: string;
}

export interface OverallSummary {
  cases: number;
  failures: number;
  still_draft: number;
  expected_total: number;
  predicted_total: number;
  citation_validity: number | null;
  recall: number | null;
  precision: number | null;
  type_accuracy: number | null;
  cost_usd: number;
}

export interface RunEvalsResult {
  results: CaseResult[];
  overall: OverallSummary;
  resultsFile: string | null;
}

function errorResult(caseFile: string, message: string): CaseResult {
  return {
    case_file: caseFile,
    client_name: "",
    transcript_file: "",
    still_draft: false,
    chunk_count: 0,
    extracted_count: 0,
    citation_dropped: 0,
    verifier_dropped: 0,
    duplicate_dropped: 0,
    expected_count: 0,
    predicted_count: 0,
    citation_validity: null,
    recall: null,
    precision: null,
    type_accuracy: null,
    matched: [],
    missed_expected: [],
    unmatched_predicted: [],
    cost_usd: 0,
    error: message,
  };
}

function pct(x: number | null): string {
  return x === null ? "-" : `${Math.round(x * 100)}%`;
}

function row(cells: Array<{ text: string; width: number; right?: boolean }>): string {
  return cells
    .map((c) => (c.right ? c.text.padStart(c.width) : c.text.padEnd(c.width)))
    .join("  ");
}

const COLS = [28, 4, 4, 5, 6, 5, 5, 8] as const;

function tableHeader(): string {
  return row([
    { text: "CASE", width: COLS[0] },
    { text: "EXP", width: COLS[1], right: true },
    { text: "PRED", width: COLS[2], right: true },
    { text: "CIT", width: COLS[3], right: true },
    { text: "RECALL", width: COLS[4], right: true },
    { text: "PREC", width: COLS[5], right: true },
    { text: "TYPE", width: COLS[6], right: true },
    { text: "COST$", width: COLS[7], right: true },
  ]);
}

function tableRow(name: string, r: CaseResult): string {
  return row([
    { text: name.slice(0, COLS[0]), width: COLS[0] },
    { text: String(r.expected_count), width: COLS[1], right: true },
    { text: String(r.predicted_count), width: COLS[2], right: true },
    { text: pct(r.citation_validity), width: COLS[3], right: true },
    { text: pct(r.recall), width: COLS[4], right: true },
    { text: pct(r.precision), width: COLS[5], right: true },
    { text: pct(r.type_accuracy), width: COLS[6], right: true },
    { text: r.cost_usd.toFixed(4), width: COLS[7], right: true },
  ]);
}

async function evaluateCase(
  llm: LLM,
  caseFilePath: string,
  verify: boolean,
): Promise<CaseResult> {
  const fileName = basename(caseFilePath);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(caseFilePath, "utf8"));
  } catch (err) {
    return errorResult(fileName, `Unreadable case file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = GoldenCaseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return errorResult(fileName, `Case file failed validation: ${parsed.error.message}`);
  }
  const goldenCase = parsed.data;

  const transcriptPath = resolveFromRepo(goldenCase.transcript_file);
  if (!existsSync(transcriptPath)) {
    return errorResult(fileName, `Transcript not found: ${transcriptPath}`);
  }
  const transcript = readFileSync(transcriptPath, "utf8");

  const extraction = await extractOffline(llm, transcript, { verify });
  let costUsd = extraction.usage.costUsd;

  // One judge call per case pairs predicted items with expected items.
  let pairs: Array<{ predicted_index: number; expected_index: number | null; same_item: boolean }> = [];
  if (extraction.predicted.length > 0 && goldenCase.expected_items.length > 0) {
    const judged = await llm.completeJSON({
      system: MATCH_JUDGE_SYSTEM_PROMPT,
      prompt: matchJudgeUserPrompt(
        extraction.predicted.map((p) => ({
          item_type: p.item_type,
          title: p.title,
          body: p.body,
          quote: p.quote,
        })),
        goldenCase.expected_items,
      ),
      schema: JudgePairsSchema,
    });
    costUsd += judged.costUsd;
    pairs = judged.data.pairs;
  }

  const scores = scorePairs(extraction.predicted, goldenCase.expected_items, pairs);

  return {
    case_file: fileName,
    client_name: goldenCase.client_name,
    transcript_file: goldenCase.transcript_file,
    still_draft: (goldenCase.drafted_at_note ?? "").toUpperCase().includes("DRAFT"),
    chunk_count: extraction.chunkCount,
    extracted_count: extraction.extractedCount,
    citation_dropped: extraction.citationDropped,
    verifier_dropped: extraction.verifierDropped,
    duplicate_dropped: extraction.duplicateDropped,
    expected_count: scores.expectedCount,
    predicted_count: scores.predictedCount,
    citation_validity:
      extraction.extractedCount === 0
        ? null
        : (extraction.extractedCount - extraction.citationDropped) / extraction.extractedCount,
    recall: scores.recall,
    precision: scores.precision,
    type_accuracy: scores.typeAccuracy,
    matched: scores.matched.map((m) => ({
      predicted_title: extraction.predicted[m.predicted_index]!.title,
      expected_title: goldenCase.expected_items[m.expected_index]!.title,
      predicted_type: extraction.predicted[m.predicted_index]!.item_type,
      expected_type: goldenCase.expected_items[m.expected_index]!.item_type,
      type_match: m.type_match,
    })),
    missed_expected: scores.missedExpected.map((i) => goldenCase.expected_items[i]!.title),
    unmatched_predicted: scores.unmatchedPredicted.map((i) => extraction.predicted[i]!.title),
    cost_usd: costUsd,
  };
}

function summarize(results: CaseResult[]): OverallSummary {
  let expectedTotal = 0;
  let predictedTotal = 0;
  let matchedExpected = 0;
  let matchedPredicted = 0;
  let matchedPairs = 0;
  let typeCorrect = 0;
  let extracted = 0;
  let citationValid = 0;
  let costUsd = 0;
  let failures = 0;
  let stillDraft = 0;

  for (const r of results) {
    costUsd += r.cost_usd;
    if (r.error) {
      failures++;
      continue;
    }
    if (r.still_draft) stillDraft++;
    expectedTotal += r.expected_count;
    predictedTotal += r.predicted_count;
    matchedExpected += r.expected_count - r.missed_expected.length;
    matchedPredicted += r.predicted_count - r.unmatched_predicted.length;
    matchedPairs += r.matched.length;
    typeCorrect += r.matched.filter((m) => m.type_match).length;
    extracted += r.extracted_count;
    citationValid += r.extracted_count - r.citation_dropped;
  }

  return {
    cases: results.length,
    failures,
    still_draft: stillDraft,
    expected_total: expectedTotal,
    predicted_total: predictedTotal,
    citation_validity: extracted === 0 ? null : citationValid / extracted,
    recall: expectedTotal === 0 ? null : matchedExpected / expectedTotal,
    precision: predictedTotal === 0 ? null : matchedPredicted / predictedTotal,
    type_accuracy: matchedPairs === 0 ? null : typeCorrect / matchedPairs,
    cost_usd: costUsd,
  };
}

export async function runEvals(
  opts: {
    casesDir?: string;
    resultsDir?: string;
    llm?: LLM;
    verify?: boolean;
    only?: string;
    writeResults?: boolean;
    log?: (line: string) => void;
  } = {},
): Promise<RunEvalsResult> {
  const casesDir = opts.casesDir ?? CASES_DIR;
  const resultsDir = opts.resultsDir ?? RESULTS_DIR;
  const verify = opts.verify ?? true;
  const log = opts.log ?? console.log;
  const llm = opts.llm ?? getLLM();

  let files = existsSync(casesDir)
    ? readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort()
    : [];
  if (opts.only) {
    const needle = opts.only.toLowerCase();
    files = files.filter((f) => f.toLowerCase().includes(needle));
  }

  log(tableHeader());
  const results: CaseResult[] = [];
  for (const file of files) {
    let result: CaseResult;
    try {
      result = await evaluateCase(llm, join(casesDir, file), verify);
    } catch (err) {
      result = errorResult(file, err instanceof Error ? err.message : String(err));
    }
    results.push(result);
    if (result.error) {
      log(`${file.padEnd(28)}  FAILED: ${result.error}`);
    } else {
      const draftTag = result.still_draft ? " (still DRAFT)" : "";
      log(tableRow(file.replace(/\.json$/, ""), result) + draftTag);
    }
  }

  const overall = summarize(results);
  log("");
  log(
    `Overall: ${overall.cases} case(s), ${overall.expected_total} expected, ${overall.predicted_total} predicted | ` +
      `citation ${pct(overall.citation_validity)}, recall ${pct(overall.recall)}, ` +
      `precision ${pct(overall.precision)}, type ${pct(overall.type_accuracy)} | ` +
      `cost $${overall.cost_usd.toFixed(4)}`,
  );
  if (overall.failures > 0) {
    log(`${overall.failures} case(s) FAILED to run; see errors above.`);
  }
  if (overall.still_draft > 0) {
    log(
      `${overall.still_draft} case(s) still carry the DRAFT note. Correct them and remove the note before trusting these scores.`,
    );
  }

  let resultsFile: string | null = null;
  if (opts.writeResults ?? true) {
    const runIso = new Date().toISOString();
    mkdirSync(resultsDir, { recursive: true });
    resultsFile = join(resultsDir, `${runIso.replace(/[:.]/g, "-")}.json`);
    writeFileSync(
      resultsFile,
      JSON.stringify(
        {
          run_at: runIso,
          prompt_version: PROMPT_VERSION,
          default_model: DEFAULT_MODEL,
          verifier_pass: verify,
          overall,
          cases: results,
        },
        null,
        2,
      ) + "\n",
    );
    log(`Results written to ${resultsFile}`);
  }

  return { results, overall, resultsFile };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const verify = !args.includes("--no-verify");
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;

  if (!hasRealLLMKey()) {
    console.error("No real LLM key found. Evals re-run the live extraction prompts and an LLM judge,");
    console.error("which MockLLM cannot answer. Set ANTHROPIC_API_KEY (preferred) or OPENROUTER_API_KEY");
    console.error("in .env and re-run.");
    process.exit(1);
  }

  const caseFiles = existsSync(CASES_DIR)
    ? readdirSync(CASES_DIR).filter((f) => f.endsWith(".json"))
    : [];
  if (caseFiles.length === 0) {
    console.error(`No golden cases found in ${CASES_DIR}.`);
    console.error('Draft one first: bun run evals/draft-golden.ts evals/golden/raw/<file>.txt "Client Name"');
    console.error("Then correct the drafted case file and re-run this command.");
    process.exit(1);
  }

  const { overall } = await runEvals({ verify, only });
  process.exit(overall.failures > 0 ? 1 : 0);
}
