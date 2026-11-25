"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Inbox } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useMessages } from "@/lib/hooks/useMessages";
import { useT } from "@/lib/i18n";
import { useMailStore } from "@/lib/stores/mail-store";
import { useSettings } from "@/lib/hooks/useSettings";
import { messages as messagesCollection, type Message } from "@/lib/pocketbase";
import { MessageRow } from "./MessageRow";

function MessageListSkeleton() {
  return (
    <div data-ref="message-list-skeleton" className="flex flex-col">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b px-3 py-2">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="size-4 rounded" />
          <Skeleton className="size-6 rounded-full" />
          <div className="flex flex-1 flex-col gap-1">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-full max-w-xs" />
          </div>
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

function MessageListEmpty() {
  const t = useT();
  return (
    <div data-ref="message-list-empty" className="flex flex-1 flex-col items-center justify-center gap-3 py-16">
      <div className="bg-muted rounded-full p-4">
        <Inbox className="text-muted-foreground size-8" />
      </div>
      <div className="text-center">
        <p data-ref="message-list-empty-title" className="font-medium">{t("message.noMessages")}</p>
        <p className="text-muted-foreground text-sm">
          {t("message.folderEmpty")}
        </p>
      </div>
    </div>
  );
}

export function MessageList() {
  const {
    messages: items,
    loading,
    hasMoreBottom: hasMore,
    loadMoreBottom: loadMore,
    newMessageIds,
    markAsRead,
    markAsStarred,
    moveToTrash,
    archiveMessage,
  } = useMessages();

  const t = useT();
  const selectedMessageId = useMailStore((s) => s.selectedMessageId);
  const selectMessage = useMailStore((s) => s.selectMessage);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const activeFolder = useMailStore((s) => s.activeFolder);
  const { autoMarkReadSeconds } = useSettings();
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [draftThreadIds, setDraftThreadIds] = useState<Set<string>>(new Set());
  const sentinelRef = useRef<HTMLDivElement>(null);
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showAccountBadge = activeAccountId === "all";

  // Recuperer les thread_ids ayant un brouillon en cours + souscription temps reel
  useEffect(() => {
    if (activeFolder === "drafts") {
      setDraftThreadIds(new Set());
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const buildFilter = () => {
      const parts = ['is_draft = true', 'thread_id != ""'];
      if (activeAccountId && activeAccountId !== "all") {
        parts.push(`account = "${activeAccountId}"`);
      }
      return parts.join(" && ");
    };

    const fetchDrafts = () => {
      messagesCollection()
        .getFullList<Message>({ filter: buildFilter() })
        .then((drafts) => {
          if (cancelled) return;
          const ids = new Set<string>();
          for (const d of drafts) {
            if (d.thread_id) ids.add(d.thread_id);
          }
          setDraftThreadIds(ids);
        })
        .catch(() => {
          if (!cancelled) setDraftThreadIds(new Set());
        });
    };

    fetchDrafts();

    // Real-time draft updates via WebSocket channel (ws-channel.ts)

    return () => {
      cancelled = true;
    };
  }, [activeAccountId, activeFolder]);

  // Infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  const handleCheck = useCallback((id: string, checked: boolean) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    };
  }, []);

  const handleSelect = useCallback(
    (messageId: string, threadId?: string) => {
      selectMessage(messageId, threadId);
      const msg = items.find((m) => m.id === messageId);
      if (msg && !msg.is_read) {
        if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
        if (autoMarkReadSeconds > 0) {
          markReadTimerRef.current = setTimeout(() => {
            markAsRead(messageId, true);
          }, autoMarkReadSeconds * 1000);
        } else {
          markAsRead(messageId, true);
        }
      }
    },
    [selectMessage, items, markAsRead, autoMarkReadSeconds]
  );

  const handleStar = useCallback(
    (id: string) => {
      markAsStarred(id);
    },
    [markAsStarred]
  );

  if (loading && items.length === 0) {
    return <MessageListSkeleton />;
  }

  if (!loading && items.length === 0) {
    return <MessageListEmpty />;
  }

  return (
    <ScrollArea data-ref="message-list-scroll" className="h-full">
      <div data-ref="message-list" role="grid" aria-label="Liste des messages">
        {items.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            selected={selectedMessageId === message.id}
            checked={checkedIds.has(message.id)}
            showAccountBadge={showAccountBadge}
            hasDraft={draftThreadIds.has(message.thread_id || message.message_id)}
            isNew={newMessageIds.has(message.id)}
            onSelect={handleSelect}
            onCheck={handleCheck}
            onStar={handleStar}
            onArchive={archiveMessage}
            onDelete={moveToTrash}
            onMarkRead={markAsRead}
          />
        ))}
        {/* Sentinel pour le chargement infini */}
        {hasMore && (
          <div ref={sentinelRef} data-ref="message-list-loader" className="flex justify-center py-4">
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded-full" />
              <span className="text-muted-foreground text-sm">
                {t("loading")}
              </span>
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
