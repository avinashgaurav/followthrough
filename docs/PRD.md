# Followthrough: product brief

One page. Every number below is either read from the code or labelled as a target or an estimate. Nothing here has been measured on real customer meetings.

## User

The people in a small B2B software company who are on client calls and make promises on them: the founder, account managers and customer success. One admin sets it up; teammates review and route.

## Job to be done

"When a client asks for something on a call, make sure it is tracked until it ships and the client hears that it shipped, without me keeping a spreadsheet."

## Problem

A client asks for a feature on a call. It may ship weeks later, and nobody tells the client. Call notes are summaries you read once, tickets lose the client's own words, and nobody can say how long an ask took to go from "said" to "shipped" to "told".

## Non-goals

- Not a meeting recorder or note taker. It takes transcripts or audio from any tool.
- Never contacts a client or files a ticket on its own. A person sends every email and raises every ticket.
- Not a CRM. It exports a CSV shaped for Zoho import instead of syncing.
- No vector search or embeddings in v1. Full-text search plus a model judge covers matching at this scale.

## How it works

- **Extract.** The model pulls typed items (feature request, complaint, commitment and so on) from the transcript. Code keeps only items whose quote is found word for word in the transcript.
- **Verify and merge.** A second model pass drops weak or mistyped items; a repeat ask becomes a new mention on the existing item, not a duplicate.
- **Review.** A person routes, rewords and finalizes each item. Nothing moves past this gate automatically.
- **Prove it shipped.** New release notes are matched to open asks by the model; code scores the match (80 full, 50 partial, capped for gated entries) and only a human click confirms it.
- **Close the loop.** The model drafts the client email; copying it is logged. Every step is an event on an append-only log, which is where all timings come from.

## North-star metric

**Median end-to-end turnaround: meeting uploaded to client told**, in days. Computed today from the event log (`end_to_end` in `src/metrics/queries.ts`) and shown on the admin Speed page.

Target: **median under 30 days** (target, not yet measured).

## Supporting metrics

1. **Closed-loop rate per client:** share of finalized asks where the client was told (`closed_loop_pct`, already computed).
2. **AI quality in use:** discard rate and mean edit-distance ratio between the model's draft and the final wording (already computed).
3. **Extraction quality on the golden set:** recall, precision, citation validity and type accuracy from `bun run evals`. No eval results are committed yet.

## Release threshold

A prompt or model change ships only if, on the 4 fictional golden cases (targets, not yet measured):

- recall at least 0.8 and precision at least 0.8 averaged across cases;
- zero items extracted from `02-hooli` (the no-asks call) and from the prompt-injection line in `04-umbrella-freight`;
- all 331 tests pass and `bunx tsc --noEmit` is clean.

## Cost per task

**Estimate, about $0.17 to $0.27 per meeting** with a transcript up to 12,000 characters (one chunk). Not yet measured; the app already logs real cost per extraction run in `extraction_runs.cost_usd`.

Arithmetic: default model `claude-opus-4-8` at $5 input and $25 output per million tokens (`src/llm/provider.ts`), about 4 characters per token, adaptive thinking on.

- Five calls: extraction (4,927-char prompt plus the 12,000-char chunk), verifier (1,195 plus the chunk plus items), clustering, dedup against open asks, and the meeting brief (1,698 plus the transcript). About 55,000 characters in total, roughly 14,000 input tokens, so about $0.07.
- Output including thinking: assumed 4,000 to 8,000 tokens, so $0.10 to $0.20.
- Each further 11,000 characters of transcript adds one extraction and one verifier call, roughly $0.08 more.
