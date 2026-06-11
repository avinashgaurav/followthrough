import { z } from "zod";
import { route, json } from "../router.ts";
import { getDb } from "../db.ts";
import { env } from "../config.ts";
import { TransitionError } from "../events.ts";
import { LLMOutputError } from "../llm/provider.ts";
import { GitHubApiError } from "./github.ts";
import {
  HttpError,
  draftTicket,
  getTicket,
  listTicketsForInsight,
  markRaised,
  createDirect,
  type Actor,
} from "./service.ts";
import type { AuthedUser } from "../auth.ts";

export { markStaleDrafts } from "./service.ts"; // scheduler hook entry point

const MarkRaisedBody = z.object({ external_url: z.string() });
const CreateDirectBody = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name") });

function actorOf(user: AuthedUser | null): Actor {
  // routes below are auth tier "user": the router guarantees a session
  return { id: user!.id, role: user!.role };
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  if (err instanceof TransitionError) return json({ error: err.message }, 403);
  if (err instanceof GitHubApiError) return json({ error: err.message }, 502);
  if (err instanceof LLMOutputError) return json({ error: err.message }, 502);
  console.error("tickets route error:", err);
  return json({ error: "internal error" }, 500);
}

async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

route("POST", "/api/insights/:id/ticket-draft", "user", async (_req, user, params) => {
  try {
    const ticket = await draftTicket(getDb(), { insightId: params.id!, actor: actorOf(user) });
    return json(ticket, 201);
  } catch (err) {
    return errorResponse(err);
  }
});

route("GET", "/api/tickets/:id", "user", (_req, _user, params) => {
  try {
    return json(getTicket(getDb(), params.id!));
  } catch (err) {
    return errorResponse(err);
  }
});

route("GET", "/api/insights/:id/tickets", "user", (_req, _user, params) => {
  try {
    return json(listTicketsForInsight(getDb(), params.id!));
  } catch (err) {
    return errorResponse(err);
  }
});

route("POST", "/api/tickets/:id/mark-raised", "user", async (req, user, params) => {
  try {
    const body = await parseBody(req, MarkRaisedBody);
    const ticket = markRaised(getDb(), {
      ticketId: params.id!,
      externalUrl: body.external_url,
      actor: actorOf(user),
    });
    return json(ticket);
  } catch (err) {
    return errorResponse(err);
  }
});

route("POST", "/api/tickets/:id/create-direct", "user", async (req, user, params) => {
  try {
    const body = await parseBody(req, CreateDirectBody);
    const ticket = await createDirect(getDb(), {
      ticketId: params.id!,
      repo: body.repo,
      actor: actorOf(user),
      token: env.GITHUB_WRITE_TOKEN,
    });
    return json(ticket);
  } catch (err) {
    return errorResponse(err);
  }
});
