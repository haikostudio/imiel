"use client";

import { useEffect, useRef } from "react";
import { useFolders } from "@/lib/hooks/useFolders";
import { useLabels } from "@/lib/hooks/useLabels";
import { fetchMailListPage, type MailListParams } from "@/lib/mail-list-api";
import { useMailStore } from "@/lib/stores/mail-store";

// DOIT rester aligne sur la taille de page des listes (useMessages/useThreads) :
// le cache client de fetchMailListPage est indexe par per_page, une valeur
// differente ici rendrait le prechargement inutile (cache jamais reutilise).
const DEFAULT_PAGE_SIZE = 50;
const LARGE_PAGE_SIZE = 50;
const PRELOAD_PAUSE_MS = 80;

function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function byFolderType(
  folders: ReturnType<typeof useFolders>["folders"],
  type: string
) {
  return folders.filter((folder) => folder.type === type).map((folder) => folder.id);
}

export function useMailListPreload() {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const { folders, loading: foldersLoading } = useFolders();
  const { list: labels } = useLabels();
  const lastPreloadKeyRef = useRef("");

  useEffect(() => {
    if (!activeAccountId || foldersLoading) return;

    const inboxIds = byFolderType(folders, "inbox");
    const sentIds = byFolderType(folders, "sent");
    const draftsIds = byFolderType(folders, "drafts");
    const trashIds = byFolderType(folders, "trash");
    const spamIds = byFolderType(folders, "spam");
    const archiveIds = byFolderType(folders, "archive");
    const customIds = byFolderType(folders, "custom");
    const labelIds = labels.map((label) => label.id);
    const preloadKey = [
      activeAccountId,
      inboxIds.join(","),
      sentIds.join(","),
      draftsIds.join(","),
      trashIds.join(","),
      spamIds.join(","),
      archiveIds.join(","),
      customIds.join(","),
      labelIds.join(","),
    ].join("|");

    if (preloadKey === lastPreloadKeyRef.current) return;
    lastPreloadKeyRef.current = preloadKey;

    // withTails : meme cle de cache que useThreads (vue conversations), sinon
    // le prechargement ne sert jamais. Les brouillons n'en ont pas besoin.
    const base = {
      page: 1,
      accountId: activeAccountId,
      sort: "date" as const,
      withTails: true,
    };
    const tasks: MailListParams[] = [];
    tasks.push({
      ...base,
      perPage: LARGE_PAGE_SIZE,
      view: "all_mail",
      isDraft: false,
    });
    if (inboxIds.length > 0) {
      tasks.push({
        ...base,
        perPage: LARGE_PAGE_SIZE,
        folderIds: inboxIds,
        excludeSecondary: true,
        isDraft: false,
      });
    }
    tasks.push({
      ...base,
      perPage: DEFAULT_PAGE_SIZE,
      view: "unread",
      isDraft: false,
    });
    tasks.push({
      ...base,
      perPage: DEFAULT_PAGE_SIZE,
      view: "starred",
      isDraft: false,
    });
    if (sentIds.length > 0) tasks.push({ ...base, perPage: DEFAULT_PAGE_SIZE, folderIds: sentIds, isDraft: false });
    if (draftsIds.length > 0) tasks.push({ ...base, perPage: DEFAULT_PAGE_SIZE, folderIds: draftsIds, isDraft: true, withTails: false });
    if (trashIds.length > 0) tasks.push({ ...base, perPage: DEFAULT_PAGE_SIZE, folderIds: trashIds, isDraft: false });
    if (spamIds.length > 0) tasks.push({ ...base, perPage: DEFAULT_PAGE_SIZE, folderIds: spamIds, isDraft: false });
    if (archiveIds.length > 0) tasks.push({ ...base, perPage: DEFAULT_PAGE_SIZE, folderIds: archiveIds, isDraft: false });
    for (const folderId of customIds) {
      tasks.push({ ...base, perPage: DEFAULT_PAGE_SIZE, folderId, isDraft: false });
    }
    for (const labelId of labelIds) {
      tasks.push({ ...base, perPage: DEFAULT_PAGE_SIZE, labelId });
    }

    let cancelled = false;
    void (async () => {
      for (const task of tasks) {
        if (cancelled) return;
        await fetchMailListPage(task).catch(() => null);
        await pause(PRELOAD_PAUSE_MS);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeAccountId, folders, foldersLoading, labels]);
}
