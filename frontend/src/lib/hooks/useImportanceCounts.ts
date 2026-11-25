"use client";

import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useMailStore } from "@/lib/stores/mail-store";
import { fetchImportanceCounts, type ImportanceCounts } from "@/lib/mail-list-api";

/**
 * Compteurs des pastilles de niveau (non lus par niveau dans le contexte de la
 * liste : compte, dossier, etiquette, filtres hors niveau et hors "non lus").
 * Partages entre la barre de filtres et l'etat vide de la liste : un seul
 * fetcher (monte par la barre), plusieurs lecteurs.
 */
interface ImportanceCountsState {
  counts: ImportanceCounts | null;
  set: (c: ImportanceCounts | null) => void;
}

export const useImportanceCountsStore = create<ImportanceCountsState>((set) => ({
  counts: null,
  set: (counts) => set({ counts }),
}));

/** Les pastilles n'ont pas de sens dans ces dossiers (envois, brouillons). */
export function importanceChipsHidden(folder: string): boolean {
  return folder === "drafts" || folder === "sent";
}

export function useImportanceCountsFetcher(): ImportanceCounts | null {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const activeFolderIds = useMailStore((s) => s.activeFolderIds);
  const activeFolder = useMailStore((s) => s.activeFolder);
  const activeLabelId = useMailStore((s) => s.activeLabelId);
  const listFilter = useMailStore((s) => s.listFilter);
  const refreshKey = useMailStore((s) => s.messagesRefreshKey);
  const newMessagesSignal = useMailStore((s) => s.newMessagesSignal);
  const localMessageUpdate = useMailStore((s) => s.localMessageUpdate);
  const counts = useImportanceCountsStore((s) => s.counts);
  const setCounts = useImportanceCountsStore((s) => s.set);
  const seq = useRef(0);

  const hidden = importanceChipsHidden(activeFolder);
  const folderKey = activeFolderIds.join(",");
  // Le niveau et "non lus" ne changent pas les compteurs (non lus par niveau).
  const contextKey = JSON.stringify({
    a: listFilter.hasAttachments,
    s: listFilter.starred,
    p: listFilter.priority,
    f: listFilter.fromText,
    b: listFilter.bodyText,
  });
  const readTs = localMessageUpdate && "is_read" in localMessageUpdate.changes ? localMessageUpdate.ts : 0;
  const importanceTs = localMessageUpdate && "importance" in localMessageUpdate.changes ? localMessageUpdate.ts : 0;

  useEffect(() => {
    if (hidden) {
      setCounts(null);
      return;
    }
    const view =
      activeFolder === "starred" ? "starred" :
      activeFolder === "all_mail" ? "all_mail" :
      activeFolder === "unread" ? "unread" : undefined;
    if (!view && activeFolder !== "label" && activeFolderIds.length === 0) return;
    const my = ++seq.current;
    const timer = setTimeout(() => {
      const f = JSON.parse(contextKey) as { a: boolean; s: boolean; p: "all" | "low" | "normal" | "high"; f: string; b: string };
      fetchImportanceCounts({
        accountId: activeAccountId,
        view,
        labelId: activeFolder === "label" ? (activeLabelId ?? undefined) : undefined,
        folderIds: !view && activeFolder !== "label" ? activeFolderIds : undefined,
        excludeSecondary: activeFolder === "inbox",
        isDraft: activeFolder === "label" ? undefined : false,
        filter: { hasAttachments: f.a, starred: f.s, priority: f.p, fromText: f.f, bodyText: f.b },
      })
        .then((c) => {
          if (my === seq.current) setCounts(c);
        })
        .catch(() => {
          /* compteurs indisponibles : pastilles sans nombre */
        });
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, activeAccountId, folderKey, activeFolder, activeLabelId, contextKey, refreshKey, newMessagesSignal, readTs, importanceTs]);

  return hidden ? null : counts;
}
