# Followthrough

Turn recorded client meetings into tracked, evidenced, closed-loop commitments.

Followthrough is a meeting-intelligence tool. You feed it a meeting (transcript or audio). It extracts the real asks, complaints, and between-the-lines signals, each anchored to the client's exact words. A human reviews and polishes each one, routes it to a track, and moves it down a pipeline: ticket raised, proof it shipped, client told. Every step is timestamped, so an admin can see how fast asks travel from meeting to shipped to told, per client and per track.

Nothing moves to a client without a person deciding it should. The AI drafts; people decide.

> This is a personal project. The bundled sample meetings under `evals/golden/` are fully synthetic — every company, person, and product name is fictional.

---

## The pipeline in one line

Capture a meeting, extract insights, review and finalize, raise a ticket, confirm it shipped, tell the client, measure the whole loop.

```
meeting ─▶ extract ─▶ review/finalize ─▶ ticket ─▶ shipped (proof) ─▶ client told ─▶ closed
            (AI)        (human gate)      (human)    (changelog match)   (email copy)
```

---

## Quick start

Prerequisites: [Bun](https://bun.sh) 1.3+. macOS or Linux.

```bash
cd followthrough
bun install

# Set your LLM key (one of these). Goes in .env, which is gitignored.
echo 'ANTHROPIC_API_KEY=sk-ant-...'    >> .env   # preferred (direct Anthropic)
# or
echo 'OPENROUTER_API_KEY=sk-or-...'    >> .env   # fallback, pinned to Claude models, retention denied

# Build the web UI and create your admin login
bun run build:web        # if this script is absent, run: cd web && bun install && bun run build
bun run seed             # prints a one-time login code for the seeded admin email

# Start the server (serves the API and the built UI on one port)
bun run start            # http://localhost:4500
```

Open http://localhost:4500, sign in with the seeded admin email and the code `seed` printed. Account creation is locked to a single configurable email domain (see `src/config.ts`).

### Optional setup

```bash
# Local transcription for audio-only uploads (open source, no API key, audio never leaves your machine)
bash scripts/setup-whisper.sh

# Nightly backups (SQLite snapshot + blob sync; restore notes in scripts/)
bun run backup
```

Other useful env vars (all optional): `PORT` (default 4500), `GITHUB_READ_TOKEN` (to poll a releases repo for changelog matching), `GITHUB_WRITE_TOKEN` (for direct ticket creation in an allowlisted repo only), `DIGEST_WEBHOOK_URL` (Slack/Google Chat incoming webhook for the weekly digest), `WATCH_DIR` (folder to auto-ingest dropped recordings), `DEEPGRAM_API_KEY` (cloud STT alternative to whisper).

---

## How you use it (the seven tabs)

The sidebar is the pipeline, top to bottom. Press `?` anywhere for the keyboard shortcuts; press `Cmd/Ctrl-K` for the command palette (jump to anything, run any action).

- **Capture** — Get a meeting in. Pick it from your connected calendar or fill it manually; type-ahead the client (or create a new one inline); confirm consent; paste a transcript, upload a file, or upload audio. Then extract.
- **Review** — The split-pane triage screen. Your queue on the left grouped by what needs you ("New from AI", "Needs final wording", "Ready for a ticket", "Confirm it shipped?", "Tell the client"); the selected insight's detail on the right. Polish the wording, route it, finalize. `j`/`k` move, `Enter` opens.
- **Insights** — Everything ever learned, filterable and searchable across transcripts and quotes.
- **Clients** — Per client: the meeting timeline (#1, #2, #3...), every open ask, the promise ledger, a one-click pre-call brief, and a CSV export for your CRM.
- **Proof** — When a release ships, the system proposes which client asks it closes, with the changelog evidence and a confidence score. You confirm or reject. Confirming marks the insight shipped and unlocks the client email.
- **Numbers** (admin) — Turnaround times per stage and track, the funnel, what's stuck, demand by theme, per-person throughput, per-client closed-loop rate, and AI quality. Every metric has a plain-words tooltip.
- **Settings** (admin) — Add teammates (each gets a one-time login code), connect the calendar feed, poll releases, preview the weekly digest, rebuild search.

---

## What makes the extraction good

One-shot "summarize this call" produces mush. The pipeline is multi-pass and verified (`src/extract/`):

1. **Clean and chunk** the transcript (handles hour-long calls; mixed English/Hindi quotes preserved verbatim).
2. **Typed extraction** — each item is a specific type (feature request, complaint, key insight, our action, their commitment, status update), including the between-the-lines subtext (fears, internal politics, ROI pressure, frustration with incumbents).
3. **Citation gate** — every item must carry a verbatim quote that is programmatically verified to exist in the transcript. No quote, no insight. This structurally kills hallucinations.
4. **Verifier pass** — an independent LLM judge drops items whose quote does not support the claim or whose type is wrong.
5. **Dedup/merge** — a repeat ask attaches as a new mention on the existing insight (the "requested by N clients" signal) instead of a duplicate.
6. **Meeting brief** — a chief-of-staff synthesis (key readings, between the lines, lessons, action items grouped by owner team).

The **eval flywheel**: every human edit and discard during Review is captured. `evals/` drafts golden cases from your transcripts and scores recall, precision, citation validity, and type accuracy on every prompt change. See `evals/README.md`.

---

## Architecture

One runtime, one source of truth.

- **Bun + TypeScript** end to end. `Bun.serve` HTTP server; `bun:sqlite` database (WAL).
- **React + Vite** SPA in `web/`, served from `web/dist` by the same server. Design system: dark-only, single-accent, `Cmd-K` command palette, vim-style keyboard nav.
- **The event log is the source of truth.** `events` is an append-only table (enforced by triggers); an insight's state is a cache rebuilt from it. Every turnaround-time metric is a query over the log, never a hand-maintained timestamp column. See `schema.sql` and `src/events.ts`.
- **LLM**: Anthropic direct (or OpenRouter pinned to Claude with retention denied). Structured outputs via Zod schemas. `src/llm/provider.ts`.
- **Storage**: metadata and transcripts in SQLite; audio/screenshots/CSVs as content-addressed blobs behind `media_assets` (local disk now, S3-ready).

### Module map (`src/`)

| Module | Responsibility |
|---|---|
| `auth`, `auth-routes` | email + login-code auth, sessions, rate-limited login, email-domain lock |
| `ingest` | clients, contacts, meetings, uploads, transcripts, dedup |
| `extract` | the multi-pass extraction pipeline + meeting brief |
| `insights` | triage, finalize, merge, lifecycle, my-queue, full-text search |
| `tickets` | draft-first GitHub issues; org-safety write allowlist |
| `evidence`, `emails` | completion evidence (all tracks) and client follow-up drafts |
| `releases` | release poller + changelog matcher + confirm queue |
| `metrics`, `exports`, `digest` | admin dashboard, CSV export, weekly digest |
| `calendar` | read-only iCal intake for capture prefill |
| `stt` | local whisper.cpp transcription |
| `watchfolder`, `retention` | folder auto-ingest; consent/deletion purge |

---

## Safety rules baked in

- **Never writes to a protected GitHub org.** Reads only. Direct ticket creation is blocked to a config allowlist in code (`src/config.ts`); a protected org cannot be targeted even by accident. Tickets are draft-first: a human creates the issue and pastes the URL back, or creates it directly only in an allowlisted repo.
- **Consent gate.** A meeting cannot be processed until consent is confirmed at upload.
- **No auto-send.** The confidence score only suggests "shipped"; a human confirms before any client email exists. Copy-to-clipboard is the send proxy, and the copy moment is the tracked timestamp.
- **Retention.** A meeting can be purged (audio, transcript, and derived quotes) while keeping the insight record. `DELETE /api/meetings/:id`.

---

## Development

```bash
bun run dev          # server with --watch
cd web && bun run dev  # vite dev server, proxies /api to :4500
bun test             # 282 tests
bunx tsc --noEmit    # typecheck
bun run evals        # extraction quality scoring (needs an LLM key)
```

The full product contract lives in `SPEC.md`. The design references are in `design-reference/`.
