/**
 * Agenda synchronise EN ENTIER avec Google (decision utilisateur 2026-11-24) :
 *
 *  - chaque agenda d'iMiel existe chez Google des qu'un compte Google est relie
 *    (rattrapage `ensureGoogleCalendarsForUser`, rejouable : un agenda local est
 *    ADOPTE s'il existe deja chez Google sous le meme nom, sinon cree) ;
 *  - chaque evenement d'un agenda Google y est envoye (`pushEventToGoogle`,
 *    rejouable : import par iCalUID pour un .ics, sinon recherche par la cle
 *    privee `imielId` avant toute creation) ;
 *  - un evenement peut etre range dans PLUSIEURS agendas : une copie par agenda
 *    (meme `copy_key`), modifiees ensemble depuis iMiel ; une modification faite
 *    dans Google sur une copie est reportee sur les autres
 *    (`propagateToSiblings`, comparaison du contenu => pas de ping-pong) ;
 *  - supprimer un agenda le supprime chez Google (proprietaire) ou le retire de
 *    la liste (partage, familial) ; l'agenda principal n'est jamais supprime.
 *
 * Coupe-circuit : CALENDAR_GOOGLE_PUSH=off (aucun envoi automatique).
 */
import crypto from "crypto";
import {
  type PBAccount,
  type PBCalendarEvent,
  type PBCalendarGroup,
  createCalendarEvent,
  deleteCalendarEvent,
  deleteCalendarGroup,
  findCalendarEventByIcsUid,
  getAccount,
  getCalendarEvent,
  getCalendarGroup,
  listCalendarEventsByCopyKey,
  listCalendarGroupsForUser,
  listUnpushedCalendarEvents,
  pbAdminFetch,
  updateCalendarEvent,
  updateCalendarGroup,
} from "./pocketbase";
import {
  type GoogleCalendarListEntry,
  deleteCalendar,
  deleteGoogleEvent,
  findEventByImielId,
  importEvent,
  insertCalendar,
  moveEvent,
  patchCalendarColor,
  patchEvent,
  pushEvent,
  removeCalendarFromList,
} from "./google-calendar";

export class CalendarRouteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function pushDisabled(): boolean {
  return (process.env.CALENDAR_GOOGLE_PUSH || "").toLowerCase() === "off";
}

export function isGoogleOAuthAccount(a: Pick<PBAccount, "is_active" | "auth_type" | "oauth_provider">): boolean {
  // « google-agenda » (version pour tous) : boite Gmail relevee par mot de passe
  // d'application, dont seul l'agenda passe par Google.
  if (a.is_active && a.oauth_provider === "google-agenda") return true;
  return a.is_active && a.auth_type === "oauth2" && (a.oauth_provider || "google").includes("google");
}

/** Roles Google ou l'on peut ecrire ("" = pas encore relu par la synchro). */
export function isWritableRole(role?: string): boolean {
  return !role || role === "owner" || role === "writer";
}

interface GoogleTarget {
  account: PBAccount;
  calendarId: string;
}

async function targetOf(group: PBCalendarGroup): Promise<GoogleTarget | null> {
  if (!group.account || !group.google_calendar_id || !isWritableRole(group.access_role)) return null;
  const account = await getAccount(group.account);
  if (!isGoogleOAuthAccount(account)) return null;
  return { account, calendarId: group.google_calendar_id };
}

/** UID d'un .ics importable tel quel chez Google (pas une occurrence, pas une cle Suivi). */
function importableUid(ev: Pick<PBCalendarEvent, "ics_uid">): string | null {
  const k = ev.ics_uid || "";
  if (!k || k.includes("#") || k.startsWith("tracking:")) return null;
  return k;
}

export function newCopyKey(): string {
  return crypto.randomBytes(9).toString("hex");
}

/**
 * Envoie chez Google un evenement pas encore relie a Google. Rejouable sans
 * doublon : .ics -> import (meme iCalUID = meme evenement) ; sinon recherche de
 * la cle privee `imielId` avant de creer.
 */
