-- Open sign-up with email + password (no email delivery yet, see issue #24).
-- The email is not verified: it is a login name. Accounts made this way can
-- never accept a teammate invite (that needs a proven inbox).
CREATE TABLE IF NOT EXISTS control.credentials (
  email         TEXT PRIMARY KEY,
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
