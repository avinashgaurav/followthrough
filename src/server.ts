import { join } from "node:path";
import { existsSync } from "node:fs";
import { env, allowedEmailDomains, demoMode, llmDailyBudgetUsd } from "./config.ts";
import { getDb, migrate } from "./db.ts";
import { handleApi } from "./app.ts";
import { startDigestScheduler } from "./digest/digest.ts";
import { failStaleExtractionRuns } from "./extract/pipeline.ts";
import { markStaleDrafts } from "./tickets/routes.ts";
import { startReleasePoller } from "./releases/routes.ts";
import { startDailyNudge } from "./notify.ts";

/**
 * Local / self-hosted server (bun run dev). On Vercel the same routes run in
 * api/server.ts, the web app is static output, and scheduled work runs from
 * the daily cron (src/cron.ts) instead of the timers below.
 */

const WEB_DIST = join(import.meta.dir, "..", "web", "dist");

async function serveStatic(pathname: string): Promise<Response> {
  const safe = pathname.replace(/\.\./g, "");
  const requested = join(WEB_DIST, safe === "/" ? "index.html" : safe);
  const servingHashedAsset = existsSync(requested) && safe.startsWith("/assets/");
  let file = requested;
  if (!existsSync(file)) file = join(WEB_DIST, "index.html"); // SPA fallback
  if (!existsSync(file)) {
    return new Response("Web UI not built. Run: bun run build:web", { status: 503 });
  }
  // Vite fingerprints /assets/* filenames, so they are safe to cache forever.
  // Everything else (index.html, the SPA shell) must revalidate so a reload
  // always picks up the latest build instead of a stale cached app.
  const cacheControl = servingHashedAsset
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  return new Response(Bun.file(file), { headers: { "Cache-Control": cacheControl } });
}

if (import.meta.main) {
  await migrate(getDb());
  // The public demo is read-only synthetic data: no polling, ingest or outbound nudges.
  if (!demoMode()) {
    startDigestScheduler();
    startReleasePoller();
    startDailyNudge(getDb);
  }
  const sweepStale = async () => {
    try {
      await markStaleDrafts(getDb());
      const swept = await failStaleExtractionRuns(getDb());
      if (swept > 0) console.warn(`swept ${swept} abandoned extraction run(s)`);
    } catch (err) {
      console.warn("stale sweep failed:", err);
    }
  };
  await sweepStale();
  setInterval(() => void sweepStale(), 60 * 60 * 1000);
  Bun.serve({
    port: env.PORT,
    idleTimeout: 255, // LLM extraction requests run for minutes, not seconds
    maxRequestBodySize: 512 * 1024 * 1024, // recordings can be large
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/share/")) return handleApi(req);
      return serveStatic(url.pathname);
    },
  });
  console.log(`followthrough listening on :${env.PORT}`);
  if (env.ACCESS_PASSWORD && allowedEmailDomains().length === 0) {
    console.warn(
      "WARNING: ACCESS_PASSWORD is set but ALLOWED_EMAIL_DOMAINS is empty: anyone with the password can sign in with any email. Set ALLOWED_EMAIL_DOMAINS.",
    );
  }
  if (demoMode()) {
    console.log(
      `DEMO_MODE on: read-only; Ask ${env.DEMO_ASK_PER_HOUR}/hour per IP, ${env.DEMO_ASK_GLOBAL_PER_HOUR}/hour total; AI budget $${llmDailyBudgetUsd()}/day`,
    );
  }
  if (!env.PRODUCT_NAME && !demoMode()) {
    console.warn("PRODUCT_NAME is not set: AI output will refer to \"our company\". Set it in .env for sharper insights.");
  }
}
