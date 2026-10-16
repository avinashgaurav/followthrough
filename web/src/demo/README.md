# Static read-only demo

`bun run build:demo` (in `web/`) builds the web app with no server behind it. `api.ts` hands every request to `static-api.ts`, which:

- answers each GET from `fixtures.json`, real responses recorded from a `DEMO_MODE` server seeded with the fictional meetings in `demo/` (status codes included, so blocked views look the same as on a hosted demo);
- filters the recorded insight list for filter combinations that were not recorded, and runs search as a plain substring match over recorded titles and transcripts;
- answers Ask only for the recorded example questions;
- refuses every write, upload and "process a meeting" action with a read-only notice, which the pages show the same way they show any API error.

Nothing calls a server or a model, so a visit costs nothing and nothing persists. The normal `bun run build` compiles all of this out (`__STATIC_DEMO__` is `false`).

Deployed on Vercel from this folder (`web/vercel.json`: Root Directory `web`).

## Regenerate the fixtures

The data is fictional. No API key is needed: the eval route `LLM_PROVIDER=claude-cli` uses a logged-in Claude Code CLI (see EVALS.md, "Method note").

```bash
export DEMO_MODE=true LLM_PROVIDER=claude-cli DATA_DIR=/tmp/ftdemo
bun run seed:demo --force
bun run build:web && bun run start &
bun run scripts/record-demo-fixtures.ts http://localhost:4500
```
