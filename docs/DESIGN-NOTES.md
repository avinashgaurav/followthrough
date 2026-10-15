# Design notes

What the product is, what it looks like, how it differs from a meeting summarizer, and what each screen is for. Moved here from the [README](../README.md).

## What it is

### Turn recorded client meetings into tracked, evidenced, closed-loop commitments.

*Meeting → extract → review → ticket → shipped → client told → closed. Every step timestamped.*

A salesperson promises a customer a feature on a call. Three weeks later it ships. Nobody tells the customer. The relationship quietly erodes. **Followthrough closes that loop.**

You feed it a meeting: transcript or audio. It extracts the real asks, complaints, and between-the-lines signals, each anchored to the client's exact words. A human reviews and polishes each one, routes it to a track, and moves it down a pipeline: ticket raised → proof it shipped → client told. Every transition is an event on an append-only log, so you can measure exactly how fast an ask travels from *said* to *shipped* to *told*, per client, per theme, per person.

> **The AI drafts; people decide.** Nothing reaches a client without a human confirming it. Every extracted insight must cite a verbatim quote from the transcript, or it doesn't exist.

> [!NOTE]
> All bundled data is **fictional**: the demo meetings in `demo/`, the eval transcripts and answer keys in `evals/golden/` (written by hand), and the release-note fixtures in `src/releases/fixtures/`. They are set around a made-up expense-software company, **Tallyhall**, and its made-up clients (Acme, Globex, Initech, Northwind Traders, Hooli, Vandelay Imports, Umbrella Freight). No real customer meetings are in this repo.

Product brief (user, problem, metrics, cost per meeting): [docs/PRD.md](PRD.md).

## Screenshots

The "Transcript Spine" UI: cinematic dark chrome, a single signal-amber accent, editorial serif headers, and a single plain-English vocabulary.

| Home (what needs you now) | Review (triage workspace) |
|:---:|:---:|
| ![Home dashboard](screenshots/home.png) | ![Review screen](screenshots/review.png) |

| Ask (cited Q&A over your meetings) | Capture (get a meeting in) |
|:---:|:---:|
| ![Ask screen](screenshots/ask.png) | ![Capture screen](screenshots/capture.png) |

| Settings (open by default; login is optional) | Sign in (only when login is required) |
|:---:|:---:|
| ![Settings access](screenshots/settings.png) | ![Login screen](screenshots/login.png) |

> Screenshots use the fictional demo data (clients Acme, Globex and Initech). A fresh install starts with an empty database; `bun run seed:demo` loads the demo.

## Why it's different

| Most "meeting summarizers" | Followthrough |
|---|---|
| One-shot "summarize this call" → mush | Multi-pass, typed extraction with an independent verifier |
| Hallucinated takeaways | **Citation gate**: no verbatim quote, no insight, enforced in code |
| A summary you read once and lose | A pipeline that tracks each ask until the client is told |
| Auto-sends / auto-files | Human gate at every outward step; AI never contacts a client |
| Timestamps maintained by hand | Append-only event log is the single source of truth |
| Black-box "AI quality" | An eval harness (`bun run evals`) that scores recall, precision & citation validity, run by hand after a prompt change |

## How you use it: the tabs

The sidebar *is* the pipeline, top to bottom. Press `?` for shortcuts, `Cmd/Ctrl-K` for the command palette.

| Tab | What it's for |
|---|---|
| **Home** | The "what needs you right now" dashboard: the pipeline at a glance (found → routed → shipped → client told), recent meetings, and a jump straight into the queue. |
| **Capture** | Get a meeting in, from your calendar or manually. Type-ahead the client, confirm consent, paste a transcript or upload audio, then extract. |
| **Review** | The split-pane triage screen. Queue grouped by what needs you (*New from AI*, *Needs final wording*, *Ready for a ticket*, *Confirm it shipped?*, *Tell the client*). Polish, route, finalize. Brief-first: triage or reject many insights from one meeting in a single pass. `j`/`k` to move, `Enter` to open. |
| **Ask** | Ask a plain-English question and get an answer drawn **only** from your own meetings and insights, every claim cited back to the exact insight or transcript so you can verify it. Search finds the sources in your own database; the model only writes the answer from them. |
| **Library** | Everything ever learned, filterable and searchable across transcripts and quotes. |
| **Clients** | Per client: meeting timeline, every open ask, the promise ledger, a one-click pre-call brief, CSV export for your CRM, and a shareable client-facing "you asked, we shipped" page. |
| *Meeting page* | Opened from any meeting row (not a sidebar tab). A single meeting's full readout: transcript, the brief, and every insight it produced, each attributed to a side (client vs us) with sentiment and intent. |
| **Confirm shipped** | When a release ships, the system proposes which client asks it closes, with changelog evidence and a confidence score. Confirm to mark *shipped* and unlock the client email. |
| **Speed** *(admin)* | Turnaround times per stage, the funnel, what's stuck, demand by theme, per-person throughput, per-client closed-loop rate, AI quality. Every metric has a plain-words tooltip. |
| **Settings** *(admin)* | Access mode (open vs login-required), teammates, calendar feed, release polling, digest preview, rebuild search, and system health. |

## Evals

4 fictional calls with 24 expected asks, complaints and commitments (21 written down before the run, 3 added after review), including a friendly check-in with nothing actionable and a transcript carrying a prompt injection. Method and every miss: [EVALS.md](../EVALS.md).

| Measure | Prompt v5 | Prompt v6 |
|---|---|---|
| Extracted items that are real (precision) | 24 / 34 (71%) | 22 / 22 (100%) |
| Expected items found (recall) | 24 / 24 (100%) | 22 / 24 (92%) |
| Items from the nothing-actionable call | 4 | 0 |
| Injected instruction turned into an item | Yes (reported, not obeyed) | No |

v5 rescored by hand on the corrected key; v6 is a live run. In v6 the code-side injection guard did not fire: the model never proposed the injected line as an item.

v6 traded some recall for precision: it merges or skips secondary commitments, which is the next fix. The prompt was tuned on these same 4 calls, so a held-out set is still needed. Run through the Claude Code CLI with the app's own prompts, not the production API path; an API rerun is planned.
