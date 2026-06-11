#!/usr/bin/env bun
/**
 * Draft a golden eval case from a raw transcript (SPEC.md section 5).
 *
 *   bun run evals/draft-golden.ts <path-to-raw-transcript.txt> [client-name] [--force] [--no-verify]
 *
 * Runs the REAL extraction prompts (and verifier pass) on the cleaned and
 * chunked transcript, then writes evals/golden/cases/<slug>.json marked as
 * a DRAFT. The founder edits that file to correct it; the corrected file is
 * the golden label. This script is offline: it never writes to the app
 * database and never overwrites an existing case file unless --force.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getLLM, type LLM } from "../src/llm/provider.ts";
import {
  CASES_DIR,
  DRAFT_NOTE,
  clientNameFromFile,
  extractOffline,
  hasRealLLMKey,
  slugify,
  toRepoRelative,
  type GoldenCase,
} from "./lib.ts";

export interface DraftResult {
  caseFile: string;
  slug: string;
  itemCount: number;
  chunkCount: number;
  extractedCount: number;
  citationDropped: number;
  verifierDropped: number;
  duplicateDropped: number;
  costUsd: number;
}

export async function draftGolden(opts: {
  transcriptPath: string;
  clientName?: string;
  outDir?: string;
  force?: boolean;
  verify?: boolean;
  llm?: LLM;
}): Promise<DraftResult> {
  const absPath = resolve(opts.transcriptPath);
  if (!existsSync(absPath)) {
    throw new Error(`Transcript file not found: ${absPath}`);
  }
  const raw = readFileSync(absPath, "utf8");
  if (raw.trim() === "") {
    throw new Error(`Transcript file is empty: ${absPath}`);
  }

  const slug = slugify(basename(absPath).replace(/\.[^.]*$/, ""));
  const outDir = opts.outDir ?? CASES_DIR;
  const caseFile = join(outDir, `${slug}.json`);
  if (existsSync(caseFile) && !opts.force) {
    throw new Error(
      `Case file already exists: ${caseFile}. It may contain founder corrections. Re-run with --force to overwrite.`,
    );
  }

  const llm = opts.llm ?? getLLM();
  const extraction = await extractOffline(llm, raw, { verify: opts.verify });

  const goldenCase: GoldenCase = {
    transcript_file: toRepoRelative(absPath),
    client_name: opts.clientName ?? clientNameFromFile(absPath),
    drafted_at_note: DRAFT_NOTE,
    expected_items: extraction.predicted.map((p) => ({
      item_type: p.item_type,
      title: p.title,
      body: p.body,
      quote: p.quote,
    })),
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(caseFile, JSON.stringify(goldenCase, null, 2) + "\n");

  return {
    caseFile,
    slug,
    itemCount: extraction.predicted.length,
    chunkCount: extraction.chunkCount,
    extractedCount: extraction.extractedCount,
    citationDropped: extraction.citationDropped,
    verifierDropped: extraction.verifierDropped,
    duplicateDropped: extraction.duplicateDropped,
    costUsd: extraction.usage.costUsd,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const verify = !args.includes("--no-verify");
  const positional = args.filter((a) => !a.startsWith("--"));
  const transcriptPath = positional[0];
  const clientName = positional[1];

  if (!transcriptPath) {
    console.error("Usage: bun run evals/draft-golden.ts <path-to-raw-transcript.txt> [client-name] [--force] [--no-verify]");
    console.error("Example: bun run evals/draft-golden.ts evals/golden/raw/01-bloomnest.txt \"BloomNest\"");
    process.exit(1);
  }

  if (!hasRealLLMKey()) {
    console.error("No real LLM key found. Drafting a golden case runs the live extraction prompts,");
    console.error("which MockLLM cannot answer. Set ANTHROPIC_API_KEY (preferred) or OPENROUTER_API_KEY");
    console.error("in .env and re-run.");
    process.exit(1);
  }

  try {
    const result = await draftGolden({ transcriptPath, clientName, force, verify });
    console.log(`Drafted ${result.itemCount} item(s) -> ${result.caseFile}`);
    console.log(
      `  chunks: ${result.chunkCount}, extracted: ${result.extractedCount}, ` +
        `citation drops: ${result.citationDropped}, verifier drops: ${result.verifierDropped}, ` +
        `duplicates: ${result.duplicateDropped}, cost: $${result.costUsd.toFixed(4)}`,
    );
    console.log("Next: open the case file, correct the items (delete invented ones, add missed ones,");
    console.log("fix types and titles), then remove the DRAFT note. The corrected file is the golden label.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
