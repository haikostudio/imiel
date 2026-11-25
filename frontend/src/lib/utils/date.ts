import {
  format,
  formatDistanceToNow,
  isToday,
  isYesterday,
  isThisYear,
  differenceInMinutes,
  differenceInHours,
  differenceInDays,
} from "date-fns";
import { fr } from "date-fns/locale";

/**
 * Formatage relatif pour les listes de messages.
 *
 * - Aujourd'hui : "Aujourd'hui 14:32"
 * - Hier : "Hier 16:42"
 * - Cette année : "Lun. 23 fév."
 * - Année précédente : "23 fév. 2024"
 */
export function formatRelativeDate(date: string | Date): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";

  if (isToday(d)) {
    return `Aujourd'hui ${format(d, "HH:mm", { locale: fr })}`;
  }

  if (isYesterday(d)) {
    return `Hier ${format(d, "HH:mm", { locale: fr })}`;
  }

  if (isThisYear(d)) {
    return format(d, "EEE d MMM", { locale: fr });
  }

  return format(d, "d MMM yyyy", { locale: fr });
}

/**
 * Date compacte d'une ligne de liste de mails (charte des maquettes) :
 * aujourd'hui = heure seule ("19:04"), hier = "Hier", sinon la date courte
 * de formatRelativeDate ("mar. 13 oct.").
 */
export function formatListDate(date: string | Date): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";
  if (isToday(d)) return format(d, "HH:mm", { locale: fr });
  if (isYesterday(d)) return "Hier";
  return formatRelativeDate(d);
}

/**
 * Formatage "il y a X" pour les timestamps récents.
 *
 * - < 1 min : "à l'instant"
 * - < 60 min : "il y a 2 min"
 * - < 24h : "il y a 1h"
 * - < 7j : "il y a 3j"
 * - Sinon : date-fns formatDistanceToNow
 */
export function formatTimeAgo(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();

  const mins = differenceInMinutes(now, d);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;

  const hours = differenceInHours(now, d);
  if (hours < 24) return `il y a ${hours}h`;

  const days = differenceInDays(now, d);
  if (days < 7) return `il y a ${days}j`;

  return formatDistanceToNow(d, { addSuffix: true, locale: fr });
}

/**
 * Format complet pour l'affichage détaillé d'un message.
 * Ex: "lundi 23 février 2025 à 14:32"
 */
export function formatFullDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(d, "EEEE d MMMM yyyy 'à' HH:mm", { locale: fr });
}

/**
 * Format hybride pour les headers de messages (thread).
 * Combine le relatif pour aujourd'hui/hier avec la date complete sinon.
 *
 * - Aujourd'hui : "Aujourd'hui, 14:32"
 * - Hier : "Hier, 16:42"
 * - Sinon : "lundi 23 février 2025 à 14:32"
 */
export function formatHeaderDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (isToday(d)) {
    return `Aujourd'hui, ${format(d, "HH:mm", { locale: fr })}`;
  }
  if (isYesterday(d)) {
    return `Hier, ${format(d, "HH:mm", { locale: fr })}`;
  }
  return format(d, "EEEE d MMMM yyyy 'à' HH:mm", { locale: fr });
}

/**
 * Format court pour les graphiques / tableaux de bord.
 * Ex: "23/02"
 */
export function formatShortDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(d, "dd/MM", { locale: fr });
}

/**
 * Format localise pour les messages du chat IA. Affiche :
 * - < 1 min : "a l'instant" (localise)
 * - < 1 h : "il y a Nmin"
 * - aujourd'hui : "HH:mm"
 * - sinon : "JJ/MM HH:mm"
 *
 * Utilise Intl.RelativeTimeFormat (natif, locale-aware) pour eviter d'avoir
 * a dupliquer les traductions dans i18n.ts pour chaque unite.
 */
export type ChatLocale = "fr" | "en" | "de" | "it";

const CHAT_LOCALE_TAG: Record<ChatLocale, string> = {
  fr: "fr-FR",
  en: "en-US",
  de: "de-DE",
  it: "it-IT",
};

export function formatChatMessageTime(
  date: string | number | Date,
  locale: ChatLocale = "fr"
): string {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const tag = CHAT_LOCALE_TAG[locale] || CHAT_LOCALE_TAG.fr;
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
  if (diffMin < 1) return rtf.format(0, "minute");
  if (diffMin < 60) return rtf.format(-diffMin, "minute");

  // Meme journee : afficher l'heure
  if (isToday(d)) {
    return new Intl.DateTimeFormat(tag, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }
  // Sinon date + heure compacte (ex: "23/02 14:32")
  return new Intl.DateTimeFormat(tag, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/**
 * Version absolue complete pour le tooltip (hover) sur la datetime du chat.
 * Ex (fr): "23 fevrier 2025, 14:32"
 */
export function formatChatMessageTimeFull(
  date: string | number | Date,
  locale: ChatLocale = "fr"
): string {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";
  const tag = CHAT_LOCALE_TAG[locale] || CHAT_LOCALE_TAG.fr;
  return new Intl.DateTimeFormat(tag, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
