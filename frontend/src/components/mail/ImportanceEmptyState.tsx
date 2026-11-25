"use client";

import { useMailStore } from "@/lib/stores/mail-store";
import { useImportanceCountsStore } from "@/lib/hooks/useImportanceCounts";
import { IMPORTANCE_COLORS, IMPORTANCE_LEVELS } from "@/lib/importance";
import { useT } from "@/lib/i18n";

/**
 * Liste vide. Avec une pastille de niveau active : phrase propre au niveau +
 * raccourcis vers les autres niveaux et leurs non-lus (maquette #da90), alignes
 * en colonne de largeur fixe pour rester droits.
 */
export function MailListEmptyState() {
  const t = useT();
  const importance = useMailStore((s) => s.listFilter.importance);
  const setListFilter = useMailStore((s) => s.setListFilter);
  const counts = useImportanceCountsStore((s) => s.counts);

  if (!importance) {
    return <p className="text-sm">{t("message.noMessages")}</p>;
  }
  const others = IMPORTANCE_LEVELS.filter((l) => l !== importance);
  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-4 px-6 text-center" data-ref="importance-empty">
      <span
        aria-hidden
        className="size-2.5 rounded-full"
        style={{ backgroundColor: IMPORTANCE_COLORS[importance] }}
      />
      <p className="text-sm font-medium text-foreground">{t(`importance.empty.${importance}`)}</p>
      <div className="flex w-full flex-col gap-1.5">
        {others.map((lvl) => (
          <button
            key={lvl}
            type="button"
            onClick={() => setListFilter({ importance: lvl })}
            data-ref={`importance-empty-goto-${lvl}`}
            className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: IMPORTANCE_COLORS[lvl] }} />
            <span className="flex-1 truncate">{t(`importance.chip.${lvl}`)}</span>
            {counts && (
              <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                {t("importance.unreadCount", { count: String(counts[lvl]) })}
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setListFilter({ importance: null })}
          className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {t("filter.all")}
        </button>
      </div>
    </div>
  );
}
