-- Hosted mode only: the registry that maps people to their workspace schema.
-- App data never lives here; each workspace has its own schema (ws_<id>)
-- created from migrations/*.sql. Every statement is idempotent.
CREATE SCHEMA IF NOT EXISTS control;

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
CREATE TABLE IF NOT EXISTS control.members (
  email        TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES control.workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
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
