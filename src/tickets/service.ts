import type { Database } from "bun:sqlite";
import { z } from "zod";
import { nowIso } from "../db.ts";
import { ulid, insightHandle } from "../ids.ts";
import { appendEvent, transitionInsight, canTransition, isActorAllowed, type Role } from "../events.ts";
import { getLLM } from "../llm/provider.ts";
import { assertRepoWritable } from "../config.ts";
import { createIssue, type FetchLike } from "./github.ts";

/**
 * Ticketing (SPEC.md section 7): draft-first, human-triggered only.
 * The tool never creates a GitHub issue on its own. Direct API creation is
 * gated by assertRepoWritable (XYZ org blocked); manual paste-back may
 * name any repo because the human created that issue, not the tool.
 */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Actor = { id: string; role: Role };

export interface TicketRow {
  id: string;
  insight_id: string;
  repo: string | null;
  draft_title: string;
  draft_body_md: string;
  state: "draft" | "raised" | "stale" | "closed";
  create_mode: "manual_paste" | "direct_api" | null;
  external_url: string | null;
  external_number: number | null;
  created_by: string | null;
  drafted_at: string;
  raised_at: string | null;
}

interface InsightRow {
  id: string;
  state: string;
  track: string | null;
  title: string;
  body_current: string;
  client_id: string;
  assignee_user_id: string | null;
}

const ISSUE_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/;

const TicketDraftSchema = z.object({
  title: z.string().min(1),
  body_md: z.string().min(1),
});

// Stable system prompt (prompt caching). Do not interpolate anything into it.
const DRAFT_SYSTEM_PROMPT = [
  "You draft GitHub issues from finalized client insights for an engineering team.",
  "Write a crisp, technical issue:",
  "- Start with a clear problem statement derived from the finalized insight body.",
  "- Include the client verbatim quotes as evidence, each attributed with the client name and meeting date.",
  "- End with acceptance criteria as a short bulleted list.",
  "- Plain engineering language only. No marketing fluff, no praise, no filler.",
  "Return JSON with fields: title, body_md.",
].join("\n");

function loadInsight(db: Database, insightId: string): InsightRow {
  const row = db
    .query(
      `SELECT id, state, track, title, body_current, client_id, assignee_user_id
       FROM insights WHERE id = ?`,
    )
    .get(insightId) as InsightRow | null;
  if (!row) throw new HttpError(404, `Insight not found: ${insightId}`);
  return row;
}

function loadTicket(db: Database, ticketId: string): TicketRow {
  const row = db.query("SELECT * FROM tickets WHERE id = ?").get(ticketId) as TicketRow | null;
  if (!row) throw new HttpError(404, `Ticket not found: ${ticketId}`);
  return row;
}

export function getTicket(db: Database, ticketId: string): TicketRow {
  return loadTicket(db, ticketId);
}

export function listTicketsForInsight(db: Database, insightId: string): TicketRow[] {
  loadInsight(db, insightId);
  return db
    .query("SELECT * FROM tickets WHERE insight_id = ? ORDER BY drafted_at DESC, id DESC")
    .all(insightId) as TicketRow[];
}

function requesterNames(db: Database, insight: InsightRow): string[] {
  const rows = db
    .query(
      `SELECT c.name FROM insight_requesters r
       JOIN clients c ON c.id = r.client_id
       WHERE r.insight_id = ? ORDER BY r.first_requested_at, c.name`,
    )
    .all(insight.id) as Array<{ name: string }>;
  if (rows.length > 0) return rows.map((r) => r.name);
  const origin = db.query("SELECT name FROM clients WHERE id = ?").get(insight.client_id) as
    | { name: string }
    | null;
  return origin ? [origin.name] : [];
}

interface Evidence {
  quote: string;
  speaker: string | null;
  client_name: string;
  meeting_date: string;
}

