# Setup and development

Full install, every environment variable, running a public demo, and the development commands. Moved here from the [README](../README.md).

## Quick start

**Prerequisites:** [Bun](https://bun.sh) 1.3+. macOS or Linux.

```bash
git clone https://github.com/avinashgaurav/followthrough.git
cd followthrough
bun install

# Set your LLM key (one of these). Goes in .env, which is gitignored.
echo 'ANTHROPIC_API_KEY=sk-ant-...'    >> .env   # preferred (direct Anthropic)
# or
echo 'OPENROUTER_API_KEY=sk-or-...'    >> .env   # fallback, pinned to Claude, retention denied

# Tell the AI who it works for (see .env.example for every option)
echo 'PRODUCT_NAME=Acme'                 >> .env

# Build the web UI
bun run build:web

# Start the server (serves the API and the built UI on one port)
bun run start            # http://localhost:4500
```

The app serves on `http://localhost:4500` by default (set `PORT` to change it). **It's open by default**: no login required, and every visitor is an admin. Fine on your laptop; **turn on Require login before exposing it to the internet.** When you're ready to lock it down, go to **Settings → Access**, add a teammate (you get a one-time login code), then turn **Require login** on. Login is email + code. Any email can hold an account unless you set `ALLOWED_EMAIL_DOMAINS` (e.g. `acme.com`). You can also seed a first admin from the CLI with `bun run seed`.

<details>
<summary><b>Optional setup</b> (local transcription, backups, env vars)</summary>

```bash
# Local transcription for audio-only uploads: open source, no API key, audio never leaves your machine
bash scripts/setup-whisper.sh

# Nightly backups (SQLite snapshot + blob sync; restore notes in scripts/RESTORE.md)
bun run backup
```

| Env var | Purpose |
|---|---|
| `PORT` | server port (default `4500`) |
| `DATA_DIR` | where the SQLite database and blobs live (default `./data`) |
| `LLM_MODEL` | Anthropic model id (default `claude-opus-4-8`); `OPENROUTER_MODEL` is the OpenRouter equivalent (default `anthropic/claude-opus-4.8`) |
| `PRODUCT_NAME` | your company or product; the AI frames every insight and email around it (e.g. `Acme`) |
| `PRODUCT_DESCRIPTION` | one line on what you sell (e.g. `a payroll platform for SMBs`) |
| `ALLOWED_EMAIL_DOMAINS` | comma-separated domains allowed to hold accounts (e.g. `acme.com,acme.io`); unset = any email |
| `RELEASE_REPO` | `owner/name` of the GitHub repo whose releases are matched against client asks; unset = poller off (paste changelogs manually) |
| `WRITABLE_REPOS` | comma-separated `owner/name` repos the tool may create issues in; unset = direct creation off (copy-paste still works) |
| `BLOCKED_ORGS` | comma-separated GitHub orgs never written to, even if allowlisted |
| `GITHUB_READ_TOKEN` | poll a releases repo for changelog matching |
| `GITHUB_WRITE_TOKEN` | direct ticket creation in an allowlisted repo only |
| `DIGEST_WEBHOOK_URL` | Slack / Google Chat webhook for the weekly digest + nudges |
| `WATCH_DIR` | folder to auto-ingest dropped recordings |
| `DEEPGRAM_API_KEY` | cloud STT alternative to local whisper |
| `DEEPGRAM_KEYTERMS` | comma-separated terms to boost Deepgram accuracy (names, jargon) |
| `DEMO_MODE` | `true` = public read-only demo: writes and login off, team and calendar hidden, Ask rate-limited per IP, background jobs off |
| `DEMO_ASK_PER_HOUR` | Ask questions per visitor IP per hour in demo mode (default `10`) |
| `DEMO_ASK_GLOBAL_PER_HOUR` | Ask questions per hour across all visitors in demo mode (default `200`) |
| `LLM_DAILY_BUDGET_USD` | hard daily cap on AI spend; once reached, AI calls return 503 until the next UTC day (resets on restart). Demo mode defaults to `5` |
| `TRUSTED_PROXY_HOPS` | proxies in front of the server that append to `X-Forwarded-For` (default `1`, right for Railway/Render/Fly; `0` ignores XFF). Drives login lockout and demo rate limits |
| `TRUST_CF_CONNECTING_IP` | `true` only when the server is reachable solely through Cloudflare |
| `ACCESS_PASSWORD` | optional shared team password: any allowed-domain email + this signs in as a member. **Set `ALLOWED_EMAIL_DOMAINS` too**, or the password alone admits any email |

</details>

## Run a public demo

`DEMO_MODE=true` turns an instance into a read-only showcase, and `bun run seed:demo` fills an empty database with three fictional client meetings (Acme, Globex, Initech for a made-up product, Tallyhall) run through the real extraction pipeline, plus a changelog that ships two of the asks and a closed loop for one client. The Docker image runs the demo seed automatically on first boot when `DEMO_MODE` is on.

```bash
DEMO_MODE=true LLM_DAILY_BUDGET_USD=5 PRODUCT_NAME=Tallyhall bun run seed:demo && bun run start
```

Seeding makes real LLM calls once and is all-or-nothing: a failure leaves the database untouched and the next boot retries. Mount a persistent volume at `DATA_DIR`, or every redeploy re-seeds (and re-spends). Demo mode caps AI spend at $5/day unless `LLM_DAILY_BUDGET_USD` says otherwise.

The hosted demo linked from the README needs no server at all: `cd web && bun run build:demo` builds a static, read-only copy of the web app that serves responses recorded from a seeded `DEMO_MODE` instance and refuses every write. No model calls, nothing persists between visitors. How it works and how to re-record the fixtures: [`web/src/demo/README.md`](../web/src/demo/README.md).

## Development

```bash
bun run dev            # server with --watch
cd web && bun run dev  # vite dev server, proxies /api to :4500
bun test               # 337 tests
bunx tsc --noEmit      # typecheck
bun run evals          # extraction quality scoring (needs an LLM key)
```

CI (`.github/workflows/ci.yml`, on pushes to `main` and on pull requests) typechecks the server, web app and extension, runs the test suite, and builds the web app and extension. It does not run the LLM evals.

The full product contract lives in [`SPEC.md`](../SPEC.md). Design references are in [`design-reference/`](../design-reference/).
