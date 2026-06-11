import type { Database } from "bun:sqlite";
import { z } from "zod";
import { nowIso } from "../db.ts";
import { ulid, insightHandle } from "../ids.ts";
import { appendEvent, transitionInsight, TransitionError, type Role } from "../events.ts";
import { syncInsightFts } from "./search.ts";

/**
 * Insight triage, finalization, lifecycle, and queue logic (SPEC.md sections 3, 4, 12).
 * Every state change goes through transitionInsight; domain facts are appendEvent rows.
 * Functions take db first so tests inject openTestDb(); routes pass getDb().
 */

export const TRACKS = ["engineering", "marketing", "product_polish", "other"] as const;
export const ITEM_TYPES = [
  "feature_request",
  "complaint",
  "key_insight",
  "action_item_ours",
  "commitment_theirs",
  "status_update",
] as const;
export const STATES = [
  "extracted",
  "triaged",
  "finalized",
  "ticketed",
  "shipped",
  "client_notified",
  "closed",
  "rejected",
  "merged",
] as const;

export interface Actor {
  id: string;
  role: Role;
}

/** Service results carry the HTTP status so routes and tests share one mapping. */
export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

const notFound = (): HttpResult => ({ status: 404, body: { error: "insight not found" } });

function mapTransitionError(err: unknown): HttpResult {
  if (err instanceof TransitionError) {
    if (err.message.includes("not found")) return { status: 404, body: { error: err.message } };
    if (err.message.includes("not allowed")) return { status: 403, body: { error: err.message } };
    return { status: 409, body: { error: err.message } };
  }
  throw err;
}

function ageDays(sinceIso: string, now = Date.now()): number {
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return 0;
  return Math.max(0, Math.floor((now - since) / 86_400_000));
}

// ---------------------------------------------------------------- list

export const ListFiltersSchema = z.object({
  state: z.enum(STATES).optional(),
  track: z.enum(TRACKS).optional(),
  client_id: z.string().optional(),
  assignee: z.string().optional(),
  item_type: z.enum(ITEM_TYPES).optional(),
});
export type ListFilters = z.infer<typeof ListFiltersSchema>;

interface ListRowRaw {
  id: string;
  title: string;
  state: string;
  track: string | null;
  item_type: string;
  priority: number;
  version: number;
  client_id: string;
  client_name: string;
  assignee_user_id: string | null;
  ai_confidence: string | null;
  created_at: string;
  updated_at: string;
  mention_count: number;
  requester_count: number;
  state_changed_at: string | null;
  has_ticket: number;
  has_evidence: number;
}

export function listInsights(db: Database, filters: ListFilters) {
  const where: string[] = [];
  const args: string[] = [];
  if (filters.state) {
    where.push("i.state = ?");
    args.push(filters.state);
  }
  if (filters.track) {
    where.push("i.track = ?");
    args.push(filters.track);
  }
  if (filters.client_id) {
    where.push("i.client_id = ?");
    args.push(filters.client_id);
  }
  if (filters.assignee) {
    where.push("i.assignee_user_id = ?");
    args.push(filters.assignee);
  }
  if (filters.item_type) {
    where.push("i.item_type = ?");
    args.push(filters.item_type);
  }
  const rows = db
    .query(
      `SELECT i.id, i.title, i.state, i.track, i.item_type, i.priority, i.version,
              i.client_id, c.name AS client_name, i.assignee_user_id, i.ai_confidence,
              i.created_at, i.updated_at,
              (SELECT COUNT(*) FROM insight_mentions m WHERE m.insight_id = i.id) AS mention_count,
              (SELECT COUNT(*) FROM insight_requesters r WHERE r.insight_id = i.id) AS requester_count,
              (SELECT MAX(e.occurred_at) FROM events e
                WHERE e.entity_type = 'insight' AND e.entity_id = i.id
                  AND e.event_type = 'insight.state_changed') AS state_changed_at,
              EXISTS(SELECT 1 FROM tickets t WHERE t.insight_id = i.id) AS has_ticket,
              EXISTS(SELECT 1 FROM completion_evidence ce WHERE ce.insight_id = i.id) AS has_evidence
       FROM insights i JOIN clients c ON c.id = i.client_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY i.priority DESC, i.created_at DESC`,
    )
    .all(...args) as ListRowRaw[];

  const now = Date.now();
  return rows.map(({ state_changed_at, has_ticket, has_evidence, ...r }) => ({
    ...r,
    handle: insightHandle(r.id),
    age_days: ageDays(state_changed_at ?? r.created_at, now),
    has_ticket: has_ticket === 1,
    has_evidence: has_evidence === 1,
  }));
}

