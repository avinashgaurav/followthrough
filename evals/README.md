# Extraction evals: the quality flywheel

This folder is how you find out, with numbers, whether a prompt change made extraction better or worse. The idea is simple: you keep a small set of meetings where YOU have written down the correct answer. Every time the prompts change, the pipeline re-runs on those meetings and gets graded against your answers.

## One-time setup

Put a real LLM key in `.env` at the repo root: `ANTHROPIC_API_KEY` (preferred) or `OPENROUTER_API_KEY`. Everything here calls the live extraction prompts, so MockLLM cannot run it; the CLIs will tell you and exit if no key is set.

## The loop, step by step

### 1. Drop raw transcripts in `evals/golden/raw/`

Plain text files, one meeting each. 22 real meeting notes are already there.

### 2. Draft a case

```
bun run evals/draft-golden.ts evals/golden/raw/01-bloomnest.txt "BloomNest"
```

This runs the real extraction pipeline (offline, it never touches the app database) and writes `evals/golden/cases/01-BloomNest.json`. The file is marked `DRAFT - founder must correct`. It is the model's first guess, not the truth.

Cost note: each draft costs a couple of LLM calls per ~12k characters of transcript. Start with 5 to 10 cases; do not draft all 22 in one sitting.

### 3. Correct the case file, once

Open the JSON file and make it the answer key:

- Delete items the model invented or that are not worth tracking.
- Add items the model missed. Each needs `item_type`, `title`, `body`, and a `quote` copied exactly from the transcript (the quote is how the grader checks citations, so copy it verbatim).
- Fix wrong types, weak titles, and bodies.
- When you are done, remove the `drafted_at_note` line (or change it to anything without the word DRAFT). The eval runner warns about cases still marked DRAFT.

This corrected file is the golden label. `draft-golden` will refuse to overwrite it unless you pass `--force`, so your corrections are safe.

Valid `item_type` values: `feature_request`, `complaint`, `key_insight`, `action_item_ours`, `commitment_theirs`, `status_update`.

### 4. Run the evals after any prompt change

```
bun run evals
```

(That is the `evals` script in package.json; it runs `evals/run-evals.ts`.) For each case it re-runs extraction on the transcript and prints a table:

- **CIT (citation validity)**: of everything the model extracted, how much carried a quote that really is in the transcript. Low CIT means the model is fabricating quotes.
- **RECALL**: how many of your labeled items the pipeline found. Low recall means missed asks.
- **PREC (precision)**: how many of the pipeline's items match something you labeled. Low precision means invented or junk items.
- **TYPE**: of the matched items, how many got the right category.

Matching predicted items to your labels is done by one LLM judge call per case; citation checking is an exact substring check, no judgment involved.

Every run is also saved to `evals/results/<timestamp>.json` with per-case detail: exactly which labeled items were missed and which predicted items matched nothing. Compare two result files before and after a prompt edit and you know whether to keep the edit.

Useful flags: `--only BloomNest` runs a single case (cheap iteration), `--no-verify` skips the verifier pass if you want to grade the raw extraction prompt alone.

## The other half of the flywheel: the app itself

You do not have to label everything by hand. Normal daily use of the app generates training signal automatically:

- Every time someone edits an insight before finalizing it, the app keeps the original LLM text next to the final human text. The gap between them (edit distance) is a live quality gauge on the dashboard.
- Every discard with a reason is recorded. A recurring discard reason is the model telling you where it fails.

When you notice the same kind of mistake showing up in discards or heavy edits, turn that meeting into a golden case (steps 2 and 3 above). From then on, every prompt change is automatically graded on the exact failure that used to annoy you. That is the flywheel: use the app, notice a miss, pin it as a case, and the eval suite gets stricter forever.

## Files in this folder

- `golden/raw/` - raw transcripts, the input.
- `golden/cases/` - one JSON per transcript: your corrected answer key.
- `results/` - one JSON per eval run, timestamped.
- `draft-golden.ts` - drafts a case from a transcript for you to correct.
- `run-evals.ts` - grades the current prompts against all cases.
- `lib.ts` - shared offline extraction and scoring code.
- `evals.test.ts` - smoke tests for the scoring math (`bun test evals`), no network.
