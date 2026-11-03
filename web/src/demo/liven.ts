// Makes the recorded demo fixtures read as a live workspace. Only bundled by
// `bun run build:demo` (static-api.ts is its one caller); see README.md.
//
// The fixtures are recorded from a seed script that processes every meeting
// within a few minutes, so every timestamp in them sits on the recording day
// and every age reads "today". liven() rewrites the timeline relative to the
// moment the page loads, deterministically:
//
// - Meeting dates move by whole days so the latest recorded meeting lands
//   7 days before today (the demo meetings are a week apart: 21, 14, 7 days ago).
// - Each meeting's processing (its client, meeting row, transcript, extracted
//   insights and their "extracted" events) moves onto that meeting's new date,
//   keeping the real gaps between them.
// - Everything recorded after the last extraction (triage, the release, release
//   matches, shipped, client told) is split into bursts wherever the recording
//   paused for more than a second, and the bursts are spread evenly from the day
//   after the last meeting to just over a day before now.
// - Derived values that the server computed from those timestamps follow:
//   insight age_days, "(state, Nd old)" and "(shipped <date>)" in briefs and the
//   digest, other recording-day dates in prose, and the WIP-aging buckets and
//   stuck-items list on the numbers page. Stage times and weekly funnel labels
//   stay as recorded.

const DAY = 86_400_000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_DATE = /\b\d{4}-\d{2}-\d{2}\b(?!T\d)/g;
/** The latest meeting lands this many days before today. */
const LATEST_MEETING_DAYS_AGO = 7;
/** New meetings sit at this UTC time on their (shifted) date. */
const MEETING_TIME_UTC = "T12:00:00.000Z";
/** A pause longer than this starts a new burst of post-extraction activity. */
const BURST_GAP_MS = 1000;
/** Mirrors DEFAULT_STUCK_THRESHOLDS in src/metrics/queries.ts. */
const STUCK_THRESHOLDS: Record<string, number> = { extracted: 3, triaged: 5, finalized: 5, ticketed: 21, shipped: 2 };
const CLOSED_STATES = new Set(["closed", "rejected", "merged"]);

export interface DemoFixtures {
  generated_at: string;
  responses: Record<string, { status: number; body: unknown }>;
  ask: Record<string, unknown>;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Visit every plain object in a JSON tree. */
function eachObject(node: unknown, fn: (o: Obj) => void): void {
  if (Array.isArray(node)) {
    for (const v of node) eachObject(v, fn);
  } else if (isObj(node)) {
    fn(node);
    for (const v of Object.values(node)) eachObject(v, fn);
  }
}

/** Rebuild a JSON tree, passing every string through fn. */
function mapStrings(node: unknown, fn: (s: string) => string): unknown {
  if (typeof node === "string") return fn(node);
  if (Array.isArray(node)) return node.map((v) => mapStrings(v, fn));
  if (isObj(node)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(node)) out[k] = mapStrings(v, fn);
    return out;
  }
  return node;
}

interface MeetingRef {
  id: string;
  date: string;
  created: number;
}

function recordedMeetings(fx: DemoFixtures): MeetingRef[] {
  const body = fx.responses["/api/meetings"]?.body;
  const list = isObj(body) && Array.isArray(body.meetings) ? body.meetings : [];
  const out: MeetingRef[] = [];
  for (const m of list) {
    if (!isObj(m)) continue;
    const id = str(m.id);
    const date = str(m.meeting_date);
    const created = Date.parse(str(m.created_at) ?? "");
    if (id && date && DATE_ONLY.test(date) && !Number.isNaN(created)) out.push({ id, date, created });
  }
  return out.sort((a, b) => a.created - b.created);
}