export async function pushEventToGoogle(
  ev: PBCalendarEvent,
  group?: PBCalendarGroup
): Promise<PBCalendarEvent> {
  if (pushDisabled() || ev.google_event_id || ev.no_push || ev.status === "cancelled") return ev;
  const g = group || (await getCalendarGroup(ev.group));
  const t = await targetOf(g);
  if (!t) return ev;

  const uid = importableUid(ev);
  if (uid) {
    // Meme invitation deja presente chez Google par un autre chemin (Gmail l'a
    // ajoutee, rattachee par la synchro) : on ne la double pas.
    const twin = await findCalendarEventByIcsUid(ev.user, uid);
    if (twin && twin.id !== ev.id && twin.google_event_id && (!ev.copy_key || twin.copy_key !== ev.copy_key)) {
      return await updateCalendarEvent(ev.id, { no_push: true });
    }
  }

  let res: { id: string; etag: string };
  if (uid) {
    res = await importEvent(t.account, t.calendarId, uid, ev);
  } else {
    const found = await findEventByImielId(t.account, t.calendarId, ev.id);
    res = found ? { id: found.id, etag: found.etag || "" } : await pushEvent(t.account, t.calendarId, ev);
  }
  const saved = await updateCalendarEvent(ev.id, {
    google_event_id: res.id,
    google_calendar_id: t.calendarId,
    etag: res.etag,
    google_pushed: true,
  });
  console.log(`[calendar-google] envoye "${ev.title}" -> ${g.name} (${ev.id} -> ${res.id})`);
  return saved;
}

/** Version sans echec (appels "au passage" : mail lu, Suivi accepte...). */
export async function pushEventQuietly(ev: PBCalendarEvent): Promise<PBCalendarEvent> {
  try {
    return await pushEventToGoogle(ev);
  } catch (err) {
    console.warn(`[calendar-google] envoi differe "${ev.title}" (${ev.id}):`, (err as Error).message);
    return ev;
  }
}

/** Reporte chez Google le contenu actuel d'un evenement deja relie. Rend le nouvel etag. */
export async function patchEventOnGoogle(ev: PBCalendarEvent): Promise<string | null> {
  if (!ev.google_event_id || !ev.google_calendar_id) return null;
  const g = await getCalendarGroup(ev.group);
  if (!g.account) return null;
  const account = await getAccount(g.account);
  if (!isGoogleOAuthAccount(account)) return null;
  const r = await patchEvent(account, ev.google_calendar_id, ev.google_event_id, ev);
  return r.etag;
}

export async function deleteEventFromGoogle(ev: PBCalendarEvent): Promise<void> {
  if (!ev.google_event_id || !ev.google_calendar_id) return;
  const g = await getCalendarGroup(ev.group).catch(() => null);
  if (!g?.account) return;
  const account = await getAccount(g.account);
  await deleteGoogleEvent(account, ev.google_calendar_id, ev.google_event_id);
}

// ---------------------------------------------------------------------------
// Copies liees (un evenement dans plusieurs agendas)
// ---------------------------------------------------------------------------

export interface EventFields {
  title?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  all_day?: boolean;
  reminders?: number[];
}

const CONTENT_KEYS = ["title", "description", "location", "start", "end", "all_day"] as const;

/** Empreinte du contenu partage entre copies (dates comparees en instants). */
export function contentKey(ev: Partial<PBCalendarEvent>): string {
  return JSON.stringify([
    ev.title || "",
    ev.description || "",
    ev.location || "",
    ev.start ? new Date(ev.start).getTime() : 0,
    ev.end ? new Date(ev.end).getTime() : 0,
    !!ev.all_day,
  ]);
}

function contentOf(ev: Partial<PBCalendarEvent>): Partial<PBCalendarEvent> {
  const out: Partial<PBCalendarEvent> = {};
  for (const k of CONTENT_KEYS) (out as Record<string, unknown>)[k] = ev[k];
  return out;
}

async function siblingsOf(ev: PBCalendarEvent): Promise<PBCalendarEvent[]> {
  if (!ev.copy_key) return [ev];
  const list = await listCalendarEventsByCopyKey(ev.user, ev.copy_key);
  return list.some((e) => e.id === ev.id) ? list : [ev, ...list];
}

async function ownedGroups(userId: string, groupIds: string[]): Promise<PBCalendarGroup[]> {
  const unique = Array.from(new Set(groupIds.filter(Boolean)));
  if (unique.length === 0) throw new CalendarRouteError(400, "at least one calendar is required");
  const out: PBCalendarGroup[] = [];
  for (const id of unique) {
    const g = await getCalendarGroup(id).catch(() => null);
    if (!g || g.user !== userId) throw new CalendarRouteError(403, "calendar not owned by user");
    out.push(g);
  }
  return out;
}

