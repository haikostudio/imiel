/**
 * Invitations d'agenda : arrivee (mail .ics ou synchro Google), notification
 * "Nouvelle invitation" avec conflit d'horaire, et REPONSE a l'organisateur.
 *
 * Un seul chemin de reponse par evenement (pas de double reponse) :
 *   - invitation NEE chez Google (google_event_id, pas google_pushed) -> on
 *     modifie NOTRE ligne d'invite chez Google, qui previent l'organisateur
 *     (sendUpdates=all) ;
 *   - sinon -> mail iMIP METHOD:REPLY depuis l'adresse invitee exacte. Une copie
 *     que NOUS avons envoyee chez Google (invitation recue hors Gmail) suit la
 *     reponse : confirmee si acceptee, effacee de Google si refusee.
 *
 * Arrivee (decision 2026-11-24) : dans l'agenda PAR DEFAUT (Chris). Recue sur la
 * boite Gmail du compte relie -> jamais envoyee (Google l'ajoute lui-meme, la
 * synchro la rattache par iCalUID) ; recue ailleurs -> envoyee chez Google des
 * reception, "a confirmer".
 * Un seul evenement par invitation : cle = UID (+ RECURRENCE-ID), partagee
 * avec l'iCalUID de la synchro Google (calendar-sync.ts fusionne).
 */
import type { ParsedIcsEvent, IcsImportContext } from "./ics";
import {
  createCalendarEvent,
  getDefaultCalendarGroup,
  findCalendarEventByIcsUid,
  getAccount,
  getCalendarEvent,
  getCalendarGroup,
  listOverlappingCalendarEvents,
  updateCalendarEvent,
  type PBCalendarEvent,
} from "./pocketbase";
import { respondGoogleInvitation } from "./google-calendar";
import { deleteEventFromGoogle, isGoogleOAuthAccount, patchEventOnGoogle, pushEventQuietly } from "./calendar-google";
import { sendCalendarReply } from "./smtp";
import { sendInvitationNotification } from "./push";

export type InvitationResponse = "accepted" | "declined" | "tentative";
type InvitationStatus = "needs_action" | "accepted" | "declined" | "tentative";

const TZ = "Europe/Paris";

export function invitationKey(ev: { uid: string; recurrenceId?: string }): string {
  return ev.recurrenceId ? `${ev.uid}#${ev.recurrenceId}` : ev.uid;
}

export function statusFromPartstat(partstat?: string): InvitationStatus {
  switch ((partstat || "").toUpperCase()) {
    case "ACCEPTED":
      return "accepted";
    case "DECLINED":
      return "declined";
    case "TENTATIVE":
      return "tentative";
    default:
      return "needs_action";
  }
}

export function eventStatusFor(inv: InvitationStatus | ""): PBCalendarEvent["status"] {
  if (inv === "accepted") return "confirmed";
  if (inv === "declined") return "cancelled";
  return "tentative";
}

/** "mar. 25 nov. · 11:20–12:00" (heure de Paris). */
export function formatInvitationWhen(startIso: string, endIso: string, allDay: boolean): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const day = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(s);
  if (allDay) return `${day} · toute la journee`;
  const hm = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);
  return `${day} · ${hm(s)}–${hm(e)}`;
}

/** Ligne de conflit : "Chevauche 11:20 Coiffeur" / "Aucun autre rendez-vous a cette heure-la". */
export async function conflictLine(
  userId: string,
  startIso: string,
  endIso: string,
  allDay: boolean,
  excludeId?: string,
  excludeKey?: string
): Promise<string> {
  if (allDay) return "";
  try {
    const others = (await listOverlappingCalendarEvents(userId, startIso, endIso, excludeId)).filter(
      (o) => !excludeKey || o.ics_uid !== excludeKey
    );
    if (others.length === 0) return "Aucun autre rendez-vous a cette heure-la";
    const o = others[0];
    const hm = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(o.start));
    return `Chevauche ${hm} ${o.title}`.slice(0, 120);
  } catch {
    return "";
  }
}

function inboxUrl(ctx: IcsImportContext): string {
  return ctx.threadId && ctx.messageId
    ? `/#/mail/all?t=${encodeURIComponent(ctx.threadId)}&m=${encodeURIComponent(ctx.messageId)}`
    : "/#/calendar";
}

