"use client";

import { useMemo } from "react";
import { isSameMonth, isToday } from "date-fns";
import { cn } from "@/lib/utils";
import { getMonthMatrix, computeWeekSegments } from "@/lib/utils/calendar";
import type { CalendarEvent } from "@/lib/pocketbase";

interface MonthViewProps {
  refDate: Date;
  events: CalendarEvent[];
  colorOf: (groupId: string) => string;
  onEventClick: (event: CalendarEvent) => void;
  onDayClick: (day: Date) => void;
  locale: string;
}

const MAX_LANES = 4;
const DAY_ROW_PX = 22; // hauteur du numero de jour
const BAR_PX = 18;

export function MonthView({ refDate, events, colorOf, onEventClick, onDayClick, locale }: MonthViewProps) {
  const weeks = useMemo(() => getMonthMatrix(refDate), [refDate]);

  const weekdayNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    // Lundi de reference (2024-01-01 est un lundi).
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [locale]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="grid shrink-0 grid-cols-7 border-b text-xs font-medium text-muted-foreground">
        {weekdayNames.map((w, i) => (
          <div key={i} className="px-2 py-1.5 capitalize">{w}</div>
        ))}
      </div>

      <div className="grid flex-1 grid-rows-6">
        {weeks.map((weekDays, wi) => {
          const segments = computeWeekSegments(weekDays, events);
          return (
            <div key={wi} className="relative grid grid-cols-7 border-b last:border-b-0">
              {/* Cellules de fond + numero de jour */}
              {weekDays.map((day, di) => {
                const inMonth = isSameMonth(day, refDate);
                const today = isToday(day);
                const hiddenCount = segments.filter(
                  (s) => s.lane >= MAX_LANES && s.startCol <= di && s.endCol >= di
                ).length;
                return (
                  <button
                    key={di}
                    type="button"
                    onClick={() => onDayClick(day)}
                    data-today={today ? "true" : undefined}
                    className={cn(
                      "flex flex-col items-start border-r p-1 text-left last:border-r-0 hover:bg-accent/40",
                      !inMonth && "bg-muted/30 text-muted-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-5 items-center justify-center rounded-full text-xs",
                        today && "calendar-today bg-primary text-primary-foreground"
                      )}
                    >
                      {day.getDate()}
                    </span>
                    {hiddenCount > 0 && (
                      <span className="mt-auto text-[10px] text-muted-foreground">+{hiddenCount}</span>
                    )}
                  </button>
                );
              })}

              {/* Barres d'evenements (lanes) */}
              <div className="pointer-events-none absolute inset-0">
                {segments
                  .filter((s) => s.lane < MAX_LANES)
                  .map((seg, si) => {
                    const color = colorOf(seg.event.group);
                    return (
                      <button
                        key={si}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEventClick(seg.event);
                        }}
                        title={seg.event.title}
                        className={cn(
                          "pointer-events-auto absolute truncate px-1.5 text-left text-[11px] leading-tight text-white",
                          seg.continuesLeft ? "rounded-l-none" : "rounded-l",
                          seg.continuesRight ? "rounded-r-none" : "rounded-r"
                        )}
                        style={{
                          left: `calc(${(seg.startCol / 7) * 100}% + 2px)`,
                          width: `calc(${((seg.endCol - seg.startCol + 1) / 7) * 100}% - 4px)`,
                          // Decale sous le numero de jour : l'absolute ignore le
                          // padding du conteneur, on l'ajoute donc au top.
                          top: DAY_ROW_PX + seg.lane * (BAR_PX + 2),
                          height: BAR_PX,
                          backgroundColor: color,
                          lineHeight: `${BAR_PX}px`,
                        }}
                      >
                        {seg.continuesLeft ? "◂ " : ""}
                        {seg.event.title}
                      </button>
                    );
                  })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
