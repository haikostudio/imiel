"use client";

import { ListChecks } from "lucide-react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { useT } from "@/lib/i18n";
import { sanitizeHtml } from "@/lib/utils/sanitize";

/** Date PocketBase ("YYYY-MM-DD HH:MM:SS.sssZ", espace) -> Date valide partout
 * (Safari refuse l'espace). */
export function parseBriefDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Note IA de la conversation, posee DANS le fil comme un message recu (a
 * gauche, meme colonne que les bulles) : violet clair a texte noir (jetons
 * --note / --note-foreground), rangee a la date de sa derniere generation
 * (ThreadView), ouverte d'office. Sous la bulle, comme les messages : le
 * libelle et la date de generation.
 */
export function ThreadBriefBubble({ content, generatedAt }: { content: string; generatedAt: Date | null }) {
  const t = useT();
  // Contenu HTML genere par l'IA, assaini via DOMPurify (sanitizeHtml).
  const safeHtml = sanitizeHtml(content);
  return (
    <div data-ref="thread-brief-bubble" className="px-3 py-1.5 md:px-5">
      <div className="w-[95%] max-w-full min-w-0 md:w-1/2">
        <div
          data-ref="thread-brief-bubble-body"
          className="thread-brief-content w-full space-y-1.5 rounded-2xl bg-note px-3 py-2 text-[0.9375rem] leading-[1.45] text-note-foreground break-words [overflow-wrap:anywhere] [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-1 [&_strong]:font-semibold [&_ul]:mt-1"
          dangerouslySetInnerHTML={{ __html: safeHtml }}
        />
        <div data-ref="thread-brief-bubble-meta" className="mt-1.5 flex min-w-0 items-center gap-2">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-note text-note-foreground">
            <ListChecks className="size-4" />
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[0.9375rem] font-medium">{t("thread.briefTitle")}</span>
            {generatedAt && (
              <span data-ref="thread-brief-bubble-date" className="text-[0.8125rem] text-muted-foreground">
                {t("thread.briefGeneratedAt", {
                  date: format(generatedAt, "d MMMM yyyy", { locale: fr }),
                  time: format(generatedAt, "HH:mm"),
                })}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
