"use client";

import { useMemo } from "react";
import { addDays, isSameMonth, isToday } from "date-fns";
import { cn } from "@/lib/utils";
import { getYearMonths, getMonthMatrix, eventDayRange } from "@/lib/utils/calendar";
import type { CalendarEvent } from "@/lib/pocketbase";

interface YearViewProps {
  refDate: Date;
  events: CalendarEvent[];
  colorOf: (groupId: string) => string;
  onDayClick: (day: Date) => void;
  locale: string;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function YearView({ refDate, events, colorOf, onDayClick, locale }: YearViewProps) {
  const months = useMemo(() => getYearMonths(refDate), [refDate]);

  // Couleur d'evenement par jour (1ere occurrence) -> pastille indicateur.
  const eventColorByDay = useMemo(() => {
    const map = new Map<string, string>();
    const sorted = [...events].sort((a, b) => +new Date(a.start) - +new Date(b.start));
    for (const e of sorted) {
      const { startDay, endDay } = eventDayRange(e);
      let cursor = startDay;
      while (cursor <= endDay) {
        const key = dayKey(cursor);
        if (!map.has(key)) map.set(key, colorOf(e.group));
        cursor = addDays(cursor, 1);
      }
    }
    return map;
  }, [events, colorOf]);
  const monthFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: "long" }), [locale]);
  const weekdayLetters = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [locale]);

  return (
    <div className="grid h-full grid-cols-3 grid-rows-4 gap-1 overflow-hidden p-1.5 sm:grid-cols-4 sm:grid-rows-3 sm:gap-2 sm:p-2">
      {months.map((month, mi) => {
        const weeks = getMonthMatrix(month);
        return (
          <div key={mi} className="flex min-h-0 flex-col rounded-md border p-1 sm:p-2">
            <div className="mb-0.5 truncate text-[10px] font-semibold capitalize sm:mb-1 sm:text-xs">{monthFmt.format(month)}</div>
            <div className="grid grid-cols-7 text-center text-[7px] text-muted-foreground sm:text-[9px]">
              {weekdayLetters.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
            <div className="grid flex-1 grid-rows-6 text-[8px] sm:text-[10px]">
              {weeks.map((week, wi) => (
                <div key={wi} className="grid grid-cols-7 text-center">
                  {week.map((day, di) => {
                    const inMonth = isSameMonth(day, month);
                    const today = isToday(day);
                    const dotColor = inMonth ? eventColorByDay.get(dayKey(day)) : undefined;
                    return (
                      <button
                        key={di}
                        type="button"
                        onClick={() => onDayClick(day)}
                        className={cn(
                          "flex items-center justify-center leading-none hover:bg-accent",
                          !inMonth && "text-muted-foreground/40"
                        )}
                      >
                        <span
                          className={cn(
                            "relative flex size-[1.5em] items-center justify-center rounded-full",
                            today && "calendar-today bg-primary font-medium text-primary-foreground"
                          )}
                        >
                          {day.getDate()}
                          {dotColor && !today && (
                            <span
                              className="absolute bottom-0 size-[3px] rounded-full"
                              style={{ backgroundColor: dotColor }}
                            />
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
