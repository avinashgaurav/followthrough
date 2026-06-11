import type { Database } from "bun:sqlite";
import { nowIso } from "../db.ts";
import { appendEvent } from "../events.ts";
import { parseIcs, type IcsEvent } from "./ics.ts";

export const CALENDAR_SETTINGS_KEY = "calendar_ics_url";

/** Window: past 14 days to future 7 days, by event start. */
const WINDOW_PAST_MS = 14 * 86_400_000;
const WINDOW_FUTURE_MS = 7 * 86_400_000;
const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export class CalendarConfigError extends Error {}
export class CalendarFetchError extends Error {}

export interface CalendarAttendee {
  name: string | null;
  email: string | null;
}

/** UI contract for the Capture prefill picker. */
export interface CalendarUiEvent {
  uid: string;
  title: string;
  start: string;
  end: string | null;
  attendees: CalendarAttendee[];
  organizer: CalendarAttendee | null;
  suggested_client_id: string | null;
  suggested_client_name: string | null;
}

export function getFeedUrl(db: Database): string | null {
  const row = db
    .query("SELECT value FROM app_settings WHERE key = ?")
    .get(CALENDAR_SETTINGS_KEY) as { value: string } | null;
  return row?.value ?? null;
}

export function setFeedUrl(db: Database, url: string, userId: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CalendarConfigError("Invalid calendar feed URL. Provide a full https URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new CalendarConfigError("Calendar feed URL must use https.");
  }
  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(CALENDAR_SETTINGS_KEY, parsed.toString(), userId, nowIso());
    appendEvent(db, {
      actorUserId: userId,
      entityType: "setting",
      entityId: CALENDAR_SETTINGS_KEY,
      eventType: "settings.updated",
      payload: { key: CALENDAR_SETTINGS_KEY },
    });
  });
  tx();
  clearCalendarCache();
}

export function clearFeedUrl(db: Database, userId: string): void {
  const tx = db.transaction(() => {
    const res = db.query("DELETE FROM app_settings WHERE key = ?").run(CALENDAR_SETTINGS_KEY);
    if (res.changes > 0) {
      appendEvent(db, {
        actorUserId: userId,
        entityType: "setting",
        entityId: CALENDAR_SETTINGS_KEY,
        eventType: "settings.updated",
        payload: { key: CALENDAR_SETTINGS_KEY, removed: true },
      });
    }
  });
  tx();
  clearCalendarCache();
}

// In-process cache of the parsed feed (per the configured URL), 5 minute TTL.
let cache: { url: string; fetchedAt: number; events: IcsEvent[] } | null = null;

/** Test hook + invalidation on settings changes. */
export function clearCalendarCache(): void {
  cache = null;
}

async function fetchParsedFeed(url: string, fetchImpl: typeof fetch): Promise<IcsEvent[]> {
  const now = Date.now();
  if (cache && cache.url === url && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.events;
  }
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CalendarFetchError(`Could not reach the calendar feed: ${detail}`);
  }
  if (!res.ok) {
    throw new CalendarFetchError(`Calendar feed responded with status ${res.status}.`);
  }
  const text = await res.text();
  const events = parseIcs(text);
  cache = { url, fetchedAt: now, events };
  return events;
}

interface ClientRow {
  id: string;
  name: string;
  domain: string | null;
}

/**
 * Suggest a client for an event: attendee email domains matched against
 * clients.domain first, then client names as case-insensitive substrings of
 * the event title. Returns nulls when nothing matches.
 */
export function suggestClient(
  clients: ClientRow[],
  event: Pick<IcsEvent, "summary" | "attendees">,
): { id: string; name: string } | null {
  const byDomain = new Map<string, ClientRow>();
  for (const c of clients) {
    const d = c.domain?.trim().toLowerCase();
    if (d && !byDomain.has(d)) byDomain.set(d, c);
  }
  for (const a of event.attendees) {
    const domain = a.email?.split("@")[1]?.toLowerCase();
    if (!domain) continue;
    const hit = byDomain.get(domain);
    if (hit) return { id: hit.id, name: hit.name };
  }
  const title = event.summary.toLowerCase();
  for (const c of clients) {
    const name = c.name.trim().toLowerCase();
    if (name.length >= 2 && title.includes(name)) return { id: c.id, name: c.name };
  }
  return null;
}

export interface CalendarEventsResult {
  configured: boolean;
  events: CalendarUiEvent[];
}

/**
 * Fetch the configured ICS feed (10s timeout, 5 minute in-process cache),
 * filter to past 14 days .. future 7 days, sort by start desc, and map to the
 * UI contract with client suggestions. Unconfigured: {configured:false, events:[]}.
 * Throws CalendarFetchError when the feed cannot be fetched.
 */
export async function fetchEvents(
  db: Database,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarEventsResult> {
  const url = getFeedUrl(db);
  if (!url) return { configured: false, events: [] };

  const all = await fetchParsedFeed(url, fetchImpl);
  const now = Date.now();
  const min = now - WINDOW_PAST_MS;
  const max = now + WINDOW_FUTURE_MS;

  const clients = db
    .query("SELECT id, name, domain FROM clients ORDER BY created_at, id")
    .all() as ClientRow[];

  const events = all
    .filter((e) => {
      const t = Date.parse(e.start);
      return Number.isFinite(t) && t >= min && t <= max;
    })
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
    .map((e): CalendarUiEvent => {
      const suggestion = suggestClient(clients, e);
      return {
        uid: e.uid,
        title: e.summary,
        start: e.start,
        end: e.end,
        attendees: e.attendees.map((a) => ({ name: a.name, email: a.email })),
        organizer: e.organizer ? { name: e.organizer.name, email: e.organizer.email } : null,
        suggested_client_id: suggestion?.id ?? null,
        suggested_client_name: suggestion?.name ?? null,
      };
    });

  return { configured: true, events };
}
