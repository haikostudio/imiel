"use client";

import { useMemo, useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Selecteur de periode commun (competence « selecteur-de-periode », modele de
 * reference Kipou, port de HaikoBill) : raccourcis 7 j / 30 j / 90 j / 1 an et
 * un bouton qui AFFICHE la plage couverte et ouvre un calendrier deux mois (un
 * seul sur telephone) avec Annuler / Appliquer. Rien ne change avant Appliquer.
 * Dates en "AAAA-MM-JJ" LOCALES (jamais toISOString : decalage de fuseau).
 */
export type Period = { type: "preset"; days: number } | { type: "range"; from: string; to: string };

export const PERIOD_PRESETS = [7, 30, 90, 365];
const RANGE_MAX_DAYS = 366;
export const DEFAULT_PERIOD: Period = { type: "preset", days: 30 };

const pad = (n: number) => String(n).padStart(2, "0");
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dateOf = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s: string, n: number) => {
  const d = dateOf(s);
  d.setDate(d.getDate() + n);
  return localDay(d);
};
export const daysBetween = (a: string, b: string) =>
  Math.round((dateOf(b).getTime() - dateOf(a).getTime()) / 86_400_000);
const today = () => localDay(new Date());
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Premier et dernier jour couverts (aujourd'hui compris pour un raccourci). */
export function periodBounds(p: Period): { from: string; to: string } {
  if (p.type === "range") return { from: p.from, to: p.to };
  const to = today();
  return { from: addDays(to, -(p.days - 1)), to };
}

/** Periode gardee par l'ecran (une cle par ecran) ; valeur abimee = defaut. */
export function readPeriod(key: string): Period {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    if (!raw) return DEFAULT_PERIOD;
    const p = JSON.parse(raw) as Period;
    if (p.type === "preset" && PERIOD_PRESETS.includes(p.days)) return p;
    if (p.type === "range" && isDay(p.from) && isDay(p.to) && p.from <= p.to) return p;
  } catch {
    /* valeur abimee */
  }
  return DEFAULT_PERIOD;
}

export function writePeriod(key: string, p: Period) {
  try {
    window.localStorage.setItem(key, JSON.stringify(p));
  } catch {
    /* stockage indisponible */
  }
}

const LOCALES: Record<string, string> = { fr: "fr-FR", en: "en-GB", de: "de-DE", it: "it-IT" };

