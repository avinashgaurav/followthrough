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
  `public`, so a workspace cannot fall through to shared tables. `citext` must
  therefore live in `extensions` (Supabase's default home for extensions,
  already on its default search path). The control migration creates it there
  when it is missing, and never moves an existing one: if it sits elsewhere,
  boot stops with a message and you run
  `ALTER EXTENSION citext SET SCHEMA extensions;` once, by hand.
- **Shared database today:** the hosted deployment uses the same Supabase
  project and database as the single-tenant production app (its tables in
  `public`, hosted in `control` and `ws_*`). Every hosted boot runs the control
  migrations, which only touch `control`, `extensions` and new workspace
  schemas. A separate database for hosted mode is the cleaner end state.

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
   - Authentication, Email Templates: in **Confirm signup** and **Magic Link**, make the link `APP_URL/auth/callback?token_hash={{ .TokenHash }}&type=email` (your real APP_URL, e.g. `https://followthrough-hosted.vercel.app/auth/callback?token_hash={{ .TokenHash }}&type=email`). The server then checks the link with Supabase itself and spends it. The old `{{ .ConfirmationURL }}` link still works for returning users, but a first sign-up by link needs the token-hash link (or the typed code), because the server no longer accepts `email/signup` sessions: with **Confirm email** off, anyone can create one for any address.
   - Optional, needs custom SMTP first: put `{{ .Token }}` in the same two templates so the email also carries a typed code.
   - Authentication, SMTP: connect a sender (e.g. Resend). Supabase's built-in sender only allows a few emails an hour, which a launch will exceed.
2. **Vercel**: import the repo (root directory: repo root) and set
   `HOSTED_MODE=true`, `APP_URL` (the public URL), `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   one AI key (`ANTHROPIC_API_KEY` or `GEMINI_API_KEY`), `LLM_DAILY_BUDGET_USD`,
   and `CRON_SECRET`. Leave `TRUSTED_PROXY_HOPS` at its default of 1: Vercel
   replaces `X-Forwarded-For` with the client's address, so the one entry is
   the real client and sign-in throttles are per person, not shared. The production build runs `bun run db:migrate`, which creates
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
  an account or a pending invite cannot be registered by password;
- a password belongs to one membership and is deleted with it;
- a password account is an unverified claim until someone proves the inbox
  (emailed link or code). That person then gets the account, with its
  workspace and data: it is marked verified, and its password and every
  session opened before are removed. So an owner who forgot their password
  signs in by email and keeps everything, and anyone who only knew the
  password (a squatter) is locked out. Nothing is deleted on a sign-in. If a
  squatter had invited teammates, they remain; the new owner sees and can
  revoke them in Settings;
- sign-up says when an email is already taken (accepted: without email there
  is no non-revealing way to refuse);
- limits: 10 sign-ups an hour per IP and 30 an hour overall; failed logins
  lock an email for 15 minutes from that IP only (300 a day per email overall).

Emailed codes and links: 10 code requests an hour per IP, 5 per email from one
IP and 20 per email overall, and code guesses limited the same way (10 per
email from one IP, 50 per email an hour), so one stranger cannot use up the
owner's allowance. Each emailed link signs in once.

Planned with #24: CAPTCHA on sign-up, removing never-used workspaces, and
password reset (still not available: a forgotten password means signing in by
emailed link or code, which turns the password off).

The emailed-link sign-in stays in the code and works for everyone once SMTP is
connected.

## What a user sees

Email, then the emailed code, then (first time only) "Company or product" and
"What you sell", which the AI uses to frame every ask. The header shows how many
free meetings are left; past the quota, creating a meeting explains how to
self-host. Admins can invite teammates from Settings; they sign in with their
own email code. One email belongs to one workspace.
