import type { Database } from "bun:sqlite";
import { env } from "../config.ts";
import { getDb } from "../db.ts";
import { appendEvent } from "../events.ts";
import { insightHandle, ulid } from "../ids.ts";
import { stuckItems } from "../metrics/queries.ts";
import { daysBetween } from "../metrics/utils.ts";

/**
 * Weekly admin digest (SPEC.md section 12). In-app preview via the route,
 * optional webhook delivery (Slack/Google Chat shaped: POST {text}).
 * No em-dashes anywhere (brand rule).
 */

const WEEK_MS = 7 * 86_400_000;

export const DIGEST_SECTIONS = [
  "## New insights this week",
  "## Awaiting finalization",
  "## Stuck items",
  "## Completions this week",
  "## Top asks by requester count",
  "## Shipped but client not yet emailed",
] as const;

export function buildDigest(db: Database, now: Date = new Date()): string {
  const nowIso = now.toISOString();
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const lines: string[] = [`# Weekly digest (${nowIso.slice(0, 10)})`, ""];

  // --- New insights this week (by track)
  lines.push(DIGEST_SECTIONS[0]);
  const fresh = db
    .query(
      `SELECT i.id, i.title, i.track, c.name AS client
       FROM insights i JOIN clients c ON c.id = i.client_id
       WHERE i.created_at >= ?
       ORDER BY COALESCE(i.track, 'untracked'), i.created_at`,
    )
    .all(since) as Array<{ id: string; title: string; track: string | null; client: string }>;
  if (fresh.length === 0) lines.push("None.");
  let currentTrack: string | null = null;
  for (const r of fresh) {
    const track = r.track ?? "untracked";
    if (track !== currentTrack) {
      lines.push(`**${track}**`);
      currentTrack = track;
    }
    lines.push(`- ${insightHandle(r.id)} ${r.title} (${r.client})`);
  }
  lines.push("");

  // --- Awaiting finalization (with ages)
  lines.push(DIGEST_SECTIONS[1]);
  const awaiting = db
    .query(
      `SELECT i.id, i.title, i.state, i.created_at,
              (SELECT MAX(e.occurred_at) FROM events e
                WHERE e.entity_type = 'insight' AND e.entity_id = i.id
                  AND e.event_type = 'insight.state_changed') AS last_change
       FROM insights i WHERE i.state IN ('extracted','triaged')
       ORDER BY i.created_at`,
    )
    .all() as Array<{ id: string; title: string; state: string; created_at: string; last_change: string | null }>;
  if (awaiting.length === 0) lines.push("None.");
  for (const r of awaiting) {
    const age = Math.floor(daysBetween(r.last_change ?? r.created_at, nowIso));
    lines.push(`- ${insightHandle(r.id)} ${r.title} (${r.state}, ${age}d old)`);
  }
  lines.push("");

  // --- Stuck items (shared thresholds with the dashboard)
  lines.push(DIGEST_SECTIONS[2]);
  const stuck = stuckItems(db, undefined, now);
  if (stuck.length === 0) lines.push("None.");
  for (const s of stuck) {
    const who = s.assignee ? `, assignee: ${s.assignee}` : "";
    lines.push(`- ${s.handle} ${s.title} (${s.state} for ${s.days_in_state}d${who})`);
  }
  lines.push("");

  // --- Completions this week, with evidence links
  lines.push(DIGEST_SECTIONS[3]);
  const completions = db
    .query(
      `SELECT i.id, i.title, m.shipped_at,
              (SELECT ce.url FROM completion_evidence ce
                WHERE ce.insight_id = i.id AND ce.status = 'confirmed' AND ce.url IS NOT NULL
                ORDER BY ce.created_at LIMIT 1) AS evidence_url
       FROM insights i JOIN insight_milestones m ON m.insight_id = i.id
       WHERE m.shipped_at >= ?
       ORDER BY m.shipped_at`,
    )
    .all(since) as Array<{ id: string; title: string; shipped_at: string; evidence_url: string | null }>;
  if (completions.length === 0) lines.push("None.");
  for (const r of completions) {
    const evidence = r.evidence_url ? ` evidence: ${r.evidence_url}` : " evidence: on file";
    lines.push(`- ${insightHandle(r.id)} ${r.title} (shipped ${r.shipped_at.slice(0, 10)})${evidence}`);
  }
  lines.push("");

  // --- Top asks by requester count (top 5)
  lines.push(DIGEST_SECTIONS[4]);
  const topAsks = db
    .query(
      `SELECT i.id, i.title, COUNT(r.client_id) AS requesters
       FROM insights i JOIN insight_requesters r ON r.insight_id = i.id
       WHERE i.state NOT IN ('rejected','merged','closed')
       GROUP BY i.id, i.title
       ORDER BY requesters DESC, i.created_at
       LIMIT 5`,
    )
    .all() as Array<{ id: string; title: string; requesters: number }>;
  if (topAsks.length === 0) lines.push("None.");
  for (const r of topAsks) {
    const plural = r.requesters === 1 ? "client" : "clients";
    lines.push(`- ${insightHandle(r.id)} ${r.title} (requested by ${r.requesters} ${plural})`);
  }
  lines.push("");

  // --- Shipped but client not yet emailed
  lines.push(DIGEST_SECTIONS[5]);
  const unEmailed = db
    .query(
      `SELECT i.id, i.title, m.shipped_at
       FROM insights i LEFT JOIN insight_milestones m ON m.insight_id = i.id
       WHERE i.state = 'shipped'
       ORDER BY m.shipped_at`,
    )
    .all() as Array<{ id: string; title: string; shipped_at: string | null }>;
  if (unEmailed.length === 0) lines.push("None.");
  for (const r of unEmailed) {
    const age = r.shipped_at ? `${Math.floor(daysBetween(r.shipped_at, nowIso))}d ago` : "date unknown";
    lines.push(`- ${insightHandle(r.id)} ${r.title} (shipped ${age})`);
  }
  lines.push("");

  return lines.join("\n");
}