async function notify(
  userId: string,
  event: Pick<PBCalendarEvent, "id" | "title" | "start" | "end" | "all_day" | "ics_uid" | "organizer_name" | "organizer_email">,
  kind: "new" | "updated" | "cancelled",
  ctx: IcsImportContext
): Promise<void> {
  const when = formatInvitationWhen(event.start, event.end, event.all_day);
  const conflict =
    kind === "cancelled" ? "" : await conflictLine(userId, event.start, event.end, event.all_day, event.id, event.ics_uid);
  await sendInvitationNotification(userId, {
    eventId: event.id,
    kind,
    title: event.title,
    organizer: event.organizer_name || event.organizer_email || "",
    when,
    conflict,
    url: inboxUrl(ctx),
  }).catch((err) => console.warn("[invitation] push failed:", (err as Error).message));
}

/**
 * Invitation recue sur la boite d'un compte Google relie : Google Agenda
 * l'ajoute lui-meme a l'agenda principal (la synchro la rattache par iCalUID),
 * on ne l'envoie donc jamais nous-memes (sinon deux exemplaires chez Google).
 */
async function receivedOnLinkedGmail(ctx: IcsImportContext): Promise<boolean> {
  if (!ctx.accountId) return false;
  try {
    return isGoogleOAuthAccount(await getAccount(ctx.accountId));
  } catch {
    return false;
  }
}

/** Retire de Google la copie que NOUS y avions envoyee (refus, annulation). */
async function dropPushedCopy(ev: PBCalendarEvent): Promise<Partial<PBCalendarEvent>> {
  if (!ev.google_pushed || !ev.google_event_id) return {};
  try {
    await deleteEventFromGoogle(ev);
    return { google_event_id: "", google_calendar_id: "", etag: "", google_pushed: false };
  } catch (err) {
    console.warn("[invitation] retrait Google echoue:", (err as Error).message);
    return {};
  }
}

