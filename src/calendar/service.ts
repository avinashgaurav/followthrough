import type { Database } from "../db.ts";
import { currentTenant, nowIso } from "../db.ts";
import { appendEvent } from "../events.ts";
import { parseIcs, type IcsEvent } from "./ics.ts";
import { hostedMode } from "../config.ts";
import { controlRateLimited } from "../hosted/tenancy.ts";
import {
  assertSafeUrl,
  FeedTooLargeError,
  safeFetchText,
  systemResolver,
  UnsafeUrlError,
  type Resolver,
} from "./safe-fetch.ts";

export const CALENDAR_SETTINGS_KEY = "calendar_ics_url";

/** Window: past 14 days to future 7 days, by event start. */
const WINDOW_PAST_MS = 14 * 86_400_000;
const WINDOW_FUTURE_MS = 7 * 86_400_000;
const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** A failed fetch is remembered this long, so a dead link is not retried on every request. */
const FAILURE_TTL_MS = 45_000;
/** Events kept per feed, after the window filter. */
export const MAX_EVENTS_PER_FEED = 5_000;
/** Whole-cache bounds: entries, and approximate size (characters of the cached JSON). */
export const CACHE_MAX_ENTRIES = 100;
export const CACHE_MAX_CHARS = 20_000_000;
/** Feed fetches running at once across the whole process. */
export const MAX_CONCURRENT_FETCHES = 20;
/** Hosted mode: network fetches (cache misses) per workspace per hour. */
export const HOSTED_FETCHES_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
const UNREACHABLE = "Could not reach the calendar feed.";

export class CalendarConfigError extends Error {}
export class CalendarFetchError extends Error {}
/** Too many feed fetches from this workspace in the last hour (hosted mode). */
export class CalendarRateLimitError extends CalendarFetchError {}

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

export async function setFeedUrl(
  db: Database,
  url: string,
  userId: string,
  resolve: Resolver = systemResolver,
): Promise<void> {
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
  // Fail fast on anything the fetch would refuse (it checks again every time).
  try {
    await assertSafeUrl(parsed, resolve);
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new CalendarConfigError(err.message);
    throw err;
  }
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

// In-process cache of fetched feeds. Keyed on workspace and URL, so in hosted
// mode one workspace can never be served another's cached events. Successes
// live CACHE_TTL_MS, failures FAILURE_TTL_MS. Only events inside the window
// are kept, at most MAX_EVENTS_PER_FEED per feed, and the whole cache is
// bounded by entry count and by approximate size.
type CacheEntry =
  | { fetchedAt: number; events: IcsEvent[]; chars: number; failure?: undefined }
  | { fetchedAt: number; failure: string; chars: number; events?: undefined };
const cache = new Map<string, CacheEntry>();
let cacheChars = 0;
const inFlight = new Map<string, Promise<IcsEvent[]>>();
let running = 0;
const LOCAL_SCOPE = "-"; // single-tenant (no workspace)

const scopeOf = (tenant: string | null) => tenant ?? LOCAL_SCOPE;
const cacheKey = (tenant: string | null, url: string) => `${scopeOf(tenant)}\n${url}`;

function drop(key: string): void {
  const old = cache.get(key);
  if (!old) return;
  cacheChars -= old.chars;
  cache.delete(key);
}

/**
 * Drops cached feeds: one workspace's when given a tenant (null is the
 * single-tenant scope), everything when called with no argument (tests).
 */
export function clearCalendarCache(tenant?: string | null): void {
  if (tenant === undefined) {
    cache.clear();
    cacheChars = 0;
    return;
  }
  const prefix = `${scopeOf(tenant)}\n`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) drop(key);
}

/** Test hook: the cache's current size. */
export function calendarCacheStats(): { entries: number; chars: number; running: number } {
  return { entries: cache.size, chars: cacheChars, running };
}

const ttlOf = (e: CacheEntry) => (e.failure === undefined ? CACHE_TTL_MS : FAILURE_TTL_MS);

function remember(key: string, entry: CacheEntry, now: number): void {
  drop(key);
  for (const [k, v] of [...cache]) if (now - v.fetchedAt >= ttlOf(v)) drop(k);
  if (entry.chars > CACHE_MAX_CHARS) return; // never cache something bigger than the whole budget
  // Map keeps insertion order, so the first key is the oldest entry.
  while (cache.size > 0 && (cache.size >= CACHE_MAX_ENTRIES || cacheChars + entry.chars > CACHE_MAX_CHARS)) {
    drop(cache.keys().next().value!);
  }
  cache.set(key, entry);
  cacheChars += entry.chars;
}