// ---------------------------------------------------------------- detail

const EDITING_STALE_MS = 10 * 60_000;

export function getInsightDetail(db: Database, id: string): Record<string, unknown> | null {
  const insight = db
    .query("SELECT i.*, c.name AS client_name FROM insights i JOIN clients c ON c.id = i.client_id WHERE i.id = ?")
    .get(id) as Record<string, unknown> | null;
  if (!insight) return null;

  const mentions = db
    .query(
      `SELECT m.id, m.meeting_id, m.client_id, m.quote, m.speaker, m.char_start, m.char_end, m.created_at,
              mt.meeting_date, mt.seq AS meeting_seq, c.name AS client_name
       FROM insight_mentions m
       JOIN meetings mt ON mt.id = m.meeting_id
       JOIN clients c ON c.id = m.client_id
       WHERE m.insight_id = ? ORDER BY m.created_at, m.id`,
    )
    .all(id);
  const requesters = db
    .query(
      `SELECT r.client_id, c.name AS client_name, r.first_requested_at, r.last_requested_at
       FROM insight_requesters r JOIN clients c ON c.id = r.client_id
       WHERE r.insight_id = ? ORDER BY r.first_requested_at`,
    )
    .all(id);
  const tags = db
    .query(
      `SELECT t.id, t.name, t.kind FROM insight_tags it JOIN tags t ON t.id = it.tag_id
       WHERE it.insight_id = ? ORDER BY t.name`,
    )
    .all(id);
  const tickets = db.query("SELECT * FROM tickets WHERE insight_id = ? ORDER BY drafted_at").all(id);
  const evidence = db
    .query("SELECT * FROM completion_evidence WHERE insight_id = ? ORDER BY created_at")
    .all(id);
  const emailDrafts = db
    .query("SELECT * FROM email_drafts WHERE insight_id = ? ORDER BY created_at")
    .all(id);
  const timeline = (
    db
      .query(
        `SELECT id, occurred_at, actor_user_id, event_type, from_state, to_state, payload_json
         FROM events WHERE entity_type = 'insight' AND entity_id = ? ORDER BY id`,
      )
      .all(id) as Array<{
      id: number;
      occurred_at: string;
      actor_user_id: string | null;
      event_type: string;
      from_state: string | null;
      to_state: string | null;
      payload_json: string | null;
    }>
  ).map(({ payload_json, ...e }) => ({
    ...e,
    payload: payload_json ? (JSON.parse(payload_json) as unknown) : null,
  }));

  const editingAt = typeof insight.editing_at === "string" ? Date.parse(insight.editing_at) : NaN;
  const editingActive =
    !!insight.editing_by && !Number.isNaN(editingAt) && Date.now() - editingAt < EDITING_STALE_MS;

  return {
    ...insight,
    handle: insightHandle(id),
    editing_active: editingActive,
    mentions,
    requesters,
    tags,
    tickets,
    completion_evidence: evidence,
    email_drafts: emailDrafts,
    timeline,
  };
}

// ---------------------------------------------------------------- triage

export const TriageSchema = z.object({
  track: z.enum(TRACKS),
  assignee_user_id: z.string().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  item_type: z.enum(ITEM_TYPES).optional(),
});
export type TriageInput = z.infer<typeof TriageSchema>;

function upsertTag(db: Database, name: string): string {
  // tags.name is UNIQUE COLLATE NOCASE, so the lookup dedupes case-insensitively
  const existing = db.query("SELECT id FROM tags WHERE name = ?").get(name) as { id: string } | null;
  if (existing) return existing.id;
  const id = ulid();
  db.query("INSERT INTO tags (id, name, kind) VALUES (?, ?, 'freeform')").run(id, name);
  return id;
}

