#!/usr/bin/env bun
/**
 * Score the extraction prompts against the held-out set in evals/heldout/
 * (cases the prompt was never tuned on; key committed before any model call).
 *
 *   LLM_PROVIDER=claude-cli bun run evals/run-heldout.ts [--no-verify]
 *
 * Same scoring as run-evals.ts. Results go to evals/results/heldout-<run>.json
 * and every path printed is relative to the repo root.
 */

import { renameSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { REPO_ROOT, RESULTS_DIR, hasRealLLMKey } from "./lib.ts";
import { runEvals } from "./run-evals.ts";

const HELDOUT_CASES_DIR = join(REPO_ROOT, "evals", "heldout", "cases");

if (!hasRealLLMKey()) {
  console.error("No real LLM key found. Set ANTHROPIC_API_KEY or LLM_PROVIDER=claude-cli and re-run.");
  process.exit(1);
}

const verify = !process.argv.slice(2).includes("--no-verify");
const rel = (p: string) => relative(REPO_ROOT, p);
const { overall, resultsFile } = await runEvals({
  casesDir: HELDOUT_CASES_DIR,
  verify,
  log: (line) => {
    if (!line.startsWith("Results written to ")) console.log(line);
  },
});
if (resultsFile) {
  const target = join(RESULTS_DIR, `heldout-${basename(resultsFile)}`);
  renameSync(resultsFile, target);
  console.log(`Results written to ${rel(target)}`);
}
process.exit(overall.failures > 0 ? 1 : 0);
