export type MeetingPlatform = "teams" | "meet" | "zoom" | "webex" | null;

export interface CalendarEvent {
  summary: string;
  dtstart: Date | null;
  dtend: Date | null;
  location: string;
  description: string;
  organizer: { name: string; email: string } | null;
  attendees: Array<{ name: string; email: string }>;
  status: string;
  uid: string;
  /** RECURRENCE-ID (occurrence d'une serie), "" sinon. */
  recurrenceId?: string;
  allDay: boolean;
  meetingUrl: string | null;
  meetingPlatform: MeetingPlatform;
}

/** Unfold RFC 5545 long lines (CRLF + space/tab continuation) */
function unfold(text: string): string {
  return text.replace(/\r?\n[ \t]/g, "");
}

/** Decode ICS escaped characters */
function decodeValue(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// --- Timezone resolution (TZID + embedded VTIMEZONE) -----------------------
// Outlook/Teams/Google write wall-clock times with a TZID (e.g.
// DTSTART;TZID=W. Europe Standard Time:20260701T110000) and embed the zone in a
// VTIMEZONE block. Ignoring it makes the card display the wrong hour whenever
// the viewer's browser timezone differs from the event's.

interface TzObservance {
  offsetFrom: number;
  offsetTo: number;
  month: number;
  weekday: number;
  nth: number;
  hour: number;
  min: number;
  sec: number;
  hasRule: boolean;
}

type TzTable = Record<string, TzObservance[]>;

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseUtcOffset(s: string): number {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(s.trim());
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/** Parse VTIMEZONE blocks from already-unfolded ICS text. */
function parseVtimezones(unfolded: string): TzTable {
  const table: TzTable = {};
  let inVtz = false;
  let curTzid: string | null = null;
  let obsKind: "STANDARD" | "DAYLIGHT" | null = null;
  let cur: Partial<TzObservance> = {};

  for (const line of unfolded.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const keyPart = line.substring(0, colonIdx);
    const value = line.substring(colonIdx + 1).trim();
    const name = (keyPart.indexOf(";") === -1 ? keyPart : keyPart.substring(0, keyPart.indexOf(";"))).toUpperCase();

    if (name === "BEGIN" && value === "VTIMEZONE") { inVtz = true; curTzid = null; continue; }
    if (name === "END" && value === "VTIMEZONE") { inVtz = false; curTzid = null; continue; }
    if (!inVtz) continue;
    if (name === "TZID" && obsKind === null) {
      curTzid = value;
      if (!table[curTzid]) table[curTzid] = [];
      continue;
    }
    if (name === "BEGIN" && (value === "STANDARD" || value === "DAYLIGHT")) { obsKind = value; cur = {}; continue; }
    if (name === "END" && (value === "STANDARD" || value === "DAYLIGHT")) {
      if (curTzid) {
        table[curTzid].push({
          offsetFrom: cur.offsetFrom ?? 0,
          offsetTo: cur.offsetTo ?? 0,
          month: cur.month ?? 0,
          weekday: cur.weekday ?? 0,
          nth: cur.nth ?? 0,
          hour: cur.hour ?? 0,
          min: cur.min ?? 0,
          sec: cur.sec ?? 0,
          hasRule: cur.hasRule ?? false,
        });
      }
      obsKind = null;
      cur = {};
      continue;
    }
    if (!obsKind) continue;
    switch (name) {
      case "TZOFFSETFROM": cur.offsetFrom = parseUtcOffset(value); break;
      case "TZOFFSETTO": cur.offsetTo = parseUtcOffset(value); break;
      case "DTSTART": {
        const t = /T(\d{2})(\d{2})(\d{2})/.exec(value);
        if (t) { cur.hour = +t[1]; cur.min = +t[2]; cur.sec = +t[3]; }
        break;
      }
      case "RRULE": {
        const byday = /BYDAY=([+-]?\d*)(SU|MO|TU|WE|TH|FR|SA)/.exec(value);
        const bymonth = /BYMONTH=(\d{1,2})/.exec(value);
        if (byday) { cur.nth = byday[1] ? parseInt(byday[1], 10) : 1; cur.weekday = WEEKDAYS[byday[2]]; }
        if (bymonth) cur.month = parseInt(bymonth[1], 10);
        cur.hasRule = true;
        break;
      }
    }
  }
  return table;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  if (nth > 0) {
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - firstDow + 7) % 7) + (nth - 1) * 7;
  }
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7) + (nth + 1) * 7;
}