/** Build the instant map (recorded ms -> new ms) and the meeting-date map. */
function buildTimeMap(fx: DemoFixtures, now: number) {
  const instants = new Set<number>();
  const tree = [fx.responses, fx.ask];
  mapStrings(tree, (s) => {
    const ms = ISO_INSTANT.test(s) ? Date.parse(s) : NaN;
    if (!Number.isNaN(ms)) instants.add(ms);
    return s;
  });
  const sorted = [...instants].sort((a, b) => a - b);
  const meetings = recordedMeetings(fx);
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00.000Z");

  if (meetings.length === 0) {
    // No meetings to anchor on: one offset so the latest instant reads as an hour ago.
    const latest = sorted.at(-1) ?? now;
    const offset = now - 3_600_000 - latest;
    const days = Math.round(offset / DAY);
    return {
      instant: (ms: number) => ms + offset,
      date: (d: string) => dateOf(Date.parse(d + "T00:00:00.000Z") + days * DAY),
    };
  }

  const latestDate = meetings.reduce((max, m) => (m.date > max ? m.date : max), meetings[0]!.date);
  const dayShift = Math.round((today - LATEST_MEETING_DAYS_AGO * DAY - Date.parse(latestDate + "T00:00:00.000Z")) / DAY);
  const date = (d: string) => dateOf(Date.parse(d + "T00:00:00.000Z") + dayShift * DAY);

  // Extraction instants per meeting: created_at of anything that names the
  // meeting directly, plus the occurred_at of its insights' "extracted" events.
  const indexById = new Map(meetings.map((m, i) => [m.id, i]));
  const byDate = new Map<string, number>();
  meetings.forEach((m, i) => byDate.set(m.date, i));
  const extraction: number[][] = meetings.map(() => []);
  eachObject(tree, (o) => {
    const mid = str(o.meeting_id);
    const md = str(o.meeting_date);
    const i = (mid !== undefined ? indexById.get(mid) : undefined) ?? (md !== undefined ? byDate.get(md) : undefined);
    if (i === undefined) return;
    const created = Date.parse(str(o.created_at) ?? "");
    if (!Number.isNaN(created)) extraction[i]!.push(created);
    if (Array.isArray(o.timeline)) {
      for (const e of o.timeline) {
        if (isObj(e) && e.to_state === "extracted") {
          const at = Date.parse(str(e.occurred_at) ?? "");
          if (!Number.isNaN(at)) extraction[i]!.push(at);
        }
      }
    }
  });

  // Phase i runs from midway between the previous meeting's last extraction
  // and this meeting's creation, up to this meeting's last extraction.
  const ends = meetings.map((m, i) => {
    const next = meetings[i + 1]?.created ?? Infinity;
    return Math.max(m.created, ...extraction[i]!.filter((t) => t < next));
  });
  const starts = meetings.map((m, i) => (i === 0 ? -Infinity : (ends[i - 1]! + m.created) / 2));
  const anchors = meetings.map((m) => Date.parse(date(m.date) + MEETING_TIME_UTC));
  const lastEnd = ends.at(-1)!;

  // Post-extraction bursts, spread from a day after the last meeting to a day ago.
  const tail = sorted.filter((t) => t > lastEnd);
  const bursts: number[] = [];
  tail.forEach((t, k) => {
    if (k === 0 || t - tail[k - 1]! > BURST_GAP_MS) bursts.push(t);
  });
  // The last burst lands a little over a day ago so it reads "1d", not "today".
  const first = anchors.at(-1)! + DAY;
  const last = Math.max(first, now - DAY - 2 * 3_600_000);
  const burstTarget = (k: number) => (bursts.length < 2 ? first : first + ((last - first) * k) / (bursts.length - 1));

  const instant = (ms: number): number => {
    if (ms > lastEnd) {
      let k = 0;
      while (k + 1 < bursts.length && bursts[k + 1]! <= ms) k++;
      return burstTarget(k) + (ms - bursts[k]!);
    }
    let i = 0;
    while (i + 1 < meetings.length && ms >= starts[i + 1]!) i++;
    return anchors[i]! + (ms - meetings[i]!.created);
  };
  return { instant, date };
}

function ageDays(sinceIso: string | undefined, now: number): number {
  const since = Date.parse(sinceIso ?? "");
  return Number.isNaN(since) ? 0 : Math.max(0, Math.floor((now - since) / DAY));
}

function ageBucket(days: number): "0-3d" | "4-7d" | "8-14d" | "15d+" {
  const d = Math.floor(days);
  if (d <= 3) return "0-3d";
  if (d <= 7) return "4-7d";
  if (d <= 14) return "8-14d";
  return "15d+";
}

