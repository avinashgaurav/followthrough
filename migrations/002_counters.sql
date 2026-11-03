-- Counters that must hold across serverless instances (they lived in process
-- memory when Followthrough ran as one long-lived server).

-- Daily AI spend, for LLM_DAILY_BUDGET_USD. One row per UTC day.
CREATE TABLE IF NOT EXISTS llm_spend (
  day TEXT PRIMARY KEY,
  usd DOUBLE PRECISION NOT NULL DEFAULT 0
);

-- Sliding-window rate limits (Ask): one row per hit, pruned as it ages out.
CREATE TABLE IF NOT EXISTS rate_hits (
  key TEXT NOT NULL,
  at  BIGINT NOT NULL   -- epoch milliseconds
);
CREATE INDEX IF NOT EXISTS idx_rate_hits ON rate_hits(key, at);
