# Architecture

The pipeline, how extraction is made trustworthy, the runtime, and the safety rules. Moved here from the [README](../README.md).

## The pipeline

```
meeting ─▶ extract ─▶ review/finalize ─▶ ticket ─▶ shipped (proof) ─▶ client told ─▶ closed
            (AI)        (human gate)      (human)    (changelog match)   (email copy)
```

Each arrow is a tracked, timestamped state transition. The funnel, the turnaround times, and the per-client closed-loop rate all fall out of the event log for free.

## What makes the extraction good

One-shot summarization produces mush. The pipeline is multi-pass and verified (`src/extract/`):

1. **Clean & chunk** the transcript into 12,000-character windows with 1,000 characters of overlap, so long calls fit; mixed English/Hindi quotes preserved verbatim.
2. **Typed extraction**: each item has a specific type (feature request, complaint, key insight, our action, their commitment) and captures the subtext: fears, internal politics, ROI pressure, frustration with incumbents. Each item is also attributed: **side** (client vs us, inferred from speaker labels + the attendee list), **sentiment**, and the client's underlying **intent**. The pass is deliberately selective: only decision-grade items, no small talk or restated points.
3. **Citation gate**: every item must carry a verbatim quote *checked in code to exist in the transcript*. No quote, no insight. This removes invented quotes by construction; the verifier deals with weak readings of real quotes.
4. **Verifier pass**: an independent LLM judge drops items whose quote doesn't support the claim, or whose type is wrong.
5. **Dedup / merge**: a repeat ask attaches as a new mention on the existing insight (the "requested by N clients" signal) instead of a duplicate.
6. **Meeting brief**: a chief-of-staff synthesis: key readings, between the lines, lessons, action items grouped by owner team.

**The eval flywheel:** every human edit and discard during Review is captured. `evals/` drafts golden cases from your transcripts and scores recall, precision, citation validity, and type accuracy when you run `bun run evals` after a prompt change (it needs an LLM key, so CI does not run it). See [`evals/README.md`](../evals/README.md).

## Architecture

One runtime, one source of truth.

- **Bun + TypeScript** end to end: `Bun.serve` HTTP server, `bun:sqlite` database (WAL).
- **React + Vite** SPA in `web/`, served from `web/dist` by the same server. Dark-only, single-accent, `Cmd-K` command palette, vim-style keyboard nav.
- **The event log is the source of truth.** `events` is an append-only table (enforced by triggers); an insight's state is a *cache* written in the same transaction as its event. Every turnaround-time metric is a query over the log, never a hand-maintained timestamp column. See `schema.sql` and `src/events.ts`.
- **LLM**: Anthropic direct (or OpenRouter pinned to Claude, retention denied). Structured outputs via Zod schemas, adaptive thinking, and a per-call cost log. Default model `claude-opus-4-8`. `src/llm/provider.ts`.
- **Storage**: metadata and transcripts in SQLite; audio/screenshots/CSVs as content-addressed blobs behind `media_assets` (local disk now, S3-ready).

<details>
<summary><b>Module map</b> (<code>src/</code>)</summary>

| Module | Responsibility |
|---|---|
| `auth`, `auth-routes` | email + login-code auth, optional shared-team password, sessions, rate-limited login, email-domain lock |
| `ingest` | clients, contacts, meetings, uploads, transcripts, dedup |
| `extract` | the multi-pass extraction pipeline + meeting brief |
| `insights` | triage, bulk triage/reject, finalize, merge, lifecycle, my-queue, full-text search, ask-your-memory (Q&A) |
| `tickets` | draft-first GitHub issues; org-safety write allowlist |
| `evidence`, `emails` | completion evidence (all tracks) and client follow-up drafts |
| `releases` | release poller + manual changelog intake + matcher + confirm queue |
| `share` | tokenized, public client-facing "you asked, we shipped" page |
| `metrics`, `exports`, `digest` | admin dashboard, CSV export, weekly digest |
| `notify` | fire-and-forget Slack / Google Chat nudges (extraction + daily summary) |
| `calendar` | read-only iCal intake for capture prefill (with SSRF guard) |
| `stt` | transcription: local whisper.cpp, or Deepgram cloud STT when a key is set |
| `watchfolder`, `retention` | folder auto-ingest; consent/deletion purge |

</details>

## Safety, by construction

- **Never writes to a protected GitHub org.** Direct ticket creation only reaches repos in `WRITABLE_REPOS`, and orgs in `BLOCKED_ORGS` are refused even if listed. Both are read at startup; there is no runtime override. Tickets are draft-first.
- **Consent gate.** A meeting can't be processed until consent is confirmed at upload.
- **No auto-send.** The confidence score only *suggests* "shipped"; a human confirms before any client email exists. Copy-to-clipboard is the send proxy, and the copy moment is the tracked timestamp.
- **Retention.** A meeting can be purged (audio, transcript, derived quotes) while keeping the insight record. `DELETE /api/meetings/:id`.
