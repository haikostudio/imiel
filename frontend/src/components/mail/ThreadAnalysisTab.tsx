"use client";

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { CalendarClock, PackageSearch, Sparkles, ListChecks, Tag } from "lucide-react";
import { ContactMemoryCard } from "@/components/contacts/ContactMemoryCard";
import { Surface } from "@/components/ui/kit";
import { parseBriefDate } from "@/components/mail/ThreadBriefBubble";
import { useLabels } from "@/lib/hooks/useLabels";
import { useThreadLabels } from "@/lib/hooks/useThreadLabels";
import { calendarSuggestions, type CalendarSuggestion, type TrackingItem } from "@/lib/pocketbase";
import { useT } from "@/lib/i18n";
import { sanitizeHtml } from "@/lib/utils/sanitize";
import { cn } from "@/lib/utils";
import type { ParticipantDetail } from "@/lib/hooks/useThreads";

// Onglet "Analyse" des Details : tout ce que l'IA a tire de la conversation
// (note, suivi, echeances, etiquettes) puis la fiche "Ce que l'IA sait" de
// chaque interlocuteur (hors l'utilisateur : sa fiche vit dans Reglages > IA).
// Monte UNIQUEMENT quand l'onglet est choisi : aucune requete avant.

export interface ThreadAnalysisTabProps {
  threadId: string;
  /** Interlocuteurs du fil, sans doublon (l'utilisateur est retire ici). */
  people: ParticipantDetail[];
  myEmails: Set<string>;
  briefContent: string;
  briefGeneratedAt?: string | null;
  onBrief: () => void;
  trackingItem: TrackingItem | null;
}

function SectionTitle({ icon: Icon, children }: { icon: typeof Tag; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 px-1 pt-4 pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      <Icon className="size-3.5 shrink-0" />
      {children}
    </h3>
  );
}

function formatWhen(value: string, allDay: boolean): string {
  const d = new Date((value || "").replace(" ", "T"));
  if (isNaN(d.getTime())) return "";
  return format(d, allDay ? "EEE d MMM yyyy" : "EEE d MMM yyyy, HH:mm", { locale: fr });
}

