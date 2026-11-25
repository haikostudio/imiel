"use client";

import { useMemo, useState } from "react";
import { addMonths, isSameDay, isSameMonth, isToday } from "date-fns";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { getMonthMatrix } from "@/lib/utils/calendar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DateTimePickerProps {
  value: Date;
  onChange: (next: Date) => void;
  /** Affiche les selecteurs heure/minute. */
  withTime?: boolean;
  locale?: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5); // pas de 5 min

export function DateTimePicker({ value, onChange, withTime = false, locale = "fr-FR" }: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => new Date(value));

  const weeks = useMemo(() => getMonthMatrix(viewMonth), [viewMonth]);
  const weekdayNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [locale]);

  const label = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    });
    return fmt.format(value);
  }, [value, withTime, locale]);

  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(viewMonth),
    [viewMonth, locale]
  );

  function pickDay(day: Date) {
    const next = new Date(value);
    next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
    onChange(next);
  }

  function pickHour(h: number) {
    const next = new Date(value);
    next.setHours(h);
    onChange(next);
  }
  function pickMinute(m: number) {
    const next = new Date(value);
    next.setMinutes(m);
    onChange(next);
  }

  // Minute la plus proche (pas de 5) pour refleter une valeur non alignee.
  const selectedMinute = MINUTES.includes(value.getMinutes())
    ? value.getMinutes()
    : Math.round(value.getMinutes() / 5) * 5 % 60;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-start font-normal">
          <CalendarDays className="size-4 text-muted-foreground" />
          <span className="capitalize">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <div className="flex items-center justify-between pb-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setViewMonth((m) => addMonths(m, -1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm font-medium capitalize">{monthLabel}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setViewMonth((m) => addMonths(m, 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] text-muted-foreground">
          {weekdayNames.map((w, i) => (
            <div key={i} className="py-1 capitalize">{w}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-0.5">
          {weeks.flat().map((day, i) => {
            const inMonth = isSameMonth(day, viewMonth);
            const selected = isSameDay(day, value);
            return (
              <button
                key={i}
                type="button"
                onClick={() => pickDay(day)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-sm hover:bg-accent",
                  !inMonth && "text-muted-foreground/50",
                  isToday(day) && !selected && "font-semibold text-primary",
                  selected && "bg-primary text-primary-foreground hover:bg-primary"
                )}
              >
                {day.getDate()}
              </button>
            );
          })}
        </div>

        {withTime && (
          <div className="mt-3 flex items-center justify-center gap-1.5 border-t pt-3">
            <Select value={String(value.getHours())} onValueChange={(v) => pickHour(Number(v))}>
              <SelectTrigger className="w-[4.5rem]">
                <SelectValue>{pad(value.getHours())}</SelectValue>
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {HOURS.map((h) => (
                  <SelectItem key={h} value={String(h)}>{pad(h)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">:</span>
            <Select value={String(selectedMinute)} onValueChange={(v) => pickMinute(Number(v))}>
              <SelectTrigger className="w-[4.5rem]">
                <SelectValue>{pad(selectedMinute)}</SelectValue>
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {MINUTES.map((m) => (
                  <SelectItem key={m} value={String(m)}>{pad(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
