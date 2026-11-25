"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT, type Locale } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import { formatChatMessageTimeFull } from "@/lib/utils/date";
import { cn } from "@/lib/utils";
import {
  isUndoable,
  listAiActionHistory,
  undoAiAction,
  type AiActionHistoryRecord,
} from "@/lib/ai-actions";

// Historique des actions faites par l'assistant IA (collection ai_actions).
// Une CREATION du jour s'annule d'un clic (retire ce qui a ete cree) ; au-dela,
// et pour les modifications/suppressions, la ligne reste lisible sans bouton.
export function AiActionHistory() {
  const t = useT();
  const language = useSettingsStore((s) => s.language) as Locale;
  const [items, setItems] = useState<AiActionHistoryRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await listAiActionHistory());
      setError(null);
    } catch (err) {
      // 404 = collection ai_actions pas encore creee (migration 062 appliquee a
      // la prochaine mise en ligne de PocketBase).
      const status = (err as { status?: number }).status;
      setError(status === 404 ? t("aiAction.historyUnavailable") : (err as Error).message);
      setItems([]);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  async function undo(rec: AiActionHistoryRecord) {
    setUndoing(rec.id);
    try {
      await undoAiAction(rec);
      toast.success(t("aiAction.undoDone"));
      await load();
    } catch (err) {
      toast.error(`${t("aiAction.undoFailed")} : ${(err as Error).message}`);
    } finally {
      setUndoing(null);
    }
  }

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-ref="ai-action-history">
      {items === null && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("aiAction.historyLoading")}
        </div>
      )}
      {error && <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      {items && items.length === 0 && !error && (
        <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t("aiAction.historyEmpty")}</div>
      )}
      {items?.map((rec) => (
        <div
          key={rec.id}
          data-ref="ai-action-history-row"
          className={cn("flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm", rec.status === "undone" && "opacity-60")}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-muted-foreground">
              {t(`aiAction.kind.${rec.kind}`)} · {formatChatMessageTimeFull(new Date(rec.created.replace(" ", "T")).getTime(), language)}
            </div>
            <div className={cn("break-words", rec.status === "undone" && "line-through")}>{rec.summary}</div>
            <div
              className={cn(
                "text-[11px]",
                rec.status === "error" ? "text-destructive" : rec.status === "undone" ? "text-muted-foreground" : "text-blue-600 dark:text-blue-400"
              )}
            >
              {rec.status === "undone" ? t("aiAction.undone") : rec.status === "error" ? rec.error || t("aiAction.failed") : t("aiAction.done")}
              {rec.status === "done" && rec.error ? ` (${rec.error})` : ""}
              {rec.edited ? ` · ${t("aiAction.edited")}` : ""}
            </div>
          </div>
          {isUndoable(rec) && (
            <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={undoing === rec.id} onClick={() => undo(rec)} data-ref="ai-action-undo">
              {undoing === rec.id ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
              {t("aiAction.undo")}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
