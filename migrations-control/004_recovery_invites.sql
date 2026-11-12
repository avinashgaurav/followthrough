-- Password recovery codes and invite links (no email sender yet, issue #24).
-- Every statement is idempotent.

-- One recovery code per password account, shown once and stored only as a
-- hash. It dies with the password (a verified inbox sign-in removes the
-- password, see promoteUnverifiedClaim), so it can never outlive the account.
CREATE TABLE IF NOT EXISTS control.recovery_codes (
  email      TEXT PRIMARY KEY REFERENCES control.credentials(email) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Single-use links an admin hands to a teammate (Slack, WhatsApp). The token
-- is never stored, only its SHA-256. A link is spent by the first person who
-- joins with it, and expires or can be revoked before that.
CREATE TABLE IF NOT EXISTS control.invite_links (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  workspace_id  TEXT NOT NULL REFERENCES control.workspaces(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  used_by_email TEXT,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_invite_links_ws ON control.invite_links(workspace_id);

ALTER TABLE control.recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.invite_links ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON control.recovery_codes FROM %I', r);
      EXECUTE format('REVOKE ALL ON control.invite_links FROM %I', r);
    END IF;
  END LOOP;
END $$;
