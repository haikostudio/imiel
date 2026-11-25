"use client";

import { Plus } from "lucide-react";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import { useTrackedThreads, type TrackingCandidate } from "@/lib/stores/tracked-threads";
import { formatRelativeDate } from "@/lib/utils/date";
import { useT } from "@/lib/i18n";
import { FicheAvatar } from "./AddToTrackingDrawer";

const REASON_KEYS: Record<TrackingCandidate["reason"], string> = {
  number: "tracking.reasonNumber",
  carrier: "tracking.reasonCarrier",
  counterpart: "tracking.reasonCounterpart",
  domain: "tracking.reasonDomain",
  similar: "tracking.reasonSimilar",
};

/**
 * "Un suivi ressemble a celui-ci" : ouvert par requestTrack (store
 * tracked-threads) quand l'action "Suivre" trouve des suivis OUVERTS proches.
 * L'utilisateur ajoute le mail a l'un d'eux, ou cree un nouveau suivi. Fermer
 * le panneau annule (aucun suivi cree). Monte une seule fois (layout global).
 */
export function TrackingChoicePanel() {
  const t = useT();
  const pending = useTrackedThreads((s) => s.pendingChoice);
  const resolveChoice = useTrackedThreads((s) => s.resolveChoice);

  return (
    <ResponsivePanel
      open={!!pending}
      onOpenChange={(open) => {
        if (!open) resolveChoice({ action: "cancel" });
      }}
      title={t("tracking.similarTitle")}
      accentColor="#f59e0b"
      mobileHeightClass="sheet-max-h"
      desktopWidthClass="sm:max-w-[520px]"
      contentClassName="z-[60]"
      overlayClassName="z-[60]"
    >
      <div data-ref="tracking-choice-panel" className="flex min-h-0 flex-1 flex-col">
        <p className="text-muted-foreground shrink-0 px-4 pt-3 pb-1 text-sm">{t("tracking.similarIntro")}</p>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {pending?.candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              data-ref="tracking-choice-candidate"
              onClick={() => resolveChoice({ action: "attach", itemId: c.id })}
              className="hover:bg-muted flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors"
            >
              <FicheAvatar item={{ title: c.title, merchant: c.merchant || "", sender_domain: c.sender_domain || "" }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.title}</div>
                <div className="text-muted-foreground truncate text-xs">
                  {t(REASON_KEYS[c.reason] ?? "tracking.reasonSimilar")}
                  {c.last_message_date ? ` · ${formatRelativeDate(c.last_message_date)}` : ""}
                </div>
              </div>
              <span className="text-primary mt-0.5 shrink-0 text-xs font-medium">{t("tracking.addHere")}</span>
            </button>
          ))}
          <button
            type="button"
            data-ref="tracking-choice-create"
            onClick={() => resolveChoice({ action: "create" })}
            className="hover:bg-muted mt-1 flex w-full items-center gap-3 rounded-lg border-t px-2 py-2.5 text-left transition-colors"
          >
            <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
              <Plus className="size-4" />
            </span>
            <span className="min-w-0 flex-1 text-sm font-medium">{t("tracking.createNew")}</span>
          </button>
        </div>
      </div>
    </ResponsivePanel>
  );
}