function mentionEvidence(db: Database, insightId: string): Evidence[] {
  return db
    .query(
      `SELECT m.quote, m.speaker, c.name AS client_name, mt.meeting_date
       FROM insight_mentions m
       JOIN meetings mt ON mt.id = m.meeting_id
       JOIN clients c ON c.id = m.client_id
       WHERE m.insight_id = ? ORDER BY mt.meeting_date, m.created_at`,
    )
    .all(insightId) as Evidence[];
}

/** Footer appended in code, never left to the LLM: requester count + hidden machine marker. */
export function ticketFooter(insightId: string, names: string[]): string {
  return [
    "---",
    `Requested by ${names.length} client(s): ${names.join(", ")}`,
    `<!-- followthrough:${insightHandle(insightId)} -->`,
    `Followthrough ref: ${insightId}`,
  ].join("\n");
}

export async function draftTicket(
  db: Database,
  opts: { insightId: string; actor: Actor },
): Promise<TicketRow> {
  const insight = loadInsight(db, opts.insightId);
  if (insight.state !== "finalized" && insight.state !== "ticketed") {
    throw new HttpError(409, `Insight must be finalized to draft a ticket (state: ${insight.state})`);
  }
  if (insight.track !== "engineering" && insight.track !== "product_polish") {
    throw new HttpError(
      409,
      `Ticket drafts apply only to engineering or product_polish tracks (track: ${insight.track ?? "unset"})`,
    );
  }

  const names = requesterNames(db, insight);
  const evidence = mentionEvidence(db, opts.insightId);
  const evidenceBlock =
    evidence.length > 0
      ? evidence
          .map(
            (e) =>
              `- "${e.quote}"${e.speaker ? ` (${e.speaker}, ` : " ("}${e.client_name}, meeting on ${e.meeting_date})`,
          )
          .join("\n")
      : "- (no verbatim quotes recorded)";

  const prompt = [
    `Insight title: ${insight.title}`,
    "",
    "Finalized insight body:",
    insight.body_current,
    "",
    "Client evidence quotes (verbatim, with client and meeting date):",
    evidenceBlock,
    "",
    `Requesting clients: ${names.join(", ") || "(unknown)"}`,
  ].join("\n");

  const { data } = await getLLM().completeJSON({
    system: DRAFT_SYSTEM_PROMPT,
    prompt,
    schema: TicketDraftSchema,
  });

  const bodyMd = `${data.body_md.trimEnd()}\n\n${ticketFooter(opts.insightId, names)}\n`;
  const id = ulid();
  const t = nowIso();
  db.transaction(() => {
    db.query(
      `INSERT INTO tickets (id, insight_id, draft_title, draft_body_md, state, created_by, drafted_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(id, opts.insightId, data.title, bodyMd, opts.actor.id, t);
    appendEvent(db, {
      actorUserId: opts.actor.id,
      entityType: "ticket",
      entityId: id,
      eventType: "ticket.drafted",
      payload: { insight_id: opts.insightId, redraft: insight.state === "ticketed" },
    });
  })();
  return loadTicket(db, id);
}

/** Shared persistence for both raise paths: update ticket + event + insight transition, atomically. */
function persistRaise(
  db: Database,
  ticket: TicketRow,
  raise: { repo: string; url: string; number: number; mode: "manual_paste" | "direct_api"; actor: Actor },
): TicketRow {
  const t = nowIso();
  db.transaction(() => {
    db.query(
      `UPDATE tickets SET repo = ?, external_url = ?, external_number = ?, create_mode = ?,
       state = 'raised', raised_at = ? WHERE id = ?`,
    ).run(raise.repo, raise.url, raise.number, raise.mode, t, ticket.id);
    appendEvent(db, {
      actorUserId: raise.actor.id,
      entityType: "ticket",
      entityId: ticket.id,
      eventType: "ticket.raised",
      payload: { repo: raise.repo, number: raise.number, mode: raise.mode, insight_id: ticket.insight_id },
    });
    const ins = db.query("SELECT state FROM insights WHERE id = ?").get(ticket.insight_id) as
      | { state: string }
      | null;
    // finalized -> ticketed; skip when already ticketed (re-draft path)
    if (ins?.state === "finalized") {
      transitionInsight(db, {
        insightId: ticket.insight_id,
        to: "ticketed",
        actor: raise.actor,
        payload: { ticket_id: ticket.id, external_url: raise.url },
      });
    }
  })();
  return loadTicket(db, ticket.id);
}

/**
 * Manual copy-paste path. The pasted URL may name ANY repo including XYZ:
 * the human created that issue by hand, so assertRepoWritable does not apply.
 */
export function markRaised(
  db: Database,
  opts: { ticketId: string; externalUrl: string; actor: Actor },
): TicketRow {
  const ticket = loadTicket(db, opts.ticketId);
  if (ticket.state === "raised") {
    throw new HttpError(409, "Ticket is already raised");
  }
  const m = opts.externalUrl.match(ISSUE_URL_RE);
  if (!m) {
    throw new HttpError(400, "external_url must be a GitHub issue URL like https://github.com/owner/repo/issues/123");
  }
  const repo = `${m[1]}/${m[2]}`;
  const number = Number(m[3]);
  return persistRaise(db, ticket, { repo, url: opts.externalUrl, number, mode: "manual_paste", actor: opts.actor });
}

/**
 * Direct API creation. assertRepoWritable runs FIRST, before any other check:
 * XYZ and non-allowlisted repos get a 403 before the ticket is even loaded.
 */
export async function createDirect(
  db: Database,
  opts: { ticketId: string; repo: string; actor: Actor; token: string | undefined; fetchImpl?: FetchLike },
): Promise<TicketRow> {
  try {
    assertRepoWritable(opts.repo);
  } catch (err) {
    throw new HttpError(403, err instanceof Error ? err.message : String(err));
  }
  const ticket = loadTicket(db, opts.ticketId);
  if (ticket.state === "raised") {
    throw new HttpError(409, "Ticket is already raised");
  }
  if (!opts.token) {
    throw new HttpError(400, "no write token configured");
  }
  // Check transition permission BEFORE the GitHub call: the API write is an
  // external side effect that cannot be rolled back if the transition fails.
  const ins = db
    .query("SELECT state, assignee_user_id FROM insights WHERE id = ?")
    .get(ticket.insight_id) as { state: string; assignee_user_id: string | null } | null;
  if (ins?.state === "finalized") {
    const rule = canTransition("finalized", "ticketed");
    if (rule && !isActorAllowed(rule, opts.actor, ins.assignee_user_id)) {
      throw new HttpError(403, "Only the assignee or an admin can raise this ticket");
    }
  }

  const issue = await createIssue(
    opts.repo,
    ticket.draft_title,
    ticket.draft_body_md,
    opts.token,
    opts.fetchImpl ?? fetch,
  );
  return persistRaise(db, ticket, {
    repo: opts.repo,
    url: issue.url,
    number: issue.number,
    mode: "direct_api",
    actor: opts.actor,
  });
}

/**
 * Drafts generated but never confirmed created go stale after N days.
 * Needs a scheduler hook (cron/digest job) to call this periodically.
 */
export function markStaleDrafts(db: Database, olderThanDays = 7): string[] {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const rows = db
    .query("SELECT id, insight_id FROM tickets WHERE state = 'draft' AND drafted_at < ?")
    .all(cutoff) as Array<{ id: string; insight_id: string }>;
  if (rows.length === 0) return [];
  db.transaction(() => {
    for (const row of rows) {
      db.query("UPDATE tickets SET state = 'stale' WHERE id = ?").run(row.id);
      appendEvent(db, {
        actorUserId: null, // system
        entityType: "ticket",
        entityId: row.id,
        eventType: "ticket.stale",
        payload: { insight_id: row.insight_id, older_than_days: olderThanDays },
      });
    }
  })();
  return rows.map((r) => r.id);
}
