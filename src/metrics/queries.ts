import type { Database } from "bun:sqlite";
import { insightHandle } from "../ids.ts";
import {
  daysBetween,
  durationStats,
  editDistanceRatio,
  isoWeek,
  median,
  round,
  type DurationStats,
} from "./utils.ts";

/**
 * Admin dashboard queries (SPEC.md section 11). Everything derives from the
 * append-only events table via the insight_milestones view; insights.state is
 * only consulted as the cache it is (open/terminal filtering).
 */

const TERMINAL_OR_GONE = ["closed", "rejected", "merged"];
const FINALIZED_PLUS = ["finalized", "ticketed", "shipped", "client_notified", "closed"];

const UNTRACKED = "untracked";

interface MilestoneRow {
  id: string;
  track: string | null;
  extracted_at: string | null;
  triaged_at: string | null;
  finalized_at: string | null;
  ticketed_at: string | null;
  shipped_at: string | null;
  notified_at: string | null;
  closed_at: string | null;
  uploaded_at: string | null;
}

function milestoneRows(db: Database): MilestoneRow[] {
  return db
    .query(
      `SELECT i.id, i.track,
              COALESCE(m.extracted_at, i.created_at) AS extracted_at,
              m.triaged_at, m.finalized_at, m.ticketed_at,
              m.shipped_at, m.notified_at, m.closed_at,
              (SELECT MIN(e.occurred_at) FROM events e
                WHERE e.entity_type = 'meeting' AND e.entity_id = i.meeting_id
                  AND e.event_type = 'meeting.uploaded') AS uploaded_at
       FROM insights i
       LEFT JOIN insight_milestones m ON m.insight_id = i.id`,
    )
    .all() as MilestoneRow[];
}

// ------------------------------------------------------------- stage TATs

export interface StageTats {
  track: string;
  extracted_to_finalized: DurationStats;
  finalized_to_ticketed: DurationStats;
  ticketed_to_shipped: DurationStats;
  finalized_to_shipped: DurationStats; // non-ticket tracks only
  shipped_to_notified: DurationStats;
  end_to_end: DurationStats; // origin meeting.uploaded -> client_notified
}

export function stageTats(db: Database): StageTats[] {
  type Buckets = { e2f: number[]; f2t: number[]; t2s: number[]; f2s: number[]; s2n: number[]; e2e: number[] };
  const byTrack = new Map<string, Buckets>();
  const bucket = (track: string): Buckets => {
    let b = byTrack.get(track);
    if (!b) {
      b = { e2f: [], f2t: [], t2s: [], f2s: [], s2n: [], e2e: [] };
      byTrack.set(track, b);
    }
    return b;
  };

  for (const r of milestoneRows(db)) {
    const b = bucket(r.track ?? UNTRACKED);
    if (r.extracted_at && r.finalized_at) b.e2f.push(daysBetween(r.extracted_at, r.finalized_at));
    if (r.finalized_at && r.ticketed_at) b.f2t.push(daysBetween(r.finalized_at, r.ticketed_at));
    if (r.ticketed_at && r.shipped_at) b.t2s.push(daysBetween(r.ticketed_at, r.shipped_at));
    if (r.finalized_at && r.shipped_at && !r.ticketed_at) {
      b.f2s.push(daysBetween(r.finalized_at, r.shipped_at));
    }
    if (r.shipped_at && r.notified_at) b.s2n.push(daysBetween(r.shipped_at, r.notified_at));
    if (r.uploaded_at && r.notified_at) b.e2e.push(daysBetween(r.uploaded_at, r.notified_at));
  }

  return [...byTrack.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([track, b]) => ({
      track,
      extracted_to_finalized: durationStats(b.e2f),
      finalized_to_ticketed: durationStats(b.f2t),
      ticketed_to_shipped: durationStats(b.t2s),
      finalized_to_shipped: durationStats(b.f2s),
      shipped_to_notified: durationStats(b.s2n),
      end_to_end: durationStats(b.e2e),
    }));
}

// ------------------------------------------------------------- funnel

const FUNNEL_STAGES = ["triaged", "finalized", "ticketed", "shipped", "notified", "closed"] as const;
type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface FunnelCohort {
  week: string; // ISO week of extracted_at
  cohort: number;
  counts: Record<FunnelStage, number>;
  pct: Record<FunnelStage, number>;
}

