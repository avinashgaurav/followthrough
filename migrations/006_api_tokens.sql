-- Personal API tokens: how an MCP client (Claude, Cursor, ...) or a script acts
-- as a user without a browser session. Only a SHA-256 of the token is stored;
-- the token itself is shown once. A token acts as its user, with that user's
-- role, and stops working when it is revoked or the user is disabled.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
