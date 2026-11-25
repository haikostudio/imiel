import { getValidAccessToken } from "./oauth";
import { type PBAccount, type PBCalendarEvent } from "./pocketbase";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendarScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleCalendarScopeError";
  }
}

export interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  backgroundColor?: string;
  primary?: boolean;
  accessRole?: string;
}

export interface GoogleEventDate {
  date?: string; // all-day (YYYY-MM-DD, end exclusive)
  dateTime?: string; // timed (RFC3339)
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string; // confirmed | tentative | cancelled
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventDate;
  end?: GoogleEventDate;
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string; self?: boolean; organizer?: boolean }>;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  iCalUID?: string;
  recurringEventId?: string;
  sequence?: number;
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
}

/** responseStatus Google -> invitation_status iMiel. */
export function invitationStatusFromGoogle(rs?: string): "needs_action" | "accepted" | "declined" | "tentative" | "" {
  if (rs === "needsAction") return "needs_action";
  if (rs === "accepted") return "accepted";
  if (rs === "declined") return "declined";
  if (rs === "tentative") return "tentative";
  return "";
}

async function googleFetch(
  account: PBAccount,
  path: string,
  options: { method?: string; body?: unknown; params?: Record<string, string> } = {}
): Promise<{ status: number; data: unknown }> {
  const token = await getValidAccessToken(account);
  let url = `${CAL_BASE}${path}`;
  if (options.params) {
    url += `?${new URLSearchParams(options.params).toString()}`;
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const res = await fetch(url, { method: options.method || "GET", headers, body });

  if (res.status === 403) {
    const text = await res.text();
    if (text.includes("insufficient") || text.includes("Insufficient") || text.includes("ACCESS_TOKEN_SCOPE")) {
      throw new GoogleCalendarScopeError(
        `Google Calendar access denied for ${account.email}: reconnect the account to grant Calendar permission.`
      );
    }
    throw new Error(`Google Calendar ${path} failed: 403 - ${text}`);
  }

  if (res.status === 204) return { status: 204, data: null };

  const data = res.status === 200 || res.status === 410 ? await res.json().catch(() => null) : await res.text();
  if (!res.ok && res.status !== 410) {
    throw new Error(`Google Calendar ${options.method || "GET"} ${path} failed: ${res.status} - ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return { status: res.status, data };
}

/** Liste les agendas accessibles (primary + agendas partages, ex celui d'Annie). */
export async function listCalendars(account: PBAccount): Promise<GoogleCalendarListEntry[]> {
  const out: GoogleCalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = { maxResults: "250", showHidden: "false" };
    if (pageToken) params.pageToken = pageToken;
    const { data } = await googleFetch(account, "/users/me/calendarList", { params });
    const d = data as { items?: GoogleCalendarListEntry[]; nextPageToken?: string };
    for (const it of d.items || []) out.push(it);
    pageToken = d.nextPageToken;
  } while (pageToken);
  return out;
}

export interface PullResult {
  events: GoogleEvent[];
  nextSyncToken: string | null;
  needsFullResync: boolean;
}

/**
 * Tire les events d'un agenda. Incremental si `syncToken`, sinon plein (borne
 * ~13 mois en arriere). `singleEvents=true` -> les recurrents sont expanses en
 * occurrences (chacune avec son id Google) : pas d'expanseur RRULE a ecrire.
 */
export async function pullEvents(
  account: PBAccount,
  calendarId: string,
  syncToken?: string | null
): Promise<PullResult> {
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  const encId = encodeURIComponent(calendarId);

  do {
    const params: Record<string, string> = {
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "2500",
    };
    if (syncToken) {
      params.syncToken = syncToken;
    } else {
      const min = new Date();
      min.setMonth(min.getMonth() - 13);
      params.timeMin = min.toISOString();
    }
    if (pageToken) params.pageToken = pageToken;

    const { status, data } = await googleFetch(account, `/calendars/${encId}/events`, { params });
    if (status === 410) {
      // syncToken perime -> resync complet demande par l'appelant.
      return { events: [], nextSyncToken: null, needsFullResync: true };
    }
    const d = data as { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
    for (const it of d.items || []) events.push(it);
    pageToken = d.nextPageToken;
    if (d.nextSyncToken) nextSyncToken = d.nextSyncToken;
  } while (pageToken);

  return { events, nextSyncToken, needsFullResync: false };
}

function ymd(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Mappe un PBCalendarEvent vers une ressource Google Calendar. */
export function toGoogleResource(event: Partial<PBCalendarEvent>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: event.title || "",
    description: event.description || "",
    location: event.location || "",
  };
  // Invitation pas encore acceptee : "a confirmer" chez Google aussi.
  if (event.status === "tentative" || event.status === "confirmed") body.status = event.status;
  // On annule explicitement le champ oppose (date<->dateTime) : un PATCH Google
  // FUSIONNE les champs, donc basculer all-day <-> time sans nuller l'ancien
  // laisse les deux presents => 400 "Invalid start time".
  if (event.all_day) {
    body.start = { date: ymd(event.start as string), dateTime: null };
    body.end = { date: ymd(event.end as string), dateTime: null };
  } else {
    body.start = { dateTime: new Date(event.start as string).toISOString(), date: null };
    body.end = { dateTime: new Date(event.end as string).toISOString(), date: null };
  }
  return body;
}

/** Mappe une ressource Google vers les champs PBCalendarEvent (sans user/group). */
export function fromGoogleEvent(g: GoogleEvent, calendarId: string): Partial<PBCalendarEvent> {
  const allDay = !!g.start?.date;
  let start: string;
  let end: string;
  if (allDay) {
    // Ancre les bornes all-day a minuit UTC (suffixe Z) pour rester
    // independant du fuseau du serveur ; la fin reste exclusive (Google).
    start = new Date(`${g.start?.date}T00:00:00Z`).toISOString();
    end = new Date(`${g.end?.date}T00:00:00Z`).toISOString();
  } else {
    start = g.start?.dateTime ? new Date(g.start.dateTime).toISOString() : new Date().toISOString();
    end = g.end?.dateTime ? new Date(g.end.dateTime).toISOString() : start;
  }
  const attendees = (g.attendees || []).map((a) => ({
    name: a.displayName,
    email: a.email || "",
    status: a.responseStatus,
  }));
  // Invitation recue (organisateur != soi) : notre reponse Google = etat de
  // l'invitation. iCalUID partage avec l'import .ics du mail (un seul evenement).
  const selfAttendee = (g.attendees || []).find((a) => a.self);
  const isInvitation = !!g.organizer && !g.organizer.self && !!selfAttendee;
  const invitation: Partial<PBCalendarEvent> = isInvitation
    ? {
        invitation_status: invitationStatusFromGoogle(selfAttendee?.responseStatus),
        organizer_email: (g.organizer?.email || "").toLowerCase(),
        organizer_name: g.organizer?.displayName || "",
        attendee_email: (selfAttendee?.email || "").toLowerCase(),
        ics_sequence: g.sequence || 0,
      }
    : {};
  let status = (g.status as PBCalendarEvent["status"]) || "confirmed";
  if (isInvitation) {
    const inv = invitation.invitation_status;
    status = inv === "accepted" ? "confirmed" : inv === "declined" ? "cancelled" : "tentative";
  }
  return {
    title: g.summary || "(no title)",
    description: g.description || "",
    location: g.location || "",
    start,
    end,
    all_day: allDay,
    source: "google",
    google_event_id: g.id,
    google_calendar_id: calendarId,
    etag: g.etag || "",
    attendees,
    status,
    ...(g.iCalUID && !g.recurringEventId ? { ics_uid: g.iCalUID } : {}),
    ...invitation,
  };
}

/** Cle privee posee sur chaque evenement que nous creons chez Google : id iMiel. */
export const IMIEL_PROP = "imielId";

export async function pushEvent(
  account: PBAccount,
  calendarId: string,
  event: Partial<PBCalendarEvent>
): Promise<{ id: string; etag: string }> {
  const encId = encodeURIComponent(calendarId);
  const body = toGoogleResource(event);
  if (event.id) body.extendedProperties = { private: { [IMIEL_PROP]: event.id } };
  const { data } = await googleFetch(account, `/calendars/${encId}/events`, {
    method: "POST",
    body,
  });
  const g = data as GoogleEvent;
  return { id: g.id, etag: g.etag || "" };
}

export async function patchEvent(
  account: PBAccount,
  calendarId: string,
  googleEventId: string,
  event: Partial<PBCalendarEvent>
): Promise<{ id: string; etag: string }> {
  const encId = encodeURIComponent(calendarId);
  const { data } = await googleFetch(
    account,
    `/calendars/${encId}/events/${encodeURIComponent(googleEventId)}`,
    { method: "PATCH", body: toGoogleResource(event) }
  );
  const g = data as GoogleEvent;
  return { id: g.id, etag: g.etag || "" };
}

/**
 * Repond a une invitation dans Google Agenda : notre ligne d'invite (self)
 * prend la reponse, et Google previent l'organisateur (sendUpdates=all). Seul
 * chemin de reponse pour un evenement Google : pas de mail iMIP en plus.
 */
export async function respondGoogleInvitation(
  account: PBAccount,
  calendarId: string,
  googleEventId: string,
  response: "accepted" | "declined" | "tentative"
): Promise<{ etag: string }> {
  const encId = encodeURIComponent(calendarId);
  const path = `/calendars/${encId}/events/${encodeURIComponent(googleEventId)}`;
  const { data } = await googleFetch(account, path);
  const g = data as GoogleEvent;
  const attendees = (g.attendees || []).map((a) => (a.self ? { ...a, responseStatus: response } : a));
  if (!attendees.some((a) => a.self)) {
    throw new Error("not an attendee of this Google event");
  }
  const res = await googleFetch(account, path, {
    method: "PATCH",
    params: { sendUpdates: "all" },
    body: { attendees },
  });
  return { etag: ((res.data as GoogleEvent) || {}).etag || "" };
}

export async function deleteGoogleEvent(
  account: PBAccount,
  calendarId: string,
  googleEventId: string
): Promise<void> {
  const encId = encodeURIComponent(calendarId);
  await googleFetch(account, `/calendars/${encId}/events/${encodeURIComponent(googleEventId)}`, {
    method: "DELETE",
  }).catch((err) => {
    // 410/404 = deja supprime cote Google : on ignore.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("410") && !msg.includes("404")) throw err;
  });
}


// --- Agendas et rattrapage (synchronisation complete avec Google) -----------

/** Cree un agenda Google (proprietaire = le compte). */
export async function insertCalendar(account: PBAccount, summary: string): Promise<string> {
  const { data } = await googleFetch(account, "/calendars", {
    method: "POST",
    body: { summary, timeZone: "Europe/Paris" },
  });
  return (data as { id: string }).id;
}

/** Couleur d'un agenda dans la liste du compte (format #rrggbb). */
export async function patchCalendarColor(account: PBAccount, calendarId: string, color: string): Promise<void> {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  await googleFetch(account, `/users/me/calendarList/${encodeURIComponent(calendarId)}`, {
    method: "PATCH",
    params: { colorRgbFormat: "true" },
    body: { backgroundColor: color, foregroundColor: "#ffffff" },
  });
}

/** Supprime un agenda dont le compte est PROPRIETAIRE (et tous ses evenements). */
export async function deleteCalendar(account: PBAccount, calendarId: string): Promise<void> {
  await googleFetch(account, `/calendars/${encodeURIComponent(calendarId)}`, { method: "DELETE" }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("404") && !msg.includes("410")) throw err;
  });
}

/** Retire un agenda partage de la liste du compte (rien n'est efface chez son proprietaire). */
export async function removeCalendarFromList(account: PBAccount, calendarId: string): Promise<void> {
  await googleFetch(account, `/users/me/calendarList/${encodeURIComponent(calendarId)}`, { method: "DELETE" }).catch(
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("404") && !msg.includes("410")) throw err;
    }
  );
}

/**
 * Importe une copie privee d'un evenement venu d'un .ics en GARDANT son iCalUID :
 * re-importer le meme UID met a jour l'evenement au lieu d'en creer un second
 * (rattrapage rejouable sans doublon).
 */
export async function importEvent(
  account: PBAccount,
  calendarId: string,
  iCalUID: string,
  event: Partial<PBCalendarEvent>
): Promise<{ id: string; etag: string }> {
  const body = toGoogleResource(event);
  body.iCalUID = iCalUID;
  if (event.id) body.extendedProperties = { private: { [IMIEL_PROP]: event.id } };
  // Pas de champ date/dateTime a null en import (refuse) : on retire l'oppose.
  for (const k of ["start", "end"]) {
    const v = body[k] as Record<string, unknown>;
    for (const f of Object.keys(v)) if (v[f] === null) delete v[f];
  }
  const { data } = await googleFetch(account, `/calendars/${encodeURIComponent(calendarId)}/events/import`, {
    method: "POST",
    body,
  });
  const g = data as GoogleEvent;
  return { id: g.id, etag: g.etag || "" };
}

/** Evenement que NOUS avons deja cree pour cet id iMiel (reprise apres coupure). */
export async function findEventByImielId(
  account: PBAccount,
  calendarId: string,
  imielId: string
): Promise<GoogleEvent | null> {
  const { data } = await googleFetch(account, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    params: { privateExtendedProperty: `${IMIEL_PROP}=${imielId}`, maxResults: "5", showDeleted: "false" },
  });
  const items = ((data as { items?: GoogleEvent[] }) || {}).items || [];
  return items.find((e) => e.status !== "cancelled") || null;
}

/** Deplace un evenement d'un agenda a un autre (meme compte), id et invitations gardes. */
export async function moveEvent(
  account: PBAccount,
  calendarId: string,
  googleEventId: string,
  destinationCalendarId: string
): Promise<{ id: string; etag: string }> {
  const { data } = await googleFetch(
    account,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}/move`,
    { method: "POST", params: { destination: destinationCalendarId } }
  );
  const g = data as GoogleEvent;
  return { id: g.id, etag: g.etag || "" };
}
