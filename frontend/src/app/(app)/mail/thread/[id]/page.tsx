"use client";

import { sanitizeHtml } from "@/lib/utils/sanitize";
import { useEffect, useState } from "react";
import { useHashRouter } from "@/lib/hash-router";
import {
  ArrowLeft,
  Star,
  Trash2,
  MoreVertical,
  Archive,
  Mail,
  Ban,
  ShieldAlert,
  Filter,
  Printer,
  Download,
  Code,
  Forward,
  Reply,
} from "lucide-react";
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
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { useMailStore } from "@/lib/stores/mail-store";
import { useThreads } from "@/lib/hooks/useThreads";
import { useMessageActions } from "@/lib/hooks/useMessageActions";
import { blockSender } from "@/lib/hooks/useSettings";
import { normalizeSubject } from "@/lib/utils/threading";
import { ThreadView } from "@/components/mail/ThreadView";
import { MessageSourceDialog } from "@/components/mail/MessageSourceDialog";
import { MessageContextMenu } from "@/components/mail/MessageContextMenu";
import { useT } from "@/lib/i18n";
import { t as tStatic } from "@/lib/i18n";
import { toast } from "sonner";


export default function ThreadPage() {
  const t = useT();
  const { params, back } = useHashRouter();
  const threadId = params.id ?? "";

  const selectMessage = useMailStore((s) => s.selectMessage);
  const openCompose = useMailStore((s) => s.openCompose);
  const openFilterRule = useMailStore((s) => s.openFilterRule);
  const { threads, loading: threadsLoading, getThread, markAsStarred } = useThreads();
  const { markAsRead, moveToSpam, bulkMoveToTrash, bulkArchive, bulkMoveToSpam } =
    useMessageActions();

  // Selectionner le thread au montage
  useEffect(() => {
    if (threadId) {
      selectMessage(null, threadId);
    }

    return () => {
      selectMessage(null, null);
    };
  }, [threadId, selectMessage]);

  const thread = getThread(threadId);
  const lastMessage = thread?.lastMessage;

  const handleBack = () => {
    back();
  };

  const handleStar = async () => {
    if (!lastMessage) return;
    await markAsStarred(lastMessage.id);
  };

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Toasts geres par useMessageActions (bulk avec comptage)
  const handleDelete = async () => {
    if (!thread) return;
    await bulkMoveToTrash(thread.messages.map((m) => m.id));
    setShowDeleteConfirm(false);
    back();
  };

  const handleArchive = async () => {
    if (!thread) return;
    await bulkArchive(thread.messages.map((m) => m.id));
    back();
  };

  const handleMarkUnread = async () => {
    if (!lastMessage) return;
    await markAsRead(lastMessage.id, false);
    toast.success(tStatic("message.markedUnread"));
  };

  const handleReply = () => {
    if (lastMessage) {
      openCompose("reply", lastMessage.id);
    }
  };

  const handleForward = () => {
    if (lastMessage) {
      openCompose("forward", lastMessage.id);
    }
  };

  const handleSpam = async () => {
    if (!thread) return;
    await bulkMoveToSpam(thread.messages.map((m) => m.id));
    back();
  };

  const handleBlock = async () => {
    if (!lastMessage || !thread) return;
    const email = lastMessage.from_address?.address;
    if (!email) return;
    // blockSender toaste et anime le retrait ; le passage en spam reste muet
    // pour ne pas empiler un second toast.
    await blockSender(email);
    for (const msg of thread.messages) {
      await moveToSpam(msg.id, { silent: true });
    }
    back();
  };

  const handleFilterSimilar = () => {
    if (!lastMessage) return;
    openFilterRule(lastMessage);
  };

  const handlePrint = () => {
    if (!lastMessage) return;
    const win = window.open("", "_blank", "width=800,height=600");
    if (!win) return;
    // Tout ce qui vient du mail est echappe ou nettoye avant d'etre ecrit dans
    // la fenetre d'impression (meme origine que l'application).
    const esc = (v: string | undefined | null) =>
      (v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const printBody = lastMessage.html_body
      ? sanitizeHtml(lastMessage.html_body)
      : `<pre>${esc(lastMessage.text_body)}</pre>`;
    win.document.write(`
      <html><head><title>${esc(lastMessage.subject)}</title>
      <style>body { font-family: -apple-system, system-ui, sans-serif; padding: 24px; max-width: 800px; margin: 0 auto; }
      .header { border-bottom: 1px solid #e5e7eb; padding-bottom: 16px; margin-bottom: 16px; }
      .field { font-size: 14px; color: #6b7280; margin: 4px 0; }
      .subject { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
      .body { font-size: 14px; line-height: 1.6; }</style></head><body>
      <div class="header">
        <div class="subject">${esc(lastMessage.subject)}</div>
        <div class="field">De : ${esc(lastMessage.from_address?.name)} &lt;${esc(lastMessage.from_address?.address)}&gt;</div>
        <div class="field">A : ${lastMessage.to_addresses?.map((a) => `${esc(a.name)} &lt;${esc(a.address)}&gt;`).join(", ") || ""}</div>
        <div class="field">Date : ${new Date(lastMessage.date).toLocaleString()}</div>
      </div>
      <div class="body">${printBody}</div>
      </body></html>
    `);
    win.document.close();
    win.print();
  };

  const handleDownload = () => {
    if (!lastMessage) return;
    const lines: string[] = [];
    lines.push(`From: ${lastMessage.from_address?.name ? `${lastMessage.from_address.name} <${lastMessage.from_address.address}>` : lastMessage.from_address?.address}`);
    lines.push(`To: ${lastMessage.to_addresses?.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", ")}`);
    if (lastMessage.cc_addresses?.length) {
      lines.push(`Cc: ${lastMessage.cc_addresses.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", ")}`);
    }
    lines.push(`Subject: ${lastMessage.subject}`);
    lines.push(`Date: ${lastMessage.date}`);
    if (lastMessage.message_id) lines.push(`Message-ID: ${lastMessage.message_id}`);
    lines.push("MIME-Version: 1.0");
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("");
    lines.push(lastMessage.html_body || lastMessage.text_body || "");
    const eml = lines.join("\r\n");
    const blob = new Blob([eml], { type: "message/rfc822" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${lastMessage.subject || "message"}.eml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [sourceOpen, setSourceOpen] = useState(false);

  return (
    <div data-ref="thread-page" className="flex h-full flex-col">
      {/* Header */}
      <header data-ref="thread-page-header" className="flex items-center gap-2 border-b px-2 py-2">
        <Button variant="ghost" size="icon-sm" onClick={handleBack} data-ref="thread-back-btn">
          <ArrowLeft className="size-5" />
          <span className="sr-only">{t("back")}</span>
        </Button>

        <h1 data-ref="thread-page-title" className="min-w-0 flex-1 truncate text-sm font-medium">
          {thread ? normalizeSubject(thread.subject) : t("loading")}
        </h1>

        <Button variant="ghost" size="icon-sm" onClick={handleStar} data-ref="thread-star-btn">
          <Star
            className={
              thread?.isStarred
                ? "size-5 fill-yellow-400 text-yellow-400"
                : "size-5"
            }
          />
          <span className="sr-only">Favori</span>
        </Button>

        <Button variant="ghost" size="icon-sm" onClick={() => setShowDeleteConfirm(true)} data-ref="thread-delete-btn">
          <Trash2 className="size-5" />
          <span className="sr-only">{t("message.moveToTrash")}</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" data-ref="thread-page-more">
              <MoreVertical className="size-5" />
              <span className="sr-only">Plus d'actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent data-ref="thread-page-more-menu" align="end" className="w-64">
            <DropdownMenuItem onClick={handleReply}>
              <Reply className="size-4" />
              {t("message.reply")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleForward}>
              <Forward className="size-4" />
              {t("message.forward")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleArchive}>
              <Archive className="size-4" />
              {t("message.archive")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleMarkUnread}>
              <Mail className="size-4" />
              {t("message.markAsUnread")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShowDeleteConfirm(true)} className="text-destructive">
              <Trash2 className="size-4" />
              {t("message.moveToTrash")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleBlock}>
              <Ban className="size-4" />
              {t("message.blockSender", { sender: lastMessage?.from_address?.name || lastMessage?.from_address?.address || "" })}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleSpam}>
              <ShieldAlert className="size-4" />
              {t("message.reportSpam")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleFilterSimilar}>
              <Filter className="size-4" />
              {t("message.filterSimilar")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handlePrint}>
              <Printer className="size-4" />
              {t("message.print")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleDownload}>
              <Download className="size-4" />
              {t("message.downloadMessage")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSourceOpen(true)}>
              <Code className="size-4" />
              {t("message.showOriginal")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Contenu du thread (la zone de reponse drawer est rendue par ThreadView) */}
      <div className="flex-1 overflow-hidden">
        <ThreadView threads={threads} loading={threadsLoading} getThread={getThread} />
      </div>

      {lastMessage && (
        <MessageSourceDialog
          message={lastMessage}
          open={sourceOpen}
          onOpenChange={setSourceOpen}
        />
      )}

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
    </div>
  );
}
