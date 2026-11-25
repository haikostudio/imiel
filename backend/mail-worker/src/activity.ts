import { createActivity, type PBEmailAddress } from "./pocketbase";
import { senderFaviconUrl } from "./push";

/**
 * Journal d'activite (centre de notifications). Une entree par evenement
 * notable, ECRITE MEME SI le push est desactive : contrairement au push qui est
 * ephemere, le journal garde un historique consultable 30 jours ("ce qui s'est
 * passe, par qui et quand"). Tout est best-effort : jamais bloquant, jamais
 * fatal (si la collection `activities` n'existe pas encore, createActivity
 * avale l'erreur).
 *
 * Les helpers construisent title/body/url/icon coherents avec les push
 * correspondants (push.ts) pour que le deep-link au clic soit identique.
 */

function iso(date?: string | Date): string {
  if (!date) return new Date().toISOString();
  if (date instanceof Date) return date.toISOString();
  return date;
}

function clip(s: string | undefined, n: number): string {
  const v = (s || "").trim();
  return v.length > n ? v.slice(0, n) : v;
}

function mailThreadUrl(messageId: string, threadId?: string): string {
  return threadId
    ? `/#/mail/all?t=${encodeURIComponent(threadId)}&m=${encodeURIComponent(messageId)}`
    : "/#/mail/all";
}

/** Nouveau mail recu (l'expediteur est "par qui"). */
export async function logNewMailActivity(input: {
  userId: string;
  accountId: string;
  senderLabel: string;
  subject: string;
  messageId: string;
  threadId?: string;
  senderAddress?: string;
  date?: string;
}): Promise<void> {
  await createActivity({
    user: input.userId,
    account: input.accountId,
    type: "new_email",
    title: clip(input.senderLabel, 400) || "Nouveau message",
    body: clip(input.subject, 1000) || "(sans sujet)",
    icon: senderFaviconUrl(input.senderAddress) || "",
    url: mailThreadUrl(input.messageId, input.threadId),
    source_collection: "messages",
    source_id: input.messageId,
    thread_id: input.threadId || "",
    metadata: { senderAddress: input.senderAddress || "" },
    is_read: false,
    event_date: iso(input.date),
  });
}

/** Mail envoye depuis l'app ("mes envois"). Journalise comme deja lu : c'est ma
 * propre action, elle ne doit pas gonfler le compteur de non-lus. */
export async function logSentMailActivity(input: {
  userId: string;
  accountId: string;
  messageId: string;
  threadId?: string;
  subject: string;
  to?: PBEmailAddress[];
}): Promise<void> {
  const names = (input.to || [])
    .map((a) => a?.name || a?.address)
    .filter((v): v is string => Boolean(v));
  const recipients =
    names.length === 0
      ? ""
      : names.length <= 2
        ? names.join(", ")
        : `${names[0]} +${names.length - 1}`;
  await createActivity({
    user: input.userId,
    account: input.accountId,
    type: "mail_sent",
    title: clip(recipients, 400) || "Message envoye",
    body: clip(input.subject, 1000) || "(sans sujet)",
    url: mailThreadUrl(input.messageId, input.threadId),
    source_collection: "messages",
    source_id: input.messageId,
    thread_id: input.threadId || "",
    is_read: true,
    event_date: new Date().toISOString(),
  });
}

/** Nouvelle newsletter agregee dans le flux. */
export async function logNewsletterActivity(input: {
  userId: string;
  accountId?: string;
  sourceName: string;
  subject: string;
  messageId: string;
  threadId?: string;
  date?: string;
}): Promise<void> {
  await createActivity({
    user: input.userId,
    ...(input.accountId ? { account: input.accountId } : {}),
    type: "newsletter",
    title: clip(input.sourceName, 400) || "Newsletter",
    body: clip(input.subject, 1000),
    url: "/#/newsletters",
    source_collection: "newsletter_posts",
    source_id: input.messageId,
    thread_id: input.threadId || "",
    is_read: false,
    event_date: iso(input.date),
  });
}

/** Nouvelle fiche de suivi creee. */
export async function logTrackingNewActivity(input: {
  userId: string;
  accountId?: string;
  itemId: string;
  title: string;
  type?: string;
  threadId?: string;
  date?: string;
}): Promise<void> {
  await createActivity({
    user: input.userId,
    ...(input.accountId ? { account: input.accountId } : {}),
    type: "tracking_new",
    title: clip(input.title, 400) || "Nouveau suivi",
    body: clip(input.type, 1000),
    url: "/#/suivi",
    source_collection: "tracking_items",
    source_id: input.itemId,
    thread_id: input.threadId || "",
    is_read: false,
    event_date: iso(input.date),
  });
}

/** Changement de statut d'une fiche de suivi. */
export async function logTrackingStatusActivity(input: {
  userId: string;
  itemId: string;
  title: string;
  statusLabel: string;
  date?: string;
}): Promise<void> {
  await createActivity({
    user: input.userId,
    type: "tracking_status",
    title: clip(input.title, 400) || "Suivi mis a jour",
    body: clip(input.statusLabel, 1000),
    url: "/#/suivi",
    source_collection: "tracking_items",
    source_id: input.itemId,
    metadata: { statusLabel: input.statusLabel },
    is_read: false,
    event_date: iso(input.date),
  });
}

/** Rappel d'un evenement d'agenda a venir. */
export async function logCalendarReminderActivity(input: {
  userId: string;
  eventId: string;
  title: string;
  body: string;
  date?: string;
}): Promise<void> {
  await createActivity({
    user: input.userId,
    type: "calendar_reminder",
    title: clip(input.title, 400) || "Rappel",
    body: clip(input.body, 1000),
    url: `/#/calendar?event=${input.eventId}`,
    source_collection: "calendar_events",
    source_id: input.eventId,
    is_read: false,
    event_date: iso(input.date),
  });
}

/** Echeance(s)/livraison(s)/RDV detectes dans le suivi, en attente d'ajout a
 * l'agenda. */
export async function logCalendarSuggestionActivity(input: {
  userId: string;
  itemId: string;
  count: number;
  sample: string;
  ficheTitle?: string;
  date?: string;
}): Promise<void> {
  if (input.count <= 0) return;
  const title =
    input.count > 1
      ? `${input.count} echeances a ajouter`
      : "Echeance a ajouter";
  await createActivity({
    user: input.userId,
    type: "calendar_suggestion",
    title,
    body: clip(input.sample || input.ficheTitle, 1000),
    url: "/#/suivi?dates=1",
    source_collection: "calendar_suggestions",
    source_id: input.itemId,
    metadata: { count: input.count },
    is_read: false,
    event_date: iso(input.date),
  });
}
