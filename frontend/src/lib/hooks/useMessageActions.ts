"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { messages, updateMessageFlags, updateMessageViaWorker, deleteMessageViaWorker, type Message } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import type { FolderType, SidebarCounts } from "@/lib/stores/mail-store";
import { sendAction } from "@/lib/ws-channel";
import { t as tStatic } from "@/lib/i18n";

interface ActionOpts {
  /** Supprime le toast de confirmation (flows composites, ex: blocage). */
  silent?: boolean;
}

/** Duree des toasts annulables (laisse le temps de cliquer "Annuler"). */
const UNDO_TOAST_DURATION_MS = 6000;

/** Options sonner pour un toast avec bouton "Annuler". */
function undoToastOpts(undo: () => void) {
  return {
    duration: UNDO_TOAST_DURATION_MS,
    action: { label: tStatic("undo"), onClick: () => undo() },
  };
}

/** Apres un undo serveur reussi : resynchronise listes + compteurs et confirme. */
function confirmUndone() {
  const { invalidateMessages, invalidateFolders } = useMailStore.getState();
  invalidateMessages();
  invalidateFolders();
  toast.success(tStatic("actionUndone"));
}

/** Apprentissage Bayes Rspamd (best-effort, non bloquant). */
function learnSpam(accountId: string, messageId: string, type: "spam" | "ham") {
  fetch("/worker/spam/learn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, messageId, type }),
  }).catch(() => {});
}

/** Toast de confirmation d'un deplacement de message(s) vers un dossier. */
function toastMoved(folderType: string, count = 1, undo?: () => void) {
  const opts = undo ? undoToastOpts(undo) : undefined;
  switch (folderType) {
    case "trash":
      toast.success(count > 1 ? tStatic("message.bulkMovedToTrash", { count: String(count) }) : tStatic("message.movedToTrash"), opts);
      break;
    case "archive":
      toast.success(count > 1 ? tStatic("message.bulkArchived", { count: String(count) }) : tStatic("message.archived"), opts);
      break;
    case "spam":
      toast.success(count > 1 ? tStatic("message.bulkMovedToSpam", { count: String(count) }) : tStatic("message.movedToSpam"), opts);
      break;
    case "inbox":
      toast.success(count > 1 ? tStatic("message.bulkMovedToInbox", { count: String(count) }) : tStatic("message.movedToInbox"), opts);
      break;
  }
}

export function folderToCountKey(folderType: FolderType | string): keyof SidebarCounts | null {
  switch (folderType) {
    case "inbox": return "inboxTotal";
    case "sent": return "sent";
    case "drafts": return "drafts";
    case "trash": return "trash";
    case "spam": return "spam";
    case "starred": return "starred";
    case "all_mail": return "allMail";
    default: return null;
  }
}

/**
 * Actions sur les messages avec notification locale via le store.
 * Chaque action fait un retrait/update optimiste immediat puis
 * execute les requetes serveur en arriere-plan (pas de re-fetch).
 * Les actions reversibles affichent un bouton "Annuler" dans le toast :
 * l'undo attend la fin de l'operation serveur d'origine puis la renverse,
 * et resynchronise listes/compteurs via invalidateMessages/invalidateFolders.
 */
