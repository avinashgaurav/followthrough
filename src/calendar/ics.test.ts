import { describe, expect, test } from "bun:test";
import { parseIcs, parseIcsDateTime, parsePropLine, unfoldIcsLines } from "./ics.ts";

const CRLF = "\r\n";

function wrap(body: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...body, "END:VCALENDAR"].join(CRLF);
}

describe("unfoldIcsLines", () => {
  test("joins CRLF + space and CRLF + tab continuations", () => {
    const text = "SUMMARY:Quarterly busin" + CRLF + " ess review" + CRLF + "\twith Acme";
    expect(unfoldIcsLines(text)).toEqual(["SUMMARY:Quarterly business reviewwith Acme"]);
  });

  test("handles bare LF folding too", () => {
    expect(unfoldIcsLines("DESCRIPTION:ab\n cd")).toEqual(["DESCRIPTION:abcd"]);
  });
});

describe("parsePropLine", () => {
  test("parses name, params, value", () => {
    const p = parsePropLine("ATTENDEE;CN=Bob Jones;ROLE=REQ-PARTICIPANT:mailto:bob@acme.com");
    expect(p).toEqual({
      name: "ATTENDEE",
      params: { CN: "Bob Jones", ROLE: "REQ-PARTICIPANT" },
      value: "mailto:bob@acme.com",
    });
  });

  test("quoted param values may contain colons, semicolons, commas", () => {
    const p = parsePropLine('ORGANIZER;CN="Smith, John; CEO: Acme":mailto:john@acme.com');
    expect(p?.params["CN"]).toBe("Smith, John; CEO: Acme");
    expect(p?.value).toBe("mailto:john@acme.com");
  });

  test("returns null for lines without a colon", () => {
    expect(parsePropLine("THIS IS NOT A PROPERTY")).toBeNull();
  });
});

describe("parseIcsDateTime", () => {
  test("UTC Z form", () => {
    expect(parseIcsDateTime("20260610T130000Z", {})).toEqual({
      iso: "2026-06-10T13:00:00.000Z",
      allDay: false,
    });
  });

  test("TZID form converts wall time to UTC (winter, EST -5)", () => {
    expect(parseIcsDateTime("20260115T090000", { TZID: "America/New_York" })).toEqual({
      iso: "2026-01-15T14:00:00.000Z",
      allDay: false,
    });
  });

  test("TZID form respects DST (summer, EDT -4)", () => {
    expect(parseIcsDateTime("20260715T090000", { TZID: "America/New_York" })).toEqual({
      iso: "2026-07-15T13:00:00.000Z",
      allDay: false,
    });
  });

  test("unknown TZID falls back to UTC instead of throwing", () => {
    expect(parseIcsDateTime("20260115T090000", { TZID: "Bogus/Zone" })).toEqual({
      iso: "2026-01-15T09:00:00.000Z",
      allDay: false,
    });
  });

  test("all-day VALUE=DATE form", () => {
    expect(parseIcsDateTime("20260612", { VALUE: "DATE" })).toEqual({
      iso: "2026-06-12T00:00:00.000Z",
      allDay: true,
    });
  });

  test("garbage returns null", () => {
    expect(parseIcsDateTime("not-a-date", {})).toBeNull();
    expect(parseIcsDateTime("20269999T000000Z", {})).toBeNull();
  });
});

describe("parseIcs", () => {
  test("full event: folded summary, organizer, attendees, dtstart/dtend", () => {
    const ics = wrap([
      "BEGIN:VEVENT",
      "UID:ev-1@example.com",
      "SUMMARY:Quarterly busin",
      " ess review with Acme",
      "DTSTART:20260610T130000Z",
      "DTEND:20260610T140000Z",
      'ORGANIZER;CN="Smith, John":mailto:john@acme.com',
      "ATTENDEE;CN=Bob Jones;ROLE=REQ-PARTICIPANT:mailto:bob@acme.com",
      "ATTENDEE;CN=Ana:mailto:ana@xyz.com",
      "END:VEVENT",
    ]);
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.uid).toBe("ev-1@example.com");
    expect(ev.summary).toBe("Quarterly business review with Acme");
    expect(ev.start).toBe("2026-06-10T13:00:00.000Z");
    expect(ev.end).toBe("2026-06-10T14:00:00.000Z");
    expect(ev.allDay).toBe(false);
    expect(ev.recurring).toBe(false);
    expect(ev.organizer).toEqual({ name: "Smith, John", email: "john@acme.com" });
    expect(ev.attendees).toEqual([
      { name: "Bob Jones", email: "bob@acme.com" },
      { name: "Ana", email: "ana@xyz.com" },
    ]);
  });

  test("TZID event converts to UTC", () => {
    const ics = wrap([
      "BEGIN:VEVENT",
      "UID:tz-1",
      "SUMMARY:NY morning standup",
      "DTSTART;TZID=America/New_York:20260115T090000",
      "DTEND;TZID=America/New_York:20260115T093000",
      "END:VEVENT",
    ]);
    const ev = parseIcs(ics)[0]!;
    expect(ev.start).toBe("2026-01-15T14:00:00.000Z");
    expect(ev.end).toBe("2026-01-15T14:30:00.000Z");
  });

  test("all-day event", () => {
    const ics = wrap([
      "BEGIN:VEVENT",
      "UID:allday-1",
      "SUMMARY:Acme onsite",
      "DTSTART;VALUE=DATE:20260612",
      "DTEND;VALUE=DATE:20260613",
      "END:VEVENT",
    ]);
    const ev = parseIcs(ics)[0]!;
    expect(ev.allDay).toBe(true);
    expect(ev.start).toBe("2026-06-12T00:00:00.000Z");
    expect(ev.end).toBe("2026-06-13T00:00:00.000Z");
  });

  test("malformed VEVENTs are skipped, valid neighbors survive", () => {
    const ics = wrap([
      "BEGIN:VEVENT",
      "SUMMARY:No UID here",
      "DTSTART:20260610T130000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:bad-date",
      "SUMMARY:Broken start",
      "DTSTART:garbage",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:good-1",
      "SUMMARY:Survivor",
      "DTSTART:20260611T100000Z",
      "WEIRD-PROP;;;==:::whatever",
      "END:VEVENT",
    ]);
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    expect(events[0]!.uid).toBe("good-1");
  });

  test("recurring events are flagged, instances taken as-is (no RRULE expansion)", () => {
    const ics = wrap([
      "BEGIN:VEVENT",
      "UID:rec-1",
      "SUMMARY:Weekly sync",
      "DTSTART:20260608T100000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "END:VEVENT",
    ]);
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    expect(events[0]!.recurring).toBe(true);
    expect(events[0]!.start).toBe("2026-06-08T10:00:00.000Z");
  });

  test("escaped text is unescaped", () => {
    const ics = wrap([
      "BEGIN:VEVENT",
      "UID:esc-1",
      "SUMMARY:Demo\\, part 2\\; final",
      "DTSTART:20260610T130000Z",
      "END:VEVENT",
    ]);
    expect(parseIcs(ics)[0]!.summary).toBe("Demo, part 2; final");
  });

  test("never throws on junk input", () => {
    expect(parseIcs("")).toEqual([]);
    expect(parseIcs("complete nonsense\nnot ics at all")).toEqual([]);
    expect(parseIcs("BEGIN:VEVENT\nUID:dangling")).toEqual([]); // no END:VEVENT
  });
});