export function triageInsight(db: Database, id: string, actor: Actor, input: TriageInput): HttpResult {
  const row = db
    .query("SELECT state, track, assignee_user_id, item_type FROM insights WHERE id = ?")
    .get(id) as
    | { state: string; track: string | null; assignee_user_id: string | null; item_type: string }
    | null;
  if (!row) return notFound();
  if (input.assignee_user_id) {
    const u = db.query("SELECT 1 AS x FROM users WHERE id = ?").get(input.assignee_user_id);
    if (!u) return { status: 400, body: { error: "assignee user not found" } };
  }

  try {
    const tx = db.transaction(() => {
      db.query(
        `UPDATE insights SET track = ?,
            assignee_user_id = COALESCE(?, assignee_user_id),
            item_type = COALESCE(?, item_type),
            updated_at = ?
         WHERE id = ?`,
      ).run(input.track, input.assignee_user_id ?? null, input.item_type ?? null, nowIso(), id);

      for (const name of input.tags ?? []) {
        const tagId = upsertTag(db, name);
        db.query(
          "INSERT OR IGNORE INTO insight_tags (insight_id, tag_id, applied_by, applied_at) VALUES (?, ?, ?, ?)",
        ).run(id, tagId, actor.id, nowIso());
      }

      if (row.state === "extracted") {
        transitionInsight(db, {
          insightId: id,
          to: "triaged",
          actor,
          payload: {
            track: input.track,
            assignee_user_id: input.assignee_user_id ?? row.assignee_user_id,
          },
        });
      } else {
        appendEvent(db, {
          actorUserId: actor.id,
          entityType: "insight",
          entityId: id,
          eventType: "insight.routed",
          payload: {
            previous: {
              track: row.track,
              assignee_user_id: row.assignee_user_id,
              item_type: row.item_type,
            },
            track: input.track,
            assignee_user_id: input.assignee_user_id ?? row.assignee_user_id,
            item_type: input.item_type ?? row.item_type,
          },
        });
      }
      syncInsightFts(db, id);
    });
    tx();
  } catch (err) {
    return mapTransitionError(err);
  }

  const updated = db.query("SELECT * FROM insights WHERE id = ?").get(id) as Record<string, unknown>;
  return { status: 200, body: { ok: true, insight: { ...updated, handle: insightHandle(id) } } };
}

// ---------------------------------------------------------------- body edit (optimistic concurrency)

export const BodyEditSchema = z.object({
  body_current: z.string(),
  version: z.number().int().min(1),
});

