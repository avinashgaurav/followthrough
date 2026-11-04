# Hosted mode (sign-up app on Supabase + Vercel)

`HOSTED_MODE=true` turns one deployment into a sign-up product: anyone can create
a workspace with their email, and each workspace gets a free meeting quota paid
from this deployment's AI key.

## How data is kept apart

- Every workspace has its **own Postgres schema** (`ws_<id>`) with the full app
  schema in it. A small `control` schema maps emails and sessions to workspaces
  and holds the quota and the deployment-wide AI spend tally.
- Every request is pinned to the caller's schema before any route runs
  (`src/hosted/routes.ts` `hostedDispatch`): each statement runs in a transaction
  that starts with `SET LOCAL search_path`, so the Supabase transaction pooler
  can never carry one workspace's path into another's query.
- Workspaces resolve names in their own schema and `extensions` only, never
  `public`, so a workspace cannot fall through to shared tables. The control
  migration moves `citext` into `extensions` (Supabase's default home for
  extensions, already on its default search path), so a single-tenant app in
  the same database keeps working.

## Limits that protect your bill

| Setting | Default | What it does |
|---|---|---|
| `FREE_MEETINGS_PER_WORKSPACE` | 5 | Meetings a workspace may create (transcribe + extract) |
| `MAX_WORKSPACES` | 300 | Sign-ups stop here |
| `LLM_DAILY_BUDGET_USD` | 5 | One daily AI cap across every workspace; over it, AI calls return 503 until the next UTC day |
| `WORKSPACE_DAILY_BUDGET_USD` | 1 | Each workspace's own daily AI cap inside the one above, so one workspace cannot spend everyone's budget |
| `MAX_MEMBERS_PER_WORKSPACE` | 10 | Teammates a workspace admin can invite |

Single-tenant features that would act with this deployment's credentials are
off: GitHub issue creation, the release poller, the digest webhook, the watch
folder, team-password / admin-code sign-in, the release poll, iCal calendar
feeds (server-side fetches), the evidence-link liveness check, and the
operator's chat webhook.

Invites are pending until the invitee signs in with their own email code and
chooses to join; they can create their own workspace instead.

## Set up

1. **Supabase**: create a new project.
   - Database URL: Project Settings, Database, Connection string, **Transaction pooler** (port 6543) → `DATABASE_URL`.
   - Project URL and **anon** key: Project Settings, API → `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
   - Authentication, URL Configuration: add `APP_URL/auth/callback` (exact, no wildcards) to **Redirect URLs**. People sign in by clicking the emailed link.
   - Optional, needs custom SMTP first: put `{{ .Token }}` in **Confirm signup** and **Magic Link** so the email also carries a typed code.
   - Authentication, SMTP: connect a sender (e.g. Resend). Supabase's built-in sender only allows a few emails an hour, which a launch will exceed.
2. **Vercel**: import the repo (root directory: repo root) and set
   `HOSTED_MODE=true`, `APP_URL` (the public URL), `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   one AI key (`ANTHROPIC_API_KEY` or `GEMINI_API_KEY`), `LLM_DAILY_BUDGET_USD`,
   and `CRON_SECRET`. The production build runs `bun run db:migrate`, which creates
   the `control` schema and migrates every workspace.
3. Sign up at your deployment URL with your own email to check the flow end to end.

## Sign-up while no email sender is connected

Until a custom SMTP sender is set up (issue #24), Supabase only emails members
of the project team, so the main path is **email + password**: an account and
its workspace are created at once. The email is not verified, so:

- anyone can register any address (each account is still its own isolated
  workspace with the free quota and AI caps);
- there is no password reset yet (it needs email);
- password accounts never pass the invite path, and an email that already has
  an account or a pending invite cannot be registered by password.

The emailed-link sign-in stays in the code and works for everyone once SMTP is
connected.

## What a user sees

Email, then the emailed code, then (first time only) "Company or product" and
"What you sell", which the AI uses to frame every ask. The header shows how many
free meetings are left; past the quota, creating a meeting explains how to
self-host. Admins can invite teammates from Settings; they sign in with their
own email code. One email belongs to one workspace.
