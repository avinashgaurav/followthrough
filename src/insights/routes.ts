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

route("GET", "/api/search", "user", (req) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return json({ error: "q is required" }, 400);
  const parsed = SearchFiltersSchema.safeParse(queryParams(url, ["client_id", "track", "state"]));
  if (!parsed.success) return invalid(parsed.error.issues);
  return json(searchAll(getDb(), q, parsed.data));
});

route("POST", "/api/search/rebuild", "admin", () => {
  return json({ ok: true, ...rebuildFts(getDb()) });
});
