/**
 * Dependency-free ICS (RFC 5545) parser, scoped to what calendar intake needs:
 * VEVENT blocks with UID, SUMMARY, DTSTART/DTEND, ORGANIZER, ATTENDEE.
 *
 * Deliberate limits:
 * - Recurring events (RRULE) are NOT expanded. Each VEVENT instance present in
 *   the feed is taken as-is and flagged `recurring: true`. Feeds that only ship
 *   the master event will surface one instance at its DTSTART.
 * - Tolerant by design: malformed VEVENTs are skipped, unknown properties and
 *   unparseable params are ignored. parseIcs never throws on weird input.
 */

export interface IcsPerson {
  name: string | null;
  email: string | null;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  /** ISO 8601 UTC instant. All-day events resolve to midnight UTC of the date. */
  start: string;
  end: string | null;
  allDay: boolean;
  organizer: IcsPerson | null;
  attendees: IcsPerson[];
  /** VEVENT carried an RRULE; instances are taken as-is, no expansion. */
  recurring: boolean;
}

/** Unfold folded lines: CRLF (or LF) followed by a space/tab continues the previous line. */
export function unfoldIcsLines(text: string): string[] {
  const raw = text.split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.length > 0);
}

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Parse one unfolded content line: NAME;PARAM=VAL;PARAM="quoted":value. Null when hopeless. */
export function parsePropLine(line: string): IcsProp | null {
  // Find the first ':' outside double quotes (param values may quote colons).
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  // Split the head on ';' outside quotes: first segment is the name, rest are params.
  const segs: string[] = [];
  let cur = "";
  inQuotes = false;
  for (const c of head) {
    if (c === '"') {
      inQuotes = !inQuotes;
      cur += c;
    } else if (c === ";" && !inQuotes) {
      segs.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  segs.push(cur);

  const name = (segs.shift() ?? "").trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const seg of segs) {
    const eq = seg.indexOf("=");
    if (eq === -1) continue; // tolerate junk params
    const key = seg.slice(0, eq).trim().toUpperCase();
    let val = seg.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (key) params[key] = val;
  }
  return { name, params, value };
}

/** RFC 5545 text unescaping: \n newline, \, \; \\ literals. */
function unescapeText(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Wall-clock offset of an IANA time zone at a given UTC instant, in ms. */
function tzOffsetMs(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0; // some ICU builds render midnight as 24
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - utcMs;
}

/** Convert a wall-clock time in an IANA zone to a UTC epoch ms. Two-pass for DST edges. */
function zonedToUtcMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    guess = wall - tzOffsetMs(timeZone, guess);
  }
  return guess;
}

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/**
 * Parse a DTSTART/DTEND value with its params into a UTC ISO string.
 * Supports: UTC (...Z), TZID=<iana zone>, VALUE=DATE all-day, and floating
 * local time (treated as UTC, tolerant fallback). Returns null if unparseable.
 */
export function parseIcsDateTime(
  value: string,
  params: Record<string, string>,
): { iso: string; allDay: boolean } | null {
  const m = value.trim().match(DT_RE);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;

  const isDateOnly = m[4] === undefined || params["VALUE"]?.toUpperCase() === "DATE";
  if (isDateOnly) {
    const ms = Date.UTC(y, mo - 1, d);
    if (Number.isNaN(ms)) return null;
    return { iso: new Date(ms).toISOString(), allDay: true };
  }

  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  if (h > 23 || mi > 59 || s > 60) return null;

  const tzid = params["TZID"];
  let ms: number;
  if (m[7] === "Z" || !tzid) {
    // UTC, or floating local time treated as UTC (tolerant fallback).
    ms = Date.UTC(y, mo - 1, d, h, mi, s);
  } else {
    try {
      ms = zonedToUtcMs(y, mo, d, h, mi, s, tzid);
    } catch {
      // Unknown TZID (e.g. Windows zone names): fall back to treating as UTC.
      ms = Date.UTC(y, mo - 1, d, h, mi, s);
    }
  }
  if (Number.isNaN(ms)) return null;
  return { iso: new Date(ms).toISOString(), allDay: false };
}

/** Extract {name, email} from an ORGANIZER/ATTENDEE property. */
function parsePerson(prop: IcsProp): IcsPerson {
  const cn = prop.params["CN"];
  const name = cn ? unescapeText(cn).trim() || null : null;
  let email: string | null = null;
  const v = prop.value.trim();
  if (/^mailto:/i.test(v)) email = v.replace(/^mailto:/i, "").trim().toLowerCase() || null;
  else if (v.includes("@")) email = v.toLowerCase();
  return { name, email };
}

function buildEvent(props: IcsProp[]): IcsEvent | null {
  let uid: string | null = null;
  let summary = "";
  let start: { iso: string; allDay: boolean } | null = null;
  let end: { iso: string; allDay: boolean } | null = null;
  let organizer: IcsPerson | null = null;
  const attendees: IcsPerson[] = [];
  let recurring = false;

  for (const p of props) {
    switch (p.name) {
      case "UID":
        uid = p.value.trim() || null;
        break;
      case "SUMMARY":
        summary = unescapeText(p.value).trim();
        break;
      case "DTSTART":
        start = parseIcsDateTime(p.value, p.params);
        break;
      case "DTEND":
        end = parseIcsDateTime(p.value, p.params);
        break;
      case "ORGANIZER":
        organizer = parsePerson(p);
        break;
      case "ATTENDEE":
        attendees.push(parsePerson(p));
        break;
      case "RRULE":
      case "RDATE":
        recurring = true;
        break;
      default:
        break; // ignore everything else
    }
  }

  // Malformed gate: an event without a UID or a parseable start is skipped.
  if (!uid || !start) return null;
  return {
    uid,
    summary: summary || "(untitled event)",
    start: start.iso,
    end: end?.iso ?? null,
    allDay: start.allDay,
    organizer,
    attendees,
    recurring,
  };
}

/** Parse ICS text into events. Skips malformed VEVENTs; never throws. */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  if (typeof text !== "string" || text.length === 0) return events;

  const lines = unfoldIcsLines(text);
  let inEvent = false;
  let props: IcsProp[] = [];

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      inEvent = true;
      props = [];
      continue;
    }
    if (upper === "END:VEVENT") {
      if (inEvent) {
        try {
          const ev = buildEvent(props);
          if (ev) events.push(ev);
        } catch {
          // skip malformed VEVENT
        }
      }
      inEvent = false;
      props = [];
      continue;
    }
    if (!inEvent) continue;
    try {
      const prop = parsePropLine(line);
      if (prop) props.push(prop);
    } catch {
      // tolerate weird property lines
    }
  }
  return events;
}
