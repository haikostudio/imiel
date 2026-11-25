"use client";

import { useCallback, useState } from "react";
import {
  Reply,
  ReplyAll,
  Forward,
  Archive,
  Trash2,
  ShieldAlert,
  Mail,
  MailOpen,
  Star,
  Tag,
  FolderInput,
  Inbox,
  PackagePlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { useMailStore } from "@/lib/stores/mail-store";
import { useT, t as tStatic } from "@/lib/i18n";
import { useMessageActions } from "@/lib/hooks/useMessageActions";
import { useFolders } from "@/lib/hooks/useFolders";
import { messages as messagesCollection, type Label as LabelType } from "@/lib/pocketbase";
import pb from "@/lib/pocketbase";
import { AddToTrackingDrawer } from "./AddToTrackingDrawer";

interface MessageActionsProps {
  messageIds: string[];
  isRead?: boolean;
  isStarred?: boolean;
}

export function MessageActions({
  messageIds,
  isRead = true,
  isStarred = false,
}: MessageActionsProps) {
  const t = useT();
  const openCompose = useMailStore((s) => s.openCompose);
  const selectedMessageId = useMailStore((s) => s.selectedMessageId);
  const activeFolder = useMailStore((s) => s.activeFolder);
  const {
    markAsStarred,
    bulkArchive,
    bulkMoveToTrash,
    bulkMoveToSpam,
    bulkMoveToInbox,
    bulkMarkAsRead,
  } = useMessageActions();
  const isInSpam = activeFolder === "spam";
  const isInTrash = activeFolder === "trash";
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showSpamConfirm, setShowSpamConfirm] = useState(false);
  const [addToTrackingOpen, setAddToTrackingOpen] = useState(false);
  const { folders: folderList } = useFolders();
  const [labels, setLabels] = useState<LabelType[]>([]);
  const [labelsLoaded, setLabelsLoaded] = useState(false);

  const isSingle = messageIds.length === 1;

  const handleReply = () => {
    if (isSingle) openCompose("reply", messageIds[0]);
  };

  const handleReplyAll = () => {
    if (isSingle) openCompose("reply-all", messageIds[0]);
  };

  const handleForward = () => {
    if (isSingle) openCompose("forward", messageIds[0]);
  };

  // Toasts geres par useMessageActions (actions bulk, comptage inclus)
  const handleArchive = useCallback(async () => {
    await bulkArchive(messageIds);
  }, [messageIds, bulkArchive]);

  const handleDelete = useCallback(async () => {
    await bulkMoveToTrash(messageIds);
    setShowDeleteConfirm(false);
  }, [messageIds, bulkMoveToTrash]);

  const handleSpam = useCallback(async () => {
    await bulkMoveToSpam(messageIds);
    setShowSpamConfirm(false);
  }, [messageIds, bulkMoveToSpam]);

  const handleNotSpam = useCallback(async () => {
    await bulkMoveToInbox(messageIds);
  }, [messageIds, bulkMoveToInbox]);

  const handleRestore = useCallback(async () => {
    await bulkMoveToInbox(messageIds);
  }, [messageIds, bulkMoveToInbox]);

  const handleMarkRead = useCallback(async () => {
    await bulkMarkAsRead(messageIds, !isRead);
  }, [messageIds, isRead, bulkMarkAsRead]);

  const handleStar = useCallback(async () => {
    for (const id of messageIds) {
      await markAsStarred(id, !isStarred, { silent: true });
    }
    toast.success(tStatic(!isStarred ? "message.starred" : "message.unstarred"));
  }, [messageIds, isStarred, markAsStarred]);


  const handleMoveToFolder = useCallback(
    async (folderId: string) => {
      for (const id of messageIds) {
        await messagesCollection().update(id, { folder: folderId });
      }
      toast.success(tStatic("message.moved"));
    },
    [messageIds]
  );

  const loadLabels = useCallback(async () => {
    if (labelsLoaded) return;
    try {
      const result = await pb
        .collection<LabelType>("labels")
        .getFullList({ sort: "name" });
      setLabels(result);
      setLabelsLoaded(true);
    } catch {
      // Erreur silencieuse
    }
  }, [labelsLoaded]);

  const handleToggleLabel = useCallback(
    async (labelId: string) => {
      for (const id of messageIds) {
        const msg = await messagesCollection().getOne(id);
        const currentLabels = msg.labels ?? [];
        const hasLabel = currentLabels.includes(labelId);
        const newLabels = hasLabel
          ? currentLabels.filter((l: string) => l !== labelId)
          : [...currentLabels, labelId];
        await messagesCollection().update(id, { labels: newLabels });
      }
      toast.success(tStatic("message.labelsUpdated"));
    },
    [messageIds]
  );

  if (messageIds.length === 0) return null;

  return (
    <>
    <div data-ref="toolbar-actions" className="flex items-center gap-1">
      {/* Reponse / Transfert (single only) */}
      {isSingle && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={handleReply} data-ref="toolbar-actions-reply">
                <Reply className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("message.replyShortcut")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={handleReplyAll} data-ref="toolbar-actions-reply-all">
                <ReplyAll className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("message.replyAllShortcut")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={handleForward} data-ref="toolbar-actions-forward">
                <Forward className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("message.forwardShortcut")}</TooltipContent>
          </Tooltip>
          <Separator orientation="vertical" className="mx-1 h-6" />
        </>
      )}

      {/* Archiver */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={handleArchive} data-ref="toolbar-actions-archive">
            <Archive className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("message.archiveShortcut")}</TooltipContent>
      </Tooltip>

      {/* Supprimer */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={() => setShowDeleteConfirm(true)} data-ref="toolbar-actions-delete">
            <Trash2 className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("message.deleteShortcut")}</TooltipContent>
      </Tooltip>

      {/* Restaurer (corbeille -> boite de reception) */}
      {isInTrash && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={handleRestore} data-ref="toolbar-actions-restore">
              <Inbox className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("message.restore")}</TooltipContent>
        </Tooltip>
      )}

      {/* Spam / Not spam */}
      {isInSpam ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={handleNotSpam} data-ref="toolbar-actions-not-spam">
              <ShieldAlert className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("message.notSpam")}</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => setShowSpamConfirm(true)} data-ref="toolbar-actions-spam">
              <ShieldAlert className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("message.reportSpam")}</TooltipContent>
        </Tooltip>
      )}

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* Marquer lu/non lu */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={handleMarkRead} data-ref="toolbar-actions-mark-read">
            {isRead ? <Mail className="size-4" /> : <MailOpen className="size-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {isRead ? t("message.markAsUnread") : t("message.markAsRead")}
        </TooltipContent>
      </Tooltip>

      {/* Favori */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={handleStar} data-ref="toolbar-actions-star">
            <Star
              className={
                isStarred
                  ? "size-4 fill-yellow-400 text-yellow-400"
                  : "size-4"
              }
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {isStarred ? t("message.removeFavorite") : t("message.addFavorite")}
        </TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* Labels */}
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={loadLabels}
              >
                <Tag className="size-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("labels")}</TooltipContent>
        </Tooltip>
        <PopoverContent data-ref="toolbar-actions-labels-popover" className="w-48 p-2" align="start">
          <p className="text-muted-foreground mb-2 px-2 text-xs font-medium">
            {t("labels")}
          </p>
          {labels.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1 text-sm">
              {t("noLabel")}
            </p>
          ) : (
            labels.map((label) => (
              <button
                key={label.id}
                onClick={() => handleToggleLabel(label.id)}
                className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
              >
                <span
                  className="size-3 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                {label.name}
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>

      {/* Deplacer */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <FolderInput className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("message.moveTo")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent data-ref="toolbar-actions-move-menu" align="start">
          {folderList.map((folder) => (
            <DropdownMenuItem
              key={folder.id}
              onClick={() => handleMoveToFolder(folder.id)}
            >
              {folder.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Ajouter au suivi existant */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setAddToTrackingOpen(true)}
            data-ref="toolbar-actions-add-tracking"
          >
            <PackagePlus className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("tracking.addToExisting")}</TooltipContent>
      </Tooltip>
    </div>

    <AddToTrackingDrawer
      open={addToTrackingOpen}
      onOpenChange={setAddToTrackingOpen}
      messageIds={messageIds}
    />

    <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("message.deleteConfirmTitle")}</DialogTitle>
          <DialogDescription>{t("message.deleteConfirmDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
            {t("cancel")}
          </Button>
          <Button variant="destructive" onClick={handleDelete}>
            {t("message.moveToTrash")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={showSpamConfirm} onOpenChange={setShowSpamConfirm}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("message.spamConfirmTitle")}</DialogTitle>
          <DialogDescription>{t("message.spamConfirmDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowSpamConfirm(false)}>
            {t("cancel")}
          </Button>
          <Button variant="destructive" onClick={handleSpam}>
            {t("message.reportSpam")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