/** Traite UN evenement d'un .ics recu par mail. */
export async function handleInvitationEvent(
  userId: string,
  ev: ParsedIcsEvent,
  ctx: IcsImportContext
): Promise<void> {
  const self = new Set(
    [...(ctx.selfEmails || []), ctx.accountEmail || ""].map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
  const key = invitationKey(ev);
  const existing = await findCalendarEventByIcsUid(userId, key);
  const organizerIsSelf = !!ev.organizer && self.has(ev.organizer.email);
  const me = ev.attendees.find((a) => self.has(a.email)) || null;

  // --- Annulation par l'organisateur -------------------------------------
  if (ev.method === "CANCEL" || (ev.status === "CANCELLED" && !!existing)) {
    if (existing && existing.status !== "cancelled") {
      await updateCalendarEvent(existing.id, { status: "cancelled", ...(await dropPushedCopy(existing)) });
      if (ctx.notify && existing.invitation_status) await notify(userId, existing, "cancelled", ctx);
    }
    return;
  }

  // --- Reponse d'un invite a NOTRE invitation -----------------------------
  if (ev.method === "REPLY") {
    if (existing && ev.attendees.length > 0) {
      const byEmail = new Map(ev.attendees.map((a) => [a.email, a]));
      const attendees = (existing.attendees || []).map((a) => {
        const r = byEmail.get((a.email || "").toLowerCase());
        return r?.partstat ? { ...a, status: r.partstat.toLowerCase() } : a;
      });
      await updateCalendarEvent(existing.id, { attendees });
    }
    return;
  }

  const isInvitation =
    !!ev.organizer && !organizerIsSelf && (ev.method === "REQUEST" || (!ev.method && ev.attendees.length > 0));

  if (!isInvitation) {
    // Reservation / billet / PUBLISH : rendez-vous lu dans le mail, range dans
    // l'agenda par defaut et envoye chez Google.
    if (existing) return;
    const group = await getDefaultCalendarGroup(userId);
    const booked = await createCalendarEvent({
      user: userId,
      group: group.id,
      title: ev.title,
      description: ev.description,
      location: ev.location,
      start: ev.start,
      end: ev.end,
      all_day: ev.allDay,
      source: "email",
      ics_uid: key,
      status: "confirmed",
    });
    await pushEventQuietly(booked);
    return;
  }

  const invitationStatus = statusFromPartstat(me?.partstat);
  const fields: Partial<PBCalendarEvent> = {
    title: ev.title,
    description: ev.description,
    location: ev.location,
    start: ev.start,
    end: ev.end,
    all_day: ev.allDay,
    organizer_email: ev.organizer?.email || "",
    organizer_name: ev.organizer?.name || "",
    attendee_email: me?.email || (ctx.accountEmail || "").toLowerCase(),
    ics_sequence: ev.sequence,
    ics_recurrence_id: ev.rawRecurrenceId,
    attendees: ev.attendees.map((a) => ({ name: a.name, email: a.email, status: (a.partstat || "").toLowerCase() })),
    ...(ctx.accountId ? { account: ctx.accountId } : {}),
    ...(ctx.messageId ? { message: ctx.messageId } : {}),
  };

  if (existing) {
    const prevSeq = existing.ics_sequence || 0;
    if (ev.sequence < prevSeq) return; // invitation perimee
    const firstMail = !existing.message;
    if (ev.sequence === prevSeq && existing.invitation_status && !firstMail) return; // meme invitation (copie sur un autre compte)
    const moved =
      new Date(existing.start).getTime() !== new Date(ev.start).getTime() ||
      new Date(existing.end).getTime() !== new Date(ev.end).getTime();
    // Evenement deja synchronise depuis Google : Google fait foi sur l'horaire
    // et la reponse ; on complete seulement ce qui sert a repondre et a ouvrir le mail.
    const patch: Partial<PBCalendarEvent> =
      existing.source === "google"
        ? {
            organizer_email: fields.organizer_email,
            organizer_name: fields.organizer_name,
            attendee_email: existing.attendee_email || fields.attendee_email,
            ...(ctx.accountId && !existing.account ? { account: ctx.accountId } : {}),
            ...(ctx.messageId ? { message: ctx.messageId } : {}),
            invitation_status: existing.invitation_status || invitationStatus,
          }
        : {
            ...fields,
            invitation_status: invitationStatus,
            status: eventStatusFor(invitationStatus),
            ...(moved ? { reminders_sent: [] } : {}),
          };
    const updated = await updateCalendarEvent(existing.id, patch);
    // Copie envoyee par nous chez Google : elle suit l'horaire et le titre.
    if (existing.google_pushed && existing.google_event_id) {
      await patchEventOnGoogle({ ...existing, ...updated }).catch((err) =>
        console.warn("[invitation] mise a jour Google echouee:", (err as Error).message)
      );
    }
    const inv = (patch.invitation_status || existing.invitation_status) as InvitationStatus;
    if (ctx.notify && inv === "needs_action" && (firstMail || moved)) {
      await notify(userId, { ...existing, ...updated }, firstMail ? "new" : "updated", ctx);
    }
    return;
  }

  const group = await getDefaultCalendarGroup(userId);
  const created = await createCalendarEvent({
    ...fields,
    user: userId,
    group: group.id,
    source: "email",
    ics_uid: key,
    invitation_status: invitationStatus,
    status: eventStatusFor(invitationStatus),
    no_push: await receivedOnLinkedGmail(ctx),
  });
  if (!created.no_push) await pushEventQuietly(created);
  console.log(`[invitation] ${invitationStatus} "${ev.title}" de ${ev.organizer?.email} (${key})`);
  if (ctx.notify && invitationStatus === "needs_action") {
    await notify(userId, created, "new", ctx);
  }
}

// ---------------------------------------------------------------------------
// Reponse
// ---------------------------------------------------------------------------

function icsDate(iso: string, allDay: boolean): string {
  const d = new Date(iso);
  if (allDay) return d.toISOString().slice(0, 10).replace(/-/g, "");
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsEscape(text: string): string {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsQuote(name: string): string {
  return `"${String(name || "").replace(/"/g, "'")}"`;
}

const PARTSTAT: Record<InvitationResponse, string> = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
};

/** Corps iMIP METHOD:REPLY (RFC 6047) : meme UID, meme SEQUENCE, notre PARTSTAT. */
export function buildReplyIcs(
  ev: Pick<
    PBCalendarEvent,
    "ics_uid" | "ics_recurrence_id" | "ics_sequence" | "start" | "end" | "all_day" | "title" | "organizer_email" | "organizer_name" | "attendee_email"
  >,
  response: InvitationResponse,
  attendeeName: string,
  now: Date = new Date()
): string {
  const uid = (ev.ics_uid || "").split("#")[0];
  const dateParam = ev.all_day ? ";VALUE=DATE" : "";
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//iMiel//Invitations//FR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    ...(ev.ics_recurrence_id
      ? [/^RECURRENCE-ID[;:]/i.test(ev.ics_recurrence_id) ? ev.ics_recurrence_id : `RECURRENCE-ID:${ev.ics_recurrence_id}`]
      : []),
    `SEQUENCE:${ev.ics_sequence || 0}`,
    `DTSTAMP:${icsDate(now.toISOString(), false)}`,
    `DTSTART${dateParam}:${icsDate(ev.start, ev.all_day)}`,
    `DTEND${dateParam}:${icsDate(ev.end, ev.all_day)}`,
    `SUMMARY:${icsEscape(ev.title)}`,
    `ORGANIZER${ev.organizer_name ? `;CN=${icsQuote(ev.organizer_name)}` : ""}:mailto:${ev.organizer_email}`,
    `ATTENDEE;PARTSTAT=${PARTSTAT[response]}${attendeeName ? `;CN=${icsQuote(attendeeName)}` : ""}:mailto:${ev.attendee_email}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

const SUBJECT_PREFIX: Record<InvitationResponse, string> = {
  accepted: "Accepte",
  declined: "Refuse",
  tentative: "Provisoire",
};

export class InvitationError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Repond a une invitation au nom de `userId` (deja AUTHENTIFIE par l'appelant :
 * jeton PocketBase ou cle d'appareil signee). Verifie la propriete.
 */
export async function respondToInvitation(
  userId: string,
  eventId: string,
  response: InvitationResponse
): Promise<{ event: PBCalendarEvent; sentVia: "google" | "email" }> {
  let ev: PBCalendarEvent;
  try {
    ev = await getCalendarEvent(eventId);
  } catch {
    throw new InvitationError(404, "event not found");
  }
  if (ev.user !== userId) throw new InvitationError(403, "event not owned by user");
  if (!ev.invitation_status || !ev.organizer_email) throw new InvitationError(400, "not an invitation");

  let sentVia: "google" | "email";
  // Copie envoyee PAR NOUS chez Google : Google ne connait pas l'organisateur,
  // un PATCH de notre ligne d'invite repondrait a... nous. Reponse en iMIP.
  if (ev.google_event_id && ev.google_calendar_id && !ev.google_pushed) {
    const group = await getCalendarGroup(ev.group);
    if (!group.account) throw new InvitationError(409, "google calendar without account");
    const account = await getAccount(group.account);
    await respondGoogleInvitation(account, ev.google_calendar_id, ev.google_event_id, response);
    sentVia = "google";
  } else {
    if (!ev.account) throw new InvitationError(409, "no mailbox to reply from");
    const account = await getAccount(ev.account);
    if (account.user !== userId) throw new InvitationError(403, "account not owned by user");
    const fromAddr = (ev.attendee_email || account.email).toLowerCase();
    const name = account.display_name || account.label || "";
    await sendCalendarReply(account, {
      from: fromAddr,
      fromName: name,
      to: ev.organizer_email,
      subject: `${SUBJECT_PREFIX[response]} : ${ev.title}`,
      text:
        response === "accepted"
          ? `${name || fromAddr} a accepte l'invitation.`
          : response === "declined"
            ? `${name || fromAddr} a refuse l'invitation.`
            : `${name || fromAddr} a repondu peut-etre.`,
      ics: buildReplyIcs({ ...ev, attendee_email: fromAddr }, response, name),
    });
    sentVia = "email";
  }

  // Copie Google envoyee par nous : confirmee / "a confirmer", effacee si refus.
  let googleFields: Partial<PBCalendarEvent> = {};
  if (sentVia === "email" && ev.google_pushed && ev.google_event_id) {
    if (response === "declined") {
      googleFields = await dropPushedCopy(ev);
    } else {
      const etag = await patchEventOnGoogle({ ...ev, status: eventStatusFor(response) }).catch((err) => {
        console.warn("[invitation] statut Google non mis a jour:", (err as Error).message);
        return null;
      });
      if (etag) googleFields = { etag };
    }
  }

  const updated = await updateCalendarEvent(ev.id, {
    invitation_status: response,
    status: eventStatusFor(response),
    ...googleFields,
  });
  console.log(`[invitation] reponse ${response} via ${sentVia} -> ${ev.organizer_email} (${ev.id})`);
  return { event: { ...ev, ...updated }, sentVia };
}