async function createCopy(
  userId: string,
  group: PBCalendarGroup,
  fields: Partial<PBCalendarEvent>,
  copyKey: string
): Promise<PBCalendarEvent> {
  const target = await targetOf(group).catch(() => null);
  const created = await createCalendarEvent({
    ...fields,
    user: userId,
    group: group.id,
    status: fields.status || "confirmed",
    source: target ? "google" : "local",
    copy_key: copyKey,
    reminders_sent: [],
  });
  return target ? await pushEventToGoogle(created, group) : created;
}

/** Cree l'evenement dans chaque agenda coche (une copie par agenda). */
export async function createEventCopies(
  userId: string,
  groupIds: string[],
  fields: EventFields
): Promise<PBCalendarEvent[]> {
  const groups = await ownedGroups(userId, groupIds);
  const copyKey = groups.length > 1 ? newCopyKey() : "";
  const base: Partial<PBCalendarEvent> = {
    title: fields.title || "",
    description: fields.description || "",
    location: fields.location || "",
    start: fields.start,
    end: fields.end,
    all_day: !!fields.all_day,
    reminders: Array.isArray(fields.reminders) ? fields.reminders : [],
  };
  const out: PBCalendarEvent[] = [];
  for (const g of groups) out.push(await createCopy(userId, g, base, copyKey));
  return out;
}

/**
 * Modifie un evenement et TOUTES ses copies ; `groupIds` (facultatif) fixe
 * l'ensemble des agendas : copie ajoutee / retiree, ou deplacement direct chez
 * Google (events.move) quand un seul agenda Google change pour un autre du meme
 * compte (identite et invitation gardees).
 */
export async function updateEventCopies(
  userId: string,
  eventId: string,
  fields: EventFields,
  groupIds?: string[]
): Promise<PBCalendarEvent> {
  const ev = await getCalendarEvent(eventId).catch(() => null);
  if (!ev || ev.user !== userId) throw new CalendarRouteError(404, "event not found");
  let siblings = await siblingsOf(ev);

  const updates: Partial<PBCalendarEvent> = {};
  for (const k of CONTENT_KEYS) {
    if (fields[k] !== undefined) (updates as Record<string, unknown>)[k] = fields[k];
  }
  if (Array.isArray(fields.reminders)) updates.reminders = fields.reminders;
  // Horaire ou alertes changes : les rappels deja envoyes ne comptent plus.
  if (fields.start !== undefined || Array.isArray(fields.reminders)) updates.reminders_sent = [];

  // 1) Ensemble d'agendas.
  if (groupIds) {
    const wanted = await ownedGroups(userId, groupIds);
    const wantedIds = new Set(wanted.map((g) => g.id));
    const toRemove = siblings.filter((s) => !wantedIds.has(s.group));
    const present = new Set(siblings.map((s) => s.group));
    const toAdd = wanted.filter((g) => !present.has(g.id));

    // Deplacement simple entre deux agendas Google du meme compte.
    if (toRemove.length === 1 && toAdd.length === 1 && toRemove[0].google_event_id) {
      const from = await getCalendarGroup(toRemove[0].group);
      const to = toAdd[0];
      const fromT = await targetOf(from).catch(() => null);
      const toT = await targetOf(to).catch(() => null);
      if (fromT && toT && fromT.account.id === toT.account.id) {
        const moved = await moveEvent(fromT.account, toRemove[0].google_calendar_id, toRemove[0].google_event_id, toT.calendarId);
        const saved = await updateCalendarEvent(toRemove[0].id, {
          group: to.id,
          google_calendar_id: toT.calendarId,
          google_event_id: moved.id,
          etag: moved.etag,
        });
        siblings = siblings.map((s) => (s.id === saved.id ? saved : s));
        toRemove.length = 0;
        toAdd.length = 0;
      }
    }

    if (toAdd.length > 0) {
      let copyKey = ev.copy_key || "";
      if (!copyKey) {
        copyKey = newCopyKey();
        for (const s of siblings) await updateCalendarEvent(s.id, { copy_key: copyKey });
        siblings = siblings.map((s) => ({ ...s, copy_key: copyKey }));
      }
      const model = { ...ev, ...updates };
      const base: Partial<PBCalendarEvent> = {
        ...contentOf(model),
        reminders: model.reminders || [],
        status: model.status === "cancelled" ? "confirmed" : model.status,
      };
      for (const g of toAdd) siblings.push(await createCopy(userId, g, base, copyKey));
    }
    for (const s of toRemove) {
      await deleteEventFromGoogle(s).catch((err) =>
        console.warn(`[calendar-google] retrait Google echoue (${s.id}):`, (err as Error).message)
      );
      await deleteCalendarEvent(s.id);
    }
    siblings = siblings.filter((s) => !toRemove.some((r) => r.id === s.id));
  }

  // 2) Contenu reporte sur chaque copie (et sa copie Google).
  let main: PBCalendarEvent | null = null;
  for (const s of siblings) {
    const merged = { ...s, ...updates } as PBCalendarEvent;
    const local: Partial<PBCalendarEvent> = { ...updates };
    if (s.google_event_id) {
      const etag = await patchEventOnGoogle(merged);
      if (etag) local.etag = etag;
    }
    const saved = Object.keys(local).length ? await updateCalendarEvent(s.id, local) : s;
    const pushed = s.google_event_id ? saved : await pushEventQuietly(saved);
    if (s.id === ev.id || !main) main = pushed;
  }
  return main || ev;
}

