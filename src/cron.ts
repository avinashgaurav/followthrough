import { route, json } from "./router.ts";
import { getDb } from "./db.ts";
import { env, demoMode, hostedMode } from "./config.ts";
import { withTenant } from "./db.ts";
import { listWorkspaces, pruneControl } from "./hosted/tenancy.ts";
import { maybeSendDigest } from "./digest/digest.ts";
import { dailyNudgeText, sendChat } from "./notify.ts";
import { runPollPipeline } from "./releases/routes.ts";
import { getLLM } from "./llm/provider.ts";
import { failStaleExtractionRuns, staleRunMinutes } from "./extract/pipeline.ts";
import { markStaleDrafts } from "./tickets/routes.ts";
import { secretsEqual } from "./auth.ts";
import { pruneRateHits } from "./insights/routes.ts";
import { getStore, sweepOrphanUploads } from "./storage.ts";

/**
 * Scheduled work on Vercel (vercel.json "crons"). The Hobby plan runs a cron at
 * most once a day, so one daily job does what the long-running server did with
 * timers: the Monday 09:00 IST digest (scheduled at 03:30 UTC), the release
 * poll, the "waiting on the team" nudge, the stale sweeps, and the cleanup of
 * uploads that were never attached to a meeting. Each step is
 * independent; a failure is reported and the rest still run.
 *
 * Vercel calls the route with "Authorization: Bearer $CRON_SECRET". Without
 * CRON_SECRET set, the route refuses to run.
 */
export async function runDailyJobs(now: Date = new Date()): Promise<Record<string, unknown>> {
  if (hostedMode()) return runHostedDailyJobs(now);
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
  await step("orphan_uploads_deleted", () => sweepOrphanUploads(db, getStore(), now.getTime()));
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

/**
 * Hosted mode: the housekeeping sweeps run in each workspace. Digest, nudges
 * and release polling are single-tenant features (one webhook, one repo) and
 * stay off. One workspace failing never stops the rest.
 */
async function runHostedDailyJobs(now: Date): Promise<Record<string, unknown>> {
  const db = getDb();
  const out: Record<string, unknown> = { control: await pruneControl(db, now.getTime()) };
  let ok = 0;
  const failed: string[] = [];
  // Stay well inside the function's 300s limit. The start rotates by day, so
  // workspaces past the deadline one day are swept first on a later day.
  const all = await listWorkspaces(db);
  const start = all.length ? Math.floor(now.getTime() / 86_400_000) % all.length : 0;
  const ordered = [...all.slice(start), ...all.slice(0, start)];
  const deadline = Date.now() + 240_000;
  for (const ws of ordered) {
    if (Date.now() > deadline) {
      out.stopped_early = true;
      break;
    }
    try {
      await withTenant(ws.schema_name, async () => {
        await failStaleExtractionRuns(db, staleRunMinutes());
        await markStaleDrafts(db);
        await pruneRateHits(db, now.getTime());
      });
      ok++;
    } catch (err) {
      failed.push(ws.id);
      console.warn(`cron sweep failed for workspace ${ws.id}:`, err);
    }
  }
  out.workspaces_swept = ok;
  if (failed.length) out.workspaces_failed = failed;
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
