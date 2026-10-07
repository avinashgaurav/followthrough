// Test preload (bunfig.toml): pin deployment config so tests never depend on a
// developer's .env. Individual tests may still mutate `env` from config.ts.
process.env.RELEASE_REPO = "acme/product";
process.env.WRITABLE_REPOS = "avinashgaurav/followthrough";
process.env.BLOCKED_ORGS = "xyz";
process.env.ALLOWED_EMAIL_DOMAINS = "xyz.com";
process.env.PRODUCT_NAME = "XYZ";
