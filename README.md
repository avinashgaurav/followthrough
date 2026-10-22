<div align="center">

# Followthrough

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.3+-fbf0df?logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-337%20passing-brightgreen.svg)](docs/SETUP.md#development)
[![LLM: Claude](https://img.shields.io/badge/LLM-Claude-d97757.svg)](https://www.anthropic.com/)

</div>

A client asks for a feature on a call, it ships weeks later, and nobody tells the client; Followthrough tracks each ask from the client's exact words to "shipped" to "client told".

**Live demo:** https://followthrough-demo-neon.vercel.app (read-only, fictional meetings; run it yourself to process your own calls).

> [!TIP]
> **In pilot:** a sales team is trying followthrough on its own client calls.

![Demo: Home, Review and Capture screens on fictional data](docs/demo.gif)

> [!NOTE]
> **How well it works.** It was tested on 4 made-up calls with 24 expected requests, complaints and commitments. One call has nothing to act on. One transcript contains planted instructions for the AI (a prompt injection).
>
> | Measure | Prompt v5 | Prompt v6 |
> |---|---|---|
> | Of the items it flagged, how many were right (precision) | 24 / 34 (71%) | **22 / 22 (100%)** |
> | Of the items it should have found, how many it found (recall) | 24 / 24 (100%) | **22 / 24 (92%)** |
> | Items pulled from the call with nothing to act on | 4 | **0** |
> | Planted instruction turned into an item | Yes (reported, not followed) | **No** |
>
> **Test on new calls** (4 new made-up calls the tool had never been tuned on, 38 expected items; the correct answers were saved before the AI saw any call, the prompt was not changed, and the test ran 3 times): every item it flagged was right in every run (**100%**). It found **76%** of expected items (71% to 79%). It pulled nothing from the call with nothing to act on, and the planted instruction never became an item. The missed items come from one known weakness: when one person makes two commitments, v6 often merges the second into the first.
>
> Limits: the data is made up. The tests ran through the Claude Code command-line tool, not the way the live app calls the AI. The v5 and v6 columns use the 4 calls used while building the prompt. The correct answers for the new calls were written by the author. How it was tested, and every miss: [EVALS.md](EVALS.md).

## Why AI here, why code there

| Step | Done by | Why |
|---|---|---|
| Pull asks, complaints and commitments out of a transcript; verify them; draft tickets, emails and the meeting brief | Model (`src/extract/`, `src/emails/`, `src/tickets/`) | Reading intent and subtext from speech is a language task. |
| Keep an item only if its quote appears word for word in the transcript | Code (`buildQuoteMatcher` in `src/extract/segment.ts`) | Whether a quote exists is a fact to check, not a judgment. No quote, no item. |
| Triage, reword, route and finalize; confirm a release really shipped an ask | A person (Review and Confirm shipped screens) | The client relationship is on the line, so a human signs off every outward step. |
| Pipeline state, allowed transitions, and every turnaround time | Code (`src/events.ts`, `schema.sql`, `src/metrics/queries.ts`) | Timings must be exact and auditable, so they come from an append-only event log. |

## Quick start

Needs [Bun](https://bun.sh) 1.3+.

```bash
git clone https://github.com/avinashgaurav/followthrough.git && cd followthrough
bun install
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env
bun run build:web && bun run start   # http://localhost:4500, open by default: turn on Require login before exposing it
```

## More

- [docs/PRD.md](docs/PRD.md): product brief: user, problem, metrics, cost per meeting.
- [EVALS.md](EVALS.md): how the tests were run, the results and every miss.
- [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md): screenshots, how it differs from a summarizer, and what each screen is for.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the pipeline, multi-pass extraction, runtime and safety rules.
- [docs/SETUP.md](docs/SETUP.md): full setup, every env var, public demo mode, development.
- [SPEC.md](SPEC.md): the full product contract.

## License

[MIT](LICENSE) © 2026 Avinash Gaurav
