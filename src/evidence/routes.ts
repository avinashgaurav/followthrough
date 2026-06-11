import { z } from "zod";
import { route, json } from "../router.ts";
import { getDb } from "../db.ts";
import { TransitionError } from "../events.ts";
import {
  ServiceError,
  proposeEvidence,
  confirmEvidence,
  rejectEvidence,
  listEvidence,
} from "./service.ts";

const ProposeBody = z.object({
  kind: z.enum(["asset_published", "ux_verified_in_prod", "manual_attestation"]),
  url: z.string().min(1).optional(),
  asset_id: z.string().min(1).optional(),
  confidence: z.number().int().min(0).max(100).optional(),
});

const RejectBody = z.object({ reason: z.string().min(1) });

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function fail(err: unknown): Response {
  if (err instanceof ServiceError) return json({ error: err.message }, err.status);
  if (err instanceof TransitionError) {
    return json({ error: err.message }, /not allowed/i.test(err.message) ? 403 : 409);
  }
  throw err;
}

route("POST", "/api/insights/:id/evidence", "user", async (req, user, params) => {
  const parsed = ProposeBody.safeParse(await readBody(req));
  if (!parsed.success) return json({ error: "invalid body", issues: parsed.error.issues }, 400);
  try {
    const evidence = await proposeEvidence(getDb(), {
      insightId: params.id ?? "",
      kind: parsed.data.kind,
      url: parsed.data.url,
      assetId: parsed.data.asset_id,
      confidence: parsed.data.confidence,
      actor: { id: user!.id, role: user!.role },
    });
    return json({ evidence }, 201);
  } catch (err) {
    return fail(err);
  }
});

route("POST", "/api/evidence/:id/confirm", "user", (_req, user, params) => {
  try {
    const evidence = confirmEvidence(getDb(), {
      evidenceId: params.id ?? "",
      actor: { id: user!.id, role: user!.role },
    });
    return json({ evidence });
  } catch (err) {
    return fail(err);
  }
});

route("POST", "/api/evidence/:id/reject", "user", async (req, user, params) => {
  const parsed = RejectBody.safeParse(await readBody(req));
  if (!parsed.success) return json({ error: "reason is required", issues: parsed.error.issues }, 400);
  try {
    const evidence = rejectEvidence(getDb(), {
      evidenceId: params.id ?? "",
      reason: parsed.data.reason,
      actor: { id: user!.id, role: user!.role },
    });
    return json({ evidence });
  } catch (err) {
    return fail(err);
  }
});

route("GET", "/api/insights/:id/evidence", "user", (_req, _user, params) => {
  try {
    return json({ evidence: listEvidence(getDb(), params.id ?? "") });
  } catch (err) {
    return fail(err);
  }
});
