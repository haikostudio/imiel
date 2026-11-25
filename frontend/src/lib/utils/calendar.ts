import {
  startOfDay,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  addDays,
  isSameDay,
  differenceInCalendarDays,
} from "date-fns";
import type { CalendarEvent } from "@/lib/pocketbase";

export type CalendarView = "year" | "month" | "week" | "list";

// Semaine commencant le lundi (convention FR/EU).
const WEEK_OPTS = { weekStartsOn: 1 as const };

/** Jour calendaire (local) correspondant aux composantes UTC d'un timestamp. */
function utcDayToLocal(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Jour de debut/fin (inclusif) couvert par un event. */
export function eventDayRange(event: CalendarEvent): { startDay: Date; endDay: Date } {
  if (event.all_day) {
    // Bornes all-day ancrees a minuit UTC : on lit les composantes UTC pour
    // rester stable quel que soit le fuseau du navigateur (sinon un event d'un
    // jour deborde sur le suivant). Fin exclusive -> recule d'1 jour.
    const startDay = utcDayToLocal(event.start);
    const endDay = addDays(utcDayToLocal(event.end), -1);
    return { startDay, endDay: endDay < startDay ? startDay : endDay };
  }
  const startMs = +new Date(event.start);
  const endMs = +new Date(event.end);
  const startDay = startOfDay(new Date(startMs));
  // Fin exclusive (convention minuit) -> recule d'1ms.
  const endDay = startOfDay(new Date(Math.max(startMs, endMs - 1)));
  return { startDay, endDay };
}

export function isMultiDay(event: CalendarEvent): boolean {
  const { startDay, endDay } = eventDayRange(event);
  return event.all_day || differenceInCalendarDays(endDay, startDay) >= 1;
}

/** Matrice 6x7 (Date[][]) pour la vue mensuelle, debutant un lundi. */
export function getMonthMatrix(ref: Date): Date[][] {
  const first = startOfWeek(startOfMonth(ref), WEEK_OPTS);
  const weeks: Date[][] = [];
  let cursor = first;
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) {
      row.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(row);
  }
  return weeks;
}

/** Les 7 jours (lundi -> dimanche) de la semaine contenant `ref`. */
export function getWeekDays(ref: Date): Date[] {
  const first = startOfWeek(ref, WEEK_OPTS);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/** Mois (12 premiers jours de mois) de l'annee de `ref`. */
export function getYearMonths(ref: Date): Date[] {
  return Array.from({ length: 12 }, (_, i) => new Date(ref.getFullYear(), i, 1));
}

export interface EventSegment {
  event: CalendarEvent;
  startCol: number; // 0-6 dans la semaine
  endCol: number; // 0-6 inclusif
  continuesLeft: boolean; // l'event a commence avant cette semaine
  continuesRight: boolean; // l'event continue apres cette semaine
  lane: number;
}

/**
 * Segments (barres) des events sur une semaine donnee, avec affectation de lane
 * (greedy) pour empiler les events qui se chevauchent. Un event multi-jours est
 * une barre continue ; le libelle n'est affiche qu'au 1er segment (continuesLeft=false).
 */
export function computeWeekSegments(weekDays: Date[], events: CalendarEvent[]): EventSegment[] {
  const weekStart = weekDays[0];
  const weekEnd = weekDays[6];

  const segments: Omit<EventSegment, "lane">[] = [];
  for (const event of events) {
    const { startDay, endDay } = eventDayRange(event);
    // Hors de la semaine ?
    if (endDay < weekStart || startDay > weekEnd) continue;
    const startCol = Math.max(0, differenceInCalendarDays(startDay, weekStart));
    const endCol = Math.min(6, differenceInCalendarDays(endDay, weekStart));
    segments.push({
      event,
      startCol,
      endCol,
      continuesLeft: startDay < weekStart,
      continuesRight: endDay > weekEnd,
    });
  }

  // Tri : par jour de debut puis duree (les plus longs en premier) pour des
  // barres stables.
  segments.sort((a, b) => {
    if (a.startCol !== b.startCol) return a.startCol - b.startCol;
    return b.endCol - b.startCol - (a.endCol - a.startCol);
  });

  // Affectation de lanes : chaque lane garde la colonne de fin occupee.
  const laneEnds: number[] = [];
  const result: EventSegment[] = [];
  for (const seg of segments) {
    let lane = laneEnds.findIndex((end) => end < seg.startCol);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(seg.endCol);
    } else {
      laneEnds[lane] = seg.endCol;
    }
    result.push({ ...seg, lane });
  }
  return result;
}

/** Events (timed, non all-day) d'un jour precis, tries par heure. */
export function timedEventsForDay(day: Date, events: CalendarEvent[]): CalendarEvent[] {
  return events
    .filter((e) => !e.all_day && !isMultiDay(e) && isSameDay(new Date(e.start), day))
    .sort((a, b) => +new Date(a.start) - +new Date(b.start));
}

/** Position verticale (fraction 0-1) d'une heure dans la journee. */
export function dayFraction(date: Date): number {
  const d = new Date(date);
  return (d.getHours() * 60 + d.getMinutes()) / (24 * 60);
}

/** Fraction de hauteur d'un event timed (clamp >= 1.5%). */
export function eventHeightFraction(event: CalendarEvent): number {
  const durMin = Math.max(15, (+new Date(event.end) - +new Date(event.start)) / 60000);
  return Math.max(0.015, durMin / (24 * 60));
}

/** Events couvrant un jour (pour la vue annuelle : marquer les jours occupes). */
export function dayHasEvent(day: Date, events: CalendarEvent[]): boolean {
  return events.some((e) => {
    const { startDay, endDay } = eventDayRange(e);
    return day >= startDay && day <= endDay;
  });
}
