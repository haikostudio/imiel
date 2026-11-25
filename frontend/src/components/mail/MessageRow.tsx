"use client";

import { useState } from "react";
import {
  Star,
  Paperclip,
  Archive,
  Trash2,
  MailOpen,
  Mail,
  ShieldAlert,
  PenLine,
  PackageSearch,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import { Button } from "@/components/ui/button";
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
import { formatRelativeDate } from "@/lib/utils/date";
import { stripReplacementChars } from "@/lib/utils/sanitize";
import { useT } from "@/lib/i18n";
import { useTrackedThreads } from "@/lib/stores/tracked-threads";
import type { Message } from "@/lib/pocketbase";
import { useSettings } from "@/lib/hooks/useSettings";
import { useLongPressContextMenu } from "@/lib/hooks/useLongPress";
import { MessageLabels } from "@/components/mail/MessageLabels";
import { SenderAvatar } from "@/components/mail/SenderAvatar";

interface MessageRowProps {
  message: Message;
  selected: boolean;
  checked: boolean;
  showAccountBadge?: boolean;
  accountName?: string;
  isSpam?: boolean;
  hasDraft?: boolean;
  isNew?: boolean;
  onSelect: (messageId: string, threadId?: string) => void;
  onCheck: (messageId: string, checked: boolean) => void;
  onStar: (messageId: string) => void;
  onArchive: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onMarkRead: (messageId: string, read: boolean) => void;
}

export function MessageRow({
  message,
  selected,
  checked,
  showAccountBadge = false,
  accountName,
  isSpam = false,
  hasDraft = false,
  isNew = false,
  onSelect,
  onCheck,
  onStar,
  onArchive,
  onDelete,
  onMarkRead,
}: MessageRowProps) {
  const t = useT();
  const isTracked = useTrackedThreads((s) =>
    message.thread_id ? s.ids.has(message.thread_id) : false
  );
  const [hovered, setHovered] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const { density, previewLines } = useSettings();
  const senderName = stripReplacementChars(message.from_address?.name || message.from_address?.address || "");
  const senderEmail = message.from_address?.address || "";
  const isUnread = !message.is_read && !isSpam;
  const unreadStyle = isUnread && !selected;
  // Compact = une seule ligne (nom, sujet, date), sans apercu.
  const isCompact = density === "compact";
  const rowPadding = isCompact ? "py-1" : density === "spacious" ? "py-3" : "py-2";

  // Charte : plus de ligne inversee pour le non-lu (point noir + gras).
  const unreadRowStyle: React.CSSProperties | undefined = undefined;
  const unreadMutedStyle: React.CSSProperties | undefined = undefined;

  const longPress = useLongPressContextMenu();

  return (
    <>
    <div
      role="row"
      tabIndex={0}
      data-ref="message-row"
      className={cn(
        "group relative flex cursor-pointer items-center gap-3 border-b px-3 transition-colors select-none [-webkit-touch-callout:none] md:select-auto",
        rowPadding,
        selected ? "bg-accent" : unreadStyle ? "bg-muted" : "hover:bg-muted/50",
        isUnread && "font-semibold",
        isSpam && !selected && "opacity-50",
        isNew && "animate-message-slide-in"
      )}
      style={unreadRowStyle}
      onClick={() => onSelect(message.id, message.thread_id ?? message.message_id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onTouchStart={longPress.onTouchStart}
      onTouchMove={longPress.onTouchMove}
      onTouchEnd={longPress.onTouchEnd}
      onTouchCancel={longPress.onTouchCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(message.id, message.thread_id ?? message.message_id);
        }
      }}
    >
      {/* Indicateur non lu */}
      {isUnread && (
        <span data-ref="message-row-unread-dot" className="bg-unread absolute left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full" data-unread-style={unreadStyle ? "1" : "0"} />
      )}

      {/* Checkbox */}
      <input
        type="checkbox"
        data-ref="message-row-checkbox"
        checked={checked}
        onChange={(e) => {
          e.stopPropagation();
          onCheck(message.id, e.target.checked);
        }}
        onClick={(e) => e.stopPropagation()}
        className="accent-primary size-4 shrink-0 cursor-pointer rounded"
        aria-label={`Selectionner le message de ${senderName}`}
      />

      {/* Badge compte */}
      {showAccountBadge && accountName && (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {accountName}
        </Badge>
      )}

      {/* Badge spam */}
      {isSpam && (
        <Badge variant="destructive" className="shrink-0 gap-1 px-1.5 py-0 text-[10px]">
          <ShieldAlert className="size-2.5" />
          {t("folder.spam")}
        </Badge>
      )}

      {/* Badge brouillon (masque si programme : le badge "Programme" prime) */}
      {hasDraft && !message.scheduled_at && (
        <Badge className="shrink-0 gap-1 border-amber-200 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
          <PenLine className="size-2.5" />
          {t("message.draft")}
        </Badge>
      )}

      {/* Badge envoi programme */}
      {message.is_draft && message.scheduled_at && (
        <Badge className="shrink-0 gap-1 border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          <Clock className="size-2.5" />
          {t("message.scheduled")}
        </Badge>
      )}

      {/* Indicateur suivi (decouple de l'etoile/favori) */}
      {isTracked && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="shrink-0 text-tracking"
              data-ref="message-row-tracked"
              aria-label={t("tracking.tracked")}
            >
              <PackageSearch className="size-4" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("tracking.tracked")}</TooltipContent>
        </Tooltip>
      )}

      {/* Star */}
      <Toggle
        size="sm"
        pressed={message.is_starred}
        onPressedChange={() => onStar(message.id)}
        onClick={(e) => e.stopPropagation()}
        className="shrink-0"
        data-ref="message-row-star"
        aria-label={message.is_starred ? "Retirer des favoris" : "Ajouter aux favoris"}
      >
        <Star
          className={cn(
            "size-4",
            message.is_starred
              ? "fill-yellow-400 text-yellow-400"
              : !unreadStyle && "text-muted-foreground"
          )}
          style={!message.is_starred ? unreadMutedStyle : undefined}
        />
      </Toggle>

      {/* Avatar = favicon expediteur + badge type de mail (coin haut-droit) */}
      <SenderAvatar
        name={senderName}
        email={senderEmail}
        size={isCompact ? "sm" : "default"}
        isSpam={isSpam}
        isScheduled={!!(message.is_draft && message.scheduled_at)}
        isDraft={hasDraft && !message.scheduled_at}
        isUnread={isUnread}
      />

      {/* Contenu */}
      <div data-ref="message-row-content" className="flex min-w-0 flex-1 items-center gap-2">
        <div className={cn("flex min-w-0 flex-1", isCompact ? "items-center gap-2" : "flex-col gap-0.5")}>
          <div className={cn("flex items-center gap-2", isCompact && "w-[32%] max-w-48 shrink-0")}>
            <span
              className={cn(
                "truncate text-sm",
                isUnread ? "font-bold" : "font-normal",
                isSpam && "text-muted-foreground"
              )}
              data-ref="message-row-sender"
            >
              {senderName}
            </span>
          </div>
          <div className={cn("flex min-w-0 items-center gap-1.5", isCompact && "flex-1")}>
            <span
              className={cn(
                "truncate text-sm",
                isSpam
                  ? "text-muted-foreground"
                  : isUnread ? "font-semibold" : "text-muted-foreground"
              )}
              data-ref="message-row-subject"
            >
              {stripReplacementChars(message.subject) || "(Sans objet)"}
            </span>
            <MessageLabels labelIds={message.labels} />
            {previewLines > 0 && message.snippet && !isCompact && (
              <>
                <span className={cn("shrink-0 text-sm", !unreadStyle && "text-muted-foreground")} style={unreadMutedStyle}>
                  &mdash;
                </span>
                <span data-ref="message-row-snippet" className={cn("truncate text-sm", !unreadStyle && "text-muted-foreground")} style={unreadMutedStyle}>
                  {stripReplacementChars(message.snippet)}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Actions au survol / meta-info */}
        <div data-ref="message-row-meta" className="flex shrink-0 items-center gap-1">
          {hovered ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onArchive(message.id);
                    }}
                  >
                    <Archive className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("message.archive")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteConfirm(true);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("message.moveToTrash")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMarkRead(message.id, !message.is_read);
                    }}
                  >
                    {message.is_read ? (
                      <Mail className="size-3.5" />
                    ) : (
                      <MailOpen className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {message.is_read ? t("message.markAsUnread") : t("message.markAsRead")}
                </TooltipContent>
              </Tooltip>
            </>
          ) : (
            <>
              {message.has_attachments && (
                <Paperclip className={cn("size-3.5", !unreadStyle && "text-muted-foreground")} style={unreadMutedStyle} />
              )}
              <span data-ref="message-row-date" className={cn("whitespace-nowrap text-xs", !unreadStyle && "text-muted-foreground")} style={unreadMutedStyle}>
                {formatRelativeDate(message.date)}
              </span>
            </>
          )}
        </div>
      </div>
    </div>

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
          <Button variant="destructive" onClick={() => {
            onDelete(message.id);
            setShowDeleteConfirm(false);
          }}>
            {t("message.moveToTrash")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
