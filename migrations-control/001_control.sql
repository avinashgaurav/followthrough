-- Hosted mode only: the registry that maps people to their workspace schema.
-- App data never lives here; each workspace has its own schema (ws_<id>)
-- created from migrations/*.sql. Every statement is idempotent.
CREATE SCHEMA IF NOT EXISTS control;

-- Workspaces search only their own schema plus "extensions", never public, so
-- citext must live in extensions (Supabase's default home for extensions; its
-- default search_path already includes it). This runs on every hosted boot,
-- and today hosted mode shares its database with the single-tenant app, so it
-- never touches an extension that already exists: it only creates citext when
-- it is missing. If citext sits in another schema, boot stops (see
-- assertExtensionsReady) and the operator moves it once, by hand:
--   ALTER EXTENSION citext SET SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS extensions;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'citext') THEN
    CREATE EXTENSION citext SCHEMA extensions;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS control.workspaces (
  id                  TEXT PRIMARY KEY,
  schema_name         TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  product_name        TEXT NOT NULL,
  product_description TEXT,
  owner_email         TEXT NOT NULL,
  meetings_quota      INTEGER NOT NULL,
  meetings_used       INTEGER NOT NULL DEFAULT 0 CHECK (meetings_used >= 0),
  created_at          TEXT NOT NULL
);

-- One workspace per email. user_id is the person's row in that workspace's users table.
-- An admin's invite is only 'invited' until the invitee signs in and accepts:
-- nobody can be placed in a workspace without proving they own the email.
CREATE TABLE IF NOT EXISTS control.members (
  email        TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES control.workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited')),
  invited_by   TEXT,
  created_at   TEXT NOT NULL
);

-- Session id to workspace. The session itself (user, expiry) lives in the workspace's sessions table.
CREATE TABLE IF NOT EXISTS control.sessions (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES control.workspaces(id) ON DELETE CASCADE,
  expires_at   TEXT NOT NULL
);

-- A verified email with no workspace yet: the one-time code is spent, so this
-- short-lived token carries the verification to the "name your workspace" step.
CREATE TABLE IF NOT EXISTS control.pending_signups (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Per-workspace daily AI spend, under the deployment-wide cap in llm_spend.
CREATE TABLE IF NOT EXISTS control.llm_spend_ws (
  workspace_id TEXT NOT NULL,
  day          TEXT NOT NULL,
  usd          DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);

-- Deployment-wide counters: AI spend (one cap across every workspace) and sign-in throttling.
CREATE TABLE IF NOT EXISTS control.llm_spend (
  day TEXT PRIMARY KEY,
  usd DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS control.rate_hits (
  key TEXT NOT NULL,
  at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_rate_hits ON control.rate_hits(key, at);

-- Defence in depth: no policies, so API roles could read nothing even if granted.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'control' LOOP
    EXECUTE format('ALTER TABLE control.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

-- Supabase exposes schemas over its REST API to anon/authenticated roles; this
-- registry is server-only.
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA control FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA control FROM %I', r);
    END IF;
  END LOOP;
END $$;