function observanceOnsetUTC(obs: TzObservance, year: number): number {
  const day = nthWeekdayOfMonth(year, obs.month, obs.weekday, obs.nth);
  const localMs = Date.UTC(year, obs.month - 1, day, obs.hour, obs.min, obs.sec);
  return localMs - obs.offsetFrom * 60000;
}

function offsetAtInstant(observances: TzObservance[], utcMs: number): number {
  const ruled = observances.filter((o) => o.hasRule && o.month >= 1);
  if (ruled.length === 0) {
    return observances.length ? observances[observances.length - 1].offsetTo : 0;
  }
  const year = new Date(utcMs).getUTCFullYear();
  let best: { onset: number; offsetTo: number } | null = null;
  for (const y of [year - 1, year, year + 1]) {
    for (const obs of ruled) {
      const onset = observanceOnsetUTC(obs, y);
      if (onset <= utcMs && (best === null || onset > best.onset)) {
        best = { onset, offsetTo: obs.offsetTo };
      }
    }
  }
  return best ? best.offsetTo : ruled[0].offsetTo;
}

function wallClockToUtcMs(
  Y: number, Mo: number, D: number, H: number, Mi: number, S: number,
  observances: TzObservance[]
): number {
  const wallMs = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  const candidates = Array.from(new Set(observances.map((o) => o.offsetTo)));
  for (const off of candidates) {
    const guess = wallMs - off * 60000;
    if (offsetAtInstant(observances, guess) === off) return guess;
  }
  return wallMs - (candidates[0] ?? 0) * 60000;
}

function ianaOffsetMinutes(timeZone: string, utcMs: number): number | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (t: string) => +(parts.find((p) => p.type === t)?.value ?? "0");
    let hour = get("hour");
    if (hour === 24) hour = 0;
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
    return Math.round((asUtc - utcMs) / 60000);
  } catch {
    return null;
  }
}

function ianaWallClockToUtcMs(
  Y: number, Mo: number, D: number, H: number, Mi: number, S: number,
  timeZone: string
): number | null {
  const wallMs = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  const off = ianaOffsetMinutes(timeZone, wallMs);
  if (off === null) return null;
  let guess = wallMs - off * 60000;
  const off2 = ianaOffsetMinutes(timeZone, guess);
  if (off2 !== null && off2 !== off) guess = wallMs - off2 * 60000;
  return guess;
}

/**
 * Parse an ICS date string to a Date object.
 * Handles: 20250315T100000Z (UTC), TZID=... (zoned), 20250315T100000 (floating),
 * 20250315 (all-day).
 */
function parseIcsDate(
  value: string,
  tzid?: string,
  tzTable?: TzTable
): { date: Date | null; allDay: boolean } {
  const cleaned = value.replace(/[^0-9TZ]/g, "");

  // All-day: YYYYMMDD
  const allDayMatch = cleaned.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (allDayMatch) {
    return {
      date: new Date(+allDayMatch[1], +allDayMatch[2] - 1, +allDayMatch[3]),
      allDay: true,
    };
  }

  // DateTime: YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
  const dtMatch = cleaned.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/
  );
  if (dtMatch) {
    const [, y, m, d, h, min, s, z] = dtMatch;
    if (z) {
      return { date: new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +s)), allDay: false };
    }
    if (tzid) {
      const obs = tzTable?.[tzid];
      if (obs && obs.length) {
        return { date: new Date(wallClockToUtcMs(+y, +m, +d, +h, +min, +s, obs)), allDay: false };
      }
      const ms = ianaWallClockToUtcMs(+y, +m, +d, +h, +min, +s, tzid);
      if (ms !== null) return { date: new Date(ms), allDay: false };
    }
    // Floating time: interpret in the viewer's local timezone.
    return { date: new Date(+y, +m - 1, +d, +h, +min, +s), allDay: false };
  }

  return { date: null, allDay: false };
}

/** Extract CN param and mailto value from ORGANIZER/ATTENDEE */
function parseParticipant(
  params: string,
  value: string
): { name: string; email: string } {
  const cnMatch = params.match(/CN=([^;]*)/i);
  const rawName = cnMatch
    ? decodeValue(cnMatch[1].replace(/^"|"$/g, ""))
    : "";
  const email = value.replace(/^mailto:/i, "").trim();
  return { name: rawName || email, email };
}

