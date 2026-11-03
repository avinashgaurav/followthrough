-- At most one extraction per meeting can be running. The app checks first, but
-- two requests can pass that check together; the second insert now fails with
-- a unique violation, which runExtraction reports as "already running".
CREATE UNIQUE INDEX IF NOT EXISTS uq_extraction_runs_one_running
  ON extraction_runs (meeting_id) WHERE status = 'running';

-- events is append-only: row triggers block UPDATE and DELETE, and this
-- statement trigger blocks TRUNCATE (which row triggers do not see).
DROP TRIGGER IF EXISTS events_no_truncate ON events;
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();
REVOKE TRUNCATE ON events FROM PUBLIC;
