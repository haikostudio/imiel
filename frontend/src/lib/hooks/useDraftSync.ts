"use client";

import { useEffect, useRef } from "react";
import { useMailStore } from "@/lib/stores/mail-store";
import type { DraftData, SavedAttachment } from "@/lib/hooks/useAutoSave";

export interface DraftSyncUpdate {
  data: DraftData;
  attachments?: SavedAttachment[];
  fromAccountId?: string;
}

interface DraftSyncCallbacks {
  onContentUpdate: (update: DraftSyncUpdate) => void;
  onDeleted: () => void;
  onSent: () => void;
}

export function useDraftSync(
  draftId: string | null,
  sourceId: string,
  callbacks: DraftSyncCallbacks
): void {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const contentUpdate = useMailStore((s) => s.draftContentUpdate);
  const lifecycleEvent = useMailStore((s) => s.draftLifecycleEvent);

  useEffect(() => {
    if (!contentUpdate || !draftId) return;
    if (contentUpdate.draftId !== draftId) return;
    if (contentUpdate.sourceId === sourceId) return;
    callbacksRef.current.onContentUpdate({
      data: contentUpdate.data,
      attachments: contentUpdate.attachments,
      fromAccountId: contentUpdate.fromAccountId,
    });
  }, [contentUpdate, draftId, sourceId]);

  useEffect(() => {
    if (!lifecycleEvent || !draftId) return;
    if (lifecycleEvent.draftId !== draftId) return;
    if (lifecycleEvent.sourceId === sourceId) return;
    if (lifecycleEvent.event === "deleted") {
      callbacksRef.current.onDeleted();
    } else if (lifecycleEvent.event === "sent") {
      callbacksRef.current.onSent();
    }
  }, [lifecycleEvent, draftId, sourceId]);
}