/** Events inside the window, newest first, at most MAX_EVENTS_PER_FEED. */
function inWindow(events: IcsEvent[], now: number): IcsEvent[] {
  const min = now - WINDOW_PAST_MS;
  const max = now + WINDOW_FUTURE_MS;
  return events
    .filter((e) => {
      const t = Date.parse(e.start);
      return Number.isFinite(t) && t >= min && t <= max;
    })
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
    .slice(0, MAX_EVENTS_PER_FEED);
}

/**
 * Returns a feed's events inside the window (cached per workspace + URL).
 * Concurrent requests for the same feed share one fetch. A cache miss counts
 * against the workspace's hourly fetch limit in hosted mode, and at most
 * MAX_CONCURRENT_FETCHES fetches run at once. Fetch failures are reported as
 * one generic message (the real reason is logged), except the size cap.
 * Exported for tests; the app goes through fetchEvents.
 */
export async function loadFeed(
  db: Database,
  url: string,
  fetchImpl: typeof fetch = fetch,
  resolve: Resolver = systemResolver,
): Promise<IcsEvent[]> {
  const tenant = currentTenant();
  const key = cacheKey(tenant, url);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < ttlOf(hit)) {
    if (hit.failure !== undefined) throw new CalendarFetchError(hit.failure);
    return hit.events;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  if (hostedMode() && tenant) {
    if (await controlRateLimited(db, `cal-fetch:${tenant}`, HOSTED_FETCHES_PER_HOUR, HOUR_MS)) {
      throw new CalendarRateLimitError("Too many calendar refreshes this hour. Try again later.");
    }
  }
  // Another request for this feed may have started while we checked the limit.
  const raced = inFlight.get(key);
  if (raced) return raced;
  if (running >= MAX_CONCURRENT_FETCHES) {
    throw new CalendarFetchError("The calendar service is busy. Try again in a moment.");
  }

  running++;
  const job = fetchAndParse(url, fetchImpl, resolve).then(
    (events) => {
      remember(key, { fetchedAt: Date.now(), events, chars: JSON.stringify(events).length }, Date.now());
      return events;
    },
    (err: unknown) => {
      const message = err instanceof CalendarFetchError ? err.message : UNREACHABLE;
      remember(key, { fetchedAt: Date.now(), failure: message, chars: message.length }, Date.now());
      throw err instanceof CalendarFetchError ? err : new CalendarFetchError(message);
    },
  );
  const tracked = job.finally(() => {
    running--;
    inFlight.delete(key);
  });
  inFlight.set(key, tracked);
  return tracked;
}

async function fetchAndParse(url: string, fetchImpl: typeof fetch, resolve: Resolver): Promise<IcsEvent[]> {
  let res: { ok: boolean; status: number; text: string };
  try {
    res = await safeFetchText(url, { fetchImpl, resolve, timeoutMs: FETCH_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof FeedTooLargeError) throw new CalendarFetchError(err.message);
    // Refused hops, lookups and network errors look the same to the caller.
    console.warn("calendar feed fetch failed:", err instanceof Error ? err.message : err);
    throw new CalendarFetchError(UNREACHABLE);
  }
  if (!res.ok) {
    console.warn(`calendar feed fetch failed: upstream status ${res.status}`);
    throw new CalendarFetchError(UNREACHABLE);
  }
  return inWindow(parseIcs(res.text), Date.now());
}

/**
 * Save-time pattern check for obviously internal hosts. setFeedUrl also runs
 * the full assertSafeUrl; the guard that matters runs at every fetch
 * (safe-fetch.ts), checking each resolved address and redirect hop.
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
 * every hop checked for private addresses; cached per workspace, see loadFeed),
 * filter to past 14 days .. future 7 days, sort by start desc, and map to the
 * UI contract with client suggestions. Unconfigured: {configured:false, events:[]}.
 * Throws CalendarFetchError when the feed cannot be fetched (CalendarRateLimitError
 * when a hosted workspace has used its hourly fetches).
 */
export async function fetchEvents(
  db: Database,
  fetchImpl: typeof fetch = fetch,
  resolve: Resolver = systemResolver,
): Promise<CalendarEventsResult> {
  const url = await getFeedUrl(db);
  if (!url) return { configured: false, events: [] };

  // Cached events were windowed when fetched; re-window as time has moved on.
  const all = inWindow(await loadFeed(db, url, fetchImpl, resolve), Date.now());

  const clients = await db
    .query("SELECT id, name, domain FROM clients ORDER BY created_at, id")
    .all() as ClientRow[];

  const events = all.map((e): CalendarUiEvent => {
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