/** "Supprimer" dans iMiel : toutes les copies, partout. */
export async function deleteEventCopies(userId: string, eventId: string): Promise<number> {
  const ev = await getCalendarEvent(eventId).catch(() => null);
  if (!ev || ev.user !== userId) throw new CalendarRouteError(404, "event not found");
  const siblings = await siblingsOf(ev);
  for (const s of siblings) {
    await deleteEventFromGoogle(s);
    await deleteCalendarEvent(s.id);
  }
  return siblings.length;
}

/**
 * Une copie vient d'etre modifiee CHEZ GOOGLE (synchro) : on reporte le contenu
 * sur les autres copies et sur leurs copies Google. Garde anti-boucle : une
 * copie deja identique est sautee, et l'etag renvoye par Google est memorise
 * (la synchro suivante de son agenda voit le meme etag et ne fait rien).
 */
export async function propagateToSiblings(before: PBCalendarEvent, after: PBCalendarEvent): Promise<number> {
  if (!after.copy_key || contentKey(before) === contentKey(after)) return 0;
  const list = await listCalendarEventsByCopyKey(after.user, after.copy_key);
  const content = contentOf(after);
  const startChanged = new Date(before.start).getTime() !== new Date(after.start).getTime();
  let n = 0;
  for (const s of list) {
    if (s.id === after.id || contentKey(s) === contentKey(after)) continue;
    const patch: Partial<PBCalendarEvent> = { ...content, ...(startChanged ? { reminders_sent: [] } : {}) };
    try {
      if (s.google_event_id) {
        const etag = await patchEventOnGoogle({ ...s, ...patch } as PBCalendarEvent);
        if (etag) patch.etag = etag;
      }
      await updateCalendarEvent(s.id, patch);
      n++;
    } catch (err) {
      console.warn(`[calendar-google] report sur la copie ${s.id} echoue:`, (err as Error).message);
    }
  }
  if (n) console.log(`[calendar-google] modification Google reportee sur ${n} copie(s) (${after.copy_key})`);
  return n;
}

// ---------------------------------------------------------------------------
// Agendas
// ---------------------------------------------------------------------------

/**
 * Compte Google "maison" d'un utilisateur : celui de l'agenda par defaut s'il
 * est Google, sinon le premier compte Google actif. C'est lui qui recoit les
 * agendas propres a iMiel.
 */
export async function homeGoogleAccountId(userId: string, groups?: PBCalendarGroup[]): Promise<string | null> {
  const gs = groups || (await listCalendarGroupsForUser(userId));
  const def = gs.find((g) => g.is_default && g.account && g.google_calendar_id);
  if (def) return def.account;
  const res = (await pbAdminFetch("/api/collections/accounts/records", {
    params: { filter: `user="${userId}" && is_active=true && (auth_type="oauth2" || oauth_provider="google-agenda")`, sort: "created", perPage: "20" },
  })) as { items: PBAccount[] };
  const first = res.items.find((a) => isGoogleOAuthAccount(a));
  return first ? first.id : null;
}

/**
 * Cree chez Google (compte maison) chaque agenda qui n'existe que dans iMiel.
 * Rejouable : un agenda Google du meme nom, dont le compte est proprietaire et
 * qui n'est rattache a aucun groupe, est ADOPTE au lieu d'etre recree.
 * Rend les entrees de liste a ajouter a la synchro en cours.
 */
