import { type ParsedAttachment } from "./parser";
import { handleInvitationEvent } from "./invitations";

export interface IcsPerson {
  email: string;
  name: string;
  /** PARTSTAT (attendee) : NEEDS-ACTION | ACCEPTED | DECLINED | TENTATIVE... */
  partstat?: string;
}

export interface ParsedIcsEvent {
  uid: string;
  title: string;
  description: string;
  location: string;
  start: string; // ISO
  end: string; // ISO
  allDay: boolean;
  /** METHOD du calendrier (REQUEST, CANCEL, REPLY, PUBLISH...), "" si absent. */
  method: string;
  organizer: IcsPerson | null;
  attendees: IcsPerson[];
  sequence: number;
  /** Valeur RECURRENCE-ID (occurrence d'une serie), "" sinon. */
  recurrenceId: string;
  /** Ligne RECURRENCE-ID complete (avec TZID), reprise dans la reponse. */
  rawRecurrenceId: string;
  /** STATUS du VEVENT (CONFIRMED, TENTATIVE, CANCELLED), "" si absent. */
  status: string;
  /** DTSTART / DTEND bruts (repris tels quels dans la reponse iMIP). */
  rawStart: string;
  rawEnd: string;
}

/** Deplie les lignes ICS (continuation = CRLF + espace/tab). */
function unfold(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const out: string[] = [];
  for (const line of normalized.split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): IcsProp | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = left.split(";");
  const name = segments[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < segments.length; i++) {
    const eq = segments[i].indexOf("=");
    if (eq > 0) params[segments[i].slice(0, eq).toUpperCase()] = segments[i].slice(eq + 1);
  }
  return { name, params, value };
}

// --- Resolution de fuseau horaire (TZID) -----------------------------------
// Les invitations Outlook/Teams/Google ecrivent l'heure en heure LOCALE avec un
// TZID (ex: DTSTART;TZID=W. Europe Standard Time:20260701T110000) et embarquent
// la definition du fuseau dans un bloc VTIMEZONE. Sans en tenir compte, le
// worker (conteneur en UTC) interpretait l'heure murale comme de l'UTC -> tous
// les evenements importes decalaient de +1h/+2h selon l'heure d'ete.

interface TzObservance {
  offsetFrom: number; // minutes vs UTC avant la transition
  offsetTo: number; // minutes vs UTC apres la transition
  month: number; // RRULE BYMONTH (1-12 ; 0 si pas de regle)
  weekday: number; // RRULE BYDAY (0=SU..6=SA)
  nth: number; // RRULE BYDAY (+1..+5, -1=dernier)
  hour: number;
  min: number;
  sec: number;
  hasRule: boolean;
}

type TzTable = Record<string, TzObservance[]>;

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** "+0200" -> 120 ; "-0530" -> -330 (minutes). */
function parseUtcOffset(s: string): number {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(s.trim());
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/** Parse les blocs VTIMEZONE d'un ICS -> TZID => observances (STANDARD/DAYLIGHT). */
function parseVtimezones(lines: string[]): TzTable {
  const table: TzTable = {};
  let inVtz = false;
  let curTzid: string | null = null;
  let obsKind: "STANDARD" | "DAYLIGHT" | null = null;
  let cur: Partial<TzObservance> = {};

  for (const line of lines) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value === "VTIMEZONE") {
      inVtz = true;
      curTzid = null;
      continue;
    }
    if (prop.name === "END" && prop.value === "VTIMEZONE") {
      inVtz = false;
      curTzid = null;
      continue;
    }
    if (!inVtz) continue;
    if (prop.name === "TZID" && obsKind === null) {
      curTzid = prop.value.trim();
      if (!table[curTzid]) table[curTzid] = [];
      continue;
    }
    if (prop.name === "BEGIN" && (prop.value === "STANDARD" || prop.value === "DAYLIGHT")) {
      obsKind = prop.value;
      cur = {};
      continue;
    }
    if (prop.name === "END" && (prop.value === "STANDARD" || prop.value === "DAYLIGHT")) {
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
    switch (prop.name) {
      case "TZOFFSETFROM":
        cur.offsetFrom = parseUtcOffset(prop.value);
        break;
      case "TZOFFSETTO":
        cur.offsetTo = parseUtcOffset(prop.value);
        break;
      case "DTSTART": {
        const t = /T(\d{2})(\d{2})(\d{2})/.exec(prop.value);
        if (t) {
          cur.hour = +t[1];
          cur.min = +t[2];
          cur.sec = +t[3];
        }
        break;
      }
      case "RRULE": {
        const byday = /BYDAY=([+-]?\d*)(SU|MO|TU|WE|TH|FR|SA)/.exec(prop.value);
        const bymonth = /BYMONTH=(\d{1,2})/.exec(prop.value);
        if (byday) {
          cur.nth = byday[1] ? parseInt(byday[1], 10) : 1;
          cur.weekday = WEEKDAYS[byday[2]];
        }
        if (bymonth) cur.month = parseInt(bymonth[1], 10);
        cur.hasRule = true;
        break;
      }
    }
  }
  return table;
}

