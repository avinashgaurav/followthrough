-- Runs last (900_): add every new app table to the list below.
--
-- Supabase exposes the public schema through its REST API (PostgREST) to the
-- anon and authenticated roles. Followthrough never uses that API: the server
-- connects as the database owner. So, for the app's own tables only, switch on
-- row-level security (with no policies, the API roles see nothing) and revoke
-- the API roles' grants. Other tables in the schema are left alone. The role
-- step is a no-op where those roles do not exist (PGlite in tests, plain Postgres).

DO $$
DECLARE
  app_tables text[] := ARRAY[
    'users', 'sessions', 'login_attempts', 'clients', 'client_contacts', 'media_assets', 'meetings',
    'transcripts', 'extraction_runs', 'insights', 'insight_mentions', 'insight_requesters', 'action_items',
    'tags', 'insight_tags', 'tickets', 'releases', 'release_entries', 'release_matches', 'completion_evidence',
    'email_drafts', 'csv_exports', 'events', 'fts_transcripts', 'fts_insights', 'meeting_analyses',
    'app_settings', 'llm_spend', 'rate_hits'
  ];
  t text;
  r text;
BEGIN
  FOREACH t IN ARRAY app_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY app_tables LOOP
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END LOOP;
      EXECUTE format('REVOKE ALL ON insight_milestones FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION events_append_only() FROM %I', r);
    END IF;
  END LOOP;
END $$;