export function useMessageActions() {
  const notify = useMailStore((s) => s.notifyMessageUpdate);
  const removeMsg = useMailStore((s) => s.notifyMessageRemoval);

  const markAsRead = useCallback(async (id: string, read = true) => {
    const value = !!read;
    notify(id, { is_read: value } as Partial<Message>);
    sendAction({ action: "message-update", id, changes: { is_read: value } });
    const { activeFolder } = useMailStore.getState();
    if (activeFolder === "inbox") {
      useMailStore.getState().adjustSidebarCount("inboxUnread", value ? -1 : 1);
      sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: value ? -1 : 1 });
    }
    try {
      await updateMessageFlags(id, { is_read: value });
    } catch {
      notify(id, { is_read: !value } as Partial<Message>);
      sendAction({ action: "message-update", id, changes: { is_read: !value } });
      if (activeFolder === "inbox") {
        useMailStore.getState().adjustSidebarCount("inboxUnread", value ? 1 : -1);
        sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: value ? 1 : -1 });
      }
    }
  }, [notify]);

  const markAsStarred = useCallback(async (id: string, starred?: boolean, opts?: ActionOpts) => {
    if (starred === undefined) {
      const msg = await messages().getOne<Message>(id);
      starred = !msg.is_starred;
    }
    const value = !!starred;
    notify(id, { is_starred: value } as Partial<Message>);
    sendAction({ action: "message-update", id, changes: { is_starred: value } });
    useMailStore.getState().adjustSidebarCount("starred", value ? 1 : -1);
    sendAction({ action: "sidebar-adjust", key: "starred", delta: value ? 1 : -1 });

    const serverDone = (async () => {
      try {
        await updateMessageFlags(id, { is_starred: value });
        return true;
      } catch {
        notify(id, { is_starred: !value } as Partial<Message>);
        sendAction({ action: "message-update", id, changes: { is_starred: !value } });
        useMailStore.getState().adjustSidebarCount("starred", value ? -1 : 1);
        sendAction({ action: "sidebar-adjust", key: "starred", delta: value ? -1 : 1 });
        return false;
      }
    })();

    if (!opts?.silent) {
      toast.success(
        tStatic(value ? "message.starred" : "message.unstarred"),
        undoToastOpts(async () => {
          const ok = await serverDone;
          if (!ok) return; // l'action d'origine a echoue, rien a annuler
          notify(id, { is_starred: !value } as Partial<Message>);
          sendAction({ action: "message-update", id, changes: { is_starred: !value } });
          useMailStore.getState().adjustSidebarCount("starred", !value ? 1 : -1);
          sendAction({ action: "sidebar-adjust", key: "starred", delta: !value ? 1 : -1 });
          try {
            await updateMessageFlags(id, { is_starred: !value });
            toast.success(tStatic("actionUndone"));
          } catch {
            toast.error(tStatic("message.actionFailed"));
          }
        })
      );
    }
    await serverDone;
  }, [notify]);

  const moveToFolder = useCallback(async (id: string, folderType: string, opts?: ActionOpts) => {
    removeMsg(id);
    sendAction({ action: "message-removal", id });

    // Contexte d'annulation : rempli une fois le deplacement serveur reussi.
    const undoCtx: { origFolderId: string | null; account: string | null; learnType: "spam" | "ham" | null } = {
      origFolderId: null,
      account: null,
      learnType: null,
    };
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const undo = async () => {
      await done;
      if (!undoCtx.origFolderId) return; // deplacement d'origine echoue : rien a annuler
      try {
        await updateMessageViaWorker(id, { folder: undoCtx.origFolderId });
        // Renverse l'apprentissage Bayes fait par l'action d'origine
        if (undoCtx.account && undoCtx.learnType) {
          learnSpam(undoCtx.account, id, undoCtx.learnType === "spam" ? "ham" : "spam");
        }
        confirmUndone();
      } catch {
        toast.error(tStatic("message.actionFailed"));
      }
    };
    if (!opts?.silent) toastMoved(folderType, 1, undo);

    const { activeFolder, adjustSidebarCount } = useMailStore.getState();
    const sourceKey = activeFolder !== "all_mail" ? folderToCountKey(activeFolder) : null;
    const destKey = folderToCountKey(folderType);

    if (sourceKey) {
      adjustSidebarCount(sourceKey, -1);
      sendAction({ action: "sidebar-adjust", key: sourceKey, delta: -1 });
    }
    if (destKey) {
      adjustSidebarCount(destKey, 1);
      sendAction({ action: "sidebar-adjust", key: destKey, delta: 1 });
    }

    let msg: Message;
    try {
      msg = await messages().getOne<Message>(id);
    } catch {
      toast.error(tStatic("message.actionFailed"));
      if (sourceKey) {
        adjustSidebarCount(sourceKey, 1);
        sendAction({ action: "sidebar-adjust", key: sourceKey, delta: 1 });
      }
      if (destKey) {
        adjustSidebarCount(destKey, -1);
        sendAction({ action: "sidebar-adjust", key: destKey, delta: -1 });
      }
      resolveDone();
      return;
    }

    if (activeFolder === "inbox" && !msg.is_read) {
      adjustSidebarCount("inboxUnread", -1);
      sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: -1 });
    }
    if (folderType === "inbox" && !msg.is_read) {
      adjustSidebarCount("inboxUnread", 1);
      sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: 1 });
    }

    try {
      const { default: pb } = await import("@/lib/pocketbase");
      const targetFolder = await pb
        .collection<import("@/lib/pocketbase").Folder>("folders")
        .getFirstListItem(`account = "${msg.account}" && type = "${folderType}"`);

      await updateMessageViaWorker(id, { folder: targetFolder.id });

      // Apprentissage Bayes (best-effort, non bloquant) :
      // "Signaler spam" -> spam ; "Pas spam" (depuis le dossier spam) -> ham.
      const learnType =
        folderType === "spam"
          ? "spam"
          : folderType === "inbox" && activeFolder === "spam"
            ? "ham"
            : null;
      if (learnType) {
        learnSpam(msg.account, id, learnType);
      }

      undoCtx.origFolderId = msg.folder;
      undoCtx.account = msg.account;
      undoCtx.learnType = learnType;
    } catch {
      toast.error(tStatic("message.actionFailed"));
      // Rollback compteurs seulement (le message est deja retire de la liste)
      if (sourceKey) {
        adjustSidebarCount(sourceKey, 1);
        sendAction({ action: "sidebar-adjust", key: sourceKey, delta: 1 });
      }
      if (destKey) {
        adjustSidebarCount(destKey, -1);
        sendAction({ action: "sidebar-adjust", key: destKey, delta: -1 });
      }
      if (activeFolder === "inbox" && !msg.is_read) {
        adjustSidebarCount("inboxUnread", 1);
        sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: 1 });
      }
      if (folderType === "inbox" && !msg.is_read) {
        adjustSidebarCount("inboxUnread", -1);
        sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: -1 });
      }
    }
    resolveDone();
  }, [removeMsg]);

  const moveToTrash = useCallback((id: string, opts?: ActionOpts) => moveToFolder(id, "trash", opts), [moveToFolder]);
  const archiveMessage = useCallback((id: string, opts?: ActionOpts) => moveToFolder(id, "archive", opts), [moveToFolder]);
  const moveToSpam = useCallback((id: string, opts?: ActionOpts) => moveToFolder(id, "spam", opts), [moveToFolder]);
  const moveToInbox = useCallback((id: string, opts?: ActionOpts) => moveToFolder(id, "inbox", opts), [moveToFolder]);

  const permanentDelete = useCallback(async (id: string, opts?: ActionOpts) => {
    removeMsg(id);
    sendAction({ action: "message-removal", id });
    if (!opts?.silent) toast.success(tStatic("message.deletedPermanently"));

    const { activeFolder, adjustSidebarCount } = useMailStore.getState();
    const sourceKey = folderToCountKey(activeFolder);
    if (sourceKey) {
      adjustSidebarCount(sourceKey, -1);
      sendAction({ action: "sidebar-adjust", key: sourceKey, delta: -1 });
    }
    adjustSidebarCount("allMail", -1);
    sendAction({ action: "sidebar-adjust", key: "allMail", delta: -1 });

    try {
      await deleteMessageViaWorker(id);
    } catch {
      toast.error(tStatic("message.actionFailed"));
      if (sourceKey) {
        adjustSidebarCount(sourceKey, 1);
        sendAction({ action: "sidebar-adjust", key: sourceKey, delta: 1 });
      }
      adjustSidebarCount("allMail", 1);
      sendAction({ action: "sidebar-adjust", key: "allMail", delta: 1 });
    }
  }, [removeMsg]);

  // Deplacement en masse vers un dossier (corbeille/archive/inbox/spam), annulable.
  const bulkMoveToFolder = useCallback(async (ids: string[], folderType: string) => {
    const count = ids.length;
    removeMsg(ids);
    for (const id of ids) {
      sendAction({ action: "message-removal", id });
    }

    // Deplacements effectues (pour l'annulation : retour au dossier d'origine).
    const moved: { id: string; folder: string; account: string }[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const undo = async () => {
      await done;
      if (moved.length === 0) return;
      let failed = false;
      for (const entry of moved) {
        try {
          await updateMessageViaWorker(entry.id, { folder: entry.folder });
          if (folderType === "spam") {
            learnSpam(entry.account, entry.id, "ham");
          }
        } catch {
          failed = true;
        }
      }
      if (failed) {
        toast.error(tStatic("message.actionFailed"));
        // Resynchronise quand meme ce qui a pu etre annule partiellement
        useMailStore.getState().invalidateMessages();
        useMailStore.getState().invalidateFolders();
      } else {
        confirmUndone();
      }
    };
    toastMoved(folderType, count, undo);

    const { activeFolder, adjustSidebarCount } = useMailStore.getState();
    const sourceKey = activeFolder !== "all_mail" ? folderToCountKey(activeFolder) : null;
    const destKey = folderToCountKey(folderType);
    if (sourceKey) {
      adjustSidebarCount(sourceKey, -count);
      sendAction({ action: "sidebar-adjust", key: sourceKey, delta: -count });
    }
    if (destKey) {
      adjustSidebarCount(destKey, count);
      sendAction({ action: "sidebar-adjust", key: destKey, delta: count });
    }

    for (const id of ids) {
      try {
        const msg = await messages().getOne<Message>(id);
        const { default: pb } = await import("@/lib/pocketbase");
        const targetFolder = await pb
          .collection<import("@/lib/pocketbase").Folder>("folders")
          .getFirstListItem(`account = "${msg.account}" && type = "${folderType}"`);
        await updateMessageViaWorker(id, { folder: targetFolder.id });
        moved.push({ id, folder: msg.folder, account: msg.account });

        if (folderType === "spam") {
          // Apprentissage Bayes (best-effort)
          learnSpam(msg.account, id, "spam");
        }
      } catch {
        // ignore
      }
    }
    resolveDone();
  }, [removeMsg]);

  const bulkMoveToTrash = useCallback((ids: string[]) => bulkMoveToFolder(ids, "trash"), [bulkMoveToFolder]);
  const bulkArchive = useCallback((ids: string[]) => bulkMoveToFolder(ids, "archive"), [bulkMoveToFolder]);
  const bulkMoveToInbox = useCallback((ids: string[]) => bulkMoveToFolder(ids, "inbox"), [bulkMoveToFolder]);
  const bulkMoveToSpam = useCallback((ids: string[]) => bulkMoveToFolder(ids, "spam"), [bulkMoveToFolder]);

  const bulkMarkAsRead = useCallback(async (ids: string[], read: boolean) => {
    const value = !!read;
    const { activeFolder, adjustSidebarCount } = useMailStore.getState();

    for (const id of ids) {
      notify(id, { is_read: value } as Partial<Message>);
      sendAction({ action: "message-update", id, changes: { is_read: value } });
    }
    if (activeFolder === "inbox") {
      // On ne connait pas l'etat actuel de chaque message ici. On approxime :
      // la liste est filtree, on ajuste seulement sur les changements demandes.
      adjustSidebarCount("inboxUnread", value ? -ids.length : ids.length);
      sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: value ? -ids.length : ids.length });
    }

    const serverDone = (async () => {
      for (const id of ids) {
        try {
          await updateMessageFlags(id, { is_read: value });
        } catch {
          // ignore
        }
      }
    })();

    toast.success(
      ids.length > 1
        ? tStatic(value ? "message.bulkMarkedRead" : "message.bulkMarkedUnread", { count: String(ids.length) })
        : tStatic(value ? "message.markedRead" : "message.markedUnread"),
      undoToastOpts(async () => {
        await serverDone;
        for (const id of ids) {
          notify(id, { is_read: !value } as Partial<Message>);
          sendAction({ action: "message-update", id, changes: { is_read: !value } });
        }
        if (activeFolder === "inbox") {
          useMailStore.getState().adjustSidebarCount("inboxUnread", !value ? -ids.length : ids.length);
          sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: !value ? -ids.length : ids.length });
        }
        let failed = false;
        for (const id of ids) {
          try {
            await updateMessageFlags(id, { is_read: !value });
          } catch {
            failed = true;
          }
        }
        if (failed) toast.error(tStatic("message.actionFailed"));
        else toast.success(tStatic("actionUndone"));
      })
    );

    await serverDone;
  }, [notify]);

  const bulkPermanentDelete = useCallback(async (ids: string[]) => {
    const count = ids.length;
    removeMsg(ids);
    for (const id of ids) {
      sendAction({ action: "message-removal", id });
    }
    toast.success(
      count > 1
        ? tStatic("message.bulkDeleted", { count: String(count) })
        : tStatic("message.deletedPermanently")
    );

    const { activeFolder, adjustSidebarCount } = useMailStore.getState();
    const sourceKey = folderToCountKey(activeFolder);
    if (sourceKey) {
      adjustSidebarCount(sourceKey, -count);
      sendAction({ action: "sidebar-adjust", key: sourceKey, delta: -count });
    }
    adjustSidebarCount("allMail", -count);
    sendAction({ action: "sidebar-adjust", key: "allMail", delta: -count });

    for (const id of ids) {
      try {
        await deleteMessageViaWorker(id);
      } catch {
        // ignore
      }
    }
  }, [removeMsg]);

  return {
    markAsRead,
    markAsStarred,
    moveToTrash,
    archiveMessage,
    moveToSpam,
    moveToInbox,
    permanentDelete,
    bulkMoveToTrash,
    bulkArchive,
    bulkMoveToInbox,
    bulkPermanentDelete,
    bulkMarkAsRead,
    bulkMoveToSpam,
  };
}
