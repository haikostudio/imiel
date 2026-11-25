import {
  listUpcomingEventsForReminders,
  updateCalendarEvent,
  type PBCalendarEventWithUser,
} from "./pocketbase";
import { sendPushToUser } from "./push";
import { logCalendarReminderActivity } from "./activity";

// Rappels par defaut quand l'event n'a pas d'alerte explicite : 9h / 3h / 30min
// avant le debut (offsets en minutes). Cf. demande produit.
const DEFAULT_REMINDERS = [540, 180, 30];

// Fenetre de rattrapage : on declenche encore un rappel dont l'heure cible est
// passee depuis moins de GRACE (couvre un redemarrage worker / le delai de
// premier scan / la gigue du tick). Volontairement courte : `reminders_sent`
// empeche deja les doublons, la grace ne sert qu'a ne pas RATER un rappel dont
// la minute exacte est tombee pendant une coupure. Au-dela, le rappel est
// perime (ex: event imminent cree a l'instant -> pas de "9h avant" retroactif).
const GRACE_MS = 5 * 60 * 1000; // 5 min

let running = false;

interface NormalizedEvent {
  ev: PBCalendarEventWithUser;
  startMs: number;
  offsets: number[];
  sent: number[];
}

/** Offsets valides, uniques, tries du plus grand au plus petit. */
function normalizeOffsets(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  for (const v of raw) {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n >= 0) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => b - a);
}

const UNITS: Record<string, { day: string; hour: string; minute: string; prefix: string }> = {
  fr: { day: "j", hour: "h", minute: "min", prefix: "Dans" },
  en: { day: "d", hour: "h", minute: "min", prefix: "In" },
  de: { day: "T", hour: "Std", minute: "Min", prefix: "In" },
  it: { day: "g", hour: "h", minute: "min", prefix: "Tra" },
};

/** "Dans 30 min" / "In 9 h" / "Tra 1 g" selon l'offset (minutes) et la langue. */
function reminderPhrase(offsetMin: number, lang: string): string {
  const u = UNITS[lang] || UNITS.fr;
  if (offsetMin <= 0) return { fr: "Maintenant", en: "Now", de: "Jetzt", it: "Ora" }[lang] || "Maintenant";
  let value: number;
  let unit: string;
  if (offsetMin % 1440 === 0) {
    value = offsetMin / 1440;
    unit = u.day;
  } else if (offsetMin % 60 === 0) {
    value = offsetMin / 60;
    unit = u.hour;
  } else {
    value = offsetMin;
    unit = u.minute;
  }
  return `${u.prefix} ${value} ${unit}`;
}

/**
 * Scanne les events a venir de tous les utilisateurs et envoie les rappels push
 * dont l'heure est atteinte (et pas encore notifies). Marque les offsets tires
 * dans `reminders_sent` pour ne pas re-notifier au tick suivant. Idempotent ;
 * un verrou module evite le chevauchement si un envoi est lent.
 */
export async function runCalendarReminders(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    // Inclut un court lookback pour ne pas rater un rappel "maintenant" si le
    // tick arrive quelques secondes apres le debut de l'evenement.
    const events = await listUpcomingEventsForReminders(new Date(now - GRACE_MS));

    for (const ev of events) {
      try {
        const user = ev.expand?.user;
        // Respecte la preference utilisateur (defaut: notifier).
        if (user && user.notifications_enabled === false) continue;

        const startMs = new Date(ev.start).getTime();
        if (!Number.isFinite(startMs)) continue;

        const explicit = normalizeOffsets(ev.reminders);
        // Liste vide / absente => defauts (choix produit : pas de desactivation).
        const offsets = explicit.length ? explicit : DEFAULT_REMINDERS;
        const sent = normalizeOffsets(ev.reminders_sent);

        const norm: NormalizedEvent = { ev, startMs, offsets, sent };
        await processEvent(norm, now, user?.language || "fr");
      } catch (err) {
        console.error(`[calendar-reminders] event ${ev.id} failed:`, err);
      }
    }
  } catch (err) {
    console.error("[calendar-reminders] scan failed:", err);
  } finally {
    running = false;
  }
}

async function processEvent(
  { ev, startMs, offsets, sent }: NormalizedEvent,
  now: number,
  lang: string
): Promise<void> {
  const due: number[] = [];
  for (const offset of offsets) {
    if (sent.includes(offset)) continue;
    const fireMs = startMs - offset * 60_000;
    // Atteint, pas perime au-dela de la grace. Pour les alertes "maintenant"
    // (offset 0), on garde la meme grace apres le debut de l'evenement.
    const notTooLate = offset === 0 ? now <= startMs + GRACE_MS : now <= startMs;
    if (now >= fireMs && notTooLate && fireMs >= now - GRACE_MS) {
      due.push(offset);
    }
  }
  if (due.length === 0) return;

  // Un seul push meme si plusieurs offsets arrivent a echeance en meme temps
  // (backlog apres redemarrage) : on prend le plus proche (le plus urgent) pour
  // le libelle, et on marque tous les offsets dus comme envoyes.
  const closest = Math.min(...due);
  const title = ev.title || { fr: "Evenement", en: "Event", de: "Termin", it: "Evento" }[lang] || "Evenement";
  const phrase = reminderPhrase(closest, lang);
  const body = ev.location ? `${phrase} - ${ev.location}` : phrase;

  // Marqueur visuel agenda (emoji calendrier en titre + icone dediee) pour
  // distinguer un RAPPEL d'agenda d'un push e-mail classique. L'emoji du titre
  // reste fiable partout (iOS inclus) ; l'icone est honoree sur desktop/Android.
  await sendPushToUser(ev.user, {
    title: `\u{1F4C5} ${title}`,
    body,
    icon: "/icons/calendar-192.png",
    tag: `cal-reminder-${ev.id}`,
    url: `/#/calendar?event=${ev.id}`,
    data: { type: "calendar_reminder", eventId: ev.id },
  });

  // Journal d'activite : le rappel reste consultable apres la disparition du
  // push. Titre sans emoji (l'UI pose sa propre icone). Best effort.
  void logCalendarReminderActivity({
    userId: ev.user,
    eventId: ev.id,
    title,
    body,
  }).catch((err) =>
    console.warn("[activity] reminder log failed:", (err as Error).message)
  );

  const nextSent = Array.from(new Set(sent.concat(due)));
  await updateCalendarEvent(ev.id, { reminders_sent: nextSent });
}
