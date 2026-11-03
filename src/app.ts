import { nowIso } from "./db.ts";
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
import "./share/routes.ts";
import "./cron.ts";

route("GET", "/api/health", "public", () => json({ ok: true, service: "followthrough", time: nowIso() }));

/** Every /api/* and /share/* request, on the local server and on Vercel. */
export async function handleApi(req: Request): Promise<Response> {
  return (await dispatch(req)) ?? json({ error: "not found" }, 404);
}