export function updateBody(
  db: Database,
  id: string,
  actor: Actor,
  bodyCurrent: string,
  version: number,
): HttpResult {
  let result: HttpResult | null = null;
  const tx = db.transaction(() => {
    const row = db.query("SELECT body_current, version FROM insights WHERE id = ?").get(id) as
      | { body_current: string; version: number }
      | null;
    if (!row) {
      result = notFound();
      return;
    }
    const res = db
      .query("UPDATE insights SET body_current = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
      .run(bodyCurrent, nowIso(), id, version);
    if (res.changes === 0) {
      result = {
        status: 409,
        body: { error: "version conflict: insight was edited by someone else", current_version: row.version },
      };
      return;
    }
    // body_original is never touched here, by design
    appendEvent(db, {
      actorUserId: actor.id,
      entityType: "insight",
      entityId: id,
      eventType: "insight.body_edited",
      payload: { chars_before: row.body_current.length, chars_after: bodyCurrent.length },
    });
    syncInsightFts(db, id);
    result = { status: 200, body: { ok: true, version: row.version + 1 } };
  });
  tx();
  return result ?? { status: 500, body: { error: "body update did not complete" } };
}

// ---------------------------------------------------------------- finalize / reject / merge

export function finalizeInsight(db: Database, id: string, actor: Actor): HttpResult {
  const row = db.query("SELECT state, body_current FROM insights WHERE id = ?").get(id) as
    | { state: string; body_current: string }
    | null;
  if (!row) return notFound();
  if (row.body_current.trim().length === 0) {
    return { status: 400, body: { error: "body_current is empty; polish the insight before finalizing" } };
  }
  try {
    const tx = db.transaction(() => {
      transitionInsight(db, { insightId: id, to: "finalized", actor });
      db.query("UPDATE insights SET finalized_by = ?, updated_at = ? WHERE id = ?").run(
        actor.id,
        nowIso(),
        id,
      );
    });
    tx();
  } catch (err) {
    return mapTransitionError(err);
  }
  return { status: 200, body: { ok: true, state: "finalized", finalized_by: actor.id } };
}

export const RejectSchema = z.object({ reason: z.string().trim().min(1) });

export function rejectInsight(db: Database, id: string, actor: Actor, reason: string): HttpResult {
  const row = db.query("SELECT state FROM insights WHERE id = ?").get(id);
  if (!row) return notFound();
  try {
    transitionInsight(db, { insightId: id, to: "rejected", actor, payload: { reason } });
  } catch (err) {
    return mapTransitionError(err);
  }
  return { status: 200, body: { ok: true, state: "rejected" } };
}

export const MergeSchema = z.object({ into_insight_id: z.string().min(1) });

export function mergeInsight(db: Database, sourceId: string, intoId: string, actor: Actor): HttpResult {
  if (sourceId === intoId) {
    return { status: 400, body: { error: "cannot merge an insight into itself" } };
  }
  const source = db.query("SELECT id, priority FROM insights WHERE id = ?").get(sourceId) as
    | { id: string; priority: number }
    | null;
  if (!source) return notFound();
  const target = db.query("SELECT id, state FROM insights WHERE id = ?").get(intoId) as
    | { id: string; state: string }
    | null;
  if (!target) return { status: 400, body: { error: "merge target not found" } };
  if (target.state === "rejected" || target.state === "merged") {
    return { status: 409, body: { error: `merge target is terminal (${target.state})` } };
  }

  try {
    const tx = db.transaction(() => {
      transitionInsight(db, {
        insightId: sourceId,
        to: "merged",
        actor,
        payload: { merged_into: intoId },
      });

      const mentions = db
        .query(
          "SELECT meeting_id, client_id, quote, speaker, char_start, char_end, created_at FROM insight_mentions WHERE insight_id = ?",
        )
        .all(sourceId) as Array<{
        meeting_id: string;
        client_id: string;
        quote: string;
        speaker: string | null;
        char_start: number | null;
        char_end: number | null;
        created_at: string;
      }>;
      const insertMention = db.query(
        `INSERT INTO insight_mentions (id, insight_id, meeting_id, client_id, quote, speaker, char_start, char_end, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of mentions) {
        insertMention.run(ulid(), intoId, m.meeting_id, m.client_id, m.quote, m.speaker, m.char_start, m.char_end, m.created_at);
      }

      const requesters = db
        .query("SELECT client_id, first_requested_at, last_requested_at FROM insight_requesters WHERE insight_id = ?")
        .all(sourceId) as Array<{ client_id: string; first_requested_at: string; last_requested_at: string }>;
      for (const r of requesters) {
        db.query(
          "INSERT OR IGNORE INTO insight_requesters (insight_id, client_id, first_requested_at, last_requested_at) VALUES (?, ?, ?, ?)",
        ).run(intoId, r.client_id, r.first_requested_at, r.last_requested_at);
        // ISO-8601 UTC strings compare chronologically, so MIN/MAX keep earliest/latest
        db.query(
          `UPDATE insight_requesters SET
              first_requested_at = MIN(first_requested_at, ?),
              last_requested_at = MAX(last_requested_at, ?)
           WHERE insight_id = ? AND client_id = ?`,
        ).run(r.first_requested_at, r.last_requested_at, intoId, r.client_id);
      }

      db.query("UPDATE insights SET priority = priority + ? + 1, updated_at = ? WHERE id = ?").run(
        source.priority,
        nowIso(),
        intoId,
      );
      appendEvent(db, {
        actorUserId: actor.id,
        entityType: "insight",
        entityId: intoId,
        eventType: "insight.absorbed_merge",
        payload: { from: sourceId },
      });
      syncInsightFts(db, intoId);
      syncInsightFts(db, sourceId);
    });
    tx();
  } catch (err) {
    return mapTransitionError(err);
  }
  return { status: 200, body: { ok: true, merged_into: intoId } };
}

// ---------------------------------------------------------------- editing soft lock

export const EditingSchema = z.object({ on: z.boolean() });

export function setEditing(db: Database, id: string, actor: Actor, on: boolean): HttpResult {
  const row = db.query("SELECT editing_by FROM insights WHERE id = ?").get(id) as
    | { editing_by: string | null }
    | null;
  if (!row) return notFound();
  if (on) {
    db.query("UPDATE insights SET editing_by = ?, editing_at = ? WHERE id = ?").run(actor.id, nowIso(), id);
  } else if (row.editing_by === actor.id) {
    db.query("UPDATE insights SET editing_by = NULL, editing_at = NULL WHERE id = ?").run(id);
  }
  const updated = db.query("SELECT editing_by, editing_at FROM insights WHERE id = ?").get(id) as {
    editing_by: string | null;
    editing_at: string | null;
  };
  return { status: 200, body: { ok: true, editing_by: updated.editing_by, editing_at: updated.editing_at } };
}

// ---------------------------------------------------------------- my queue

interface QueueItem {
  id: string;
  handle?: string;
  title: string;
  state: string;
  track: string | null;
  item_type: string;
  priority: number;
  client_id: string;
  client_name: string;
  assignee_user_id: string | null;
  created_at: string;
}

const QUEUE_SELECT = `
  SELECT i.id, i.title, i.state, i.track, i.item_type, i.priority,
         i.client_id, c.name AS client_name, i.assignee_user_id, i.created_at
  FROM insights i JOIN clients c ON c.id = i.client_id`;

function withHandles(rows: QueueItem[]): QueueItem[] {
  return rows.map((r) => ({ ...r, handle: insightHandle(r.id) }));
}

export function getQueue(db: Database, user: Actor): Record<string, unknown> {
  const toReview = db
    .query(
      `${QUEUE_SELECT}
       WHERE i.state = 'extracted' AND (i.assignee_user_id IS NULL OR i.assignee_user_id = ?)
       ORDER BY i.priority DESC, i.created_at`,
    )
    .all(user.id) as QueueItem[];

  const toFinalize = db
    .query(
      `${QUEUE_SELECT}
       WHERE i.state = 'triaged' AND i.assignee_user_id = ?
       ORDER BY i.priority DESC, i.created_at`,
    )
    .all(user.id) as QueueItem[];

  const toTicket = db
    .query(
      `${QUEUE_SELECT}
       WHERE i.state = 'finalized' AND i.track = 'engineering' AND i.assignee_user_id = ?
         AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.insight_id = i.id AND t.raised_at IS NOT NULL)
       ORDER BY i.priority DESC, i.created_at`,
    )
    .all(user.id) as QueueItem[];

  const toConfirm = db
    .query(
      `SELECT ce.id AS evidence_id, ce.kind AS evidence_kind, ce.confidence, ce.created_at AS proposed_at,
              i.id, i.title, i.state, i.track, i.item_type, i.priority,
              i.client_id, c.name AS client_name, i.assignee_user_id, i.created_at
       FROM completion_evidence ce
       JOIN insights i ON i.id = ce.insight_id
       JOIN clients c ON c.id = i.client_id
       WHERE ce.status = 'proposed' AND i.assignee_user_id = ?
       ORDER BY ce.created_at`,
    )
    .all(user.id) as Array<QueueItem & { evidence_id: string; evidence_kind: string; confidence: number; proposed_at: string }>;

  // an email.copied event may target the insight directly or one of its drafts
  const toEmail = db
    .query(
      `${QUEUE_SELECT}
       WHERE i.state = 'shipped' AND i.assignee_user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM events e
           LEFT JOIN email_drafts d ON d.id = e.entity_id
           WHERE e.event_type = 'email.copied' AND (e.entity_id = i.id OR d.insight_id = i.id)
         )
       ORDER BY i.priority DESC, i.created_at`,
    )
    .all(user.id) as QueueItem[];

  const queue: Record<string, unknown> = {
    to_review: withHandles(toReview),
    to_finalize: withHandles(toFinalize),
    to_ticket: withHandles(toTicket),
    to_confirm: toConfirm.map((r) => ({ ...r, handle: insightHandle(r.id) })),
    to_email: withHandles(toEmail),
  };

  if (user.role === "admin") {
    const counts = db.query("SELECT state, COUNT(*) AS n FROM insights GROUP BY state").all() as Array<{
      state: string;
      n: number;
    }>;
    queue.org_counts = Object.fromEntries(counts.map((c) => [c.state, c.n]));
  }
  return queue;
}
