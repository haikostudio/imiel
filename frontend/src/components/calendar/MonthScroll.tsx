"use client";

import { isPendingInvitation, pendingInvitationStyle } from "@/lib/invitation-style";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addDays, addWeeks, isToday, startOfMonth, startOfWeek } from "date-fns";
import { cn } from "@/lib/utils";
import { computeWeekSegments } from "@/lib/utils/calendar";
import type { CalendarEvent } from "@/lib/pocketbase";

interface MonthScrollProps {
  /** Mois de reference (pilote par le parent : Aujourd'hui, fleches, deep-link). */
  value: Date;
  /** Emis quand le mois centre par le scroll change (maj du titre + fenetre d'events). */
  onChange: (d: Date) => void;
  /** Incremente par "Aujourd'hui" : force le recentrage sur la semaine du jour. */
  focusSignal?: number;
  events: CalendarEvent[];
  colorOf: (groupId: string) => string;
  /** Un clic n'importe ou dans un jour (barre d'event incluse) ouvre la LISTE
      du jour. Les barres sont purement visuelles : le clic traverse jusqu'a la
      cellule du jour -> onDayClick (jamais l'ouverture d'un event isole). */
  onDayClick: (day: Date) => void;
  locale: string;
}

// Semaine commencant le lundi (convention FR/EU), alignee sur calendar.ts.
const WEEK_OPTS = { weekStartsOn: 1 as const };

const MAX_LANES = 4;
const DAY_ROW_PX = 22; // hauteur du numero de jour
const BAR_PX = 18; // hauteur d'une barre d'evenement
// Hauteur FIXE d'une semaine : numero du jour + MAX_LANES barres + marge. Fixe
// car le defilement infini a besoin d'une metrique stable (recentrage au bord).
const WEEK_ROW_PX = DAY_ROW_PX + MAX_LANES * (BAR_PX + 2) + 10; // = 112
const RADIUS = 18; // nb de semaines de chaque cote du centre (fenetre = 2*RADIUS+1)

const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
const weekKey = (d: Date) => {
  const s = startOfWeek(d, WEEK_OPTS);
  return `${s.getFullYear()}-${s.getMonth()}-${s.getDate()}`;
};
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/**
 * Vue mois mobile a DEFILEMENT FLUIDE et infini : l'en-tete des jours (Lun…Dim)
 * est FIXE en haut ; seules les semaines defilent dessous, en continu (pas de
 * scroll-snap, pas de saut de mois). On peut s'arreter librement sur n'importe
 * quelle date. Implementation : une fenetre glissante de semaines (rows de
 * hauteur fixe). Quand on approche d'un bord, la fenetre est reconstruite autour
 * de la semaine courante et la position de scroll est restauree AVANT paint
 * (aucun saut visible) -> defilement sans fin.
 */
