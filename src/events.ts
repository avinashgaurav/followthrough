import type { Database } from "bun:sqlite";
import { nowIso } from "./db.ts";

/**
 * Insight lifecycle state machine (SPEC.md section 4).
 * The events table is the source of truth; insights.state is a cache updated
 * in the same transaction. Corrections are compensating events, never edits.
 */
export type InsightState =
  | "extracted"
  | "triaged"
  | "finalized"
  | "ticketed"
  | "shipped"
  | "client_notified"
  | "closed"
  | "rejected"
  | "merged";

export type Role = "admin" | "member";

interface TransitionRule {
  to: InsightState;
  /** roles allowed to perform it; 'assignee' means the assigned user or admin */
  who: "any" | "assignee" | "admin";
  /** human-readable guard, enforced by the caller before invoking transition */
  guard?: string;
}

export const TRANSITIONS: Record<InsightState, TransitionRule[]> = {
  extracted: [
    { to: "triaged", who: "any", guard: "track and assignee set" },
    { to: "rejected", who: "any", guard: "reason in payload" },
    { to: "merged", who: "any", guard: "merge target in payload" },
  ],
  triaged: [
    { to: "finalized", who: "assignee", guard: "body_current non-empty" },
    { to: "rejected", who: "any", guard: "reason in payload" },
    { to: "merged", who: "any", guard: "merge target in payload" },
  ],
  finalized: [
    { to: "ticketed", who: "assignee", guard: "ticket raised with external_url" },
    { to: "shipped", who: "assignee", guard: "confirmed completion evidence (non-ticket tracks)" },
    { to: "rejected", who: "admin", guard: "reason in payload" },
  ],
  ticketed: [
    { to: "shipped", who: "assignee", guard: "confirmed completion evidence" },
  ],
  shipped: [
    { to: "client_notified", who: "assignee", guard: "email.copied event fired" },
    { to: "closed", who: "assignee", guard: "skip-notify reason in payload" },
  ],
  client_notified: [{ to: "closed", who: "assignee" }],
  closed: [
    { to: "finalized", who: "admin", guard: "reopen with reason" },
  ],
  rejected: [],
  merged: [],
};

export function canTransition(from: InsightState, to: InsightState): TransitionRule | null {
  return TRANSITIONS[from]?.find((r) => r.to === to) ?? null;
}

export function isActorAllowed(
  rule: TransitionRule,
  actor: { id: string; role: Role },
  assigneeId: string | null,
): boolean {
  if (actor.role === "admin") return true;
  if (rule.who === "any") return true;
  if (rule.who === "assignee") return assigneeId === actor.id;
  return false; // admin-only and actor is not admin
}

export interface EventInput {
  actorUserId: string | null; // null = system
  entityType: string;
  entityId: string;
  eventType: string;
  fromState?: string;
  toState?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  occurredAt?: string;
}

/** Append an event. Returns the event row id, or null if idempotency key already seen. */
export function appendEvent(db: Database, e: EventInput): number | null {
  if (e.idempotencyKey) {
    const dup = db
      .query("SELECT id FROM events WHERE idempotency_key = ?")
      .get(e.idempotencyKey) as { id: number } | null;
    if (dup) return null;
  }
  const res = db
    .query(
      `INSERT INTO events (occurred_at, actor_user_id, entity_type, entity_id, event_type,
                           from_state, to_state, payload_json, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.occurredAt ?? nowIso(),
      e.actorUserId,
      e.entityType,
      e.entityId,
      e.eventType,
      e.fromState ?? null,
      e.toState ?? null,
      e.payload ? JSON.stringify(e.payload) : null,
      e.idempotencyKey ?? null,
    );
  return Number(res.lastInsertRowid);
}

export class TransitionError extends Error {}

/**
 * Validated insight state transition: checks the transition map and actor,
 * appends the event and updates the cached state column in one transaction.
 */
export function transitionInsight(
  db: Database,
  opts: {
    insightId: string;
    to: InsightState;
    actor: { id: string; role: Role };
    payload?: Record<string, unknown>;
    /** admin-only escape hatch for revert/reopen paths outside the map */
    adminOverride?: boolean;
  },
): void {
  const row = db
    .query("SELECT state, assignee_user_id FROM insights WHERE id = ?")
    .get(opts.insightId) as { state: InsightState; assignee_user_id: string | null } | null;
  if (!row) throw new TransitionError(`Insight not found: ${opts.insightId}`);

  const rule = canTransition(row.state, opts.to);
  if (!rule && !(opts.adminOverride && opts.actor.role === "admin")) {
    throw new TransitionError(`Illegal transition ${row.state} -> ${opts.to}`);
  }
  if (rule && !isActorAllowed(rule, opts.actor, row.assignee_user_id)) {
    throw new TransitionError(
      `Actor ${opts.actor.id} not allowed for ${row.state} -> ${opts.to} (requires ${rule.who})`,
    );
  }
  if ((opts.to === "rejected" || opts.to === "closed") && rule?.guard?.includes("reason")) {
    if (!opts.payload?.reason) throw new TransitionError(`Transition to ${opts.to} requires a reason`);
  }
  if (opts.to === "merged" && !opts.payload?.merged_into) {
    throw new TransitionError("Transition to merged requires payload.merged_into");
  }

  const tx = db.transaction(() => {
    appendEvent(db, {
      actorUserId: opts.actor.id,
      entityType: "insight",
      entityId: opts.insightId,
      eventType: "insight.state_changed",
      fromState: row.state,
      toState: opts.to,
      payload: opts.payload,
    });
    db.query("UPDATE insights SET state = ?, updated_at = ? WHERE id = ?").run(
      opts.to,
      nowIso(),
      opts.insightId,
    );
    if (opts.to === "merged" && opts.payload?.merged_into) {
      db.query("UPDATE insights SET merged_into_insight_id = ? WHERE id = ?").run(
        String(opts.payload.merged_into),
        opts.insightId,
      );
    }
  });
  tx();
}
