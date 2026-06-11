import type { Database } from "bun:sqlite";
import { z } from "zod";
import { nowIso } from "../db.ts";
import { ulid, insightHandle } from "../ids.ts";
import { appendEvent, transitionInsight, type Role } from "../events.ts";
import { getLLM } from "../llm/provider.ts";

/**
 * Client follow-up emails (SPEC.md sections 8/9 of the pipeline): one draft
 * per requesting client, grounded in that client's own verbatim quotes and the
 * confirmed completion evidence. Copy-to-clipboard is the TAT timestamp.
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

export interface DraftRow {
  id: string;
  insight_id: string;
  client_id: string;
  contact_id: string | null;
  subject: string;
  body_md: string;
  generated_by: string | null;
  version: number;
  superseded_by_id: string | null;
  sent_confirmed_at: string | null;
  sent_final_text: string | null;
  created_at: string;
}

const EmailSchema = z.object({ subject: z.string(), body_md: z.string() });

// Stable system prompt: do not interpolate per-call data here, it gets cached.
const EMAIL_SYSTEM_PROMPT = [
  "You write client follow-up emails for XYZ, a cloud cost optimization platform.",
  "Brand voice: direct, confident, short sentences. No fluff, no hype.",
  "Hard rules:",
  "- Never use em-dashes anywhere in the subject or body. Use a period or comma instead.",
  "- Never use these words: amazing, powerful, transform, leverage, revolutionize, best-in-class, industry-leading.",
  "- Keep it short. A few sentences, then the proof link.",
  "- Quote the client's own words back to them, with the meeting date, so they recognize their own ask.",
  "Return JSON with fields: subject, body_md (markdown body).",
].join("\n");

interface RequesterRow {
  client_id: string;
  name: string;
}

interface MentionRow {
  quote: string;
  speaker: string | null;
  meeting_date: string;
}

interface EvidenceRefRow {
  kind: string;
  url: string | null;
}

function buildPrompt(opts: {
  insight: { id: string; title: string; body_current: string };
  clientName: string;
  contactName: string | null;
  mentions: MentionRow[];
  evidence: EvidenceRefRow[];
}): string {
  const quotes =
    opts.mentions.length > 0
      ? opts.mentions
          .map((m) => `- [${m.meeting_date}] "${m.quote}"${m.speaker ? ` (${m.speaker})` : ""}`)
          .join("\n")
      : "- (no verbatim quotes on file for this client)";
  const proof =
    opts.evidence.length > 0
      ? opts.evidence.map((e) => `- ${e.kind}: ${e.url ?? "(no url, text attestation)"}`).join("\n")
      : "- (no confirmed evidence rows; do not invent a link)";
  return [
    `Write a short follow-up email for client "${opts.clientName}"${opts.contactName ? `, addressed to ${opts.contactName}` : ""}.`,
    "",
    `What shipped (finalized insight ${insightHandle(opts.insight.id)}):`,
    `Title: ${opts.insight.title}`,
    opts.insight.body_current,
    "",
    "This client's own words, verbatim, with meeting dates:",
    quotes,
    "",
    "Confirmed completion evidence (the proof):",
    proof,
    "",
    'The message: you asked for this, it is now live. Quote the client back to themselves and include the proof link.',
  ].join("\n");
}

/**
 * Fan-out: one draft per external requesting client. Regeneration inserts a
 * new version and points the old row's superseded_by_id at it.
 */
export async function generateDrafts(
  db: Database,
  opts: { insightId: string; actor: Actor },
): Promise<DraftRow[]> {
  const insight = db
    .query("SELECT id, state, title, body_current FROM insights WHERE id = ?")
    .get(opts.insightId) as { id: string; state: string; title: string; body_current: string } | null;
  if (!insight) throw new ServiceError(404, "Insight not found");
  if (insight.state !== "shipped" && insight.state !== "client_notified") {
    throw new ServiceError(
      409,
      `Email drafts require a shipped or client_notified insight (current state: ${insight.state})`,
    );
  }

  const requesters = db
    .query(
      `SELECT ir.client_id, c.name FROM insight_requesters ir
       JOIN clients c ON c.id = ir.client_id
       WHERE ir.insight_id = ? AND c.is_internal = 0
       ORDER BY ir.first_requested_at, ir.client_id`,
    )
    .all(opts.insightId) as RequesterRow[];

  const evidence = db
    .query(
      "SELECT kind, url FROM completion_evidence WHERE insight_id = ? AND status = 'confirmed' ORDER BY created_at",
    )
    .all(opts.insightId) as EvidenceRefRow[];

  const llm = getLLM();
  const drafts: DraftRow[] = [];

  for (const requester of requesters) {
    const contact = db
      .query(
        `SELECT id, name FROM client_contacts
         WHERE client_id = ? AND email IS NOT NULL AND email != ''
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(requester.client_id) as { id: string; name: string } | null;

    const mentions = db
      .query(
        `SELECT im.quote, im.speaker, m.meeting_date FROM insight_mentions im
         JOIN meetings m ON m.id = im.meeting_id
         WHERE im.insight_id = ? AND im.client_id = ?
         ORDER BY m.meeting_date, im.created_at`,
      )
      .all(opts.insightId, requester.client_id) as MentionRow[];

    const { data } = await llm.completeJSON({
      system: EMAIL_SYSTEM_PROMPT,
      prompt: buildPrompt({
        insight,
        clientName: requester.name,
        contactName: contact?.name ?? null,
        mentions,
        evidence,
      }),
      schema: EmailSchema,
    });

    const prev = db
      .query(
        `SELECT id, version FROM email_drafts
         WHERE insight_id = ? AND client_id = ? AND superseded_by_id IS NULL
         ORDER BY version DESC LIMIT 1`,
      )
      .get(opts.insightId, requester.client_id) as { id: string; version: number } | null;

    const draftId = ulid();
    const version = prev ? prev.version + 1 : 1;
    const tx = db.transaction(() => {
      db.query(
        `INSERT INTO email_drafts
           (id, insight_id, client_id, contact_id, subject, body_md, generated_by, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        draftId,
        opts.insightId,
        requester.client_id,
        contact?.id ?? null,
        data.subject,
        data.body_md,
        opts.actor.id,
        version,
        nowIso(),
      );
      if (prev) {
        db.query("UPDATE email_drafts SET superseded_by_id = ? WHERE id = ?").run(draftId, prev.id);
      }
      appendEvent(db, {
        actorUserId: opts.actor.id,
        entityType: "email_draft",
        entityId: draftId,
        eventType: "email.drafted",
        payload: { insight_id: opts.insightId, client_id: requester.client_id, version },
      });
    });
    tx();
    drafts.push(getDraft(db, draftId)!);
  }

  return drafts;
}

