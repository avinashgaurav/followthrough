import { getDb } from "./db.ts";
import { userForSession, readSessionCookie, guestUser, type AuthedUser } from "./auth.ts";
import { authRequired } from "./settings.ts";

export type Handler = (
  req: Request,
  user: AuthedUser | null,
  params: Record<string, string>,
) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
  auth: "public" | "user" | "admin";
}

const routes: Route[] = [];

/** Register a route. Path params use :name. Modules call this at import time. */
export function route(method: string, path: string, auth: Route["auth"], handler: Handler): void {
  const paramNames: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([a-zA-Z]+)/g, (_, name: string) => {
        paramNames.push(name);
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern, paramNames, handler, auth });
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function dispatch(req: Request): Promise<Response> | Response | null {
  const url = new URL(req.url);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1]!)));
    const db = getDb();
    let user = userForSession(db, readSessionCookie(req));
    // Open by default: with login not required, fall back to a guest admin so the
    // whole app works with no sign-in. A real session always takes precedence.
    if (!user && !authRequired(db)) user = guestUser(db);
    if (r.auth !== "public") {
      if (!user) return json({ error: "unauthorized" }, 401);
      if (r.auth === "admin" && user.role !== "admin") return json({ error: "admin only" }, 403);
    }
    return r.handler(req, user, params);
  }
  return null; // not an API route; caller may serve static files
}
