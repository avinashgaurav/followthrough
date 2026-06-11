-- Insights Engine schema (SQLite, WAL). See SPEC.md sections 4, 9, 11.
-- Conventions: TEXT ULID primary keys; ISO-8601 UTC TEXT timestamps; JSON as TEXT.
-- The events table is the source of truth for lifecycle facts; status columns are caches.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- users/auth

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  code_hash     TEXT,                -- NULL = login revoked/disabled
  code_rotated_at TEXT,
  invited_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL COLLATE NOCASE,
  ip          TEXT,
  occurred_at TEXT NOT NULL,
  success     INTEGER NOT NULL CHECK (success IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(email, occurred_at);

-- ---------------------------------------------------------------- clients

CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  domain      TEXT,
  crm_id      TEXT,                  -- Zoho id placeholder
  is_internal INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_contacts (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id),
  name       TEXT NOT NULL,
  email      TEXT,
  title      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_client ON client_contacts(client_id);

-- ---------------------------------------------------------------- media / meetings / transcripts

CREATE TABLE IF NOT EXISTS media_assets (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('audio','video','transcript_file','screenshot','csv','other')),
  storage_backend TEXT NOT NULL DEFAULT 'local' CHECK (storage_backend IN ('local','s3')),
  storage_ref     TEXT NOT NULL,     -- relative key, never an absolute path
  filename        TEXT NOT NULL,
  content_type    TEXT,
  size_bytes      INTEGER,
  sha256          TEXT NOT NULL,
  uploaded_by     TEXT REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploading','uploaded','failed')),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_sha ON media_assets(sha256);

CREATE TABLE IF NOT EXISTS meetings (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  seq             INTEGER NOT NULL,  -- meeting #N per client, assigned at insert
  title           TEXT,
  meeting_date    TEXT NOT NULL,
  meeting_type    TEXT CHECK (meeting_type IN ('discovery','demo','qbr','support','other')),
  source          TEXT NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('extension','meet','zoom','fireflies','manual','watch_folder','drive')),
  attendees_json  TEXT,              -- [{name, email?, side: 'client'|'internal'}]
  audio_asset_id  TEXT REFERENCES media_assets(id),
  consent_confirmed INTEGER NOT NULL DEFAULT 0,  -- processing blocked until 1
  restricted      INTEGER NOT NULL DEFAULT 0,    -- 1 = only allowed_users_json may view
  allowed_users_json TEXT,
  status          TEXT NOT NULL DEFAULT 'uploaded'
                  CHECK (status IN ('uploaded','transcribing','transcribed','transcription_failed','extracted')),
  uploaded_by     TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  deleted_at      TEXT               -- retention: soft-delete marker; purge job clears blobs+quotes
);
CREATE INDEX IF NOT EXISTS idx_meetings_client ON meetings(client_id, meeting_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_client_seq ON meetings(client_id, seq);

CREATE TABLE IF NOT EXISTS transcripts (
  id           TEXT PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id),
  content      TEXT NOT NULL,        -- canonical cleaned transcript
  raw_content  TEXT,                 -- as uploaded / as returned by STT
  language     TEXT,
  quality_flag TEXT CHECK (quality_flag IN ('ok','low','machine_no_diarization')),
  source       TEXT NOT NULL CHECK (source IN ('uploaded','stt','pasted')),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcripts_meeting ON transcripts(meeting_id);

-- ---------------------------------------------------------------- extraction

CREATE TABLE IF NOT EXISTS extraction_runs (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id),
  transcript_id  TEXT NOT NULL REFERENCES transcripts(id),
  llm_model      TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  error          TEXT,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  cost_usd       REAL,
  coverage_note  TEXT,               -- chunking coverage indicator
  started_at     TEXT,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_meeting ON extraction_runs(meeting_id);

-- ---------------------------------------------------------------- insights

CREATE TABLE IF NOT EXISTS insights (
  id                TEXT PRIMARY KEY,            -- shown as INS-<short>
  meeting_id        TEXT NOT NULL REFERENCES meetings(id),   -- first/origin meeting
  client_id         TEXT NOT NULL REFERENCES clients(id),    -- origin client (denormalized)
  extraction_run_id TEXT REFERENCES extraction_runs(id),     -- NULL = manually added
  item_type         TEXT NOT NULL CHECK (item_type IN
                    ('feature_request','complaint','key_insight','action_item_ours','commitment_theirs','status_update')),
  track             TEXT CHECK (track IN ('engineering','marketing','product_polish','other')),
  title             TEXT NOT NULL,
  body_original     TEXT NOT NULL,    -- raw LLM output, immutable
  body_current      TEXT NOT NULL,    -- human-polished
  state             TEXT NOT NULL DEFAULT 'extracted' CHECK (state IN
                    ('extracted','triaged','finalized','ticketed','shipped','client_notified','closed','rejected','merged')),
  ai_confidence     TEXT CHECK (ai_confidence IN ('high','medium','low')),
  ai_suggested_json TEXT,             -- {track, assignee, tags[]} for routing-correction metric
  assignee_user_id  TEXT REFERENCES users(id),
  finalized_by      TEXT REFERENCES users(id),
  merged_into_insight_id TEXT REFERENCES insights(id),
  priority          INTEGER NOT NULL DEFAULT 0,  -- bumped by mentions/requesters
  version           INTEGER NOT NULL DEFAULT 1,  -- optimistic concurrency
  editing_by        TEXT REFERENCES users(id),   -- soft edit indicator
  editing_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insights_state ON insights(state, track);
CREATE INDEX IF NOT EXISTS idx_insights_client ON insights(client_id, state);
CREATE INDEX IF NOT EXISTS idx_insights_assignee ON insights(assignee_user_id, state);

-- every appearance of an ask: origin extraction + repeat mentions in later meetings
CREATE TABLE IF NOT EXISTS insight_mentions (
  id          TEXT PRIMARY KEY,
  insight_id  TEXT NOT NULL REFERENCES insights(id),
  meeting_id  TEXT NOT NULL REFERENCES meetings(id),
  client_id   TEXT NOT NULL REFERENCES clients(id),
  quote       TEXT NOT NULL,          -- verbatim, substring-verified against transcript
  speaker     TEXT,
  char_start  INTEGER,                -- position in transcript content
  char_end    INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mentions_insight ON insight_mentions(insight_id);
CREATE INDEX IF NOT EXISTS idx_mentions_meeting ON insight_mentions(meeting_id);

-- requesters of a canonical insight (fan-out targets). M:N clients <-> insights.
CREATE TABLE IF NOT EXISTS insight_requesters (
  insight_id TEXT NOT NULL REFERENCES insights(id),
  client_id  TEXT NOT NULL REFERENCES clients(id),
  first_requested_at TEXT NOT NULL,
  last_requested_at  TEXT NOT NULL,
  PRIMARY KEY (insight_id, client_id)
);

CREATE TABLE IF NOT EXISTS action_items (
  id               TEXT PRIMARY KEY,
  meeting_id       TEXT NOT NULL REFERENCES meetings(id),
  insight_id       TEXT REFERENCES insights(id),
  description      TEXT NOT NULL,
  assignee_user_id TEXT REFERENCES users(id),
  due_date         TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  created_at       TEXT NOT NULL,
  completed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_assignee ON action_items(assignee_user_id, status);

CREATE TABLE IF NOT EXISTS tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL DEFAULT 'freeform' CHECK (kind IN ('freeform','system'))
);

CREATE TABLE IF NOT EXISTS insight_tags (
  insight_id TEXT NOT NULL REFERENCES insights(id),
  tag_id     TEXT NOT NULL REFERENCES tags(id),
  applied_by TEXT REFERENCES users(id),
  applied_at TEXT NOT NULL,
  PRIMARY KEY (insight_id, tag_id)
);

-- ---------------------------------------------------------------- tickets (draft-first, human-triggered only)

CREATE TABLE IF NOT EXISTS tickets (
  id              TEXT PRIMARY KEY,
  insight_id      TEXT NOT NULL REFERENCES insights(id),
  repo            TEXT,               -- owner/name; validated against config allowlist on direct-create
  draft_title     TEXT NOT NULL,
  draft_body_md   TEXT NOT NULL,      -- embeds <!-- insights-engine:INS-id --> marker
  state           TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','raised','stale','closed')),
  create_mode     TEXT CHECK (create_mode IN ('manual_paste','direct_api')),
  external_url    TEXT,               -- human paste-back, or API response
  external_number INTEGER,
  created_by      TEXT REFERENCES users(id),
  drafted_at      TEXT NOT NULL,
  raised_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_insight ON tickets(insight_id);

-- ---------------------------------------------------------------- releases / matching

CREATE TABLE IF NOT EXISTS releases (
  id                TEXT PRIMARY KEY,
  repo              TEXT NOT NULL,            -- 'XYZ/XYZ'
  github_release_id INTEGER NOT NULL,
  tag_name          TEXT NOT NULL,
  name              TEXT,
  body_md           TEXT NOT NULL,
  published_at      TEXT NOT NULL,
  fetched_at        TEXT NOT NULL,
  UNIQUE (repo, github_release_id)
);

CREATE TABLE IF NOT EXISTS release_entries (
  id           TEXT PRIMARY KEY,
  release_id   TEXT NOT NULL REFERENCES releases(id),
  section_type TEXT NOT NULL CHECK (section_type IN ('feature','fix','technical','baseline','other')),
  title        TEXT NOT NULL,
  body_md      TEXT,
  product_area TEXT,                          -- XYZ | XYZ Day | unspecified...
  pr_refs_json TEXT,                          -- validated PR numbers only
  flags_json   TEXT,                          -- ['flag_gated','internal_only','shadow','advisory','reverted']
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_release ON release_entries(release_id);

CREATE TABLE IF NOT EXISTS release_matches (
  id                 TEXT PRIMARY KEY,
  release_entry_id   TEXT NOT NULL REFERENCES release_entries(id),
  insight_id         TEXT NOT NULL REFERENCES insights(id),
  ticket_id          TEXT REFERENCES tickets(id),
  confidence         INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  method             TEXT NOT NULL CHECK (method IN ('llm','pr_ref','manual')),
  verdict            TEXT NOT NULL CHECK (verdict IN ('full','partial','none')),
  evidence_quotes_json TEXT,                  -- verbatim, substring-verified against the entry
  rationale          TEXT,
  status             TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected')),
  decided_by         TEXT REFERENCES users(id),
  decided_at         TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_insight ON release_matches(insight_id, status);

-- ---------------------------------------------------------------- completion evidence (uniform done-signal, all tracks)

CREATE TABLE IF NOT EXISTS completion_evidence (
  id           TEXT PRIMARY KEY,
  insight_id   TEXT NOT NULL REFERENCES insights(id),
  kind         TEXT NOT NULL CHECK (kind IN ('release_match','asset_published','ux_verified_in_prod','manual_attestation')),
  ref_match_id TEXT REFERENCES release_matches(id),
  url          TEXT,
  url_verified_at TEXT,                       -- HTTP 200 liveness check timestamp
  asset_id     TEXT REFERENCES media_assets(id),  -- before/after screenshot
  confidence   INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  status       TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected')),
  attested_by  TEXT REFERENCES users(id),
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_insight ON completion_evidence(insight_id, status);

-- ---------------------------------------------------------------- emails / exports

CREATE TABLE IF NOT EXISTS email_drafts (
  id               TEXT PRIMARY KEY,
  insight_id       TEXT NOT NULL REFERENCES insights(id),
  client_id        TEXT NOT NULL REFERENCES clients(id),
  contact_id       TEXT REFERENCES client_contacts(id),
  subject          TEXT NOT NULL,
  body_md          TEXT NOT NULL,
  generated_by     TEXT REFERENCES users(id),
  version          INTEGER NOT NULL DEFAULT 1,
  superseded_by_id TEXT REFERENCES email_drafts(id),
  sent_confirmed_at TEXT,                     -- explicit "I sent it" click
  sent_final_text  TEXT,                      -- optional paste-back of what was actually sent
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_insight ON email_drafts(insight_id);
-- copy timestamps live in events (event_type='email.copied'); copies can happen N times.

CREATE TABLE IF NOT EXISTS csv_exports (
  id            TEXT PRIMARY KEY,
  client_id     TEXT REFERENCES clients(id), -- NULL = all clients
  requested_by  TEXT REFERENCES users(id),
  filter_json   TEXT,
  row_count     INTEGER NOT NULL,
  asset_id      TEXT REFERENCES media_assets(id),
  created_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------- events (append-only source of truth)

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic ordering guarantee
  occurred_at   TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),          -- NULL = system
  entity_type   TEXT NOT NULL,                      -- 'insight'|'meeting'|'ticket'|'release'|'email_draft'|...
  entity_id     TEXT NOT NULL,
  event_type    TEXT NOT NULL,                      -- namespaced: 'insight.state_changed', 'email.copied', ...
  from_state    TEXT,
  to_state      TEXT,
  payload_json  TEXT,
  idempotency_key TEXT UNIQUE                        -- for system ingesters (release poller, watch folder)
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id, id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_to_state ON events(to_state, occurred_at);

-- physically append-only
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

-- first time each state was reached, per insight: every TAT metric is a SELECT over this
CREATE VIEW IF NOT EXISTS insight_milestones AS
SELECT entity_id AS insight_id,
       MIN(CASE WHEN to_state = 'extracted'       THEN occurred_at END) AS extracted_at,
       MIN(CASE WHEN to_state = 'triaged'         THEN occurred_at END) AS triaged_at,
       MIN(CASE WHEN to_state = 'finalized'       THEN occurred_at END) AS finalized_at,
       MIN(CASE WHEN to_state = 'ticketed'        THEN occurred_at END) AS ticketed_at,
       MIN(CASE WHEN to_state = 'shipped'         THEN occurred_at END) AS shipped_at,
       MIN(CASE WHEN to_state = 'client_notified' THEN occurred_at END) AS notified_at,
       MIN(CASE WHEN to_state = 'closed'          THEN occurred_at END) AS closed_at
FROM events
WHERE entity_type = 'insight' AND event_type = 'insight.state_changed'
GROUP BY entity_id;

-- ---------------------------------------------------------------- search (FTS5)

CREATE VIRTUAL TABLE IF NOT EXISTS fts_transcripts USING fts5(
  content, meeting_id UNINDEXED, content_rowid UNINDEXED
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_insights USING fts5(
  title, body, quotes, insight_id UNINDEXED
);

-- ---------------------------------------------------------------- meeting analysis briefs (v2)

CREATE TABLE IF NOT EXISTS meeting_analyses (
  id           TEXT PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id),
  content_md   TEXT NOT NULL,
  content_json TEXT NOT NULL,
  llm_model    TEXT,
  prompt_version TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_meeting ON meeting_analyses(meeting_id, created_at);

-- ---------------------------------------------------------------- app settings (admin-configured key/value)

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
