import type { Database } from "bun:sqlite";
import { nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { appendEvent, transitionInsight, type Role } from "../events.ts";

/**
 * Completion evidence (SPEC.md section 8): the uniform done-signal across all
 * tracks. Rows start 'proposed'; a human confirm is the only path to 100
 * confidence and is what moves the insight to 'shipped'.
 */

export interface Actor {
  id: string;
  role: Role;
}

export class ServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Injectable liveness checker so tests never hit the network. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number }>;

const defaultFetch: FetchLike = (url) =>
  fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8000) });

export interface EvidenceRow {
  id: string;
  insight_id: string;
  kind: string;
  ref_match_id: string | null;
  url: string | null;
  url_verified_at: string | null;
  asset_id: string | null;
  confidence: number;
  status: "proposed" | "confirmed" | "rejected";
  attested_by: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
}

export function getEvidence(db: Database, id: string): EvidenceRow | null {
  return db.query("SELECT * FROM completion_evidence WHERE id = ?").get(id) as EvidenceRow | null;
}

export interface ProposeInput {
  insightId: string;
  /** release_match rows are created by the release matcher, not this endpoint */
  kind: "asset_published" | "ux_verified_in_prod" | "manual_attestation";
  url?: string;
  assetId?: string;
  confidence?: number;
  actor: Actor;
  fetchImpl?: FetchLike;
}

export async function proposeEvidence(db: Database, input: ProposeInput): Promise<EvidenceRow> {
  const insight = db
    .query("SELECT id, state FROM insights WHERE id = ?")
    .get(input.insightId) as { id: string; state: string } | null;
  if (!insight) throw new ServiceError(404, "Insight not found");
  if (insight.state !== "finalized" && insight.state !== "ticketed") {
    throw new ServiceError(
      409,
      `Evidence requires a finalized or ticketed insight (current state: ${insight.state})`,
    );
  }
  if (input.kind === "asset_published" && !input.url) {
    throw new ServiceError(400, "asset_published evidence requires a url");
  }
  if (input.kind === "ux_verified_in_prod" && !input.assetId && !input.url) {
    throw new ServiceError(400, "ux_verified_in_prod evidence requires asset_id or url");
  }
  if (input.assetId) {
    const asset = db.query("SELECT id FROM media_assets WHERE id = ?").get(input.assetId);
    if (!asset) throw new ServiceError(400, `Unknown asset_id: ${input.assetId}`);
  }

  // Liveness check: 2xx marks the url verified; any failure proceeds with null.
  let urlVerifiedAt: string | null = null;
  if (input.url) {
    try {
      const res = await (input.fetchImpl ?? defaultFetch)(input.url);
      if (res.ok) urlVerifiedAt = nowIso();
    } catch {
      // unreachable url is not a blocker, just lower default confidence
    }
  }

  const confidence = input.confidence ?? (urlVerifiedAt ? 90 : 50);
  const id = ulid();
  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO completion_evidence
         (id, insight_id, kind, url, url_verified_at, asset_id, confidence, status, attested_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    ).run(
      id,
      input.insightId,
      input.kind,
      input.url ?? null,
      urlVerifiedAt,
      input.assetId ?? null,
      confidence,
      input.actor.id,
      nowIso(),
    );
    appendEvent(db, {
      actorUserId: input.actor.id,
      entityType: "evidence",
      entityId: id,
      eventType: "evidence.proposed",
      payload: { kind: input.kind, url: input.url ?? null },
    });
  });
  tx();
  return getEvidence(db, id)!;
}

/**
 * Confirm any evidence kind (including release_match rows written by the
 * matcher). Assignee-or-admin only, mirroring transitionInsight's rule.
 */
export function confirmEvidence(db: Database, opts: { evidenceId: string; actor: Actor }): EvidenceRow {
  const row = db
    .query(
      `SELECT e.id, e.status, e.insight_id, e.kind, i.state AS insight_state, i.assignee_user_id
       FROM completion_evidence e JOIN insights i ON i.id = e.insight_id
       WHERE e.id = ?`,
    )
    .get(opts.evidenceId) as {
    id: string;
    status: string;
    insight_id: string;
    kind: string;
    insight_state: string;
    assignee_user_id: string | null;
  } | null;
  if (!row) throw new ServiceError(404, "Evidence not found");
  if (opts.actor.role !== "admin" && row.assignee_user_id !== opts.actor.id) {
    throw new ServiceError(403, "Only the insight assignee or an admin can confirm evidence");
  }
  if (row.status === "confirmed") return getEvidence(db, row.id)!; // idempotent
  if (row.status === "rejected") {
    throw new ServiceError(409, "Evidence was rejected; propose a new record instead");
  }

  // Insights already at or past shipped just get the row confirmed.
  const pastShipped = ["shipped", "client_notified", "closed"].includes(row.insight_state);
  const tx = db.transaction(() => {
    db.query(
      `UPDATE completion_evidence
       SET status = 'confirmed', confidence = 100, confirmed_by = ?, confirmed_at = ?
       WHERE id = ?`,
    ).run(opts.actor.id, nowIso(), row.id);
    appendEvent(db, {
      actorUserId: opts.actor.id,
      entityType: "evidence",
      entityId: row.id,
      eventType: "evidence.confirmed",
      payload: { insight_id: row.insight_id, kind: row.kind },
    });
    if (!pastShipped) {
      // Valid from 'finalized' (non-ticket tracks) and 'ticketed'; anything
      // else throws TransitionError and rolls back the confirm.
      transitionInsight(db, {
        insightId: row.insight_id,
        to: "shipped",
        actor: opts.actor,
        payload: { evidence_id: row.id, evidence_kind: row.kind },
      });
    }
  });
  tx();
  return getEvidence(db, row.id)!;
}

export function rejectEvidence(
  db: Database,
  opts: { evidenceId: string; reason: string; actor: Actor },
): EvidenceRow {
  const row = db
    .query("SELECT id, status, insight_id FROM completion_evidence WHERE id = ?")
    .get(opts.evidenceId) as { id: string; status: string; insight_id: string } | null;
  if (!row) throw new ServiceError(404, "Evidence not found");
  if (row.status === "confirmed") {
    throw new ServiceError(409, "Evidence already confirmed; rejection would contradict the event log");
  }
  const tx = db.transaction(() => {
    db.query("UPDATE completion_evidence SET status = 'rejected' WHERE id = ?").run(row.id);
    appendEvent(db, {
      actorUserId: opts.actor.id,
      entityType: "evidence",
      entityId: row.id,
      eventType: "evidence.rejected",
      payload: { insight_id: row.insight_id, reason: opts.reason },
    });
  });
  tx();
  return getEvidence(db, row.id)!;
}

export function listEvidence(db: Database, insightId: string): EvidenceRow[] {
  const insight = db.query("SELECT id FROM insights WHERE id = ?").get(insightId);
  if (!insight) throw new ServiceError(404, "Insight not found");
  return db
    .query("SELECT * FROM completion_evidence WHERE insight_id = ? ORDER BY created_at, id")
    .all(insightId) as EvidenceRow[];
}
