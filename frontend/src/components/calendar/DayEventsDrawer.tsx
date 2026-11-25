"use client";

import { isPendingInvitation, pendingInvitationStyle } from "@/lib/invitation-style";
import { useMemo } from "react";
import { startOfDay } from "date-fns";
import { CalendarOff, Plus } from "lucide-react";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { eventDayRange, isMultiDay } from "@/lib/utils/calendar";
import type { CalendarEvent } from "@/lib/pocketbase";

interface DayEventsDrawerProps {
  day: Date | null;
  events: CalendarEvent[];
  colorOf: (groupId: string) => string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEventClick: (event: CalendarEvent) => void;
  onCreate: (day: Date) => void;
  locale: string;
}

/** L'event couvre-t-il ce jour (debut <= jour <= fin) ? */
function coversDay(event: CalendarEvent, day: Date): boolean {
  const { startDay, endDay } = eventDayRange(event);
  return day >= startDay && day <= endDay;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Tiroir listant les evenements d'un jour (clic sur une case de la vue mois).
 * Un clic sur un event ouvre sa fiche detail (EventDrawer, via `onEventClick`).
 */
export function DayEventsDrawer({
  day,
  events,
  colorOf,
  open,
  onOpenChange,
  onEventClick,
  onCreate,
  locale,
}: DayEventsDrawerProps) {
  const t = useT();

  const fmt = useMemo(
    () => ({
      title: new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }),
      time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }),
    }),
    [locale]
  );

  const dayEvents = useMemo(() => {
    if (!day) return [];
    const d = startOfDay(day);
    return events
      .filter((e) => coversDay(e, d))
      .sort((a, b) => {
        const aAll = a.all_day || isMultiDay(a);
        const bAll = b.all_day || isMultiDay(b);
        if (aAll !== bAll) return aAll ? -1 : 1; // all-day / multi-jours en premier
        return +new Date(a.start) - +new Date(b.start);
      });
  }, [day, events]);

  return (
    <ResponsivePanel
      open={open}
      onOpenChange={onOpenChange}
      title={day ? capitalize(fmt.title.format(day)) : ""}
      headerActions={
        day ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onCreate(day)}
            title={t("calendar.newEvent")}
          >
            <Plus className="size-4" />
          </Button>
        ) : null
      }
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {dayEvents.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
            <CalendarOff className="size-8 opacity-40" />
            <p className="text-sm">{t("calendar.noEvents")}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-1"
              onClick={() => day && onCreate(day)}
            >
              <Plus className="size-4" />
              {t("calendar.newEvent")}
            </Button>
          </div>
        ) : (
          <div className="space-y-0.5">
            {dayEvents.map((event) => {
              const color = colorOf(event.group);
              const allDay = event.all_day || isMultiDay(event);
              return (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => onEventClick(event)}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-accent"
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={isPendingInvitation(event) ? { border: `1.5px dashed ${color}` } : { backgroundColor: color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {event.title || t("calendar.untitled")}
                    {isPendingInvitation(event) && (
                      <span className="text-muted-foreground" data-invitation="pending">
                        {" · "}
                        {t("invitation.calendarSuffix")}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                    {allDay ? t("calendar.allDay") : fmt.time.format(new Date(event.start))}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </ResponsivePanel>
  );
}
