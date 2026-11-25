"use client";

import { isPendingInvitation, pendingInvitationStyle } from "@/lib/invitation-style";
import { useMemo } from "react";
import { isToday } from "date-fns";
import { cn } from "@/lib/utils";
import {
  getWeekDays,
  computeWeekSegments,
  isMultiDay,
  timedEventsForDay,
  dayFraction,
  eventHeightFraction,
} from "@/lib/utils/calendar";
import type { CalendarEvent } from "@/lib/pocketbase";

interface WeekViewProps {
  refDate: Date;
  events: CalendarEvent[];
  colorOf: (groupId: string) => string;
  onEventClick: (event: CalendarEvent) => void;
  onDayClick: (day: Date) => void;
  locale: string;
}

const ALLDAY_BAR_PX = 18;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function WeekView({ refDate, events, colorOf, onEventClick, onDayClick, locale }: WeekViewProps) {
  const weekDays = useMemo(() => getWeekDays(refDate), [refDate]);

  const allDayEvents = useMemo(() => events.filter((e) => e.all_day || isMultiDay(e)), [events]);
  const allDaySegments = useMemo(() => computeWeekSegments(weekDays, allDayEvents), [weekDays, allDayEvents]);
  const allDayLanes = allDaySegments.reduce((m, s) => Math.max(m, s.lane + 1), 0);

  const dayFmt = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "short" }), [locale]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* En-tete jours */}
      <div className="grid shrink-0 grid-cols-[3rem_repeat(7,1fr)] border-b">
        <div className="border-r" />
        {weekDays.map((day, i) => {
          const today = isToday(day);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onDayClick(day)}
              data-today={today ? "true" : undefined}
              className="flex flex-col items-center justify-center gap-0.5 border-r py-2 text-xs last:border-r-0 hover:bg-accent/40 sm:flex-row sm:gap-1.5 sm:py-1.5"
            >
              <span className="capitalize text-muted-foreground">{dayFmt.format(day)}</span>
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-xs sm:size-5",
                  today && "calendar-today bg-primary text-primary-foreground"
                )}
              >
                {day.getDate()}
              </span>
            </button>
          );
        })}
      </div>

      {/* Bande all-day / multi-jours */}
      {allDayLanes > 0 && (
        <div className="grid shrink-0 grid-cols-[3rem_repeat(7,1fr)] border-b">
          <div className="border-r" />
          <div className="relative col-span-7" style={{ height: allDayLanes * (ALLDAY_BAR_PX + 2) + 2 }}>
            {allDaySegments.map((seg, si) => {
              const color = colorOf(seg.event.group);
              return (
                <button
                  key={si}
                  type="button"
                  onClick={() => onEventClick(seg.event)}
                  title={seg.event.title}
                  className={cn(
                    "absolute truncate px-1.5 text-left text-[11px] text-white",
                    seg.continuesLeft ? "rounded-l-none" : "rounded-l",
                    seg.continuesRight ? "rounded-r-none" : "rounded-r"
                  )}
                  style={{
                    left: `calc(${(seg.startCol / 7) * 100}% + 2px)`,
                    width: `calc(${((seg.endCol - seg.startCol + 1) / 7) * 100}% - 4px)`,
                    top: seg.lane * (ALLDAY_BAR_PX + 2) + 1,
                    height: ALLDAY_BAR_PX,
                    lineHeight: `${ALLDAY_BAR_PX - (isPendingInvitation(seg.event) ? 3 : 0)}px`,
                    backgroundColor: color,
                    ...(isPendingInvitation(seg.event) ? pendingInvitationStyle(color) : {}),
                  }}
                  data-invitation={isPendingInvitation(seg.event) ? "pending" : undefined}
                >
                  {seg.event.title}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Grille horaire : remplit la hauteur en desktop (sans scroll), scrollable
          avec des heures plus hautes en mobile pour une meilleure lisibilite */}
      <div className="grid flex-1 grid-cols-[3rem_repeat(7,1fr)] overflow-y-auto sm:overflow-hidden">
        {/* Colonne des heures */}
        <div className="flex flex-col border-r">
          {HOURS.map((h) => (
            <div
              key={h}
              className="relative min-h-[2.75rem] flex-1 border-b text-[10px] text-muted-foreground last:border-b-0 sm:min-h-0"
            >
              {/* Place l'heure juste au-dessus de la ligne (bord haut = ligne h:00). */}
              <span className="absolute top-0 right-1 -translate-y-full pb-0.5">{h > 0 ? `${h}:00` : ""}</span>
            </div>
          ))}
        </div>

        {/* Colonnes jours */}
        {weekDays.map((day, di) => {
          const timed = timedEventsForDay(day, events);
          return (
            <div
              key={di}
              className="relative flex flex-col border-r last:border-r-0"
              onClick={() => onDayClick(day)}
            >
              {/* Lignes horaires de fond */}
              {HOURS.map((h) => (
                <div key={h} className="min-h-[2.75rem] flex-1 border-b last:border-b-0 sm:min-h-0" />
              ))}
              {/* Events timed */}
              {timed.map((event, ei) => {
                const color = colorOf(event.group);
                return (
                  <button
                    key={ei}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(event);
                    }}
                    title={event.title}
                    className="absolute left-0.5 right-0.5 overflow-hidden rounded px-1 text-left text-[10px] leading-tight text-white"
                    style={{
                      top: `${dayFraction(new Date(event.start)) * 100}%`,
                      height: `${eventHeightFraction(event) * 100}%`,
                      backgroundColor: color,
                      ...(isPendingInvitation(event) ? pendingInvitationStyle(color) : {}),
                    }}
                    data-invitation={isPendingInvitation(event) ? "pending" : undefined}
                  >
                    {event.title}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
