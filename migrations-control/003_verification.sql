-- Security fixes for hosted sign-in. Every statement is idempotent.

-- When a member proved they own their email (emailed code or link, or
-- accepting an invite). NULL means an unverified claim: an email + password
-- sign-up that nobody has proven yet. A later inbox sign-in for that email
-- promotes the claim (sets this, removes the password and every older session)
-- instead of deleting the account, so a person who forgot their password never
-- loses their workspace.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'control' AND table_name = 'members' AND column_name = 'verified_at') THEN
    ALTER TABLE control.members ADD COLUMN verified_at TEXT;
    -- Backfill once: active members without a password came in through the
    -- inbox; password accounts and pending invites stay unverified.
    UPDATE control.members m SET verified_at = m.created_at
    WHERE m.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM control.credentials c WHERE c.email = m.email);
  END IF;
END $$;

-- Emailed sign-in links already used here (a hash of the link token, or the
-- Supabase session id), so a link signs in once even if Supabase would accept
-- it again. Rows expire with the link and are pruned.
CREATE TABLE IF NOT EXISTS control.used_links (
  key        TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
ALTER TABLE control.used_links ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON control.used_links FROM %I', r);
    END IF;
  END LOOP;
END $$;
