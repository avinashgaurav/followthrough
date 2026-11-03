// Test preload (bunfig.toml): pin deployment config so tests never depend on a
// developer's .env. Individual tests may still mutate `env` from config.ts.
process.env.RELEASE_REPO = "acme/product";
process.env.WRITABLE_REPOS = "avinashgaurav/followthrough";
process.env.BLOCKED_ORGS = "tallyhall";
process.env.ALLOWED_EMAIL_DOMAINS = "tallyhall.com";
process.env.PRODUCT_NAME = "Tallyhall";
// The claude-cli eval route spawns the real CLI; a shell that exports
// LLM_PROVIDER=claude-cli must not make plain `bun test` call it.
delete process.env.LLM_PROVIDER;
// MockLLM replays queued responses in call order, so extraction runs chunks one at a time.
process.env.EXTRACT_CONCURRENCY = "1";
// Tests use the local blob store, never a configured Supabase bucket.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