export function ThreadAnalysisTab({
  threadId,
  people,
  myEmails,
  briefContent,
  briefGeneratedAt,
  onBrief,
  trackingItem,
}: ThreadAnalysisTabProps) {
  const t = useT();
  const briefDate = parseBriefDate(briefGeneratedAt);

  // Echeances reperees par le suivi (propositions d'agenda de la fiche).
  const itemId = trackingItem?.id || "";
  const [dates, setDates] = useState<{ item: string; list: CalendarSuggestion[] }>({ item: "", list: [] });
  useEffect(() => {
    if (!itemId) return;
    let cancelled = false;
    calendarSuggestions()
      .getList(1, 30, { filter: `item = "${itemId}"`, sort: "start", requestKey: `thread-analysis-dates-${itemId}` })
      .then((res) => !cancelled && setDates({ item: itemId, list: res.items }))
      .catch(() => !cancelled && setDates({ item: itemId, list: [] }));
    return () => {
      cancelled = true;
    };
  }, [itemId]);
  const deadlines = dates.item === itemId ? dates.list : [];

  // Etiquettes du fil : le schema ne dit pas qui a pose une etiquette sur un
  // message (classement IA ou filtre). Seul un ajout depuis la conversation
  // laisse une trace (override "included") : celles-la sont marquees "a la main".
  const { byId } = useLabels();
  const { labelIds, overrides } = useThreadLabels(threadId);
  const labels = useMemo(
    () =>
      labelIds
        .map((id) => byId.get(id))
        .filter((l): l is NonNullable<typeof l> => !!l)
        .map((l) => ({ id: l.id, name: l.name, color: l.color || "#6b7280", manual: overrides.get(l.id) === "included" })),
    [labelIds, byId, overrides]
  );

  const others = people.filter((p) => p.address && !myEmails.has(p.address.toLowerCase()));
  const otherAddrs = others.map((p) => p.address.toLowerCase());

  const isClosed = trackingItem?.status === "done" || trackingItem?.status === "cancelled";

  return (
    <div data-ref="thread-details-analysis" className="pb-2">
      {/* (1) Note de synthese : jetons de la note IA (violet). */}
      <SectionTitle icon={ListChecks}>{t("thread.analysisNote")}</SectionTitle>
      {briefContent ? (
        <div data-ref="thread-analysis-note" className="rounded-2xl bg-note px-4 py-3 text-note-foreground">
          <div
            className="thread-brief-content space-y-1.5 text-[0.9375rem] leading-[1.45] break-words [overflow-wrap:anywhere] [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-1 [&_strong]:font-semibold [&_ul]:mt-1"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(briefContent) }}
          />
          <div className="mt-2 flex items-center gap-2 text-[0.8125rem]">
            {briefDate && (
              <span className="min-w-0 flex-1 truncate opacity-70">
                {t("thread.briefGeneratedAt", {
                  date: format(briefDate, "d MMMM yyyy", { locale: fr }),
                  time: format(briefDate, "HH:mm"),
                })}
              </span>
            )}
            <button
              type="button"
              onClick={onBrief}
              className="ml-auto shrink-0 rounded-full bg-note-strong/15 px-3 py-1 font-medium hover:bg-note-strong/25"
            >
              {t("thread.analysisNoteUpdate")}
            </button>
          </div>
        </div>
      ) : (
        <Surface className="flex items-center gap-3 px-4 py-3">
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">{t("thread.analysisNoteEmpty")}</span>
          <button
            type="button"
            onClick={onBrief}
            data-ref="thread-analysis-note-create"
            className="shrink-0 rounded-full bg-note px-3 py-1 text-sm font-medium text-note-foreground"
          >
            {t("thread.analysisNoteCreate")}
          </button>
        </Surface>
      )}

      {/* (2) Suivi de l'affaire. */}
      {trackingItem && (
        <>
          <SectionTitle icon={PackageSearch}>{t("tracking.title")}</SectionTitle>
          <Surface data-ref="thread-analysis-tracking" className="space-y-1.5 px-4 py-3">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 text-[0.9375rem] font-medium">{trackingItem.title}</span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                  isClosed ? "bg-muted text-muted-foreground" : "bg-tracking/15 text-tracking"
                )}
              >
                {isClosed ? t("thread.analysisClosed") : t("thread.analysisOpen")}
              </span>
            </div>
            {trackingItem.status_label && <p className="text-sm">{trackingItem.status_label}</p>}
            {trackingItem.context_summary && (
              <p className="text-sm whitespace-pre-line text-muted-foreground">{trackingItem.context_summary}</p>
            )}
            {trackingItem.last_message_date && (
              <p className="text-xs text-muted-foreground">
                {t("thread.analysisLastUpdate", { date: formatWhen(trackingItem.last_message_date, true) })}
              </p>
            )}
          </Surface>
        </>
      )}

      {/* (3) Rendez-vous et echeances reperes. */}
      {deadlines.length > 0 && (
        <>
          <SectionTitle icon={CalendarClock}>{t("thread.analysisDates")}</SectionTitle>
          <Surface data-ref="thread-analysis-dates" className="px-4 py-1">
            {deadlines.map((d) => (
              <div key={d.id} className="flex items-start gap-3 border-b border-border py-2.5 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[0.9375rem]">{d.label || d.title || d.kind}</span>
                  <span className="text-sm text-muted-foreground">{formatWhen(d.start, d.all_day)}</span>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-xs",
                    d.status === "accepted" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                  )}
                >
                  {t(`thread.analysisDate.${d.status}`)}
                </span>
              </div>
            ))}
          </Surface>
        </>
      )}

      {/* (4) Etiquettes du fil. */}
      {labels.length > 0 && (
        <>
          <SectionTitle icon={Tag}>{t("thread.analysisLabels")}</SectionTitle>
          <Surface data-ref="thread-analysis-labels" className="flex flex-wrap gap-1.5 px-4 py-3">
            {labels.map((l) => (
              <span
                key={l.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-sm"
              >
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: l.color }} />
                {l.name}
                {l.manual && <span className="text-xs text-muted-foreground">· {t("thread.analysisLabelManual")}</span>}
              </span>
            ))}
          </Surface>
        </>
      )}

      {/* (5) Ce que l'IA sait de chaque interlocuteur ; fiche construite
          d'office si elle n'existe pas encore. */}
      {others.length > 0 && (
        <>
          <SectionTitle icon={Sparkles}>{t("thread.analysisPeople")}</SectionTitle>
          <div className="space-y-3">
            {others.map((p) => {
              const addr = p.address.toLowerCase();
              return (
                <div key={addr} data-ref="thread-analysis-person" className="space-y-1">
                  <div className="px-1 text-sm">
                    <span className="font-medium">{p.name || p.address}</span>
                    {p.name && <span className="text-muted-foreground"> · {p.address}</span>}
                  </div>
                  <ContactMemoryCard
                    memoryKey={addr}
                    name={p.name || ""}
                    participants={otherAddrs.filter((a) => a !== addr)}
                    autoBuild
                    className="bg-card"
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
