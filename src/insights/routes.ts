import { z } from "zod";
import { route, json } from "../router.ts";
import { getDb, type Database } from "../db.ts";
import type { AuthedUser } from "../auth.ts";
import {
  ListFiltersSchema,
  TriageSchema,
  BodyEditSchema,
  RejectSchema,
  MergeSchema,
  EditingSchema,
  TRACKS,
  STATES,
  listInsights,
  getInsightDetail,
  triageInsight,
  updateBody,
  finalizeInsight,
  rejectInsight,
  mergeInsight,
  setEditing,
  getQueue,
  type HttpResult,
} from "./service.ts";
import { rebuildFts, searchAll } from "./search.ts";
import { askMemory } from "./ask.ts";
import { demoMode, env } from "../config.ts";
import { clientIp } from "../demo.ts";

function actorOf(user: AuthedUser | null): { id: string; role: "admin" | "member" } {
  // the router enforces auth for "user"/"admin" routes; this narrows the type
  if (!user) throw new Error("authenticated route invoked without a user");
  return { id: user.id, role: user.role };
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function send(result: HttpResult): Response {
  return json(result.body, result.status);
}

function queryParams(url: URL, keys: readonly string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const k of keys) {
    const v = url.searchParams.get(k);
    if (v !== null && v !== "") raw[k] = v;
  }
  return raw;
}

function invalid(issues: unknown): Response {
  return json({ error: "invalid request", issues }, 400);
}

// ---------------------------------------------------------------- list + detail

route("GET", "/api/insights", "user", async (req) => {
  const raw = queryParams(new URL(req.url), ["state", "track", "client_id", "assignee", "item_type"]);
  const parsed = ListFiltersSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error.issues);
  return json({ insights: await listInsights(getDb(), parsed.data) });
});

route("GET", "/api/insights/:id", "user", async (_req, _user, params) => {
  const detail = await getInsightDetail(getDb(), params.id ?? "");
  if (!detail) return json({ error: "insight not found" }, 404);
  return json(detail);
});

// ---------------------------------------------------------------- lifecycle

route("POST", "/api/insights/:id/triage", "user", async (req, user, params) => {
  const parsed = TriageSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  return send(await triageInsight(getDb(), params.id ?? "", actorOf(user), parsed.data));
});

const BulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  action: z.enum(["triage", "reject"]),
  track: z.enum(TRACKS).optional(),
  assignee_user_id: z.string().optional(),
  reason: z.string().max(500).optional(),
});

// Brief-first review: act on many insights from one meeting in one shot.
// Each id is processed independently; partial success is reported per id.
route("POST", "/api/insights/bulk", "user", async (req, user) => {
  const parsed = BulkSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  const { ids, action, track, assignee_user_id, reason } = parsed.data;
  if (action === "triage" && !track) return json({ error: "track is required for bulk triage" }, 400);
  const db = getDb();
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of ids) {
    try {
      if (action === "triage") {
        await triageInsight(db, id, actorOf(user), { track: track!, assignee_user_id });
      } else {
        await rejectInsight(db, id, actorOf(user), reason?.trim() || "Bulk reject during meeting review");
      }
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : "failed" });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return json({ ok: okCount, failed: results.length - okCount, results });
});

route("PUT", "/api/insights/:id/body", "user", async (req, user, params) => {
  const parsed = BodyEditSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  return send(await updateBody(getDb(), params.id ?? "", actorOf(user), parsed.data.body_current, parsed.data.version));
});

route("POST", "/api/insights/:id/finalize", "user", async (_req, user, params) => {
  return send(await finalizeInsight(getDb(), params.id ?? "", actorOf(user)));
});

route("POST", "/api/insights/:id/reject", "user", async (req, user, params) => {
  const parsed = RejectSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  return send(await rejectInsight(getDb(), params.id ?? "", actorOf(user), parsed.data.reason));
});