export function funnel(db: Database): FunnelCohort[] {
  const byWeek = new Map<string, { cohort: number; counts: Record<FunnelStage, number> }>();
  for (const r of milestoneRows(db)) {
    if (!r.extracted_at) continue;
    const week = isoWeek(r.extracted_at);
    let agg = byWeek.get(week);
    if (!agg) {
      agg = { cohort: 0, counts: { triaged: 0, finalized: 0, ticketed: 0, shipped: 0, notified: 0, closed: 0 } };
      byWeek.set(week, agg);
    }
    agg.cohort += 1;
    if (r.triaged_at) agg.counts.triaged += 1;
    if (r.finalized_at) agg.counts.finalized += 1;
    if (r.ticketed_at) agg.counts.ticketed += 1;
    if (r.shipped_at) agg.counts.shipped += 1;
    if (r.notified_at) agg.counts.notified += 1;
    if (r.closed_at) agg.counts.closed += 1;
  }

  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, { cohort, counts }]) => {
      const pct = {} as Record<FunnelStage, number>;
      for (const s of FUNNEL_STAGES) pct[s] = cohort === 0 ? 0 : round((counts[s] / cohort) * 100, 1);
      return { week, cohort, counts, pct };
    });
}

// ------------------------------------------------------------- WIP and aging

interface OpenInsightRow {
  id: string;
  title: string;
  state: string;
  track: string | null;
  created_at: string;
  assignee_user_id: string | null;
  assignee_name: string | null;
  last_change: string | null;
}

function openInsightRows(db: Database): OpenInsightRow[] {
  return db
    .query(
      `SELECT i.id, i.title, i.state, i.track, i.created_at, i.assignee_user_id,
              u.name AS assignee_name,
              (SELECT MAX(e.occurred_at) FROM events e
                WHERE e.entity_type = 'insight' AND e.entity_id = i.id
                  AND e.event_type = 'insight.state_changed') AS last_change
       FROM insights i
       LEFT JOIN users u ON u.id = i.assignee_user_id
       WHERE i.state NOT IN ('closed','rejected','merged')`,
    )
    .all() as OpenInsightRow[];
}

const AGE_BUCKETS = ["0-3d", "4-7d", "8-14d", "15d+"] as const;
type AgeBucket = (typeof AGE_BUCKETS)[number];

function ageBucket(days: number): AgeBucket {
  const d = Math.floor(days);
  if (d <= 3) return "0-3d";
  if (d <= 7) return "4-7d";
  if (d <= 14) return "8-14d";
  return "15d+";
}

export interface WipGroup {
  state: string;
  track: string;
  count: number;
  age_buckets: Record<AgeBucket, number>;
}

export function wipAndAging(db: Database, now: Date = new Date()): WipGroup[] {
  const nowIso = now.toISOString();
  const groups = new Map<string, WipGroup>();
  for (const r of openInsightRows(db)) {
    const track = r.track ?? UNTRACKED;
    const key = `${r.state}|${track}`;
    let g = groups.get(key);
    if (!g) {
      g = { state: r.state, track, count: 0, age_buckets: { "0-3d": 0, "4-7d": 0, "8-14d": 0, "15d+": 0 } };
      groups.set(key, g);
    }
    g.count += 1;
    g.age_buckets[ageBucket(daysBetween(r.last_change ?? r.created_at, nowIso))] += 1;
  }
  return [...groups.values()].sort((a, b) => a.state.localeCompare(b.state) || a.track.localeCompare(b.track));
}

// ------------------------------------------------------------- stuck items

export const DEFAULT_STUCK_THRESHOLDS: Record<string, number> = {
  extracted: 3,
  triaged: 5,
  finalized: 5,
  ticketed: 21,
  shipped: 2,
};

export interface StuckItem {
  insight_id: string;
  handle: string;
  title: string;
  state: string;
  track: string | null;
  assignee: string | null;
  days_in_state: number;
}

/** Insights whose time in their current state exceeds the per-state threshold (days). */
export function stuckItems(
  db: Database,
  thresholds: Record<string, number> = DEFAULT_STUCK_THRESHOLDS,
  now: Date = new Date(),
): StuckItem[] {
  const nowIso = now.toISOString();
  const out: StuckItem[] = [];
  for (const r of openInsightRows(db)) {
    const threshold = thresholds[r.state];
    if (threshold === undefined) continue;
    const days = daysBetween(r.last_change ?? r.created_at, nowIso);
    if (days > threshold) {
      out.push({
        insight_id: r.id,
        handle: insightHandle(r.id),
        title: r.title,
        state: r.state,
        track: r.track,
        assignee: r.assignee_name,
        days_in_state: round(days, 1),
      });
    }
  }
  return out.sort((a, b) => b.days_in_state - a.days_in_state);
}

