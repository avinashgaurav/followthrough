import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "../db.ts";
import { nowIso, openTestDb } from "../db.ts";
import { ulid } from "../ids.ts";
import {
  CALENDAR_SETTINGS_KEY,
  CalendarConfigError,
  CalendarFetchError,
  CACHE_MAX_CHARS,
  CACHE_MAX_ENTRIES,
  MAX_CONCURRENT_FETCHES,
  MAX_EVENTS_PER_FEED,
  calendarCacheStats,
  clearCalendarCache,
  clearFeedUrl,
  fetchEvents,
  loadFeed,
  getFeedUrl,
  setFeedUrl,
  suggestClient,
} from "./service.ts";
import type { Resolver } from "./safe-fetch.ts";

// Every hostname resolves to a public address, so tests need no real DNS.
const publicDns: Resolver = async () => ["93.184.216.34"];

const FEED_URL = "https://calendar.example.com/feed.ics";

async function seedUser(db: Database): Promise<string> {
  const id = ulid();
  await db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'Tester', 'admin', ?)",
  ).run(id, `${id}@tallyhall.com`, nowIso());
  return id;
}

async function seedClient(db: Database, name: string, domain: string | null): Promise<string> {
  const id = ulid();
  await db.query("INSERT INTO clients (id, name, domain, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    name,
    domain,
    nowIso(),
  );
  return id;
}

