import { z } from "zod";
import { route, json } from "../router.ts";
import { getDb } from "../db.ts";
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

route("GET", "/api/insights", "user", (req) => {
  const raw = queryParams(new URL(req.url), ["state", "track", "client_id", "assignee", "item_type"]);
  const parsed = ListFiltersSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error.issues);
  return json({ insights: listInsights(getDb(), parsed.data) });
});

route("GET", "/api/insights/:id", "user", (_req, _user, params) => {
  const detail = getInsightDetail(getDb(), params.id ?? "");
  if (!detail) return json({ error: "insight not found" }, 404);
  return json(detail);
});

// ---------------------------------------------------------------- lifecycle

route("POST", "/api/insights/:id/triage", "user", async (req, user, params) => {
  const parsed = TriageSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  return send(triageInsight(getDb(), params.id ?? "", actorOf(user), parsed.data));
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
        triageInsight(db, id, actorOf(user), { track: track!, assignee_user_id });
      } else {
        rejectInsight(db, id, actorOf(user), reason?.trim() || "Bulk reject during meeting review");
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
  return send(updateBody(getDb(), params.id ?? "", actorOf(user), parsed.data.body_current, parsed.data.version));
});

route("POST", "/api/insights/:id/finalize", "user", (_req, user, params) => {
  return send(finalizeInsight(getDb(), params.id ?? "", actorOf(user)));
});

route("POST", "/api/insights/:id/reject", "user", async (req, user, params) => {
  const parsed = RejectSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  return send(rejectInsight(getDb(), params.id ?? "", actorOf(user), parsed.data.reason));
});

route("POST", "/api/insights/:id/merge", "user", async (req, user, params) => {
  const parsed = MergeSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  return send(mergeInsight(getDb(), params.id ?? "", parsed.data.into_insight_id, actorOf(user)));
});

route("POST", "/api/insights/:id/editing", "user", async (req, user, params) => {
  const parsed = EditingSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  return send(setEditing(getDb(), params.id ?? "", actorOf(user), parsed.data.on));
});

// ---------------------------------------------------------------- my queue

route("GET", "/api/queue", "user", (_req, user) => {
  return json(getQueue(getDb(), actorOf(user)));
});

// ---------------------------------------------------------------- search

const SearchFiltersSchema = z.object({
  client_id: z.string().optional(),
  track: z.enum(TRACKS).optional(),
  state: z.enum(STATES).optional(),
});

route("GET", "/api/search", "user", (req, user) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return json({ error: "q is required" }, 400);
  const parsed = SearchFiltersSchema.safeParse(queryParams(url, ["client_id", "track", "state"]));
  if (!parsed.success) return invalid(parsed.error.issues);
  return json(searchAll(getDb(), q, parsed.data, user ? { id: user.id, role: user.role } : undefined));
});

route("POST", "/api/search/rebuild", "admin", () => {
  return json({ ok: true, ...rebuildFts(getDb()) });
});

const AskSchema = z.object({
  question: z.string().min(3).max(500),
  client_id: z.string().optional(),
});

// Lightweight per-user rate limit: the ask endpoint calls the LLM on every hit,
// so cap it to keep a runaway client (or a loop) from draining the API budget.
const ASK_LIMIT = 30;
const ASK_WINDOW_MS = 60 * 60 * 1000;
const askHits = new Map<string, number[]>();
function askRateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (askHits.get(userId) ?? []).filter((t) => now - t < ASK_WINDOW_MS);
  if (recent.length >= ASK_LIMIT) {
    askHits.set(userId, recent);
    return true;
  }
  recent.push(now);
  askHits.set(userId, recent);
  return false;
}

// Drop idle users so the map can't grow unbounded over a long-lived process.
function pruneAskHits(now: number): void {
  for (const [uid, hits] of askHits) {
    if (hits.every((t) => now - t >= ASK_WINDOW_MS)) askHits.delete(uid);
  }
}

route("POST", "/api/ask", "user", async (req, user) => {
  const parsed = AskSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error.issues);
  const actor = actorOf(user);
  pruneAskHits(Date.now());
  if (askRateLimited(actor.id)) {
    return json({ error: "Too many questions in a short window. Wait a bit and try again." }, 429);
  }
  const result = await askMemory(getDb(), parsed.data.question, { client_id: parsed.data.client_id }, actor);
  return json(result);
});