// ------------------------------------------------------------- per person

export interface PersonWeek {
  user_id: string;
  name: string | null;
  week: string;
  finalized: number;
  ticketed: number;
  evidence_confirms: number;
  email_copies: number;
}

export function perPerson(db: Database): PersonWeek[] {
  type Counter = keyof Pick<PersonWeek, "finalized" | "ticketed" | "evidence_confirms" | "email_copies">;
  const agg = new Map<string, PersonWeek>();
  const names = new Map<string, string>();
  for (const u of db.query("SELECT id, name FROM users").all() as Array<{ id: string; name: string }>) {
    names.set(u.id, u.name);
  }
  const bump = (userId: string | null, occurredAt: string, counter: Counter) => {
    if (!userId) return;
    const week = isoWeek(occurredAt);
    const key = `${userId}|${week}`;
    let row = agg.get(key);
    if (!row) {
      row = {
        user_id: userId,
        name: names.get(userId) ?? null,
        week,
        finalized: 0,
        ticketed: 0,
        evidence_confirms: 0,
        email_copies: 0,
      };
      agg.set(key, row);
    }
    row[counter] += 1;
  };

  // finalized: attributed to insights.finalized_by, falling back to the transition actor
  const finalizedRows = db
    .query(
      `SELECT COALESCE(i.finalized_by, e.actor_user_id) AS user_id, e.occurred_at
       FROM events e JOIN insights i ON i.id = e.entity_id
       WHERE e.entity_type = 'insight' AND e.event_type = 'insight.state_changed' AND e.to_state = 'finalized'`,
    )
    .all() as Array<{ user_id: string | null; occurred_at: string }>;
  for (const r of finalizedRows) bump(r.user_id, r.occurred_at, "finalized");

  const ticketedRows = db
    .query(
      `SELECT actor_user_id AS user_id, occurred_at FROM events
       WHERE entity_type = 'insight' AND event_type = 'insight.state_changed' AND to_state = 'ticketed'`,
    )
    .all() as Array<{ user_id: string | null; occurred_at: string }>;
  for (const r of ticketedRows) bump(r.user_id, r.occurred_at, "ticketed");

  const confirms = db
    .query("SELECT actor_user_id AS user_id, occurred_at FROM events WHERE event_type = 'evidence.confirmed'")
    .all() as Array<{ user_id: string | null; occurred_at: string }>;
  for (const r of confirms) bump(r.user_id, r.occurred_at, "evidence_confirms");

  const copies = db
    .query("SELECT actor_user_id AS user_id, occurred_at FROM events WHERE event_type = 'email.copied'")
    .all() as Array<{ user_id: string | null; occurred_at: string }>;
  for (const r of copies) bump(r.user_id, r.occurred_at, "email_copies");

  return [...agg.values()].sort(
    (a, b) => a.week.localeCompare(b.week) || a.user_id.localeCompare(b.user_id),
  );
}

// ------------------------------------------------------------- per client closed loop

export interface ClientClosedLoop {
  client_id: string;
  client_name: string;
  finalized: number;
  notified: number;
  closed_loop_pct: number | null; // null when nothing finalized yet
  median_days_finalized_to_notified: number | null;
}

export function perClientClosedLoop(db: Database): ClientClosedLoop[] {
  const rows = db
    .query(
      `SELECT i.client_id, c.name AS client_name, m.finalized_at, m.notified_at
       FROM insights i
       JOIN clients c ON c.id = i.client_id
       LEFT JOIN insight_milestones m ON m.insight_id = i.id`,
    )
    .all() as Array<{ client_id: string; client_name: string; finalized_at: string | null; notified_at: string | null }>;

  const agg = new Map<string, { name: string; finalized: number; notified: number; durations: number[] }>();
  for (const r of rows) {
    let a = agg.get(r.client_id);
    if (!a) {
      a = { name: r.client_name, finalized: 0, notified: 0, durations: [] };
      agg.set(r.client_id, a);
    }
    if (r.finalized_at) a.finalized += 1;
    if (r.notified_at) a.notified += 1;
    if (r.finalized_at && r.notified_at) a.durations.push(daysBetween(r.finalized_at, r.notified_at));
  }

  return [...agg.entries()]
    .map(([client_id, a]) => ({
      client_id,
      client_name: a.name,
      finalized: a.finalized,
      notified: a.notified,
      closed_loop_pct: a.finalized === 0 ? null : round((a.notified / a.finalized) * 100, 1),
      median_days_finalized_to_notified: a.durations.length === 0 ? null : round(median(a.durations)!, 2),
    }))
    .sort((a, b) => a.client_name.localeCompare(b.client_name));
}

