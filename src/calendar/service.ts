import type { Database } from "../db.ts";
import { currentTenant, nowIso } from "../db.ts";
import { appendEvent } from "../events.ts";
import { parseIcs, type IcsEvent } from "./ics.ts";
import { FeedTooLargeError, safeFetchText, systemResolver, UnsafeUrlError, type Resolver } from "./safe-fetch.ts";

export const CALENDAR_SETTINGS_KEY = "calendar_ics_url";

/** Window: past 14 days to future 7 days, by event start. */
const WINDOW_PAST_MS = 14 * 86_400_000;
const WINDOW_FUTURE_MS = 7 * 86_400_000;
const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_MAX_ENTRIES = 500;

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

export async function getFeedUrl(db: Database): Promise<string | null> {
  const row = await db
    .query("SELECT value FROM app_settings WHERE key = ?")
    .get(CALENDAR_SETTINGS_KEY) as { value: string } | null;
  return row?.value ?? null;
}

export async function setFeedUrl(db: Database, url: string, userId: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CalendarConfigError("Invalid calendar feed URL. Provide a full https URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new CalendarConfigError("Calendar feed URL must use https.");
  }
  if (parsed.port !== "") {
    throw new CalendarConfigError("Calendar feed URL must use the standard https port (443).");
  }
  assertPublicHost(parsed.hostname);
  const tx = () => db.transaction(async () => {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(CALENDAR_SETTINGS_KEY, parsed.toString(), userId, nowIso());
    await appendEvent(db, {
      actorUserId: userId,
      entityType: "setting",
      entityId: CALENDAR_SETTINGS_KEY,
      eventType: "settings.updated",
      payload: { key: CALENDAR_SETTINGS_KEY },
    });
  });
  await tx();
  clearCalendarCache(currentTenant());
}

export async function clearFeedUrl(db: Database, userId: string): Promise<void> {
  const tx = () => db.transaction(async () => {
    const res = await db.query("DELETE FROM app_settings WHERE key = ?").run(CALENDAR_SETTINGS_KEY);
    if (res.changes > 0) {
      await appendEvent(db, {
        actorUserId: userId,
        entityType: "setting",
        entityId: CALENDAR_SETTINGS_KEY,
        eventType: "settings.updated",
        payload: { key: CALENDAR_SETTINGS_KEY, removed: true },
      });
    }
  });
  await tx();
  clearCalendarCache(currentTenant());
}

// In-process cache of parsed feeds, 5 minute TTL. Keyed on workspace and URL,
// so in hosted mode one workspace can never be served another's cached events.
const cache = new Map<string, { fetchedAt: number; events: IcsEvent[] }>();
const LOCAL_SCOPE = "-"; // single-tenant (no workspace)

const scopeOf = (tenant: string | null) => tenant ?? LOCAL_SCOPE;
const cacheKey = (tenant: string | null, url: string) => `${scopeOf(tenant)}\n${url}`;

/**
 * Drops cached feeds: one workspace's when given a tenant (null is the
 * single-tenant scope), everything when called with no argument (tests).
 */
export function clearCalendarCache(tenant?: string | null): void {
  if (tenant === undefined) {
    cache.clear();
    return;
  }
  const prefix = `${scopeOf(tenant)}\n`;
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

function remember(key: string, events: IcsEvent[], now: number): void {
  for (const [k, v] of cache) if (now - v.fetchedAt >= CACHE_TTL_MS) cache.delete(k);
  cache.delete(key);
  // Map keeps insertion order, so the first key is the oldest entry.
  while (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { fetchedAt: now, events });
}

/**
 * Save-time check for obviously internal hosts, so a bad link is refused when
 * it is entered. The real guard runs at fetch time (safe-fetch.ts): it checks
 * every resolved address and every redirect hop.
 */
export function assertPublicHost(hostname: string): void {
  const h = hostname.toLowerCase();
  const privatePatterns = [
    /^localhost$/, /^127\./, /^0\.0\.0\.0$/, /^10\./, /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^\[?::1\]?$/, /^\[?fe80:/, /^\[?fc/, /^\[?fd/,
    /^metadata\.google/, /^169\.254\.169\.254$/,
  ];
  if (privatePatterns.some((re) => re.test(h))) {
    throw new CalendarConfigError("Calendar feed URL points at a private or internal host.");
  }
}

async function fetchParsedFeed(url: string, fetchImpl: typeof fetch, resolve: Resolver): Promise<IcsEvent[]> {
  const now = Date.now();
  const key = cacheKey(currentTenant(), url);
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.events;

  let res: { ok: boolean; status: number; text: string };
  try {
    res = await safeFetchText(url, { fetchImpl, resolve, timeoutMs: FETCH_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof UnsafeUrlError || err instanceof FeedTooLargeError) {
      throw new CalendarFetchError(err.message);
    }
    console.warn("calendar feed fetch failed:", err);
    throw new CalendarFetchError("Could not reach the calendar feed. Check the link and try again.");
  }
  if (!res.ok) {
    throw new CalendarFetchError(`Calendar feed responded with status ${res.status}.`);
  }
  const events = parseIcs(res.text);
  remember(key, events, now);
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
 * Fetch the configured ICS feed (10s timeout, 5 MB cap, at most 3 redirects,
 * every hop checked for private addresses; 5 minute per-workspace cache),
 * filter to past 14 days .. future 7 days, sort by start desc, and map to the
 * UI contract with client suggestions. Unconfigured: {configured:false, events:[]}.
 * Throws CalendarFetchError when the feed cannot be fetched.
 */
export async function fetchEvents(
  db: Database,
  fetchImpl: typeof fetch = fetch,
  resolve: Resolver = systemResolver,
): Promise<CalendarEventsResult> {
  const url = await getFeedUrl(db);
  if (!url) return { configured: false, events: [] };

  const all = await fetchParsedFeed(url, fetchImpl, resolve);
  const now = Date.now();
  const min = now - WINDOW_PAST_MS;
  const max = now + WINDOW_FUTURE_MS;

  const clients = await db
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
