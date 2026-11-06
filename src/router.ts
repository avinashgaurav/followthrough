import { getDb } from "./db.ts";
import { userForSession, readSessionCookie, guestUser, type AuthedUser } from "./auth.ts";
import { authRequired } from "./settings.ts";
import { demoBlocks, DEMO_BLOCKED_MESSAGE } from "./demo.ts";
import { isAIConfigError, LLMBudgetError, LLMRateLimitError } from "./llm/provider.ts";

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

export async function dispatch(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    const params: Record<string, string> = {};
    try {
      r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1]!)));
    } catch {
      return json({ error: "bad request: malformed URL encoding" }, 400);
    }
    if (demoBlocks(req.method, url.pathname)) {
      return json({ error: DEMO_BLOCKED_MESSAGE, demo: true }, 403);
    }
    let user: AuthedUser | null = null;
    // Public routes never look at the user, so they skip the session lookup.
    if (r.auth !== "public") {
      const db = getDb();
      user = await userForSession(db, readSessionCookie(req));
      // Open mode (login not required): fall back to a guest admin so the whole
      // app works with no sign-in. A real session always takes precedence, and
      // with login required no guest is ever created.
      if (!user && !(await authRequired(db))) user = await guestUser(db);
      if (!user) return json({ error: "unauthorized" }, 401);
      if (r.auth === "admin" && user.role !== "admin") return json({ error: "admin only" }, 403);
    }
    return Promise.resolve(r.handler(req, user, params)).catch((err: unknown) => {
      // Plain words for people, never the provider's text. The client adds
      // what was kept (a pasted call stays saved; see Capture and Meeting).
      if (err instanceof LLMBudgetError || err instanceof LLMRateLimitError) {
        // The provider's detail stays in the logs for the operator.
        console.warn(`${req.method} ${url.pathname}: ${err.message.slice(0, 300)}`);
      }
      if (err instanceof LLMBudgetError) {
        return json({ error: "The AI has done all it can for today. Try again tomorrow.", kind: "budget" }, 503);
      }
      if (isAIConfigError(err)) {
        // Status and the message's first part only ("Gemini 400"): never the upstream body.
        const e = err as { status?: unknown; message?: unknown };
        console.error(
          `${req.method} ${url.pathname}: the AI provider rejected this server's API key ` +
            `(check ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY): status=${String(e.status ?? "?")} ` +
            String(e.message ?? "").split(":")[0]!.slice(0, 80),
        );
        return json(
          { error: "AI isn't configured on this server: the AI provider rejected its API key. The operator needs to fix it.", kind: "ai_config" },
          503,
        );
      }
      if (err instanceof LLMRateLimitError) {
        return err.daily
          ? json({ error: "The AI has done all it can for today. Try again tomorrow.", kind: "budget" }, 503)
          : json({ error: "The AI is busy right now. Try again in a few minutes.", kind: "rate_limit" }, 503);
      }
      // Never answer with a stack trace or a server error page.
      console.error(`${req.method} ${url.pathname} failed:`, err);
      return json({ error: "Something went wrong on the server. Try again." }, 500);
    });
  }
  return null; // not an API route; caller may serve static files
}