route("POST", "/api/insights/:id/merge", "user", async (req, user, params) => {
  const parsed = MergeSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  return send(await mergeInsight(getDb(), params.id ?? "", parsed.data.into_insight_id, actorOf(user)));
});

route("POST", "/api/insights/:id/editing", "user", async (req, user, params) => {
  const parsed = EditingSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  return send(await setEditing(getDb(), params.id ?? "", actorOf(user), parsed.data.on));
});

// ---------------------------------------------------------------- my queue

route("GET", "/api/queue", "user", async (_req, user) => {
  return json(await getQueue(getDb(), actorOf(user)));
});

// ---------------------------------------------------------------- search

const SearchFiltersSchema = z.object({
  client_id: z.string().optional(),
  track: z.enum(TRACKS).optional(),
  state: z.enum(STATES).optional(),
});

route("GET", "/api/search", "user", async (req, user) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return json({ error: "q is required" }, 400);
  const parsed = SearchFiltersSchema.safeParse(queryParams(url, ["client_id", "track", "state"]));
  if (!parsed.success) return invalid(parsed.error.issues);
  return json(await searchAll(getDb(), q, parsed.data, user ? { id: user.id, role: user.role } : undefined));
});

route("POST", "/api/search/rebuild", "admin", async () => {
  return json({ ok: true, ...await rebuildFts(getDb()) });
});

const AskSchema = z.object({
  question: z.string().min(3).max(500),
  client_id: z.string().optional(),
});

// Lightweight per-user rate limit: the ask endpoint calls the LLM on every hit,
// so cap it to keep a runaway client (or a loop) from draining the API budget.
// In DEMO_MODE every visitor is the same guest, so the key is the client IP and
// the cap is DEMO_ASK_PER_HOUR instead. Hits live in the database (rate_hits)
// so the limit holds across serverless instances.
const ASK_LIMIT = 30;
const ASK_WINDOW_MS = 60 * 60 * 1000;

export const ASK_WINDOW = ASK_WINDOW_MS;

/**
 * Count-then-insert under a per-key advisory lock held for the transaction, so
 * two requests for the same key cannot both see room for one more. Old hits
 * are pruned by the daily cron (pruneRateHits).
 */
export async function askRateLimited(db: Database, key: string, limit = ASK_LIMIT, now = Date.now()): Promise<boolean> {
  return db.transaction(async () => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext(?))").get(`rate:${key}`);
    const { n } = (await db
      .query("SELECT COUNT(*) AS n FROM rate_hits WHERE key = ? AND at >= ?")
      .get(key, now - ASK_WINDOW_MS)) as { n: number };
    if (n >= limit) return true;
    await db.query("INSERT INTO rate_hits (key, at) VALUES (?, ?)").run(key, now);
    return false;
  });
}

/** Drop hits older than the window (daily cron). Returns rows removed. */
export async function pruneRateHits(db: Database, now = Date.now()): Promise<number> {
  return (await db.query("DELETE FROM rate_hits WHERE at < ?").run(now - ASK_WINDOW_MS)).changes;
}

route("POST", "/api/ask", "user", async (req, user) => {
  const parsed = AskSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  const actor = actorOf(user);
  const db = getDb();
  // Demo: per-IP first, then a global cap so total spend is bounded even if
  // IPs are unknown or rotated.
  const limited = demoMode()
    ? (await askRateLimited(db, `ip:${clientIp(req) ?? "unknown"}`, env.DEMO_ASK_PER_HOUR)) ||
      (await askRateLimited(db, "demo:global", env.DEMO_ASK_GLOBAL_PER_HOUR))
    : await askRateLimited(db, actor.id);
  if (limited) {
    return json({ error: "Too many questions in a short window. Wait a bit and try again." }, 429);
  }
  const result = await askMemory(getDb(), parsed.data.question, { client_id: parsed.data.client_id }, actor);
  return json(result);
});
