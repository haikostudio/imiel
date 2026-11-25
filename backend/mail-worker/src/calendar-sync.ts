import {
  type PBAccount,
  type PBCalendarGroup,
  getAccount,
  listAccountsDueForSync,
  listCalendarGroupsForUser,
  findCalendarGroupByGoogleId,
  createCalendarGroup,
  updateCalendarGroup,
  findCalendarEventByGoogleId,
  findUnlinkedCalendarEventByIcsUid,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from "./pocketbase";
import {
  listCalendars,
  pullEvents,
  fromGoogleEvent,
  GoogleCalendarScopeError,
} from "./google-calendar";
import {
  ensureGoogleCalendarsForUser,
  isGoogleOAuthAccount,
  propagateToSiblings,
  pushPendingEventsForAccount,
} from "./calendar-google";

const DEFAULT_COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316", "#14b8a6", "#6366f1",
];

/**
 * Une seule synchro a la fois par utilisateur : deux synchros concurrentes
 * (minuterie + bouton) rataient chacune le groupe que l'autre creait, d'ou le
 * doublon "Chris (christ)" du 2026-07-04.
 */
const userLocks = new Map<string, Promise<unknown>>();
async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) || Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  userLocks.set(userId, run);
  try {
    return await run;
  } finally {
    if (userLocks.get(userId) === run) userLocks.delete(userId);
  }
}

/**
 * Sync bidirectionnelle (cote pull) d'un compte Google :
 * - liste les agendas accessibles (le tien + les partages comme Annie)
 * - mappe chacun a un calendar_groups (cree si absent)
 * - tire les events incrementalement (syncToken) et upsert/delete en local
 */
export async function syncCalendarForAccount(accountId: string): Promise<{ calendars: number; events: number; pushed: number }> {
  const account = await getAccount(accountId);
  if (!isGoogleOAuthAccount(account)) {
    return { calendars: 0, events: 0, pushed: 0 };
  }
  return await withUserLock(account.user, () => syncCalendarForAccountLocked(account));
}

async function syncCalendarForAccountLocked(account: PBAccount): Promise<{ calendars: number; events: number; pushed: number }> {
  const calendars = await listCalendars(account);
  // Agendas propres a iMiel -> crees (ou retrouves) chez Google AVANT la
  // correspondance agendas/groupes, pour qu'un agenda cree lors d'une synchro
  // interrompue soit rattache a son groupe et non recopie.
  for (const extra of await ensureGoogleCalendarsForUser(account, calendars)) {
    if (!calendars.some((c) => c.id === extra.id)) calendars.push(extra);
  }
  const existingGroups = await listCalendarGroupsForUser(account.user);
  const usedColors = new Set(existingGroups.map((g) => g.color).filter(Boolean));

  let eventCount = 0;

  for (let i = 0; i < calendars.length; i++) {
    const cal = calendars[i];
    let group = await findCalendarGroupByGoogleId(account.user, account.id, cal.id);
    if (!group) {
      const color =
        cal.backgroundColor ||
        DEFAULT_COLORS.find((c) => !usedColors.has(c)) ||
        DEFAULT_COLORS[i % DEFAULT_COLORS.length];
      usedColors.add(color);
      group = await createGroupSafe(account.user, account.id, cal.id, cal.summary || cal.id, color);
    }
    // Role et statut "principal" relus a chaque synchro (droits d'ecriture,
    // suppression autorisee ou non).
    const role = cal.accessRole || "";
    const primary = !!cal.primary;
    if ((group.access_role || "") !== role || !!group.is_primary !== primary) {
      group = await updateCalendarGroup(group.id, { access_role: role, is_primary: primary });
    }

    eventCount += await syncCalendarGroup(account, group);
  }

  // Evenements pas encore chez Google (rattrapage, mails lus, Suivi...).
  const pushed = await pushPendingEventsForAccount(account).catch((err) => {
    console.warn(`[calendar] envoi vers Google echoue (${account.email}):`, (err as Error).message);
    return 0;
  });

  return { calendars: calendars.length, events: eventCount, pushed };
}