function useFormats() {
  const language = useSettingsStore((s) => s.language) || "fr";
  return useMemo(() => {
    const loc = LOCALES[language] || "fr-FR";
    return {
      short: new Intl.DateTimeFormat(loc, { day: "numeric", month: "short" }),
      long: new Intl.DateTimeFormat(loc, { day: "numeric", month: "short", year: "numeric" }),
      month: new Intl.DateTimeFormat(loc, { month: "long", year: "numeric" }),
      dayLong: new Intl.DateTimeFormat(loc, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
      weekdays: Array.from({ length: 7 }, (_, i) =>
        new Intl.DateTimeFormat(loc, { weekday: "narrow" }).format(new Date(2024, 0, 1 + i)),
      ),
    };
  }, [language]);
}

/** « 3 sept. – 2 oct. » (l'annee seulement hors de l'annee en cours). */
export function rangeLabel(from: string, to: string, f: { short: Intl.DateTimeFormat; long: Intl.DateTimeFormat }): string {
  const year = String(new Date().getFullYear());
  const fmt = from.startsWith(year) && to.startsWith(year) ? f.short : f.long;
  return from === to ? fmt.format(dateOf(from)) : `${fmt.format(dateOf(from))} – ${fmt.format(dateOf(to))}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function PeriodSelector({
  period,
  onChange,
  className,
}: {
  period: Period;
  onChange: (p: Period) => void;
  className?: string;
}) {
  const t = useT();
  const f = useFormats();
  const [open, setOpen] = useState(false);
  const b = periodBounds(period);

  return (
    <div
      data-ref="period-selector"
      className={cn("flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center", className)}
    >
      <div
        role="group"
        aria-label={t("period.label")}
        className="grid h-9 grid-cols-4 items-stretch gap-1 rounded-lg border bg-card p-1 sm:inline-grid sm:auto-cols-auto"
      >
        {PERIOD_PRESETS.map((days) => {
          const active = period.type === "preset" && period.days === days;
          return (
            <button
              key={days}
              type="button"
              aria-pressed={active}
              data-ref={`period-preset-${days}`}
              onClick={() => onChange({ type: "preset", days })}
              className={cn(
                "rounded-md px-2 text-sm font-medium whitespace-nowrap transition-colors sm:px-3",
                active ? "bg-primary text-primary-foreground" : "text-foreground/70 hover:bg-accent hover:text-foreground",
              )}
            >
              {days === 365 ? t("period.year") : t("period.days", { n: String(days) })}
            </button>
          );
        })}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-ref="period-range"
            aria-haspopup="dialog"
            title={t("period.pick")}
            className={cn(
              "inline-flex h-9 min-w-0 items-center gap-2 rounded-lg border bg-card px-3 text-sm font-medium transition-colors hover:bg-accent",
              period.type === "range" ? "border-primary text-primary" : "border-border",
            )}
          >
            <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left tabular-nums">{rangeLabel(b.from, b.to, f)}</span>
            <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} collisionPadding={8} className="w-auto max-w-[calc(100vw-1rem)] p-0">
          {open && (
            <RangeCalendar
              from={b.from}
              to={b.to}
              onCancel={() => setOpen(false)}
              onApply={(from, to) => {
                setOpen(false);
                onChange({ type: "range", from, to });
              }}
            />
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Deux mois cote a cote (un seul sur telephone) ; 1er clic = debut, 2e = fin. */
function RangeCalendar({
  from,
  to,
  onCancel,
  onApply,
}: {
  from: string;
  to: string;
  onCancel: () => void;
  onApply: (from: string, to: string) => void;
}) {
  const t = useT();
  const f = useFormats();
  const now = today();
  const [two] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches);
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState<string | null>(to);
  const [hover, setHover] = useState<string | null>(null);
  const [month, setMonth] = useState(() => {
    const d = dateOf(to > now ? now : to);
    return new Date(d.getFullYear(), d.getMonth() - (two ? 1 : 0), 1);
  });

  const tip = end ?? hover;
  const [a, z] = tip ? (tip < start ? [tip, start] : [start, tip]) : [start, start];

  function pick(j: string) {
    if (end !== null) {
      setStart(j);
      setEnd(null);
      return;
    }
    if (j < start) {
      setEnd(start);
      setStart(j);
    } else setEnd(j);
  }

  const outOfRange = (j: string) => j > now || (end === null && Math.abs(daysBetween(start, j)) >= RANGE_MAX_DAYS);
  const months = useMemo(
    () => (two ? [month, new Date(month.getFullYear(), month.getMonth() + 1, 1)] : [month]),
    [two, month],
  );
  const last = months[months.length - 1];
  const nextDisabled = localDay(new Date(last.getFullYear(), last.getMonth() + 1, 1)) > now;

  return (
    <div role="dialog" aria-label={t("period.pick")} className="p-3 sm:p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
        {months.map((m, k) => {
          const offset = (m.getDay() + 6) % 7;
          const nb = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
          const cells: (string | null)[] = [
            ...Array.from({ length: offset }, () => null),
            ...Array.from({ length: nb }, (_, i) => localDay(new Date(m.getFullYear(), m.getMonth(), i + 1))),
          ];
          return (
            <div key={localDay(m)} className="w-[17.5rem] max-w-full">
              <div className="mb-2 flex h-8 items-center justify-between">
                {k === 0 ? (
                  <button
                    type="button"
                    aria-label={t("period.prevMonth")}
                    onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                    className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                ) : (
                  <span className="size-8" />
                )}
                <span className="text-sm font-semibold">{capitalize(f.month.format(m))}</span>
                {k === months.length - 1 ? (
                  <button
                    type="button"
                    aria-label={t("period.nextMonth")}
                    disabled={nextDisabled}
                    onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                    className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                ) : (
                  <span className="size-8" />
                )}
              </div>
              <div role="grid" className="grid grid-cols-7 gap-y-1" onMouseLeave={() => setHover(null)}>
                {f.weekdays.map((w, i) => (
                  <span key={i} aria-hidden className="flex h-7 items-center justify-center text-xs font-medium text-muted-foreground">
                    {w.toUpperCase()}
                  </span>
                ))}
                {cells.map((j, i) => {
                  if (!j) return <span key={`v${i}`} />;
                  const off = outOfRange(j);
                  const inside = j >= a && j <= z;
                  const edge = j === a || j === z;
                  const day = dateOf(j).getDate();
                  const bandStart = j === a || i % 7 === 0 || day === 1;
                  const bandEnd = j === z || i % 7 === 6 || day === nb;
                  return (
                    <button
                      key={j}
                      type="button"
                      disabled={off}
                      data-day={j}
                      onClick={() => pick(j)}
                      onMouseEnter={() => setHover(j)}
                      aria-label={f.dayLong.format(dateOf(j))}
                      aria-pressed={edge}
                      className={cn(
                        "relative flex h-9 items-center justify-center text-sm tabular-nums transition-colors disabled:cursor-default disabled:text-muted-foreground/40",
                        inside && "bg-primary/15",
                        inside && bandStart && "rounded-l-full",
                        inside && bandEnd && "rounded-r-full",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-9 items-center justify-center rounded-full",
                          edge && "bg-primary font-semibold text-primary-foreground",
                          !edge && !off && "hover:bg-accent",
                          j === now && !edge && "font-semibold text-primary ring-1 ring-primary/40",
                        )}
                      >
                        {day}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <span data-ref="period-summary" className="text-sm text-muted-foreground tabular-nums">
          {end
            ? `${rangeLabel(start, end, f)} · ${t("period.nDays", { n: String(daysBetween(start, end) + 1) })}`
            : t("period.pickEnd")}
        </span>
        <span className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button type="button" size="sm" disabled={!end} onClick={() => end && onApply(start, end)} data-ref="period-apply">
            {t("period.apply")}
          </Button>
        </span>
      </div>
    </div>
  );
}