export function getDraft(db: Database, id: string): DraftRow | null {
  return db.query("SELECT * FROM email_drafts WHERE id = ?").get(id) as DraftRow | null;
}

export function listDrafts(db: Database, insightId: string): DraftRow[] {
  const insight = db.query("SELECT id FROM insights WHERE id = ?").get(insightId);
  if (!insight) throw new ServiceError(404, "Insight not found");
  return db
    .query("SELECT * FROM email_drafts WHERE insight_id = ? ORDER BY client_id, version")
    .all(insightId) as DraftRow[];
}

/**
 * Copy-to-clipboard log: THE TAT timestamp for shipped -> client_notified.
 * The first copy transitions the insight; later copies just append the event.
 */
export function markCopied(
  db: Database,
  opts: { draftId: string; actor: Actor },
): { ok: true; transitioned: boolean } {
  const draft = db
    .query(
      `SELECT d.id, d.insight_id, d.client_id, d.version, i.state AS insight_state
       FROM email_drafts d JOIN insights i ON i.id = d.insight_id
       WHERE d.id = ?`,
    )
    .get(opts.draftId) as {
    id: string;
    insight_id: string;
    client_id: string;
    version: number;
    insight_state: string;
  } | null;
  if (!draft) throw new ServiceError(404, "Email draft not found");

  const shouldTransition = draft.insight_state === "shipped";
  const tx = db.transaction(() => {
    appendEvent(db, {
      actorUserId: opts.actor.id,
      entityType: "email_draft",
      entityId: draft.id,
      eventType: "email.copied",
      payload: { client_id: draft.client_id, draft_version: draft.version },
    });
    if (shouldTransition) {
      transitionInsight(db, {
        insightId: draft.insight_id,
        to: "client_notified",
        actor: opts.actor,
        payload: { email_draft_id: draft.id, client_id: draft.client_id },
      });
    }
  });
  tx();
  return { ok: true, transitioned: shouldTransition };
}

/** Explicit "I sent it" confirmation, optionally with the edited final text. */
export function confirmSent(
  db: Database,
  opts: { draftId: string; finalText?: string; actor: Actor },
): DraftRow {
  const draft = getDraft(db, opts.draftId);
  if (!draft) throw new ServiceError(404, "Email draft not found");
  const tx = db.transaction(() => {
    db.query(
      "UPDATE email_drafts SET sent_confirmed_at = ?, sent_final_text = ? WHERE id = ?",
    ).run(nowIso(), opts.finalText ?? null, draft.id);
    appendEvent(db, {
      actorUserId: opts.actor.id,
      entityType: "email_draft",
      entityId: draft.id,
      eventType: "email.sent_confirmed",
      payload: {
        insight_id: draft.insight_id,
        client_id: draft.client_id,
        has_final_text: opts.finalText != null,
      },
    });
  });
  tx();
  return getDraft(db, draft.id)!;
}

/**
 * Close the loop. From client_notified no reason is needed; from shipped the
 * skip-notify edge requires a reason (enforced by the transition map, surfaced
 * here as a clear 400).
 */
export function closeInsight(
  db: Database,
  opts: { insightId: string; reason?: string; actor: Actor },
): void {
  const insight = db
    .query("SELECT id, state FROM insights WHERE id = ?")
    .get(opts.insightId) as { id: string; state: string } | null;
  if (!insight) throw new ServiceError(404, "Insight not found");
  if (insight.state === "shipped" && !opts.reason) {
    throw new ServiceError(
      400,
      "Closing from shipped skips client notification and requires a reason",
    );
  }
  transitionInsight(db, {
    insightId: opts.insightId,
    to: "closed",
    actor: opts.actor,
    payload: opts.reason ? { reason: opts.reason } : undefined,
  });
}