/** Return a copy of the fixtures with every timestamp moved relative to `now`. */
export function liven<T extends DemoFixtures>(fx: T, now: number = Date.now()): T {
  const map = buildTimeMap(fx, now);
  const recordedDates = new Set<string>();
  const meetingDates = new Set(recordedMeetings(fx).map((m) => m.date));

  const shift = (node: unknown) =>
    mapStrings(node, (s) => {
      const ms = ISO_INSTANT.test(s) ? Date.parse(s) : NaN;
      if (!Number.isNaN(ms)) {
        recordedDates.add(s.slice(0, 10));
        return new Date(map.instant(ms)).toISOString();
      }
      if (DATE_ONLY.test(s) && !Number.isNaN(Date.parse(s))) return map.date(s);
      return s;
    });
  const responses = shift(fx.responses) as T["responses"];
  const ask = shift(fx.ask) as T["ask"];

  // Per insight (from the recorded detail responses): last state change and shipped time.
  const lastChange = new Map<string, string>();
  const shippedAt = new Map<string, string>();
  const handles = new Map<string, Obj>();
  eachObject(responses, (o) => {
    const id = str(o.id);
    if (!id || !Array.isArray(o.timeline)) return;
    for (const e of o.timeline) {
      if (!isObj(e) || e.event_type !== "insight.state_changed") continue;
      const at = str(e.occurred_at);
      if (!at) continue;
      if (at > (lastChange.get(id) ?? "")) lastChange.set(id, at);
      if (e.to_state === "shipped" && !shippedAt.has(id)) shippedAt.set(id, at);
    }
  });
  const sinceOf = (o: Obj) => lastChange.get(str(o.id) ?? "") ?? str(o.updated_at) ?? str(o.created_at);
  eachObject(responses, (o) => {
    if (typeof o.age_days === "number") o.age_days = ageDays(sinceOf(o), now);
    const handle = str(o.handle);
    if (handle && str(o.state) && !handles.has(handle)) handles.set(handle, o);
  });

  // Dates written into prose (briefs, digest, email drafts).
  const today = dateOf(now);
  const firstShipped = [...shippedAt.values()].sort()[0];
  const otherDay = firstShipped ? firstShipped.slice(0, 10) : today;
  const prose = (s: string): string => {
    if (!/\d{4}-\d{2}-\d{2}/.test(s) && !/\d+d old\)/.test(s)) return s;
    return s
      .replace(/^(# Weekly digest \()(\d{4}-\d{2}-\d{2})\)/m, (_m, head: string) => `${head}${today})`)
      .replace(/\b(INS-[A-Z0-9]+)\b((?:(?!INS-)[^\n])*?)\((\w+), \d+d old\)/g, (m, h: string, mid: string, state: string) => {
        const row = handles.get(h);
        return row ? `${h}${mid}(${state}, ${ageDays(sinceOf(row), now)}d old)` : m;
      })
      .replace(/\b(INS-[A-Z0-9]+)\b((?:(?!INS-)[^\n])*?)\(shipped (\d{4}-\d{2}-\d{2})\)/g, (m, h: string, mid: string) => {
        const id = str(handles.get(h)?.id);
        const at = id ? shippedAt.get(id) : undefined;
        return at ? `${h}${mid}(shipped ${at.slice(0, 10)})` : m;
      })
      .replace(TEXT_DATE, (d) => {
        if (meetingDates.has(d)) return map.date(d);
        if (recordedDates.has(d)) return otherDay;
        return d;
      });
  };
  // Bare dates and instants were already moved above; rewriting them again
  // would double-shift any that happen to land on a recorded date.
  const inProse = (s: string) => (ISO_INSTANT.test(s) || DATE_ONLY.test(s) ? s : prose(s));
  const outResponses = mapStrings(responses, inProse) as T["responses"];
  const outAsk = mapStrings(ask, inProse) as T["ask"];

  recomputeAging(outResponses, sinceOf, now);
  return { ...fx, responses: outResponses, ask: outAsk };
}

/** WIP-aging buckets and stuck items, recomputed the way src/metrics/queries.ts does. */
function recomputeAging(
  responses: DemoFixtures["responses"],
  sinceOf: (o: Obj) => string | undefined,
  now: number,
): void {
  const overview = responses["/api/metrics/overview"]?.body;
  const list = responses["/api/insights"]?.body;
  if (!isObj(overview) || !isObj(list) || !Array.isArray(list.insights)) return;

  const names = new Map<string, string>();
  eachObject(responses, (o) => {
    const id = str(o.user_id) ?? str(o.id);
    const name = str(o.name);
    if (id && name) names.set(id, name);
  });

  const open = list.insights.filter((r): r is Obj => isObj(r) && !CLOSED_STATES.has(String(r.state)));
  if (Array.isArray(overview.wip_aging)) {
    const groups = new Map<string, Obj & { count: number; age_buckets: Record<string, number> }>();
    for (const r of open) {
      const track = str(r.track) ?? "untracked";
      const key = `${String(r.state)}|${track}`;
      let g = groups.get(key);
      if (!g) {
        g = { state: r.state, track, count: 0, age_buckets: { "0-3d": 0, "4-7d": 0, "8-14d": 0, "15d+": 0 } };
        groups.set(key, g);
      }
      g.count += 1;
      g.age_buckets[ageBucket((now - Date.parse(sinceOf(r) ?? "")) / DAY)]! += 1;
    }
    overview.wip_aging = [...groups.values()].sort(
      (a, b) => String(a.state).localeCompare(String(b.state)) || String(a.track).localeCompare(String(b.track)),
    );
  }
  if (Array.isArray(overview.stuck_items)) {
    const stuck: Obj[] = [];
    for (const r of open) {
      const threshold = STUCK_THRESHOLDS[String(r.state)];
      const days = (now - Date.parse(sinceOf(r) ?? "")) / DAY;
      if (threshold === undefined || !(days > threshold)) continue;
      const assignee = str(r.assignee_user_id);
      stuck.push({
        insight_id: r.id,
        handle: r.handle,
        title: r.title,
        state: r.state,
        track: r.track ?? null,
        assignee: assignee ? (names.get(assignee) ?? null) : null,
        days_in_state: Math.round(days * 10) / 10,
      });
    }
    overview.stuck_items = stuck.sort((a, b) => Number(b.days_in_state) - Number(a.days_in_state));
  }
}
