"use client";

import { PageSearchField } from "@/components/layout/PageSearchField";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  endOfMonth,
  endOfWeek,
  endOfYear,
  isSameWeek,
  isSameYear,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from "date-fns";
import {
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  List,
  MoreVertical,
  Plus,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { useAgendaEvents } from "@/lib/hooks/useAgendaEvents";
import { useCalendarGroups } from "@/lib/hooks/useCalendarGroups";
import { getWeekDays, type CalendarView } from "@/lib/utils/calendar";
import { calendarEvents, type CalendarEvent } from "@/lib/pocketbase";
import { useHashRouter } from "@/lib/hash-router";
import { YearView } from "@/components/calendar/YearView";
import { MonthScroll } from "@/components/calendar/MonthScroll";
import { WeekView } from "@/components/calendar/WeekView";
import { InfinitePager } from "@/components/calendar/InfinitePager";
import { ListView } from "@/components/calendar/ListView";
import { EventDrawer } from "@/components/calendar/EventDrawer";
import { DayEventsDrawer } from "@/components/calendar/DayEventsDrawer";
import { EventForm } from "@/components/calendar/EventForm";
import { GroupManager, GroupManagerContent } from "@/components/calendar/GroupManager";

const LOCALES: Record<string, string> = { fr: "fr-FR", en: "en-US", de: "de-DE", it: "it-IT" };
const STORAGE_KEY = "imiel:calendarState";

// Config des vues : reutilisee par les onglets (desktop) et le dropdown (mobile).
const VIEW_OPTIONS: { value: CalendarView; icon: typeof CalendarDays; labelKey: string }[] = [
  { value: "year", icon: LayoutGrid, labelKey: "calendar.year" },
  { value: "month", icon: CalendarDays, labelKey: "calendar.month" },
  { value: "week", icon: CalendarRange, labelKey: "calendar.week" },
  { value: "list", icon: List, labelKey: "calendar.list" },
];

// Helpers du pager infini (mois/semaine/annee) : semaine commencant le lundi.
const WEEK_OPTS = { weekStartsOn: 1 as const };
const yearKey = (d: Date) => `${d.getFullYear()}`;
const weekKey = (d: Date) => {
  const s = startOfWeek(d, WEEK_OPTS);
  return `${s.getFullYear()}-${s.getMonth()}-${s.getDate()}`;
};
const sameWeek = (a: Date, b: Date) => isSameWeek(a, b, WEEK_OPTS);

function loadState(): { view: CalendarView; refDate: string } {
  if (typeof window === "undefined") return { view: "month", refDate: new Date().toISOString() };
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // ignore
  }
  return { view: "month", refDate: new Date().toISOString() };
}

