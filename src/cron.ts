import { route, json } from "./router.ts";
import { getDb } from "./db.ts";
import { env, demoMode } from "./config.ts";
import { maybeSendDigest } from "./digest/digest.ts";
import { dailyNudgeText, sendChat } from "./notify.ts";
import { runPollPipeline } from "./releases/routes.ts";
import { getLLM } from "./llm/provider.ts";
import { failStaleExtractionRuns, staleRunMinutes } from "./extract/pipeline.ts";
import { markStaleDrafts } from "./tickets/routes.ts";
import { secretsEqual } from "./auth.ts";
import { pruneRateHits } from "./insights/routes.ts";

/**
 * Scheduled work on Vercel (vercel.json "crons"). The Hobby plan runs a cron at
 * most once a day, so one daily job does what the long-running server did with
 * timers: the Monday 09:00 IST digest (scheduled at 03:30 UTC), the release
 * poll, the "waiting on the team" nudge, and the stale sweeps. Each step is
 * independent; a failure is reported and the rest still run.
 *
 * Vercel calls the route with "Authorization: Bearer $CRON_SECRET". Without
 * CRON_SECRET set, the route refuses to run.
 */
export async function runDailyJobs(now: Date = new Date()): Promise<Record<string, unknown>> {
  const db = getDb();
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (err) {
      out[name] = { error: err instanceof Error ? err.message : String(err) };
      console.warn(`cron ${name} failed:`, err);
    }
  };
  await step("stale_extraction_runs", () => failStaleExtractionRuns(db, staleRunMinutes()));
  await step("stale_ticket_drafts", () => markStaleDrafts(db));
  await step("rate_hits_pruned", () => pruneRateHits(db, now.getTime()));
  if (!demoMode()) {
    await step("digest_sent", () => maybeSendDigest(db, now));
    if (env.DIGEST_WEBHOOK_URL) {
      await step("nudge", async () => {
        const text = await dailyNudgeText(db);
        if (text) await sendChat(text);
        return text ? "sent" : "nothing waiting";
      });
    }
    if (env.RELEASE_REPO) await step("releases", () => runPollPipeline(db, getLLM()));
  }
  return out;
}

export function cronAuthorized(req: Request, secret: string | undefined = process.env.CRON_SECRET): boolean {
  if (!secret) return false;
  return secretsEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

route("GET", "/api/cron/daily", "public", async (req) => {
  if (!process.env.CRON_SECRET) return json({ error: "CRON_SECRET is not set" }, 503);
  if (!cronAuthorized(req)) return json({ error: "unauthorized" }, 401);
  return json({ ok: true, ran: await runDailyJobs() });
});