export async function ensureGoogleCalendarsForUser(
  account: PBAccount,
  calendars: GoogleCalendarListEntry[]
): Promise<GoogleCalendarListEntry[]> {
  if (pushDisabled()) return [];
  const groups = await listCalendarGroupsForUser(account.user);
  if ((await homeGoogleAccountId(account.user, groups)) !== account.id) return [];
  const mapped = new Set(groups.map((g) => g.google_calendar_id).filter(Boolean));
  const added: GoogleCalendarListEntry[] = [];
  for (const g of groups) {
    if (g.google_calendar_id) continue;
    const existing = calendars.find((c) => c.summary === g.name && c.accessRole === "owner" && !mapped.has(c.id));
    const id = existing ? existing.id : await insertCalendar(account, g.name);
    await updateCalendarGroup(g.id, {
      account: account.id,
      google_calendar_id: id,
      access_role: "owner",
      is_primary: false,
      sync_token: "",
    });
    await patchCalendarColor(account, id, g.color).catch(() => undefined);
    mapped.add(id);
    added.push({ id, summary: g.name, accessRole: "owner" });
    console.log(`[calendar-google] agenda "${g.name}" ${existing ? "rattache a" : "cree chez"} Google (${id})`);
  }
  return added;
}

/** Envoie chez Google les evenements pas encore relies des agendas de ce compte. */
export async function pushPendingEventsForAccount(account: PBAccount): Promise<number> {
  if (pushDisabled()) return 0;
  const groups = (await listCalendarGroupsForUser(account.user)).filter(
    (g) => g.account === account.id && g.google_calendar_id && isWritableRole(g.access_role)
  );
  let n = 0;
  for (const g of groups) {
    const pending = await listUnpushedCalendarEvents(g.id);
    for (const ev of pending) {
      try {
        const saved = await pushEventToGoogle(ev, g);
        if (saved.google_event_id) n++;
      } catch (err) {
        console.warn(`[calendar-google] envoi "${ev.title}" (${ev.id}) echoue:`, (err as Error).message);
      }
    }
  }
  if (n) console.log(`[calendar-google] ${n} evenement(s) envoye(s) chez Google (${account.email})`);
  return n;
}

/**
 * Supprime un agenda : chez Google s'il appartient au compte (sinon retire de
 * la liste : partage, familial), puis dans iMiel avec ses evenements.
 */
export async function deleteGroupEverywhere(
  userId: string,
  groupId: string
): Promise<{ effect: "google_deleted" | "unsubscribed" | "local" }> {
  const g = await getCalendarGroup(groupId).catch(() => null);
  if (!g || g.user !== userId) throw new CalendarRouteError(404, "calendar not found");
  if (g.is_primary) throw new CalendarRouteError(400, "the primary Google calendar cannot be deleted");
  let effect: "google_deleted" | "unsubscribed" | "local" = "local";
  if (g.account && g.google_calendar_id) {
    const account = await getAccount(g.account);
    if (g.access_role === "owner") {
      try {
        await deleteCalendar(account, g.google_calendar_id);
        effect = "google_deleted";
      } catch (err) {
        // Agenda familial : Google refuse sa suppression par l'API -> retrait.
        console.warn(`[calendar-google] suppression refusee, retrait de la liste (${g.name}):`, (err as Error).message);
        await removeCalendarFromList(account, g.google_calendar_id);
        effect = "unsubscribed";
      }
    } else {
      await removeCalendarFromList(account, g.google_calendar_id);
      effect = "unsubscribed";
    }
  }
  await deleteCalendarGroup(g.id);
  console.log(`[calendar-google] agenda "${g.name}" supprime (${effect})`);
  return { effect };
}

/** Archive d'une fiche de Suivi : ses evenements partent d'iMiel ET de Google. */
export async function deleteTrackingEventsEverywhere(userId: string, itemId: string): Promise<number> {
  const result = (await pbAdminFetch("/api/collections/calendar_events/records", {
    params: { filter: `user="${userId}" && ics_uid ~ "tracking:${itemId}:"`, perPage: "200" },
  })) as { items: PBCalendarEvent[] };
  let n = 0;
  for (const ev of result.items) {
    try {
      await deleteEventFromGoogle(ev).catch(() => undefined);
      await deleteCalendarEvent(ev.id);
      n++;
    } catch {
      /* best effort */
    }
  }
  return n;
}