export default function CalendarPage() {
  const t = useT();
  const language = useSettingsStore((s) => s.language);
  const locale = LOCALES[language] || "en-US";

  const initial = useRef(loadState());
  const [view, setView] = useState<CalendarView>(initial.current.view);
  const [refDate, setRefDate] = useState<Date>(() => new Date(initial.current.refDate));
  const [listRangeStart, setListRangeStart] = useState<Date>(() => addDays(startOfDay(new Date()), -90));
  const [listRangeEnd] = useState<Date>(() => addDays(startOfDay(new Date()), 365));

  const { accounts } = useAccounts();
  const { groups, loading: groupsLoading, refresh: refreshGroups, createGroup, updateGroup, deleteGroup, toggleVisibility } =
    useCalendarGroups();

  // Persiste vue + date.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ view, refDate: refDate.toISOString() }));
    } catch {
      // ignore
    }
  }, [view, refDate]);

  // Fenetre de dates a charger selon la vue. Elargie (+/- quelques periodes)
  // car le pager infini rend aussi les periodes voisines : il leur faut leurs
  // events sans attendre que le scroll recentre la fenetre.
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (view === "year") {
      return { rangeStart: startOfYear(addYears(refDate, -1)), rangeEnd: endOfYear(addYears(refDate, 1)) };
    }
    if (view === "week") {
      return {
        rangeStart: startOfWeek(addWeeks(refDate, -2), WEEK_OPTS),
        rangeEnd: endOfWeek(addWeeks(refDate, 2), WEEK_OPTS),
      };
    }
    if (view === "list") {
      return { rangeStart: listRangeStart, rangeEnd: listRangeEnd };
    }
    return {
      rangeStart: startOfWeek(startOfMonth(addMonths(refDate, -2)), WEEK_OPTS),
      rangeEnd: endOfWeek(endOfMonth(addMonths(refDate, 2)), WEEK_OPTS),
    };
  }, [view, refDate, listRangeStart, listRangeEnd]);

  const { events, loading, createEvent, updateEvent, deleteEvent, syncAccount, syncing } = useAgendaEvents(
    rangeStart,
    rangeEnd
  );

  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const colorOf = useCallback((groupId: string) => groupMap.get(groupId)?.color || "#888", [groupMap]);

  // Un evenement range dans plusieurs agendas (copies liees, meme copy_key)
  // s'affiche UNE fois, dans la couleur de son premier agenda visible ; sa
  // fiche liste tous ses agendas.
  const visibleEvents = useMemo(() => {
    const seen = new Set<string>();
    const out: CalendarEvent[] = [];
    for (const e of events) {
      const g = groupMap.get(e.group);
      if (g && !g.is_visible) continue;
      if (e.copy_key) {
        if (seen.has(e.copy_key)) continue;
        seen.add(e.copy_key);
      }
      out.push(e);
    }
    return out;
  }, [events, groupMap]);

  const copyGroupsOf = useCallback(
    (ev: CalendarEvent | null): string[] => {
      if (!ev) return [];
      if (!ev.copy_key) return [ev.group];
      const ids = events.filter((e) => e.copy_key === ev.copy_key).map((e) => e.group);
      return ids.length ? ids : [ev.group];
    },
    [events]
  );

  // Cree un groupe local par defaut au premier passage si aucun n'existe.
  // ATTENDRE la fin du chargement : groups est vide PENDANT le fetch, seeder la
  // re-creerait "Perso" (index unique user+name) -> 400 + toast "action a echoue".
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || groupsLoading || groups.length > 0) return;
    seededRef.current = true;
    createGroup({ name: "Perso", color: "#3b82f6" });
  }, [groupsLoading, groups.length, createGroup]);

  // --- Drawer (details / edit) ---
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // --- Drawer "evenements du jour" (clic sur une case de la vue mois) ---
  const [dayDrawerDay, setDayDrawerDay] = useState<Date | null>(null);
  const [dayDrawerOpen, setDayDrawerOpen] = useState(false);

  // Signal incremente par "Aujourd'hui" pour forcer le scroll de la vue Liste.
  const [focusTodaySignal, setFocusTodaySignal] = useState(0);

  // Tiroirs mobiles (remplacent les dropdowns : tout tient sur une barre).
  const [viewDrawerOpen, setViewDrawerOpen] = useState(false);
  const [optionsDrawerOpen, setOptionsDrawerOpen] = useState(false);

  // Deep-link depuis la recherche globale : #/calendar?event=<id>. On charge
  // l'event (meme hors fenetre courante), recentre la date et ouvre le drawer,
  // puis on nettoie le param pour ne pas re-declencher.
  const { searchParams, replace } = useHashRouter();
  const eventParam = searchParams.get("event");
  useEffect(() => {
    if (!eventParam) return;
    let cancelled = false;
    (async () => {
      let ev = events.find((e) => e.id === eventParam) ?? null;
      if (!ev) {
        try {
          ev = await calendarEvents().getOne<CalendarEvent>(eventParam);
        } catch {
          ev = null;
        }
      }
      // Rendu abandonne (page remontee au passage ordinateur -> telephone) :
      // ne PAS consommer le parametre, c'est le nouveau rendu qui ouvre la
      // fiche. Avant, l'ancien retirait ?event= et le nouveau n'ouvrait rien.
      if (cancelled) return;
      if (ev) {
        setRefDate(new Date(ev.start));
        setSelectedEvent(ev);
        setDrawerOpen(true);
      }
      replace("/calendar");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventParam]);

  // --- Create form ---
  const [createOpen, setCreateOpen] = useState(false);
  const [createDefault, setCreateDefault] = useState<Date | null>(null);

  const handleEventClick = useCallback((event: CalendarEvent) => {
    setSelectedEvent(event);
    setDrawerOpen(true);
  }, []);

  // Ouvre le formulaire de creation pre-rempli sur un jour (9h par defaut).
  const openCreateForDay = useCallback((day: Date) => {
    const start = new Date(day);
    start.setHours(9, 0, 0, 0);
    setDayDrawerOpen(false);
    setCreateDefault(start);
    setCreateOpen(true);
  }, []);

  const handleDayClick = useCallback(
    (day: Date) => {
      if (view === "year") {
        setRefDate(day);
        setView("week");
        return;
      }
      // Vue mois : un clic sur le jour ouvre la liste des evenements du jour.
      if (view === "month") {
        setDayDrawerDay(day);
        setDayDrawerOpen(true);
        return;
      }
      openCreateForDay(day);
    },
    [view, openCreateForDay]
  );

  // Clic sur un event depuis le tiroir "evenements du jour" -> ouvre sa fiche
  // PAR-DESSUS la liste (on ne ferme PAS le tiroir du jour : a la fermeture de
  // la fiche, on revient sur la liste). La fiche s'empile via z-[60] (EventDrawer).
  const handleDayEventClick = useCallback((event: CalendarEvent) => {
    setSelectedEvent(event);
    setDrawerOpen(true);
  }, []);

  const handleToday = useCallback(() => {
    setRefDate(new Date());
    setFocusTodaySignal((n) => n + 1);
  }, []);

  const shift = useCallback(
    (dir: number) => {
      setRefDate((d) => {
        if (view === "year") return addYears(d, dir);
        if (view === "week") return addWeeks(d, dir);
        return addMonths(d, dir);
      });
    },
    [view]
  );

  const title = useMemo(() => {
    if (view === "year") return String(refDate.getFullYear());
    if (view === "list") return t("calendar.list");
    if (view === "week") {
      const days = getWeekDays(refDate);
      const fmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
      const fmtY = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
      return `${fmt.format(days[0])} – ${fmtY.format(days[6])}`;
    }
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(refDate);
  }, [view, refDate, locale, t]);

  const googleAccounts = useMemo(() => accounts.filter((a) => a.auth_type === "oauth2"), [accounts]);

  const activeView = VIEW_OPTIONS.find((v) => v.value === view) ?? VIEW_OPTIONS[1];

  const handleSync = useCallback(async () => {
    if (googleAccounts.length === 0) return;
    let reconnect = false;
    for (const a of googleAccounts) {
      const res = await syncAccount(a.id);
      if (res && "needsReconnect" in res && res.needsReconnect) reconnect = true;
    }
    await refreshGroups();
    if (reconnect) toast.error(t("calendar.reconnectHint"));
    else toast.success(t("calendar.syncDone"));
  }, [googleAccounts, syncAccount, refreshGroups, t]);

  const handleListReachTop = useCallback(() => {
    setListRangeStart((start) => addDays(start, -90));
  }, []);

  return (
    <div data-ref="calendar-page" className="relative flex h-full w-full min-w-0 flex-col overflow-x-hidden">
      {/* Toolbar : une seule barre (desktop ET mobile). En mobile, les dropdowns
          (vue, groupes) deviennent des tiroirs pour gagner de la place. */}
      {/* Miel ordinateur : la recherche en tete de la page (recherche globale). */}
      <PageSearchField placeholder={t("searchIn.calendar")} className="mt-3.5 mb-1.5" />
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-2 sm:gap-2 sm:px-3">
        {/* Desktop : "Aujourd'hui" (texte) + fleches de navigation */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleToday}
          className="hidden shrink-0 sm:inline-flex"
        >
          {t("calendar.today")}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => shift(-1)}
          disabled={view === "list"}
          className="hidden shrink-0 sm:inline-flex"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => shift(1)}
          disabled={view === "list"}
          className="hidden shrink-0 sm:inline-flex"
        >
          <ChevronRight className="size-4" />
        </Button>

        {/* Mobile : selecteur de vue a la place du libelle -> ouvre le tiroir des vues */}
        <Button
          variant="ghost"
          onClick={() => setViewDrawerOpen(true)}
          title={t("calendar.view")}
          className="flex h-9 min-w-0 flex-1 items-center justify-start gap-1.5 px-1.5 sm:hidden"
        >
          <activeView.icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium capitalize">{title}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>

        {/* Desktop : titre de la periode */}
        <span className="hidden min-w-0 flex-1 truncate text-sm font-medium capitalize sm:block">
          {title}
        </span>

        {/* Cluster desktop : onglets + actions inline */}
        <div className="hidden items-center gap-2 sm:flex">
          <Tabs value={view} onValueChange={(v) => setView(v as CalendarView)}>
            <TabsList>
              {VIEW_OPTIONS.map((opt) => (
                <TabsTrigger key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <GroupManager
            groups={groups}
            onCreate={async (d) => { await createGroup(d); }}
            onUpdate={async (id, d) => { await updateGroup(id, d); }}
            onDelete={async (id) => { await deleteGroup(id); }}
            onToggle={async (id) => { await toggleVisibility(id); }}
            trigger={
              <Button variant="ghost" size="icon-sm" title={t("calendar.manageGroups")}>
                <SlidersHorizontal className="size-4" />
              </Button>
            }
          />

          {googleAccounts.length > 0 && (
            <Button variant="ghost" size="icon-sm" onClick={handleSync} disabled={syncing} title={t("calendar.sync")}>
              <RefreshCw className={syncing ? "size-4 animate-spin" : "size-4"} />
            </Button>
          )}

          <Button size="sm" onClick={() => { setCreateDefault(new Date()); setCreateOpen(true); }}>
            <Plus className="size-4" />
            {t("calendar.newEvent")}
          </Button>
        </div>

        {/* Cluster mobile (droite) : Aujourd'hui (icone) + options (points verticaux) */}
        <div className="flex items-center gap-1 sm:hidden">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={handleToday}
            title={t("calendar.today")}
            className="shrink-0"
          >
            <CalendarCheck className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setOptionsDrawerOpen(true)}
            title={t("calendar.options")}
            className="shrink-0"
          >
            <MoreVertical className="size-4" />
          </Button>
        </div>
      </div>

      {/* Content : mois/semaine/annee en pager a defilement infini (scroller =
          periode suivante/precedente) ; la Liste garde son propre scroll. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "year" && (
          <InfinitePager
            orientation="vertical"
            value={refDate}
            onChange={setRefDate}
            step={addYears}
            samePeriod={isSameYear}
            keyOf={yearKey}
            radius={6}
            renderPanel={(d) => (
              <YearView refDate={d} events={visibleEvents} colorOf={colorOf} onDayClick={handleDayClick} locale={locale} />
            )}
          />
        )}
        {view === "month" && (
          // En-tete des jours FIXE + defilement fluide/infini des semaines (pas
          // de scroll-snap mois par mois) : desktop comme mobile.
          <MonthScroll
            value={refDate}
            onChange={setRefDate}
            focusSignal={focusTodaySignal}
            events={visibleEvents}
            colorOf={colorOf}
            onDayClick={handleDayClick}
            locale={locale}
          />
        )}
        {view === "week" && (
          <InfinitePager
            orientation="horizontal"
            value={refDate}
            onChange={setRefDate}
            step={addWeeks}
            samePeriod={sameWeek}
            keyOf={weekKey}
            radius={10}
            renderPanel={(d) => (
              <WeekView
                refDate={d}
                events={visibleEvents}
                colorOf={colorOf}
                onEventClick={handleEventClick}
                onDayClick={handleDayClick}
                locale={locale}
              />
            )}
          />
        )}
        {view === "list" && (
          <ListView
            events={visibleEvents}
            colorOf={colorOf}
            onEventClick={handleEventClick}
            onReachTop={handleListReachTop}
            loading={loading}
            locale={locale}
            focusTodaySignal={focusTodaySignal}
          />
        )}
      </div>

      <DayEventsDrawer
        day={dayDrawerDay}
        events={visibleEvents}
        colorOf={colorOf}
        open={dayDrawerOpen}
        onOpenChange={setDayDrawerOpen}
        onEventClick={handleDayEventClick}
        onCreate={openCreateForDay}
        locale={locale}
      />

      <EventDrawer
        event={selectedEvent}
        groups={groups}
        copyGroupIds={copyGroupsOf(selectedEvent)}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onUpdate={async (id, input) => {
          await updateEvent(id, input);
          toast.success(t("calendar.eventUpdated"));
        }}
        onDelete={async (id) => {
          await deleteEvent(id);
          toast.success(t("calendar.eventDeleted"));
        }}
      />

      {/* Tiroir selecteur de vue (mobile) */}
      <ResponsivePanel
        open={viewDrawerOpen}
        onOpenChange={setViewDrawerOpen}
        title={t("calendar.view")}
        mobileHeightClass="h-auto"
      >
        <div className="flex flex-col gap-0.5 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {VIEW_OPTIONS.map((opt) => {
            const active = view === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { setView(opt.value); setViewDrawerOpen(false); }}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-accent",
                  active && "bg-accent font-medium"
                )}
              >
                <opt.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1">{t(opt.labelKey)}</span>
                {active && <Check className="size-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      </ResponsivePanel>

      {/* Tiroir options (mobile) : synchro + gestion des groupes */}
      <ResponsivePanel open={optionsDrawerOpen} onOpenChange={setOptionsDrawerOpen} title={t("calendar.options")}>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          {googleAccounts.length > 0 && (
            <Button
              variant="outline"
              className="w-full justify-start gap-2"
              onClick={handleSync}
              disabled={syncing}
            >
              <RefreshCw className={syncing ? "size-4 animate-spin" : "size-4"} />
              {t("calendar.sync")}
            </Button>
          )}
          <div className="rounded-md border p-2">
            <GroupManagerContent
              groups={groups}
              onCreate={async (d) => { await createGroup(d); }}
              onUpdate={async (id, d) => { await updateGroup(id, d); }}
              onDelete={async (id) => { await deleteGroup(id); }}
              onToggle={async (id) => { await toggleVisibility(id); }}
              onOpenSettings={() => setOptionsDrawerOpen(false)}
            />
          </div>
        </div>
      </ResponsivePanel>

      <ResponsivePanel open={createOpen} onOpenChange={setCreateOpen} title={t("calendar.newEvent")}>
        <EventForm
          groups={groups}
          defaultStart={createDefault}
          onSubmit={async (input) => {
            await createEvent(input);
            setCreateOpen(false);
            toast.success(t("calendar.eventCreated"));
          }}
          onCancel={() => setCreateOpen(false)}
        />
      </ResponsivePanel>

      {/* Bouton flotant "creer un evenement" (mobile) : remplace le + de la
          barre d'outils, ancre en bas a droite au-dessus de la safe-area. */}
      <Button
        size="icon"
        onClick={() => { setCreateDefault(new Date()); setCreateOpen(true); }}
        title={t("calendar.newEvent")}
        aria-label={t("calendar.newEvent")}
        className="absolute right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 size-14 rounded-full shadow-lg sm:hidden"
      >
        <Plus className="size-6" />
      </Button>
    </div>
  );
}