/** Structural fetch type so tests can pass a plain stub function. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Build and deliver the digest. Posts {text: markdown} to the webhook when
 * configured, then logs a digest.sent event either way so the scheduler can
 * dedupe per day.
 */
export async function sendDigest(
  db: Database,
  fetchImpl: FetchLike = fetch,
  webhookUrl: string | undefined = env.DIGEST_WEBHOOK_URL,
  now: Date = new Date(),
): Promise<{ delivered: boolean; markdown: string }> {
  const markdown = buildDigest(db, now);
  let delivered = false;
  if (webhookUrl) {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: markdown }),
    });
    delivered = res.ok;
  }
  appendEvent(db, {
    actorUserId: null, // system
    entityType: "digest",
    entityId: ulid(),
    eventType: "digest.sent",
    payload: { delivered, webhook_configured: !!webhookUrl },
    occurredAt: now.toISOString(),
  });
  return { delivered, markdown };
}

interface IstClock {
  weekday: string; // 'Mon'
  hour: number; // 0-23
  date: string; // '2026-06-15' in IST
}

function istClock(d: Date): IstClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: get("weekday"), hour: Number(get("hour")), date: `${get("year")}-${get("month")}-${get("day")}` };
}

/**
 * Fire the digest once when it is Monday 09:00-09:59 Asia/Kolkata and the
 * latest digest.sent event is not from today (IST). Returns true if sent.
 */
export async function maybeSendDigest(
  db: Database,
  now: Date = new Date(),
  fetchImpl: FetchLike = fetch,
  webhookUrl: string | undefined = env.DIGEST_WEBHOOK_URL,
): Promise<boolean> {
  const ist = istClock(now);
  if (ist.weekday !== "Mon" || ist.hour !== 9) return false;
  const last = db
    .query("SELECT occurred_at FROM events WHERE event_type = 'digest.sent' ORDER BY id DESC LIMIT 1")
    .get() as { occurred_at: string } | null;
  if (last && istClock(new Date(last.occurred_at)).date === ist.date) return false;
  await sendDigest(db, fetchImpl, webhookUrl, now);
  return true;
}

/**
 * Hourly scheduler. server.ts must call this once at startup (integration
 * point; this module never edits server.ts). The timer is unref'd so it never
 * keeps a short-lived process alive.
 */
export function startDigestScheduler(): ReturnType<typeof setInterval> {
  const tick = () => {
    maybeSendDigest(getDb()).catch((err) => console.error("digest scheduler:", err));
  };
  tick(); // catch a window that is already open at startup
  const timer = setInterval(tick, 3_600_000);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}
