"use client";

import { isPendingInvitation, pendingInvitationStyle } from "@/lib/invitation-style";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { isSameDay, isToday, startOfDay } from "date-fns";
import { CalendarOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { eventDayRange } from "@/lib/utils/calendar";
import { useT } from "@/lib/i18n";
import type { CalendarEvent } from "@/lib/pocketbase";

interface ListViewProps {
  events: CalendarEvent[];
  colorOf: (groupId: string) => string;
  onEventClick: (event: CalendarEvent) => void;
  onReachTop?: () => void;
  loading?: boolean;
  locale: string;
  /** Incremente par le bouton "Aujourd'hui" du parent pour forcer le retour sur aujourd'hui. */
  focusTodaySignal?: number;
}

interface DayGroup {
  day: Date;
  events: CalendarEvent[];
}

function dayKey(day: Date): string {
  return `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
}

export function ListView({
  events,
  colorOf,
  onEventClick,
  onReachTop,
  loading = false,
  locale,
  focusTodaySignal = 0,
}: ListViewProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const todayRef = useRef<HTMLDivElement | null>(null);
  // Tant que l'utilisateur n'a pas defile manuellement, on (re)cale la liste sur
  // aujourd'hui a chaque vague de donnees -- evite qu'un 1er rendu sur une fenetre
  // de dates encore partielle ne fige le scroll au mauvais endroit.
  const userInteractedRef = useRef(false);
  const topLoadArmedRef = useRef(true);
  const pendingTopLoadRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  // Formatage localise (date-fns `format` est en anglais par defaut).
  const fmt = useMemo(
    () => ({
      day: new Intl.DateTimeFormat(locale, { day: "numeric" }),
      weekday: new Intl.DateTimeFormat(locale, { weekday: "short" }),
      month: new Intl.DateTimeFormat(locale, { month: "short" }),
      time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }),
    }),
    [locale]
  );

  const dayGroups = useMemo<DayGroup[]>(() => {
    const today = startOfDay(new Date());
    const sorted = [...events].sort((a, b) => +new Date(a.start) - +new Date(b.start));
    const groups: DayGroup[] = [];
    for (const event of sorted) {
      const { startDay } = eventDayRange(event);
      const last = groups[groups.length - 1];
      if (last && isSameDay(last.day, startDay)) {
        last.events.push(event);
      } else {
        groups.push({ day: startDay, events: [event] });
      }
    }
    if (!groups.some((group) => isSameDay(group.day, today))) {
      groups.push({ day: today, events: [] });
      groups.sort((a, b) => +a.day - +b.day);
    }
    return groups;
  }, [events]);

  // Place aujourd'hui en haut du conteneur (calcul relatif au scroller : evite
  // que scrollIntoView ne fasse defiler aussi les parents / la fenetre).
  const scrollToToday = useCallback(() => {
    const el = todayRef.current;
    const scroller = scrollRef.current;
    if (!el || !scroller) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top);
  }, []);

  const markInteracted = useCallback(() => {
    userInteractedRef.current = true;
  }, []);

  // Auto-ancrage initial (et a chaque vague de donnees) tant que l'utilisateur
  // n'a pas defile lui-meme.
  useEffect(() => {
    if (loading || userInteractedRef.current) return;
    const raf = requestAnimationFrame(scrollToToday);
    return () => cancelAnimationFrame(raf);
  }, [dayGroups, loading, scrollToToday]);

  // Bouton "Aujourd'hui" du parent : force le retour sur aujourd'hui et re-arme
  // l'auto-ancrage (utile si les events ne sont pas encore charges).
  const firstSignalRef = useRef(true);
  useEffect(() => {
    if (firstSignalRef.current) {
      firstSignalRef.current = false;
      return;
    }
    userInteractedRef.current = false;
    const raf = requestAnimationFrame(scrollToToday);
    return () => cancelAnimationFrame(raf);
  }, [focusTodaySignal, scrollToToday]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const pending = pendingTopLoadRef.current;
    if (!scroller || !pending) return;
    const delta = scroller.scrollHeight - pending.scrollHeight;
    if (delta > 0) scroller.scrollTop = pending.scrollTop + delta;
    pendingTopLoadRef.current = null;
  }, [dayGroups]);

  const handleScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller || !onReachTop) return;
    if (scroller.scrollTop > 120) {
      topLoadArmedRef.current = true;
      return;
    }
    if (!topLoadArmedRef.current || loading) return;
    topLoadArmedRef.current = false;
    pendingTopLoadRef.current = {
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
    };
    onReachTop();
  };

  if (!loading && events.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <CalendarOff className="size-10 opacity-40" />
        <p className="text-sm">{t("calendar.noEvents")}</p>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={markInteracted}
      onTouchMove={markInteracted}
      onPointerDown={markInteracted}
      className="h-full overflow-x-hidden overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-2xl divide-y">
        {dayGroups.map((group) => {
          const currentDay = isToday(group.day);
          return (
            <div
              key={dayKey(group.day)}
              ref={currentDay ? todayRef : undefined}
              className={cn(
                "flex gap-3 border-l-2 px-3 py-2 sm:gap-4 sm:px-4 sm:py-3",
                currentDay ? "border-l-primary bg-primary/5" : "border-l-transparent"
              )}
            >
              <div className="w-9 shrink-0 pt-0.5 text-right sm:w-14">
                <div
                  className={cn(
                    "ml-auto flex size-8 items-center justify-center rounded-full text-lg font-semibold leading-none sm:text-2xl sm:font-light",
                    currentDay && "bg-primary text-primary-foreground"
                  )}
                >
                  {fmt.day.format(group.day)}
                </div>
                <div className="text-[10px] uppercase leading-tight text-muted-foreground sm:text-xs">
                  {fmt.weekday.format(group.day)}
                </div>
                <div className="text-[10px] leading-tight text-muted-foreground">{fmt.month.format(group.day)}</div>
              </div>
              <div className="min-w-0 flex-1 space-y-0.5">
                {group.events.length === 0 && currentDay && (
                  <div className="px-2 py-1.5 text-sm font-medium text-primary">{t("calendar.today")}</div>
                )}
                {group.events.map((event) => {
                  const color = colorOf(event.group);
                  return (
                    <button
                      key={event.id}
                      type="button"
                      onClick={() => onEventClick(event)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={isPendingInvitation(event) ? { border: `1.5px dashed ${color}` } : { backgroundColor: color }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {event.title}
                        {isPendingInvitation(event) && (
                          <span className="text-muted-foreground" data-invitation="pending">
                            {" · "}
                            {t("invitation.calendarSuffix")}
                          </span>
                        )}
                      </span>
                      {event.all_day ? (
                        // Libelle long masque en mobile (l'absence d'heure suffit) :
                        // sinon "Toute la journee" (nowrap) impose une largeur qui
                        // deborde l'ecran.
                        <span className="hidden shrink-0 whitespace-nowrap text-xs text-muted-foreground sm:inline">
                          {t("calendar.allDay")}
                        </span>
                      ) : (
                        <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground sm:text-xs">
                          {fmt.time.format(new Date(event.start))}
                        </span>
                      )}
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
