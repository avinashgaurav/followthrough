# Static read-only demo

`bun run build:demo` (in `web/`) builds the web app with no server behind it. `api.ts` hands every request to `static-api.ts`, which:

- answers each GET from `fixtures.json`, real responses recorded from a `DEMO_MODE` server seeded with the fictional meetings in `demo/` (status codes included, so blocked views look the same as on a hosted demo);
- filters the recorded insight list for filter combinations that were not recorded, and runs search as a plain substring match over recorded titles and transcripts;
- answers Ask only for the recorded example questions;
- refuses every write, upload and "process a meeting" action with a read-only notice, which the pages show the same way they show any API error.

Nothing calls a server or a model, so a visit costs nothing and nothing persists.

## Timestamps are moved at page load

The seed processes all three meetings within a few minutes, so every recorded timestamp sits on the recording day and every age would read "today" forever. `liven.ts` rewrites the fixtures once, when the demo loads, relative to that moment. It is deterministic for a given load time:

- Meeting dates move by whole days so the latest one lands 7 days before today. The demo meetings were recorded a week apart, so they read 21, 14 and 7 days ago.
- Each meeting's processing (client, meeting, transcript, extracted insights and their "extracted" events) moves onto that meeting's new date at 15:00 UTC, keeping the real seconds between steps.
- Everything recorded after the last extraction (triage, the v2.4.0 release, release matches, shipped, client told) is split into bursts wherever the recording paused for more than a second. The bursts are spread evenly from the day after the last meeting to just over a day ago, so the newest activity reads "1d".
- Values the server derived from those timestamps follow: insight `age_days`, "(state, Nd old)" and "(shipped date)" in client briefs and the digest, the digest heading (today), other recording-day dates in prose such as email drafts, and the WIP-aging buckets and stuck-items list on Numbers.
- Not recomputed: stage turnaround times, weekly funnel and per-person week labels, and the digest's "new this week" grouping. They stay as recorded.

`liven.test.ts` (run by the root `bun test`) pins this behaviour against the recorded fixtures. It assumes the recorder's order: meetings processed one at a time, then triage and release work afterwards. The normal `bun run build` compiles all of this out (`__STATIC_DEMO__` is `false`).

Deployed on Vercel from this folder (`web/vercel.json`: Root Directory `web`).

## Regenerate the fixtures

The data is fictional. No API key is needed: the eval route `LLM_PROVIDER=claude-cli` uses a logged-in Claude Code CLI (see EVALS.md, "Method note").

```bash
export DEMO_MODE=true LLM_PROVIDER=claude-cli DATA_DIR=/tmp/ftdemo
bun run seed:demo --force
bun run build:web && bun run start &
bun run scripts/record-demo-fixtures.ts http://localhost:4500
```