/**
 * Parse ICS content string and extract the first VEVENT.
 * Returns null if the content is not valid ICS or contains no VEVENT.
 */
export function parseIcsContent(icsText: string): CalendarEvent | null {
  const unfolded = unfold(icsText);
  const tzTable = parseVtimezones(unfolded);
  const lines = unfolded.split(/\r?\n/);

  // Find first VEVENT block
  let inEvent = false;
  const eventLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === "BEGIN:VEVENT") {
      inEvent = true;
      continue;
    }
    if (line.trim() === "END:VEVENT") {
      break;
    }
    if (inEvent) {
      eventLines.push(line);
    }
  }

  if (eventLines.length === 0) return null;

  const event: CalendarEvent = {
    summary: "",
    dtstart: null,
    dtend: null,
    location: "",
    description: "",
    organizer: null,
    attendees: [],
    status: "",
    uid: "",
    allDay: false,
    meetingUrl: null,
    meetingPlatform: null,
  };

  for (const line of eventLines) {
    // Split on first ':' to get key (with params) and value
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const keyPart = line.substring(0, colonIdx);
    const value = line.substring(colonIdx + 1);

    // Key may have params after ';' (e.g., DTSTART;TZID=Europe/Paris)
    const semiIdx = keyPart.indexOf(";");
    const propName = (
      semiIdx === -1 ? keyPart : keyPart.substring(0, semiIdx)
    ).toUpperCase();
    const params = semiIdx === -1 ? "" : keyPart.substring(semiIdx + 1);

    switch (propName) {
      case "SUMMARY":
        event.summary = decodeValue(value);
        break;
      case "DTSTART": {
        const isValueDate = params.toUpperCase().includes("VALUE=DATE");
        const tzid = params.match(/TZID=([^;]*)/i)?.[1];
        const parsed = parseIcsDate(value, tzid, tzTable);
        event.dtstart = parsed.date;
        event.allDay = isValueDate || parsed.allDay;
        break;
      }
      case "DTEND": {
        const tzid = params.match(/TZID=([^;]*)/i)?.[1];
        const parsed = parseIcsDate(value, tzid, tzTable);
        event.dtend = parsed.date;
        break;
      }
      case "LOCATION":
        event.location = decodeValue(value);
        break;
      case "DESCRIPTION":
        event.description = decodeValue(value);
        break;
      case "ORGANIZER":
        event.organizer = parseParticipant(params, value);
        break;
      case "ATTENDEE":
        event.attendees.push(parseParticipant(params, value));
        break;
      case "STATUS":
        event.status = value.trim().toUpperCase();
        break;
      case "UID":
        event.uid = value.trim();
        break;
      case "RECURRENCE-ID":
        event.recurrenceId = value.trim();
        break;
    }
  }

  // Must have at least a summary or a start date to be considered valid
  if (!event.summary && !event.dtstart) return null;

  // Detect meeting platform URLs
  const meeting = detectMeeting(event.description, event.location);
  if (meeting.url) {
    event.meetingUrl = meeting.url;
    event.meetingPlatform = meeting.platform;
  }

  return event;
}

const MEETING_PATTERNS: Array<{ platform: MeetingPlatform; regex: RegExp }> = [
  { platform: "teams", regex: /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<"\\]+/i },
  { platform: "teams", regex: /https?:\/\/teams\.live\.com\/meet\/[^\s<"\\]+/i },
  { platform: "meet", regex: /https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}[^\s<"\\]*/i },
  { platform: "zoom", regex: /https?:\/\/[\w.-]*zoom\.us\/j\/[^\s<"\\]+/i },
  { platform: "webex", regex: /https?:\/\/[\w.-]*webex\.com\/[\w./-]+\/j\.php[^\s<"\\]*/i },
  { platform: "webex", regex: /https?:\/\/[\w.-]*webex\.com\/meet\/[^\s<"\\]+/i },
];

function detectMeeting(
  description: string,
  location: string
): { url: string; platform: MeetingPlatform } {
  const searchText = `${location}\n${description}`;
  for (const { platform, regex } of MEETING_PATTERNS) {
    const match = searchText.match(regex);
    if (match) {
      return { url: match[0], platform };
    }
  }
  return { url: "", platform: null };
}

/** Filter attachment filenames that are ICS files */
export function getIcsAttachments(attachments: string[]): string[] {
  if (!attachments) return [];
  return attachments.filter((name) => /\.ics$/i.test(name));
}