async function createGroupSafe(
  userId: string,
  accountId: string,
  googleCalendarId: string,
  name: string,
  color: string
): Promise<PBCalendarGroup> {
  try {
    return await createCalendarGroup({
      user: userId,
      account: accountId,
      google_calendar_id: googleCalendarId,
      name,
      color,
      is_visible: true,
    });
  } catch (err) {
    // Collision sur un index unique. D'abord : ce MEME agenda Google a-t-il deja
    // son groupe (synchro concurrente, autre compte) ? On le reutilise.
    const groups = await listCalendarGroupsForUser(userId);
    const same =
      groups.find((g) => g.google_calendar_id === googleCalendarId && g.account === accountId) ||
      groups.find((g) => g.google_calendar_id === googleCalendarId);
    if (same) return same;
    // Agenda propre a iMiel (meme nom, pas encore relie) : c'est lui qui vient
    // d'etre cree chez Google -> on le rattache au lieu de dupliquer.
    const local = groups.find((g) => g.name === name && !g.google_calendar_id);
    if (local) {
      return await updateCalendarGroup(local.id, { account: accountId, google_calendar_id: googleCalendarId });
    }
    console.warn(`[calendar] nom d'agenda deja pris, suffixe (${name}):`, (err as Error).message);
    // Vrai homonyme (autre agenda Google du meme nom) -> suffixe.
    return await createCalendarGroup({
      user: userId,
      account: accountId,
      google_calendar_id: googleCalendarId,
      name: `${name} (${googleCalendarId.slice(0, 6)})`,
      color,
      is_visible: true,
    });
  }
}

async function syncCalendarGroup(account: PBAccount, group: PBCalendarGroup): Promise<number> {
  let pull = await pullEvents(account, group.google_calendar_id, group.sync_token);
  if (pull.needsFullResync) {
    pull = await pullEvents(account, group.google_calendar_id, null);
  }

  let count = 0;
  for (const g of pull.events) {
    const existing = await findCalendarEventByGoogleId(account.user, g.id, group.google_calendar_id);

    if (g.status === "cancelled") {
      if (existing) await deleteCalendarEvent(existing.id);
      continue;
    }

    const mapped = fromGoogleEvent(g, group.google_calendar_id);
    if (existing) {
      // Skip si rien n'a change (meme etag).
      if (existing.etag && g.etag && existing.etag === g.etag) continue;
      // Event reprogramme sur Google : reinitialise les rappels deja envoyes
      // pour que les alertes re-declenchent au nouvel horaire. Comparaison sur
      // le TIMESTAMP, pas la chaine : PB renvoie "2026-06-12 13:00:00.000Z"
      // (espace) alors que `fromGoogleEvent` produit de l'ISO avec "T" -> une
      // comparaison de chaines serait toujours vraie et viderait reminders_sent
      // a chaque sync, refaisant sonner l'alerte en boucle.
      const startChanged =
        new Date(existing.start).getTime() !== new Date(mapped.start as string).getTime();
      if (startChanged) mapped.reminders_sent = [];
      // Copie que NOUS avons envoyee : on garde sa cle (Suivi "tracking:...",
      // UID du .ics) et son origine ; Google donne un iCalUID "...@google.com".
      if (existing.ics_uid) delete mapped.ics_uid;
      if (existing.google_pushed) delete mapped.source;
      const saved = await updateCalendarEvent(existing.id, mapped);
      // Modifiee dans Google : les copies des autres agendas suivent.
      await propagateToSiblings(existing, { ...existing, ...saved }).catch((err) =>
        console.warn("[calendar] report sur les copies echoue:", (err as Error).message)
      );
    } else {
      // Invitation deja importee depuis le mail (.ics, meme iCalUID) : on la
      // RATTACHE a Google au lieu d'en creer une seconde (un seul evenement,
      // la reponse passera par Google). Le mail d'origine reste lie.
      const fromMail = mapped.ics_uid ? await findUnlinkedCalendarEventByIcsUid(account.user, mapped.ics_uid) : null;
      if (fromMail && !fromMail.google_event_id) {
        await updateCalendarEvent(fromMail.id, {
          ...mapped,
          group: group.id,
          attendee_email: fromMail.attendee_email || mapped.attendee_email,
          account: fromMail.account || account.id,
        });
      } else {
        await createCalendarEvent({ ...mapped, user: account.user, group: group.id });
      }
    }
    count++;
  }

  if (pull.nextSyncToken && pull.nextSyncToken !== group.sync_token) {
    await updateCalendarGroup(group.id, { sync_token: pull.nextSyncToken });
  }
  return count;
}

/** Poll periodique : sync calendar de tous les comptes Google actifs. */
export async function syncAllCalendars(): Promise<void> {
  let accounts: PBAccount[];
  try {
    accounts = await listAccountsDueForSync();
  } catch (err) {
    console.error("[calendar] cannot list accounts:", err);
    return;
  }
  for (const account of accounts) {
    if (!isGoogleOAuthAccount(account)) continue;
    try {
      await syncCalendarForAccount(account.id);
    } catch (err) {
      if (err instanceof GoogleCalendarScopeError) {
        // Compte non reconnecte (pas de scope Calendar) : on n'insiste pas.
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[calendar] sync failed for ${account.email}: ${msg}`);
    }
  }
}
