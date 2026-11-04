-- Open sign-up with email + password (no email delivery yet, see issue #24).
-- The email is NOT verified: it is a login name. A password belongs to one
-- membership (workspace + user) and dies with it (ON DELETE CASCADE), and a
-- later verified sign-in for the same email evicts the unverified claim, so a
-- password can never reach a workspace that someone else proved they own.
CREATE TABLE IF NOT EXISTS control.credentials (
  email         TEXT PRIMARY KEY REFERENCES control.members(email) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);
ALTER TABLE control.credentials ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON control.credentials FROM %I', r);
    END IF;
  END LOOP;
END $$;
