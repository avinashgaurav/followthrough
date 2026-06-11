import { z } from "zod";
import { route, json } from "../router.ts";
import { getDb } from "../db.ts";
import { TransitionError } from "../events.ts";
import {
  ServiceError,
  generateDrafts,
  listDrafts,
  markCopied,
  confirmSent,
  closeInsight,
} from "./service.ts";

const SentConfirmBody = z.object({ final_text: z.string().optional() });
const CloseBody = z.object({ reason: z.string().min(1).optional() });

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {}; // body optional on these endpoints
  }
}

function fail(err: unknown): Response {
  if (err instanceof ServiceError) return json({ error: err.message }, err.status);
  if (err instanceof TransitionError) {
    const msg = err.message;
    if (/not allowed/i.test(msg)) return json({ error: msg }, 403);
    if (/requires a reason/i.test(msg)) return json({ error: msg }, 400);
    return json({ error: msg }, 409);
  }
  throw err;
}

route("POST", "/api/insights/:id/email-drafts", "user", async (_req, user, params) => {
  try {
    const drafts = await generateDrafts(getDb(), {
      insightId: params.id ?? "",
      actor: { id: user!.id, role: user!.role },
    });
    return json({ drafts }, 201);
  } catch (err) {
    return fail(err);
  }
});

route("GET", "/api/insights/:id/email-drafts", "user", (_req, _user, params) => {
  try {
    return json({ drafts: listDrafts(getDb(), params.id ?? "") });
  } catch (err) {
    return fail(err);
  }
});

route("POST", "/api/emails/:id/copied", "user", (_req, user, params) => {
  try {
    const result = markCopied(getDb(), {
      draftId: params.id ?? "",
      actor: { id: user!.id, role: user!.role },
    });
    return json(result);
  } catch (err) {
    return fail(err);
  }
});

route("POST", "/api/emails/:id/sent-confirm", "user", async (req, user, params) => {
  const parsed = SentConfirmBody.safeParse(await readBody(req));
  if (!parsed.success) return json({ error: "invalid body", issues: parsed.error.issues }, 400);
  try {
    const draft = confirmSent(getDb(), {
      draftId: params.id ?? "",
      finalText: parsed.data.final_text,
      actor: { id: user!.id, role: user!.role },
    });
    return json({ draft });
  } catch (err) {
    return fail(err);
  }
});

route("POST", "/api/insights/:id/close", "user", async (req, user, params) => {
  const parsed = CloseBody.safeParse(await readBody(req));
  if (!parsed.success) return json({ error: "invalid body", issues: parsed.error.issues }, 400);
  try {
    closeInsight(getDb(), {
      insightId: params.id ?? "",
      reason: parsed.data.reason,
      actor: { id: user!.id, role: user!.role },
    });
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
});