/** ICS UTC datetime for now + offsetMs, e.g. 20260610T130000Z. */
function icsAt(offsetMs: number): string {
  return new Date(Date.now() + offsetMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

const DAY = 86_400_000;

function feed(events: string[][]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0"];
  for (const ev of events) lines.push("BEGIN:VEVENT", ...ev, "END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function stubFetch(body: string, status = 200): { impl: typeof fetch; calls: () => number } {
  let n = 0;
  const impl = (async () => {
    n++;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls: () => n };
}

beforeEach(() => clearCalendarCache());

describe("feed url settings", () => {
  test("roundtrip: set, read, overwrite, clear, with settings.updated events", async () => {
    const db = await openTestDb();
    const userId = await seedUser(db);

    expect(await getFeedUrl(db)).toBeNull();

    await setFeedUrl(db, FEED_URL, userId, publicDns);
    expect(await getFeedUrl(db)).toBe(FEED_URL);

    await setFeedUrl(db, "https://other.example.com/cal.ics", userId, publicDns);
    expect(await getFeedUrl(db)).toBe("https://other.example.com/cal.ics");
    const rows = await db.query("SELECT COUNT(*) AS n FROM app_settings").get() as { n: number };
    expect(rows.n).toBe(1); // upsert, not duplicate keys

    await clearFeedUrl(db, userId);
    expect(await getFeedUrl(db)).toBeNull();

    const events = await db
      .query(
        "SELECT event_type, entity_id, payload_json FROM events WHERE event_type = 'settings.updated' ORDER BY id",
      )
      .all() as { event_type: string; entity_id: string; payload_json: string }[];
    expect(events).toHaveLength(3); // two sets + one clear
    expect(events.every((e) => e.entity_id === CALENDAR_SETTINGS_KEY)).toBe(true);
    expect(JSON.parse(events[0]!.payload_json).key).toBe(CALENDAR_SETTINGS_KEY);
    expect(JSON.parse(events[2]!.payload_json).removed).toBe(true);
  });

  test("rejects non-https and malformed URLs", async () => {
    const db = await openTestDb();
    const userId = await seedUser(db);
    await expect(setFeedUrl(db, "http://insecure.example.com/cal.ics", userId, publicDns)).rejects.toThrow(
      CalendarConfigError,
    );
    await expect(setFeedUrl(db, "not a url", userId, publicDns)).rejects.toThrow(CalendarConfigError);
    await expect(setFeedUrl(db, "https://calendar.example.com:8443/cal.ics", userId, publicDns)).rejects.toThrow(
      CalendarConfigError,
    );
    expect(await getFeedUrl(db)).toBeNull();
  });

  test("clearing when unset appends no event", async () => {
    const db = await openTestDb();
    const userId = await seedUser(db);
    await clearFeedUrl(db, userId);
    const n = (await db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    expect(n).toBe(0);
  });
});

describe("fetchEvents", () => {
  test("unconfigured: {configured:false, events:[]} and no fetch attempted", async () => {
    const db = await openTestDb();
    const { impl, calls } = stubFetch("should not be fetched");
    const result = await fetchEvents(db, impl, publicDns);
    expect(result).toEqual({ configured: false, events: [] });
    expect(calls()).toBe(0);
  });

  test("window filter (past 14d to future 7d) and start-desc sort", async () => {
    const db = await openTestDb();
    const userId = await seedUser(db);
    await setFeedUrl(db, FEED_URL, userId, publicDns);

    const body = feed([
      ["UID:too-old", "SUMMARY:Thirty days ago", `DTSTART:${icsAt(-30 * DAY)}`],
      ["UID:recent", "SUMMARY:Two days ago", `DTSTART:${icsAt(-2 * DAY)}`],
      ["UID:upcoming", "SUMMARY:Three days out", `DTSTART:${icsAt(3 * DAY)}`],
      ["UID:too-far", "SUMMARY:Twenty days out", `DTSTART:${icsAt(20 * DAY)}`],
    ]);
    const { impl } = stubFetch(body);
    const result = await fetchEvents(db, impl, publicDns);
    expect(result.configured).toBe(true);
    expect(result.events.map((e) => e.uid)).toEqual(["upcoming", "recent"]);
  });

  test("maps to the UI contract with domain-based client suggestion", async () => {
    const db = await openTestDb();
    const userId = await seedUser(db);
    const acmeId = await seedClient(db, "Acme", "acme.com");
    await seedClient(db, "Globex", null);
    await setFeedUrl(db, FEED_URL, userId, publicDns);

    const start = icsAt(-1 * DAY);
    const end = icsAt(-1 * DAY + 3_600_000);
    const body = feed([
      [
        "UID:acme-call",
        "SUMMARY:Sync call",
        `DTSTART:${start}`,
        `DTEND:${end}`,
        "ORGANIZER;CN=Host:mailto:host@tallyhall.com",
        "ATTENDEE;CN=Bob:mailto:bob@acme.com",
      ],
    ]);
    const { impl } = stubFetch(body);
    const result = await fetchEvents(db, impl, publicDns);
    expect(result.events).toHaveLength(1);
    const ev = result.events[0]!;
    expect(ev.title).toBe("Sync call");
    expect(ev.end).not.toBeNull();
    expect(ev.organizer).toEqual({ name: "Host", email: "host@tallyhall.com" });
    expect(ev.attendees).toEqual([{ name: "Bob", email: "bob@acme.com" }]);
    expect(ev.suggested_client_id).toBe(acmeId);
    expect(ev.suggested_client_name).toBe("Acme");
  });

  test("falls back to title match, else nulls", async () => {
    const db = await openTestDb();
    const userId = await seedUser(db);
    const globexId = await seedClient(db, "Globex", null);
    await seedClient(db, "Acme", "acme.com");
    await setFeedUrl(db, FEED_URL, userId, publicDns);

    const body = feed([
      ["UID:title-match", "SUMMARY:globex weekly review", `DTSTART:${icsAt(1 * DAY)}`],
      ["UID:no-match", "SUMMARY:Internal planning", `DTSTART:${icsAt(2 * DAY)}`],
    ]);
    const { impl } = stubFetch(body);
    const { events } = await fetchEvents(db, impl, publicDns);
    const byUid = new Map(events.map((e) => [e.uid, e]));
    expect(byUid.get("title-match")?.suggested_client_id).toBe(globexId);
    expect(byUid.get("title-match")?.suggested_client_name).toBe("Globex");
    expect(byUid.get("no-match")?.suggested_client_id).toBeNull();
    expect(byUid.get("no-match")?.suggested_client_name).toBeNull();
  });

  test("caches the parsed feed for repeat calls", async () => {
    const db = await openTestDb();
    const userId = await seedUser(db);
    await setFeedUrl(db, FEED_URL, userId, publicDns);
    const body = feed([["UID:c1", "SUMMARY:Cached", `DTSTART:${icsAt(1 * DAY)}`]]);
    const { impl, calls } = stubFetch(body);

    await fetchEvents(db, impl, publicDns);
    await fetchEvents(db, impl, publicDns);
    expect(calls()).toBe(1);

    // Changing the feed URL invalidates the cache.
    await setFeedUrl(db, "https://other.example.com/cal.ics", userId, publicDns);
    await fetchEvents(db, impl, publicDns);
    expect(calls()).toBe(2);
  });

  test("non-2xx response throws CalendarFetchError", async () => {
    const db = await openTestDb();
    const userId = await seedUser(db);
    await setFeedUrl(db, FEED_URL, userId, publicDns);
    const { impl } = stubFetch("nope", 500);
    expect(fetchEvents(db, impl, publicDns)).rejects.toThrow(CalendarFetchError);
  });

  test("a feed host that resolves to a private address is refused at fetch time", async () => {
    const db = await openTestDb();
    const userId = await seedUser(db);
    await setFeedUrl(db, FEED_URL, userId, publicDns); // looks public when saved
    const { impl, calls } = stubFetch("never");
    const rebound: Resolver = async () => ["10.0.0.7"];
    // One generic message at fetch time; the reason is only logged.
    await expect(fetchEvents(db, impl, rebound)).rejects.toThrow("Could not reach the calendar feed.");
    expect(calls()).toBe(0);
  });

  test("network failure throws CalendarFetchError", async () => {
    const db = await openTestDb();
    const userId = await seedUser(db);
    await setFeedUrl(db, FEED_URL, userId, publicDns);
    const impl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(fetchEvents(db, impl, publicDns)).rejects.toThrow(CalendarFetchError);
  });
});

describe("cache and load limits", () => {
  const url = (n: number | string) => `https://calendar.example.com/feed.ics?x=${n}`;
  const oneEvent = feed([["UID:e1", "SUMMARY:Soon", `DTSTART:${icsAt(1 * DAY)}`]]);

  test("only in-window events are cached, at most MAX_EVENTS_PER_FEED per feed", async () => {
    const db = await openTestDb();
    const events: string[][] = [["UID:old", "SUMMARY:Old", `DTSTART:${icsAt(-60 * DAY)}`]];
    for (let i = 0; i < MAX_EVENTS_PER_FEED + 1_000; i++) {
      events.push([`UID:e${i}`, "SUMMARY:x", `DTSTART:${icsAt(DAY + i * 60_000)}`]);
    }
    const { impl } = stubFetch(feed(events));
    const loaded = await loadFeed(db, url("big"), impl, publicDns);
    expect(loaded).toHaveLength(MAX_EVENTS_PER_FEED);
    expect(loaded.some((e) => e.uid === "old")).toBe(false);
  });

  test("the cache is bounded by entry count (oldest evicted) and size", async () => {
    const db = await openTestDb();
    const { impl, calls } = stubFetch(oneEvent);
    for (let i = 0; i < CACHE_MAX_ENTRIES + 5; i++) await loadFeed(db, url(i), impl, publicDns);
    const stats = calendarCacheStats();
    expect(stats.entries).toBe(CACHE_MAX_ENTRIES);
    expect(stats.chars).toBeGreaterThan(0);
    expect(stats.chars).toBeLessThanOrEqual(CACHE_MAX_CHARS);
    // The newest is still cached; the oldest was evicted and is fetched again.
    const before = calls();
    await loadFeed(db, url(CACHE_MAX_ENTRIES + 4), impl, publicDns);
    expect(calls()).toBe(before);
    await loadFeed(db, url(0), impl, publicDns);
    expect(calls()).toBe(before + 1);
  });

  test("a failed fetch is cached briefly, with one generic message", async () => {
    const db = await openTestDb();
    const { impl, calls } = stubFetch("nope", 500);
    await expect(loadFeed(db, url("dead"), impl, publicDns)).rejects.toThrow("Could not reach the calendar feed.");
    await expect(loadFeed(db, url("dead"), impl, publicDns)).rejects.toThrow("Could not reach the calendar feed.");
    expect(calls()).toBe(1);
  });

  test("concurrent requests for the same feed share one fetch", async () => {
    const db = await openTestDb();
    const { impl, calls } = stubFetch(oneEvent);
    const [a, b] = await Promise.all([loadFeed(db, url("same"), impl, publicDns), loadFeed(db, url("same"), impl, publicDns)]);
    expect(a).toEqual(b);
    expect(calls()).toBe(1);
  });

  test(`at most ${MAX_CONCURRENT_FETCHES} fetches run at once`, async () => {
    const db = await openTestDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async () => {
      await gate;
      return new Response(oneEvent, { status: 200 });
    }) as unknown as typeof fetch;
    const held = Array.from({ length: MAX_CONCURRENT_FETCHES }, (_, i) => loadFeed(db, url(`held-${i}`), slow, publicDns));
    await expect(loadFeed(db, url("one-too-many"), slow, publicDns)).rejects.toThrow(/busy/);
    expect(calendarCacheStats().running).toBe(MAX_CONCURRENT_FETCHES);
    release();
    await Promise.all(held);
    expect(calendarCacheStats().running).toBe(0);
    // Once they finish, new fetches go through.
    expect(await loadFeed(db, url("one-too-many"), stubFetch(oneEvent).impl, publicDns)).toHaveLength(1);
  });
});

describe("suggestClient", () => {
  const clients = [
    { id: "c1", name: "Acme", domain: "acme.com" },
    { id: "c2", name: "Globex", domain: null },
  ];

  test("domain match wins over title match", () => {
    const hit = suggestClient(clients, {
      summary: "Globex sync",
      attendees: [{ name: null, email: "x@acme.com" }],
    });
    expect(hit).toEqual({ id: "c1", name: "Acme" });
  });

  test("title substring match is case-insensitive", () => {
    const hit = suggestClient(clients, {
      summary: "Q3 planning with GLOBEX team",
      attendees: [],
    });
    expect(hit).toEqual({ id: "c2", name: "Globex" });
  });

  test("no match returns null", () => {
    expect(suggestClient(clients, { summary: "1:1", attendees: [] })).toBeNull();
  });
});
