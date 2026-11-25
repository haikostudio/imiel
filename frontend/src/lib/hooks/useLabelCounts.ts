"use client";

import { useEffect, useSyncExternalStore } from "react";
import pb, { getCurrentUserId } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import { onPbEvent } from "@/lib/ws-channel";
import { bootMark } from "@/lib/boot-perf";

export interface LabelCount {
  id: string;
  name: string;
  color: string;
  is_secondary: boolean;
  unread: number;
  total: number;
}

const REFRESH_DEBOUNCE_MS = 800;

// Cache module-level partage par activeAccountId. Si plusieurs composants
// abonnes simultanement (FolderNav, LabelsNav...), un seul fetch reseau.

const cache: Map<string, Map<string, LabelCount>> = new Map();
const loadingPromises: Map<string, Promise<void>> = new Map();
const subscribers = new Set<() => void>();

function emit() {
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

const EMPTY: Map<string, LabelCount> = new Map();

function getSnapshotFor(key: string): Map<string, LabelCount> {
  return cache.get(key) ?? EMPTY;
}

async function loadCounts(key: string, accountId: string | null): Promise<void> {
  const existing = loadingPromises.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const t0 = performance.now();
    bootMark("label-counts:fetch-start", { account: accountId });
    try {
      const params = accountId && accountId !== "all" ? `?account_id=${accountId}` : "";
      const data = await pb.send<{ items: LabelCount[] }>(
        `/api/mail/label-counts${params}`,
        { method: "GET" }
      );
      const next = new Map<string, LabelCount>();
      for (const it of data.items || []) next.set(it.id, it);
      cache.set(key, next);
      bootMark("label-counts:fetch-done", {
        dur_ms: Math.round(performance.now() - t0),
        count: next.size,
      });
      emit();
    } catch {
      bootMark("label-counts:fetch-error", { dur_ms: Math.round(performance.now() - t0) });
    }
  })().finally(() => { loadingPromises.delete(key); });
  loadingPromises.set(key, promise);
  return promise;
}

// Hook WS unique au module : un seul listener PB events pour tout le module.
let wsHooked = false;
let pendingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

function ensureWsHook() {
  if (wsHooked) return;
  wsHooked = true;
  onPbEvent((collection, _action, record) => {
    if (collection !== "messages" && collection !== "labels") return;
    const userId = getCurrentUserId();
    if (!userId) return;
    const recUser = (record as { user?: string } | null)?.user;
    if (collection === "labels" && recUser && recUser !== userId) return;
    // Debounce par cle : refresh tous les caches charges
    for (const key of cache.keys()) {
      const existing = pendingTimers.get(key);
      if (existing) clearTimeout(existing);
      const accountId = key === "__null__" ? null : key;
      const timer = setTimeout(() => {
        pendingTimers.delete(key);
        void loadCounts(key, accountId);
      }, REFRESH_DEBOUNCE_MS);
      pendingTimers.set(key, timer);
    }
  });
}

export function useLabelCounts(): Map<string, LabelCount> {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const foldersRefreshKey = useMailStore((s) => s.foldersRefreshKey);
  // activeAccountId initial est `null` puis devient `"all"` ou un id. Pour
  // eviter un double fetch (null + all -> 2 requetes equivalentes cote SQL),
  // on traite null comme "all".
  const normalized = activeAccountId ?? "all";
  const key = normalized;

  const counts = useSyncExternalStore(
    subscribe,
    () => getSnapshotFor(key),
    () => getSnapshotFor(key)
  );

  useEffect(() => {
    ensureWsHook();
    if (!cache.has(key)) void loadCounts(key, normalized);
  }, [key, normalized]);

  useEffect(() => {
    if (foldersRefreshKey === 0) return;
    void loadCounts(key, normalized);
  }, [foldersRefreshKey, key, normalized]);

  return counts;
}
