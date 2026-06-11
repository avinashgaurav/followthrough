import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { nowIso, openTestDb } from "../db.ts";
import { ulid } from "../ids.ts";
import {
  CALENDAR_SETTINGS_KEY,
  CalendarConfigError,
  CalendarFetchError,
  clearCalendarCache,
  clearFeedUrl,
  fetchEvents,
  getFeedUrl,
  setFeedUrl,
  suggestClient,
} from "./service.ts";

const FEED_URL = "https://calendar.example.com/feed.ics";

function seedUser(db: Database): string {
  const id = ulid();
  db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'Tester', 'admin', ?)",
  ).run(id, `${id}@xyz.com`, nowIso());
  return id;
}

function seedClient(db: Database, name: string, domain: string | null): string {
  const id = ulid();
  db.query("INSERT INTO clients (id, name, domain, created_at) VALUES (?, ?, ?, ?)").run(
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
  test("roundtrip: set, read, overwrite, clear, with settings.updated events", () => {
    const db = openTestDb();
    const userId = seedUser(db);

    expect(getFeedUrl(db)).toBeNull();

    setFeedUrl(db, FEED_URL, userId);
    expect(getFeedUrl(db)).toBe(FEED_URL);

    setFeedUrl(db, "https://other.example.com/cal.ics", userId);
    expect(getFeedUrl(db)).toBe("https://other.example.com/cal.ics");
    const rows = db.query("SELECT COUNT(*) AS n FROM app_settings").get() as { n: number };
    expect(rows.n).toBe(1); // upsert, not duplicate keys

    clearFeedUrl(db, userId);
    expect(getFeedUrl(db)).toBeNull();

    const events = db
      .query(
        "SELECT event_type, entity_id, payload_json FROM events WHERE event_type = 'settings.updated' ORDER BY id",
      )
      .all() as { event_type: string; entity_id: string; payload_json: string }[];
    expect(events).toHaveLength(3); // two sets + one clear
    expect(events.every((e) => e.entity_id === CALENDAR_SETTINGS_KEY)).toBe(true);
    expect(JSON.parse(events[0]!.payload_json).key).toBe(CALENDAR_SETTINGS_KEY);
    expect(JSON.parse(events[2]!.payload_json).removed).toBe(true);
  });

  test("rejects non-https and malformed URLs", () => {
    const db = openTestDb();
    const userId = seedUser(db);
    expect(() => setFeedUrl(db, "http://insecure.example.com/cal.ics", userId)).toThrow(
      CalendarConfigError,
    );
    expect(() => setFeedUrl(db, "not a url", userId)).toThrow(CalendarConfigError);
    expect(getFeedUrl(db)).toBeNull();
  });

  test("clearing when unset appends no event", () => {
    const db = openTestDb();
    const userId = seedUser(db);
    clearFeedUrl(db, userId);
    const n = (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    expect(n).toBe(0);
  });
});

describe("fetchEvents", () => {
  test("unconfigured: {configured:false, events:[]} and no fetch attempted", async () => {
    const db = openTestDb();
    const { impl, calls } = stubFetch("should not be fetched");
    const result = await fetchEvents(db, impl);
    expect(result).toEqual({ configured: false, events: [] });
    expect(calls()).toBe(0);
  });

  test("window filter (past 14d to future 7d) and start-desc sort", async () => {
    const db = openTestDb();
    const userId = seedUser(db);
    setFeedUrl(db, FEED_URL, userId);

    const body = feed([
      ["UID:too-old", "SUMMARY:Thirty days ago", `DTSTART:${icsAt(-30 * DAY)}`],
      ["UID:recent", "SUMMARY:Two days ago", `DTSTART:${icsAt(-2 * DAY)}`],
      ["UID:upcoming", "SUMMARY:Three days out", `DTSTART:${icsAt(3 * DAY)}`],
      ["UID:too-far", "SUMMARY:Twenty days out", `DTSTART:${icsAt(20 * DAY)}`],
    ]);
    const { impl } = stubFetch(body);
    const result = await fetchEvents(db, impl);
    expect(result.configured).toBe(true);
    expect(result.events.map((e) => e.uid)).toEqual(["upcoming", "recent"]);
  });

  test("maps to the UI contract with domain-based client suggestion", async () => {
    const db = openTestDb();
    const userId = seedUser(db);
    const acmeId = seedClient(db, "Acme", "acme.com");
    seedClient(db, "Globex", null);
    setFeedUrl(db, FEED_URL, userId);

    const start = icsAt(-1 * DAY);
    const end = icsAt(-1 * DAY + 3_600_000);
    const body = feed([
      [
        "UID:acme-call",
        "SUMMARY:Sync call",
        `DTSTART:${start}`,
        `DTEND:${end}`,
        "ORGANIZER;CN=Host:mailto:host@xyz.com",
        "ATTENDEE;CN=Bob:mailto:bob@acme.com",
      ],
    ]);
    const { impl } = stubFetch(body);
    const result = await fetchEvents(db, impl);
    expect(result.events).toHaveLength(1);
    const ev = result.events[0]!;
    expect(ev.title).toBe("Sync call");
    expect(ev.end).not.toBeNull();
    expect(ev.organizer).toEqual({ name: "Host", email: "host@xyz.com" });
    expect(ev.attendees).toEqual([{ name: "Bob", email: "bob@acme.com" }]);
    expect(ev.suggested_client_id).toBe(acmeId);
    expect(ev.suggested_client_name).toBe("Acme");
  });

  test("falls back to title match, else nulls", async () => {
    const db = openTestDb();
    const userId = seedUser(db);
    const globexId = seedClient(db, "Globex", null);
    seedClient(db, "Acme", "acme.com");
    setFeedUrl(db, FEED_URL, userId);

    const body = feed([
      ["UID:title-match", "SUMMARY:globex weekly review", `DTSTART:${icsAt(1 * DAY)}`],
      ["UID:no-match", "SUMMARY:Internal planning", `DTSTART:${icsAt(2 * DAY)}`],
    ]);
    const { impl } = stubFetch(body);
    const { events } = await fetchEvents(db, impl);
    const byUid = new Map(events.map((e) => [e.uid, e]));
    expect(byUid.get("title-match")?.suggested_client_id).toBe(globexId);
    expect(byUid.get("title-match")?.suggested_client_name).toBe("Globex");
    expect(byUid.get("no-match")?.suggested_client_id).toBeNull();
    expect(byUid.get("no-match")?.suggested_client_name).toBeNull();
  });

  test("caches the parsed feed for repeat calls", async () => {
    const db = openTestDb();
    const userId = seedUser(db);
    setFeedUrl(db, FEED_URL, userId);
    const body = feed([["UID:c1", "SUMMARY:Cached", `DTSTART:${icsAt(1 * DAY)}`]]);
    const { impl, calls } = stubFetch(body);

    await fetchEvents(db, impl);
    await fetchEvents(db, impl);
    expect(calls()).toBe(1);

    // Changing the feed URL invalidates the cache.
    setFeedUrl(db, "https://other.example.com/cal.ics", userId);
    await fetchEvents(db, impl);
    expect(calls()).toBe(2);
  });

  test("non-2xx response throws CalendarFetchError", async () => {
    const db = openTestDb();
    const userId = seedUser(db);
    setFeedUrl(db, FEED_URL, userId);
    const { impl } = stubFetch("nope", 500);
    expect(fetchEvents(db, impl)).rejects.toThrow(CalendarFetchError);
  });

  test("network failure throws CalendarFetchError", async () => {
    const db = openTestDb();
    const userId = seedUser(db);
    setFeedUrl(db, FEED_URL, userId);
    const impl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(fetchEvents(db, impl)).rejects.toThrow(CalendarFetchError);
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