export function MonthScroll({
  value,
  onChange,
  focusSignal,
  events,
  colorOf,
  onDayClick,
  locale,
}: MonthScrollProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const build = useCallback(
    (centerWeek: Date) => Array.from({ length: RADIUS * 2 + 1 }, (_, i) => addWeeks(centerWeek, i - RADIUS)),
    []
  );

  // Au montage : 1ere semaine du mois de `value` placee EN HAUT (index RADIUS).
  const [weeks, setWeeks] = useState<Date[]>(() => build(startOfWeek(startOfMonth(value), WEEK_OPTS)));

  const suppressRef = useRef(false); // ignore les events scroll pendant un scroll programmatique
  const recenterTopRef = useRef<number | null>(WEEK_ROW_PX * RADIUS); // scrollTop a restaurer apres reconstruction (centrage initial inclus)
  const reportedMonthRef = useRef(monthKey(value)); // dernier mois remonte via onChange (evite le spam + distingue l'echo)
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null); // debounce reconstruction
  const prevFocusRef = useRef(focusSignal);

  const weekdayNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    // 2024-01-01 est un lundi.
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [locale]);

  const monthShort = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short" }), [locale]);

  // Restaure la position de scroll APRES une reconstruction de la fenetre (et
  // centrage initial), AVANT le paint -> pas de saut visuel.
  useLayoutEffect(() => {
    if (recenterTopRef.current == null) return;
    const target = recenterTopRef.current;
    recenterTopRef.current = null;
    const el = containerRef.current;
    if (!el) return;
    suppressRef.current = true;
    el.scrollTop = target;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        suppressRef.current = false;
      })
    );
  }, [weeks]);

  // Saut externe (fleches desktop, deep-link, changement de mois) : si ce n'est
  // PAS l'echo de notre propre onChange, on reconstruit autour du 1er du mois.
  useEffect(() => {
    if (monthKey(value) === reportedMonthRef.current) return;
    reportedMonthRef.current = monthKey(value);
    recenterTopRef.current = WEEK_ROW_PX * RADIUS;
    setWeeks(build(startOfWeek(startOfMonth(value), WEEK_OPTS)));
  }, [value, build]);

  // "Aujourd'hui" : recentre sur la SEMAINE du jour (placee en haut), meme si on
  // est deja dans le mois courant (ce que le saut par `value` ne couvre pas).
  useEffect(() => {
    if (focusSignal === prevFocusRef.current) return;
    prevFocusRef.current = focusSignal;
    const today = new Date();
    reportedMonthRef.current = monthKey(today);
    recenterTopRef.current = WEEK_ROW_PX * RADIUS;
    setWeeks(build(startOfWeek(today, WEEK_OPTS)));
  }, [focusSignal, build]);

  const handleScroll = useCallback(() => {
    if (suppressRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const vh = el.clientHeight || 0;

    // Mois "centre" = mois de la semaine qui croise le milieu du viewport (on
    // prend le jeudi, convention ISO du mois d'une semaine). Maj live du titre.
    const centerIdx = clamp(Math.floor((top + vh / 2) / WEEK_ROW_PX), 0, weeks.length - 1);
    const probeMonth = addDays(weeks[centerIdx], 3);
    const mk = monthKey(probeMonth);
    if (mk !== reportedMonthRef.current) {
      reportedMonthRef.current = mk;
      onChange(startOfMonth(probeMonth));
    }

    // Reconstruction de la fenetre DIFFEREE au repos (jamais en plein fling) :
    // si on s'est arrete pres d'un bord, on recentre autour de la semaine du
    // haut en preservant la position exacte -> defilement sans fin.
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(() => {
      const node = containerRef.current;
      if (!node) return;
      const t = node.scrollTop;
      const visible = Math.ceil((node.clientHeight || 0) / WEEK_ROW_PX);
      const topIdx = Math.round(t / WEEK_ROW_PX);
      if (topIdx <= 2 || topIdx >= weeks.length - visible - 2) {
        const anchor = weeks[clamp(topIdx, 0, weeks.length - 1)];
        const offset = t - topIdx * WEEK_ROW_PX; // decalage sous-ligne a conserver
        recenterTopRef.current = WEEK_ROW_PX * RADIUS + offset;
        setWeeks(build(anchor));
      }
    }, 140);
  }, [weeks, onChange, build]);

  useEffect(
    () => () => {
      if (idleRef.current) clearTimeout(idleRef.current);
    },
    []
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* En-tete FIXE des jours de la semaine */}
      <div className="grid shrink-0 grid-cols-7 border-b text-xs font-medium text-muted-foreground">
        {weekdayNames.map((w, i) => (
          <div key={i} className="px-2 py-1.5 capitalize">
            {w}
          </div>
        ))}
      </div>

      {/* Defilement fluide et infini des semaines */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="calendar-pager min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {weeks.map((weekStart) => {
          const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
          const segments = computeWeekSegments(weekDays, events);
          return (
            <div
              key={weekKey(weekStart)}
              className="relative grid grid-cols-7 border-b"
              style={{ height: WEEK_ROW_PX }}
            >
              {/* Cellules de fond + numero de jour */}
              {weekDays.map((day, di) => {
                const today = isToday(day);
                const firstOfMonth = day.getDate() === 1;
                const hiddenCount = segments.filter(
                  (s) => s.lane >= MAX_LANES && s.startCol <= di && s.endCol >= di
                ).length;
                return (
                  <button
                    key={di}
                    type="button"
                    onClick={() => onDayClick(day)}
                    data-today={today ? "true" : undefined}
                    className="flex h-full flex-col items-start border-r p-1 text-left last:border-r-0 hover:bg-accent/40"
                  >
                    <span className="flex items-center gap-1">
                      <span
                        className={cn(
                          "flex size-5 items-center justify-center rounded-full text-xs",
                          today && "calendar-today bg-primary text-primary-foreground"
                        )}
                      >
                        {day.getDate()}
                      </span>
                      {firstOfMonth && (
                        <span className="text-[10px] font-medium uppercase text-muted-foreground">
                          {monthShort.format(day)}
                        </span>
                      )}
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
                      // Barre purement visuelle (pas de pointer-events) : le clic
                      // traverse jusqu'a la cellule du jour -> ouvre la liste du jour.
                      <div
                        key={si}
                        title={seg.event.title}
                        className={cn(
                          "absolute truncate px-1.5 text-left text-[11px] leading-tight text-white",
                          seg.continuesLeft ? "rounded-l-none" : "rounded-l",
                          seg.continuesRight ? "rounded-r-none" : "rounded-r"
                        )}
                        style={{
                          left: `calc(${(seg.startCol / 7) * 100}% + 2px)`,
                          width: `calc(${((seg.endCol - seg.startCol + 1) / 7) * 100}% - 4px)`,
                          top: DAY_ROW_PX + seg.lane * (BAR_PX + 2),
                          height: BAR_PX,
                          backgroundColor: color,
                          lineHeight: `${BAR_PX - (isPendingInvitation(seg.event) ? 3 : 0)}px`,
                          ...(isPendingInvitation(seg.event) ? pendingInvitationStyle(color) : {}),
                        }}
                        data-invitation={isPendingInvitation(seg.event) ? "pending" : undefined}
                      >
                        {seg.continuesLeft ? "◂ " : ""}
                        {seg.event.title}
                      </div>
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
