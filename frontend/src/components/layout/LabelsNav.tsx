"use client";

import { Tag, Settings2 } from "lucide-react";
import { useLabels } from "@/lib/hooks/useLabels";
import { useLabelCounts } from "@/lib/hooks/useLabelCounts";
import { useMailStore } from "@/lib/stores/mail-store";
import { hashNavigate } from "@/lib/hash-router";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export function LabelsNav() {
  const t = useT();
  const { list, toggleSecondary } = useLabels();
  const counts = useLabelCounts();
  const activeLabelId = useMailStore((s) => s.activeLabelId);
  const activeFolder = useMailStore((s) => s.activeFolder);
  // Source de verite pour l'etat secondaire/primaire : store Zustand.
  // L'optimistic update du store est synchrone, donc le re-render est instantane.
  const secondaryLabelIds = useMailStore((s) => s.secondaryLabelIds);
  const secondarySet = new Set(secondaryLabelIds);

  function handleToggle(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    // toggleSecondary fait : 1) update store (instantane), 2) PATCH PB en async.
    // On ne fait PAS invalidateFolders ici : c'est un gros COUNT(*) SQL avec
    // N NOT LIKE qui prend des secondes (l'utilisateur trouvait ca trop long).
    // Le compteur sidebar se mettra a jour au prochain refresh naturel.
    toggleSecondary(id).catch(() => {});
  }

  return (
    <div data-ref="sidebar-labels" className="h-full overflow-y-auto px-4 py-2">
      <h3
        data-ref="sidebar-labels-title"
        className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground"
      >
        <Tag className="size-3" />
        {t("labels")}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => hashNavigate("/settings?tab=labels")}
              className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              aria-label={t("settings.manageLabels")}
              data-ref="sidebar-labels-manage"
            >
              <Settings2 className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("settings.manageLabels")}</TooltipContent>
        </Tooltip>
      </h3>

      {list.length === 0 ? (
        <p
          data-ref="sidebar-labels-empty"
          className="px-1 text-xs text-muted-foreground"
        >
          {t("noLabel")}
        </p>
      ) : (
        <ul className="space-y-0.5">
          {list.map((lbl) => {
            const active = activeFolder === "label" && activeLabelId === lbl.id;
            const c = counts.get(lbl.id);
            const unread = c?.unread ?? 0;
            const total = c?.total ?? 0;
            const isSecondary = secondarySet.has(lbl.id);
            const color = lbl.color || "#6b7280";

            return (
              <li key={lbl.id}>
                <div
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1 text-sm transition-colors",
                    active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"
                  )}
                  data-ref="sidebar-label-item"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => handleToggle(lbl.id, e)}
                        className="shrink-0 rounded-full"
                        aria-label={
                          isSecondary
                            ? t("label.includeInInbox")
                            : t("label.hideFromInbox")
                        }
                        data-ref="sidebar-label-toggle"
                      >
                        <span
                          className={cn(
                            "block size-2.5 rounded-full border transition-all",
                            isSecondary
                              ? "bg-transparent"
                              : "border-transparent"
                          )}
                          style={
                            isSecondary
                              ? { borderColor: color }
                              : { backgroundColor: color }
                          }
                          aria-hidden="true"
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {isSecondary
                        ? t("label.includeInInbox")
                        : t("label.hideFromInbox")}
                    </TooltipContent>
                  </Tooltip>
                  <button
                    type="button"
                    onClick={() => hashNavigate(`/mail/label/${lbl.id}`)}
                    className="flex flex-1 items-center gap-2 truncate text-left"
                    title={lbl.name}
                  >
                    <span className={cn("truncate", isSecondary && "text-muted-foreground")}>
                      {lbl.name}
                    </span>
                  </button>
                  {total > 0 && (
                    <span
                      data-ref="sidebar-label-count"
                      className="ml-auto text-[10px] tabular-nums text-muted-foreground"
                    >
                      {unread > 0 && (
                        <span className="font-semibold text-foreground">
                          {unread}
                        </span>
                      )}
                      {unread > 0 && " / "}
                      {total}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