/** Jour du mois (1-31) du n-ieme `weekday` (nth>0) ou du dernier (nth<0). */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  if (nth > 0) {
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - firstDow + 7) % 7) + (nth - 1) * 7;
  }
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7) + (nth + 1) * 7;
}

/** Instant UTC (ms) ou l'observance prend effet l'annee donnee. */
function observanceOnsetUTC(obs: TzObservance, year: number): number {
  const day = nthWeekdayOfMonth(year, obs.month, obs.weekday, obs.nth);
  const localMs = Date.UTC(year, obs.month - 1, day, obs.hour, obs.min, obs.sec);
  return localMs - obs.offsetFrom * 60000; // l'heure murale de transition est en offsetFrom
}

/** Offset (minutes) en vigueur dans le fuseau a l'instant UTC donne. */
function offsetAtInstant(observances: TzObservance[], utcMs: number): number {
  const ruled = observances.filter((o) => o.hasRule && o.month >= 1);
  if (ruled.length === 0) {
    // Fuseau a offset fixe (pas de DST) : derniere observance connue.
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

/** Heure murale (dans le fuseau decrit par `observances`) -> instant UTC ISO. */
function wallClockToUtcIso(
  Y: number,
  Mo: number,
  D: number,
  H: number,
  Mi: number,
  S: number,
  observances: TzObservance[]
): string {
  const wallMs = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  const candidates = Array.from(new Set(observances.map((o) => o.offsetTo)));
  for (const off of candidates) {
    const guess = wallMs - off * 60000;
    if (offsetAtInstant(observances, guess) === off) return new Date(guess).toISOString();
  }
  // Trou/chevauchement de DST : on retombe sur le premier offset connu.
  return new Date(wallMs - (candidates[0] ?? 0) * 60000).toISOString();
}

/** Offset (minutes) d'un fuseau IANA a un instant UTC, via Intl (ICU). null si invalide. */
function ianaOffsetMinutes(timeZone: string, utcMs: number): number | null {
  try {
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
    const get = (t: string) => +(parts.find((p) => p.type === t)?.value ?? "0");
    let hour = get("hour");
    if (hour === 24) hour = 0;
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
    return Math.round((asUtc - utcMs) / 60000);
  } catch {
    return null; // fuseau inconnu d'ICU
  }
}

/** Heure murale dans un fuseau IANA (ex: Europe/Paris) -> instant UTC ISO. null si fuseau inconnu.
 * Exporte pour tracking.ts (echeances extraites des mails = heure murale utilisateur,
 * PAS l'heure du conteneur qui tourne en UTC). */
export function ianaWallClockToUtcIso(
  Y: number,
  Mo: number,
  D: number,
  H: number,
  Mi: number,
  S: number,
  timeZone: string
): string | null {
  const wallMs = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  const off = ianaOffsetMinutes(timeZone, wallMs);
  if (off === null) return null;
  let guess = wallMs - off * 60000;
  const off2 = ianaOffsetMinutes(timeZone, guess);
  if (off2 !== null && off2 !== off) guess = wallMs - off2 * 60000;
  return new Date(guess).toISOString();
}

function icsDateToIso(prop: IcsProp, tzTable: TzTable): { iso: string; allDay: boolean } {
  const v = prop.value.trim();
  const isDate = prop.params.VALUE === "DATE" || /^\d{8}$/.test(v);
  if (isDate) {
    const y = +v.slice(0, 4);
    const mo = +v.slice(4, 6);
    const d = +v.slice(6, 8);
    // Jour entier : ancre a minuit UTC (deterministe quel que soit le fuseau du runtime).
    return { iso: new Date(Date.UTC(y, mo - 1, d, 0, 0, 0)).toISOString(), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) {
    const parsed = new Date(v);
    return { iso: isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString(), allDay: false };
  }
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === "Z") {
    return { iso: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString(), allDay: false };
  }
  const tzid = prop.params.TZID;
  if (tzid) {
    const obs = tzTable[tzid];
    if (obs && obs.length) {
      return { iso: wallClockToUtcIso(+y, +mo, +d, +h, +mi, +s, obs), allDay: false };
    }
    // Pas de VTIMEZONE embarque : tentative via la base IANA d'ICU (ex: Europe/Paris).
    const iso = ianaWallClockToUtcIso(+y, +mo, +d, +h, +mi, +s, tzid);
    if (iso) return { iso, allDay: false };
  }
  // Heure flottante (ni Z ni TZID) : interpretee comme UTC (deterministe).
  return { iso: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString(), allDay: false };
}

function unescape(text: string): string {
  return text
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** "mailto:Foo@Bar.com" -> "foo@bar.com" ; CN="Jean Dupont" -> nom sans guillemets. */
function icsPerson(prop: IcsProp): IcsPerson {
  const email = prop.value.replace(/^mailto:/i, "").trim().toLowerCase();
  const cn = (prop.params.CN || "").replace(/^"|"$/g, "").trim();
  const partstat = (prop.params.PARTSTAT || "").toUpperCase() || undefined;
  return { email, name: cn, ...(partstat ? { partstat } : {}) };
}

/**
 * Decoupe une ligne en respectant les guillemets des parametres
 * (CN="Dupont; Jean" ne doit pas couper au ";").
 */
function parseLineQuoted(line: string): IcsProp | null {
  let inQ = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ":" && !inQ) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments: string[] = [];
  let buf = "";
  inQ = false;
  for (const c of left) {
    if (c === '"') inQ = !inQ;
    if (c === ";" && !inQ) {
      segments.push(buf);
      buf = "";
    } else buf += c;
  }
  segments.push(buf);
  const params: Record<string, string> = {};
  for (let i = 1; i < segments.length; i++) {
    const eq = segments[i].indexOf("=");
    if (eq > 0) params[segments[i].slice(0, eq).toUpperCase()] = segments[i].slice(eq + 1);
  }
  return { name: segments[0].toUpperCase(), params, value };
}

/** Parse les VEVENT d'un blob ICS. Parser minimal (pas de dependance native). */
export function parseIcsEvents(raw: string): ParsedIcsEvent[] {
  const lines = unfold(raw);
  const tzTable = parseVtimezones(lines);
  const events: ParsedIcsEvent[] = [];
  let cur: Partial<ParsedIcsEvent> & { _startProp?: IcsProp; _endProp?: IcsProp } = {};
  let inEvent = false;
  let method = "";

  for (const line of lines) {
    const prop = parseLineQuoted(line) || parseLine(line);
    if (!prop) continue;
    if (!inEvent && prop.name === "METHOD") {
      method = prop.value.trim().toUpperCase();
      continue;
    }
    if (prop.name === "BEGIN" && prop.value === "VEVENT") {
      inEvent = true;
      cur = { attendees: [] };
      continue;
    }
    if (prop.name === "END" && prop.value === "VEVENT") {
      inEvent = false;
      if (cur._startProp) {
        const start = icsDateToIso(cur._startProp, tzTable);
        let end: { iso: string; allDay: boolean };
        if (cur._endProp) {
          end = icsDateToIso(cur._endProp, tzTable);
        } else if (start.allDay) {
          const s = new Date(start.iso);
          s.setDate(s.getDate() + 1);
          end = { iso: s.toISOString(), allDay: true };
        } else {
          end = { iso: new Date(new Date(start.iso).getTime() + 3600_000).toISOString(), allDay: false };
        }
        events.push({
          uid: cur.uid || `${start.iso}-${cur.title || ""}`,
          title: cur.title || "(no title)",
          description: cur.description || "",
          location: cur.location || "",
          start: start.iso,
          end: end.iso,
          allDay: start.allDay,
          method,
          organizer: cur.organizer || null,
          attendees: cur.attendees || [],
          sequence: cur.sequence || 0,
          recurrenceId: cur.recurrenceId || "",
          rawRecurrenceId: cur.rawRecurrenceId || "",
          status: cur.status || "",
          rawStart: cur.rawStart || "",
          rawEnd: cur.rawEnd || "",
        });
      }
      continue;
    }
    if (!inEvent) continue;

    switch (prop.name) {
      case "UID":
        cur.uid = prop.value.trim();
        break;
      case "SUMMARY":
        cur.title = unescape(prop.value).trim();
        break;
      case "DESCRIPTION":
        cur.description = unescape(prop.value).trim();
        break;
      case "LOCATION":
        cur.location = unescape(prop.value).trim();
        break;
      case "DTSTART":
        cur._startProp = prop;
        cur.rawStart = line;
        break;
      case "DTEND":
        cur._endProp = prop;
        cur.rawEnd = line;
        break;
      case "ORGANIZER":
        cur.organizer = icsPerson(prop);
        break;
      case "ATTENDEE":
        (cur.attendees ||= []).push(icsPerson(prop));
        break;
      case "SEQUENCE":
        cur.sequence = parseInt(prop.value, 10) || 0;
        break;
      case "RECURRENCE-ID":
        cur.recurrenceId = prop.value.trim();
        cur.rawRecurrenceId = line.trim();
        break;
      case "STATUS":
        cur.status = prop.value.trim().toUpperCase();
        break;
    }
  }

  return events;
}

function isCalendarAttachment(att: ParsedAttachment): boolean {
  const ct = (att.contentType || "").toLowerCase();
  const fn = (att.filename || "").toLowerCase();
  return ct.includes("calendar") || ct.includes("ics") || fn.endsWith(".ics");
}

export interface IcsImportContext {
  /** Compte qui a recu le mail (sa boite sert a repondre). */
  accountId?: string;
  accountEmail?: string;
  /** Toutes les adresses de l'utilisateur (alias, comptes relies). */
  selfEmails?: string[];
  messageId?: string;
  threadId?: string;
  /** Mail entrant en direct : autorise la notification "Nouvelle invitation". */
  notify?: boolean;
}

/**
 * Importe les invitations (.ics) d'un email recu dans l'Agenda (groupe
 * "Invitations", source=email). Une INVITATION (METHOD:REQUEST d'un autre
 * organisateur) arrive "a repondre" (tentative + needs_action), jamais
 * confirmee d'office ; une SEQUENCE superieure la met a jour ; METHOD:CANCEL
 * l'annule ; METHOD:REPLY met a jour la reponse d'un invite. Un .ics sans
 * organisateur (reservation, billet) reste importe tel quel (confirme).
 * Dedup par UID (+ occurrence) : partage avec la synchro Google (iCalUID).
 */
export async function importIcsFromEmail(
  userId: string,
  attachments: ParsedAttachment[],
  ctx: IcsImportContext = {}
): Promise<void> {
  const icsAtts = attachments.filter(isCalendarAttachment);
  if (icsAtts.length === 0) return;

  for (const att of icsAtts) {
    let events: ParsedIcsEvent[];
    try {
      events = parseIcsEvents(att.content.toString("utf8"));
    } catch (err) {
      console.error("[ics] parse failed:", err);
      continue;
    }
    for (const ev of events) {
      try {
        await handleInvitationEvent(userId, ev, ctx);
      } catch (err) {
        console.error("[ics] import failed:", err);
      }
    }
  }
}
