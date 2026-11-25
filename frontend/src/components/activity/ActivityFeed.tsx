"use client";

import { useMemo, useState } from "react";
import { Loader2, Inbox } from "lucide-react";
import { isToday, isYesterday, format } from "date-fns";
import { fr } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CollapsibleTop } from "@/components/ui/collapsible-top";
import {
  useActivityFeed,
  useActivityStore,
  type ActivityFilter,
} from "@/lib/hooks/useActivity";
import type { Activity } from "@/lib/pocketbase";
import { ActivityRow } from "@/components/activity/ActivityRow";

const FILTERS: { key: ActivityFilter; labelKey: string }[] = [
  { key: "all", labelKey: "activity.filter.all" },
  { key: "mail", labelKey: "activity.filter.mail" },
  { key: "tracking", labelKey: "activity.filter.tracking" },
  { key: "newsletter", labelKey: "activity.filter.newsletter" },
  { key: "calendar", labelKey: "activity.filter.calendar" },
];

function dayLabel(d: Date, t: (k: string) => string): string {
  if (isToday(d)) return t("activity.today");
  if (isYesterday(d)) return t("activity.yesterday");
  return format(d, "EEEE d MMMM", { locale: fr });
}

function groupByDay(items: Activity[], t: (k: string) => string) {
  const groups: { key: string; label: string; items: Activity[] }[] = [];
  for (const it of items) {
    const d = new Date(it.event_date);
    const key = d.toDateString();
    const last = groups[groups.length - 1];
    if (!last || last.key !== key) {
      groups.push({ key, label: dayLabel(d, t), items: [it] });
    } else {
      last.items.push(it);
    }
  }
  return groups;
}

/**
 * Flux d'activite groupe par jour, reutilise par l'apercu de la cloche (compact,
 * `limit`, sans onglets) et par la page Activite (onglets + chargement infini).
 * Le parent fournit le contexte flex-col (ResponsivePanel ou page).
 */
export function ActivityFeed({
  showFilters = false,
  limit,
  onNavigate,
}: {
  showFilters?: boolean;
  limit?: number;
  onNavigate: (url: string) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const { items, loading, hasMore, loadMore } = useActivityFeed(filter, limit);
  const viewingSince = useActivityStore((s) => s.viewingSince);
  // PB renvoie event_date en format espace ("...Z") et viewingSince est un ISO
  // avec "T" : on compare des timestamps, jamais les chaines (le T/espace en
  // position 10 fausse l'ordre lexicographique).
  const viewingSinceMs = useMemo(() => new Date(viewingSince).getTime(), [viewingSince]);

  const groups = useMemo(() => groupByDay(items, t), [items, t]);
  const isEmpty = !loading && items.length === 0;

  return (
    <>
      {showFilters && (
        // Telephone : la rangee de filtres se replie quand on descend dans le fil.
        <CollapsibleTop data-ref="activity-list-top">
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-[10px] py-2 md:px-3">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                filter === f.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              )}
            >
              {t(f.labelKey)}
            </button>
          ))}
        </div>
        </CollapsibleTop>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Inbox className="size-9 text-muted-foreground/40" />
            <p className="max-w-xs text-sm text-muted-foreground">
              {t("activity.empty")}
            </p>
          </div>
        ) : (
          <div className="w-full px-[calc(10px-0.5rem)] py-2 md:px-2">
            {groups.map((g) => (
              <section key={g.key} className="mb-2">
                <h3 className="sticky top-0 z-10 bg-background/95 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                  {g.label}
                </h3>
                <div className="flex flex-col">
                  {g.items.map((a) => (
                    <ActivityRow
                      key={a.id}
                      activity={a}
                      isNew={new Date(a.event_date).getTime() > viewingSinceMs}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              </section>
            ))}

            {hasMore && (
              <div className="flex justify-center py-2">
                <Button variant="ghost" size="sm" onClick={loadMore} disabled={loading}>
                  {loading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    t("activity.loadMore")
                  )}
                </Button>
              </div>
            )}

            {loading && items.length === 0 && (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
