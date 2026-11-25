"use client";

import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { Loader2, Sparkles, ListChecks, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import type { useThreadBrief } from "@/lib/hooks/useThreadBrief";

interface ThreadBriefPanelProps {
  /** Etat de la note, partage avec la bulle du fil (un seul useThreadBrief,
   * dans ThreadView). */
  brief: ReturnType<typeof useThreadBrief>;
  /** Date de la derniere generation (deja convertie). */
  generatedAt: Date | null;
  open: boolean;
  onClose: () => void;
}

/**
 * Module de GENERATION de la note, ouvert par le bouton de note en haut de la
 * conversation (choix utilisateur 2026-10-18) : etat, Analyser / Regenerer /
 * Ajouter les nouveaux messages et date de la note existante. Il ne repete PAS
 * le texte de la note : elle vit dans le fil (ThreadBriefBubble).
 */
export function ThreadBriefPanel({ brief, generatedAt, open, onClose }: ThreadBriefPanelProps) {
  const t = useT();
  const language = useSettingsStore((s) => s.language);
  const { content, loading, generating, error, hasNew, generate } = brief;

  if (!open) return null;

  const showError = error && error !== "save";
  const hasNote = !!content;

  return (
    <div
      data-ref="thread-brief"
      className="mx-3 my-2 rounded-2xl bg-muted px-4 py-3 md:mx-5"
    >
      <div className="flex items-center gap-2">
        <ListChecks className={hasNote ? "size-4 shrink-0 text-note-strong" : "size-4 shrink-0"} />
        <span className="flex-1 text-sm font-semibold">
          {t("thread.briefTitle")}
        </span>
        {hasNew && !generating && (
          <span className="rounded-full bg-background px-2 py-0.5 text-[10px] font-medium text-foreground">
            {t("thread.briefNew")}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onClose}
          title={t("thread.briefClose")}
          data-ref="thread-brief-close"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="mt-2 text-sm leading-relaxed">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            ...
          </div>
        ) : generating ? (
          <div className="flex items-center gap-2 text-muted-foreground" data-ref="thread-brief-generating">
            <Loader2 className="size-3.5 animate-spin" />
            {t("thread.briefGenerating")}
          </div>
        ) : (
          <>
            {showError ? (
              <p className="text-destructive">{t("thread.briefError")}</p>
            ) : hasNote ? (
              <p className="text-muted-foreground" data-ref="thread-brief-date">
                {generatedAt
                  ? t("thread.briefInThread", {
                      date: format(generatedAt, "d MMMM yyyy", { locale: fr }),
                      time: format(generatedAt, "HH:mm"),
                    })
                  : t("thread.briefTitle")}
              </p>
            ) : (
              <p className="text-muted-foreground">{t("thread.briefEmpty")}</p>
            )}

            <div className="mt-2 flex flex-wrap gap-2">
              {!hasNote && (
                <Button
                  type="button"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => generate({ language })}
                  data-ref="thread-brief-analyze"
                >
                  <Sparkles className="mr-1.5 size-3.5" />
                  {t("thread.briefAnalyze")}
                </Button>
              )}
              {hasNote && hasNew && (
                <Button
                  type="button"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => generate({ language })}
                  data-ref="thread-brief-update"
                >
                  <Sparkles className="mr-1.5 size-3.5" />
                  {t("thread.briefUpdate")}
                </Button>
              )}
              {(hasNote || showError) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => generate({ force: true, language })}
                  data-ref="thread-brief-regenerate"
                >
                  <Sparkles className="mr-1.5 size-3.5" />
                  {t("thread.briefRegenerate")}
                </Button>
              )}
            </div>

            {error === "save" && hasNote && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("thread.briefSaveWarn")}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
