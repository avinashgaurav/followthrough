import { join } from "node:path";
import { existsSync } from "node:fs";
import { env } from "./config.ts";
import { getDb, nowIso } from "./db.ts";
import { route, json, dispatch } from "./router.ts";

// Route modules register themselves at import time.
import "./auth-routes.ts";
import "./ingest/routes.ts";
import "./extract/routes.ts";
import "./insights/routes.ts";
import "./tickets/routes.ts";
import "./evidence/routes.ts";
import "./emails/routes.ts";
import "./metrics/routes.ts";
import "./exports/routes.ts";
import "./digest/routes.ts";
import "./stt/routes.ts";
import "./calendar/routes.ts";
import "./releases/routes.ts";
import "./watchfolder/routes.ts";
import "./retention/routes.ts";
import { startDigestScheduler } from "./digest/digest.ts";
import { failStaleExtractionRuns } from "./extract/pipeline.ts";
import { markStaleDrafts } from "./tickets/routes.ts";
import { startReleasePoller } from "./releases/routes.ts";
import { startWatchFolder } from "./watchfolder/service.ts";

getDb();

route("GET", "/api/health", "public", () => json({ ok: true, service: "insights-engine", time: nowIso() }));

const WEB_DIST = join(import.meta.dir, "..", "web", "dist");

async function serveStatic(pathname: string): Promise<Response> {
  const safe = pathname.replace(/\.\./g, "");
  let file = join(WEB_DIST, safe === "/" ? "index.html" : safe);
  if (!existsSync(file)) file = join(WEB_DIST, "index.html"); // SPA fallback
  if (!existsSync(file)) {
    return new Response("Web UI not built. Run: bun run build:web", { status: 503 });
  }
  return new Response(Bun.file(file));
}

if (import.meta.main) {
  startDigestScheduler();
  startReleasePoller();
  startWatchFolder();
  const sweepStale = () => {
    try {
      markStaleDrafts(getDb());
      const swept = failStaleExtractionRuns(getDb());
      if (swept > 0) console.warn(`swept ${swept} abandoned extraction run(s)`);
    } catch (err) {
      console.warn("stale sweep failed:", err);
    }
  };
  sweepStale();
  setInterval(sweepStale, 60 * 60 * 1000);
  Bun.serve({
    port: env.PORT,
    idleTimeout: 255, // LLM extraction requests run for minutes, not seconds
    maxRequestBodySize: 512 * 1024 * 1024, // recordings can be large
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) {
        const res = dispatch(req);
        return res ?? json({ error: "not found" }, 404);
      }
      return serveStatic(url.pathname);
    },
  });
  console.log(`insights-engine listening on :${env.PORT}`);
}
