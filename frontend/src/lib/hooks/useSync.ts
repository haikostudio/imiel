"use client";

import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import { syncAccount } from "@/lib/pocketbase";
import { useAccounts } from "./useAccounts";
import { useMailStore } from "@/lib/stores/mail-store";
import { onSyncStatus, type SyncStatusEvent } from "@/lib/ws-channel";

interface SyncState {
  lastSyncedAt: number | null;
  isSyncing: boolean;
  intervalSeconds: number;
  /** Per-account sync status from real-time WS events (accountId -> status) */
  accountSyncStatus: Record<string, { status: string; error?: string }>;
  _setLastSyncedAt: (ts: number) => void;
  _setIsSyncing: (v: boolean) => void;
  _setIntervalSeconds: (s: number) => void;
  _updateAccountSync: (accountId: string, status: string, error?: string) => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  lastSyncedAt: null,
  isSyncing: false,
  intervalSeconds: 60,
  accountSyncStatus: {},
  _setLastSyncedAt: (ts) => set({ lastSyncedAt: ts }),
  _setIsSyncing: (v) => set({ isSyncing: v }),
  _setIntervalSeconds: (s) => set({ intervalSeconds: s }),
  _updateAccountSync: (accountId, status, error) =>
    set((state) => ({
      accountSyncStatus: {
        ...state.accountSyncStatus,
        [accountId]: { status, error },
      },
    })),
}));

// Ref module-level pour eviter les syncs concurrents
let syncingLock = false;
let syncAllFn: (() => Promise<void>) | null = null;

/** Trigger a manual sync (e.g., refresh button, pull-to-refresh). Returns a
 *  promise resolving when the sync round completes. Automatic sync is handled
 *  server-side by PB cron. */
export function triggerSync(): Promise<void> {
  return syncAllFn?.() ?? Promise.resolve();
}

/**
 * Hook for manual sync trigger only.
 * Automatic periodic sync is handled server-side by PocketBase cron (mail-sync.pb.js, every 1 min).
 * This hook only exposes the manual sync function and updates the sync store for StatusBar display.
 */
export function useSync() {
  const { accounts } = useAccounts();
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const { _setLastSyncedAt, _setIsSyncing, _updateAccountSync } = useSyncStore();

  const syncAll = useCallback(async () => {
    if (syncingLock) return;
    syncingLock = true;
    _setIsSyncing(true);

    try {
      const active = accountsRef.current.filter((a) => a.is_active);
      const results = await Promise.allSettled(
        active.map((a) => syncAccount(a.id))
      );
      const hasSuccess = results.some(
        (r) => r.status === "fulfilled" && r.value?.success
      );
      if (hasSuccess) {
        _setLastSyncedAt(Date.now());
        useMailStore.getState().signalNewMessages();
        useMailStore.getState().invalidateFolders();
      }
    } finally {
      syncingLock = false;
      _setIsSyncing(false);
    }
  }, [_setLastSyncedAt, _setIsSyncing]);

  // Exposer syncAll au niveau module pour triggerSync
  useEffect(() => {
    syncAllFn = syncAll;
    return () => {
      syncAllFn = null;
    };
  }, [syncAll]);

  // Ecoute des events de sync en temps reel via WebSocket (emis par sync-engine)
  useEffect(() => {
    const unsubscribe = onSyncStatus((event: SyncStatusEvent) => {
      _updateAccountSync(event.accountId, event.status, event.error);
      if (event.status === "idle") {
        _setLastSyncedAt(Date.now());
      }
    });
    return unsubscribe;
  }, [_updateAccountSync, _setLastSyncedAt]);
}
