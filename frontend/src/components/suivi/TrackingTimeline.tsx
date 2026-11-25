"use client";

import { useT } from "@/lib/i18n";
import { formatRelativeDate } from "@/lib/utils/date";
import { CheckCircle2, ChevronRight, Mail, RefreshCw, Sparkles, UserCog } from "lucide-react";
import type { TrackingEvent } from "@/lib/pocketbase";
import { EmptyState, Surface } from "@/components/ui/kit";

const KIND_ICON = {
  created: Sparkles,
  update: RefreshCw,
  status_change: UserCog,
  manual: CheckCircle2,
} as const;

/**
 * Chronologie d'une fiche de suivi (maquette #78e0) : une frise verticale, un
 * picto rond par etape, et pour chacune une carte avec l'auteur et la date,
 * l'etape (emoji compris) resumee par l'IA, puis "Ouvrir le mail". Du plus
 * recent au plus ancien.
 */
export function TrackingTimeline({
  events,
  loading,
  onOpenMail,
}: {
  events: TrackingEvent[];
  loading: boolean;
  /** Ouvre le mail source d'une etape. */
  onOpenMail?: (messageId: string) => void;
}) {
  const t = useT();

  if (loading && events.length === 0) {
    return <p className="px-1 py-4 text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (events.length === 0) {
    return <EmptyState icon={RefreshCw} title={t("tracking.noEvents")} />;
  }

  return (
    <ol className="relative flex flex-col gap-3" data-ref="tracking-timeline">
      <span className="absolute top-5 bottom-5 left-[1.2rem] w-px bg-border" aria-hidden />
      {events.map((ev) => {
        const Icon = KIND_ICON[ev.kind] || RefreshCw;
        const author = ev.author || t("tracking.you");
        return (
          <li key={ev.id} className="relative flex gap-3">
            <span className="relative z-10 mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
              <Icon className="size-[1.1rem]" strokeWidth={1.7} />
            </span>
            <Surface className="min-w-0 flex-1 px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[0.9375rem] font-semibold">{author}</span>
                <time className="shrink-0 text-xs text-muted-foreground">
                  {formatRelativeDate(ev.date)}
                </time>
              </div>
              {ev.label && (
                <p className="mt-1 text-[0.9375rem] leading-snug font-medium break-words [overflow-wrap:anywhere]">
                  {ev.label}
                </p>
              )}
              {ev.detail && (
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground break-words [overflow-wrap:anywhere]">
                  {ev.detail}
                </p>
              )}
              {ev.message && onOpenMail && (
                <button
                  type="button"
                  onClick={() => onOpenMail(ev.message)}
                  className="mt-3 flex w-full items-center gap-3 rounded-2xl bg-muted px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-accent"
                >
                  <Mail className="size-[1.1rem] shrink-0" strokeWidth={1.6} />
                  <span className="flex-1">{t("tracking.viewMail")}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              )}
            </Surface>
          </li>
        );
      })}
    </ol>
  );
}