// ------------------------------------------------------------- theme demand

export interface ThemeDemand {
  tag: string;
  count: number;
  distinct_clients: number;
  track_mix: Record<string, number>;
}

/** Tag frequency over insights that reached finalized or beyond. */
export function themeDemand(db: Database): ThemeDemand[] {
  const placeholders = FINALIZED_PLUS.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT t.name AS tag, i.id AS insight_id, i.track, i.client_id
       FROM insight_tags it
       JOIN tags t ON t.id = it.tag_id
       JOIN insights i ON i.id = it.insight_id
       WHERE i.state IN (${placeholders})`,
    )
    .all(...FINALIZED_PLUS) as Array<{ tag: string; insight_id: string; track: string | null; client_id: string }>;

  const requesters = new Map<string, string[]>();
  const reqRows = db.query("SELECT insight_id, client_id FROM insight_requesters").all() as Array<{
    insight_id: string;
    client_id: string;
  }>;
  for (const r of reqRows) {
    const list = requesters.get(r.insight_id) ?? [];
    list.push(r.client_id);
    requesters.set(r.insight_id, list);
  }

  const agg = new Map<string, { count: number; clients: Set<string>; track_mix: Record<string, number> }>();
  for (const r of rows) {
    let a = agg.get(r.tag);
    if (!a) {
      a = { count: 0, clients: new Set(), track_mix: {} };
      agg.set(r.tag, a);
    }
    a.count += 1;
    a.clients.add(r.client_id);
    for (const c of requesters.get(r.insight_id) ?? []) a.clients.add(c);
    const track = r.track ?? UNTRACKED;
    a.track_mix[track] = (a.track_mix[track] ?? 0) + 1;
  }

  return [...agg.entries()]
    .map(([tag, a]) => ({ tag, count: a.count, distinct_clients: a.clients.size, track_mix: a.track_mix }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ------------------------------------------------------------- AI quality

export interface AiQuality {
  extracted_from_runs: number;
  rejected_from_runs: number;
  discard_rate: number;
  edit_distance_sample: number;
  mean_edit_distance_ratio: number | null;
  routing_correction_rate: number;
  routing_correction_note: string;
}

export function aiQuality(db: Database): AiQuality {
  const totals = db
    .query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN state = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM insights WHERE extraction_run_id IS NOT NULL`,
    )
    .get() as { total: number; rejected: number | null };

  const finalized = db
    .query(
      `SELECT i.body_original, i.body_current
       FROM insights i
       JOIN insight_milestones m ON m.insight_id = i.id
       WHERE m.finalized_at IS NOT NULL`,
    )
    .all() as Array<{ body_original: string; body_current: string }>;
  const ratios = finalized.map((r) => editDistanceRatio(r.body_original, r.body_current));

  return {
    extracted_from_runs: totals.total,
    rejected_from_runs: totals.rejected ?? 0,
    discard_rate: totals.total === 0 ? 0 : round((totals.rejected ?? 0) / totals.total, 3),
    edit_distance_sample: ratios.length,
    mean_edit_distance_ratio:
      ratios.length === 0 ? null : round(ratios.reduce((a, b) => a + b, 0) / ratios.length, 3),
    routing_correction_rate: 0,
    routing_correction_note: "ai_suggested_json not yet populated",
  };
}

// ------------------------------------------------------------- capture volume

export interface CaptureVolume {
  meetings_per_week: Array<{ week: string; source: string; count: number }>;
  activity_per_week: Array<{ week: string; emails_copied: number; tickets_raised: number; evidence_confirms: number }>;
}

export function captureVolume(db: Database): CaptureVolume {
  const meetingRows = db
    .query(
      `SELECT m.source,
              COALESCE(
                (SELECT MIN(e.occurred_at) FROM events e
                  WHERE e.entity_type = 'meeting' AND e.entity_id = m.id
                    AND e.event_type = 'meeting.uploaded'),
                m.created_at) AS at
       FROM meetings m`,
    )
    .all() as Array<{ source: string; at: string }>;

  const meetingAgg = new Map<string, { week: string; source: string; count: number }>();
  for (const r of meetingRows) {
    const week = isoWeek(r.at);
    const key = `${week}|${r.source}`;
    const g = meetingAgg.get(key) ?? { week, source: r.source, count: 0 };
    g.count += 1;
    meetingAgg.set(key, g);
  }

  const activityAgg = new Map<
    string,
    { week: string; emails_copied: number; tickets_raised: number; evidence_confirms: number }
  >();
  const activityRows = db
    .query(
      `SELECT event_type, occurred_at FROM events
       WHERE event_type IN ('email.copied','ticket.raised','evidence.confirmed')`,
    )
    .all() as Array<{ event_type: string; occurred_at: string }>;
  for (const r of activityRows) {
    const week = isoWeek(r.occurred_at);
    let g = activityAgg.get(week);
    if (!g) {
      g = { week, emails_copied: 0, tickets_raised: 0, evidence_confirms: 0 };
      activityAgg.set(week, g);
    }
    if (r.event_type === "email.copied") g.emails_copied += 1;
    else if (r.event_type === "ticket.raised") g.tickets_raised += 1;
    else g.evidence_confirms += 1;
  }

  return {
    meetings_per_week: [...meetingAgg.values()].sort(
      (a, b) => a.week.localeCompare(b.week) || a.source.localeCompare(b.source),
    ),
    activity_per_week: [...activityAgg.values()].sort((a, b) => a.week.localeCompare(b.week)),
  };
}

// ------------------------------------------------------------- pre-call client brief

/**
 * One-click markdown brief for a client (SPEC.md section 3): open asks,
 * shipped since their latest meeting, follow-ups owed. Returns null when the
 * client does not exist. No em-dashes (brand rule).
 */
export function clientBrief(db: Database, clientId: string, now: Date = new Date()): string | null {
  const client = db.query("SELECT id, name FROM clients WHERE id = ?").get(clientId) as {
    id: string;
    name: string;
  } | null;
  if (!client) return null;

  const rows = db
    .query(
      `SELECT i.id, i.title, i.state, i.track, i.created_at,
              (SELECT MAX(e.occurred_at) FROM events e
                WHERE e.entity_type = 'insight' AND e.entity_id = i.id
                  AND e.event_type = 'insight.state_changed') AS last_change,
              m.shipped_at,
              (SELECT ce.url FROM completion_evidence ce
                WHERE ce.insight_id = i.id AND ce.status = 'confirmed' AND ce.url IS NOT NULL
                ORDER BY ce.created_at LIMIT 1) AS evidence_url
       FROM insights i
       LEFT JOIN insight_milestones m ON m.insight_id = i.id
       WHERE i.client_id = ?
          OR EXISTS (SELECT 1 FROM insight_requesters r WHERE r.insight_id = i.id AND r.client_id = ?)
       ORDER BY i.created_at`,
    )
    .all(clientId, clientId) as Array<{
    id: string;
    title: string;
    state: string;
    track: string | null;
    created_at: string;
    last_change: string | null;
    shipped_at: string | null;
    evidence_url: string | null;
  }>;

  const latest = db
    .query("SELECT MAX(meeting_date) AS d FROM meetings WHERE client_id = ?")
    .get(clientId) as { d: string | null };

  const nowIso = now.toISOString();
  const age = (r: { last_change: string | null; created_at: string }) =>
    Math.floor(daysBetween(r.last_change ?? r.created_at, nowIso));

  const lines: string[] = [`# Pre-call brief: ${client.name}`, ""];
  lines.push(`Latest meeting on record: ${latest.d ?? "none"}`, "");

  lines.push("## Open asks");
  const open = rows.filter((r) => !TERMINAL_OR_GONE.includes(r.state));
  if (open.length === 0) lines.push("None.");
  for (const r of open) {
    lines.push(`- ${insightHandle(r.id)} ${r.title} (${r.state}, ${age(r)}d old)`);
  }
  lines.push("");

  lines.push("## Shipped since last meeting");
  const shipped = latest.d
    ? rows.filter((r) => r.shipped_at && r.shipped_at >= latest.d!)
    : [];
  if (shipped.length === 0) lines.push("None.");
  for (const r of shipped) {
    const evidence = r.evidence_url ? ` evidence: ${r.evidence_url}` : "";
    lines.push(`- ${insightHandle(r.id)} ${r.title} (shipped ${r.shipped_at!.slice(0, 10)})${evidence}`);
  }
  lines.push("");

  lines.push("## Follow-ups owed");
  const owed = rows.filter((r) => r.state === "shipped" || r.state === "client_notified");
  if (owed.length === 0) lines.push("None.");
  for (const r of owed) {
    const note = r.state === "shipped" ? "shipped, email not yet sent" : "client notified, not yet closed";
    lines.push(`- ${insightHandle(r.id)} ${r.title} (${note})`);
  }
  lines.push("");

  return lines.join("\n");
}
