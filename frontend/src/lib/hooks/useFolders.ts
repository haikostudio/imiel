"use client";

import { useEffect, useSyncExternalStore } from "react";
import { folders, type Folder } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import { bootMark } from "@/lib/boot-perf";

// Cache module-level partage par activeAccountId : un seul fetch meme si
// plusieurs composants consomment useFolders() simultanement.
// La cle est l'activeAccountId (ou "__all__" pour tous les comptes).

type CacheKey = string;
const cache: Map<CacheKey, Folder[]> = new Map();
const loadedKeys = new Set<CacheKey>();
const loadingPromises: Map<CacheKey, Promise<void>> = new Map();
const subscribers = new Set<() => void>();

function emit() {
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

const EMPTY: Folder[] = [];

function getSnapshotFor(key: CacheKey | null): Folder[] {
  if (!key) return EMPTY;
  return cache.get(key) ?? EMPTY;
}

async function loadFolders(key: CacheKey, accountFilter: string): Promise<void> {
  const existing = loadingPromises.get(key);
  if (existing) return existing;
  const promise = (async () => {
    bootMark("folders:fetch-start", { account: accountFilter || "all" });
    const t0 = performance.now();
    try {
      const filter = accountFilter ? `account = "${accountFilter}"` : "";
      const result = await folders().getFullList<Folder>({
        filter,
        sort: "sort_order,name",
      });
      cache.set(key, result);
      loadedKeys.add(key);
      bootMark("folders:fetch-done", {
        dur_ms: Math.round(performance.now() - t0),
        count: result.length,
      });
      emit();
    } catch {
      bootMark("folders:fetch-error", { dur_ms: Math.round(performance.now() - t0) });
      cache.set(key, []);
      loadedKeys.add(key);
      emit();
    }
  })().finally(() => { loadingPromises.delete(key); });
  loadingPromises.set(key, promise);
  return promise;
}

interface UseFoldersReturn {
  folders: Folder[];
  loading: boolean;
}

export function useFolders(): UseFoldersReturn {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const foldersRefreshKey = useMailStore((s) => s.foldersRefreshKey);
  const key: CacheKey | null = activeAccountId ?? null;

  // Snapshot lie a la cle active : on s'abonne globalement mais on extrait
  // selon la cle. useSyncExternalStore re-render quand emit() est appele,
  // donc le composant voit le bon snapshot.
  const items = useSyncExternalStore(
    subscribe,
    () => getSnapshotFor(key),
    () => getSnapshotFor(key)
  );

  useEffect(() => {
    if (!key) return;
    if (loadedKeys.has(key)) return;
    const accountFilter = key === "all" ? "" : key;
    void loadFolders(key, accountFilter);
  }, [key]);

  // Invalidation explicite (WS update).
  useEffect(() => {
    if (foldersRefreshKey === 0) return;
    if (!key) return;
    loadedKeys.delete(key);
    const accountFilter = key === "all" ? "" : key;
    void loadFolders(key, accountFilter);
  }, [foldersRefreshKey, key]);

  return {
    folders: items,
    loading: key !== null && !loadedKeys.has(key),
  };
}

/**
 * Charge tous les dossiers de tous les comptes (pour les settings).
 * Utilise une cle de cache distincte (__all_unfiltered__).
 */
const ALL_KEY = "__all_unfiltered__";

export function useFoldersAll(): UseFoldersReturn {
  const foldersRefreshKey = useMailStore((s) => s.foldersRefreshKey);
  const items = useSyncExternalStore(
    subscribe,
    () => getSnapshotFor(ALL_KEY),
    () => getSnapshotFor(ALL_KEY)
  );

  useEffect(() => {
    if (loadedKeys.has(ALL_KEY)) return;
    void loadFoldersAll();
  }, []);

  useEffect(() => {
    if (foldersRefreshKey === 0) return;
    loadedKeys.delete(ALL_KEY);
    void loadFoldersAll();
  }, [foldersRefreshKey]);

  return {
    folders: items,
    loading: !loadedKeys.has(ALL_KEY),
  };
}

async function loadFoldersAll(): Promise<void> {
  const existing = loadingPromises.get(ALL_KEY);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const result = await folders().getFullList<Folder>({
        sort: "sort_order,name",
      });
      cache.set(ALL_KEY, result);
      loadedKeys.add(ALL_KEY);
      emit();
    } catch {
      cache.set(ALL_KEY, []);
      loadedKeys.add(ALL_KEY);
      emit();
    }
  })().finally(() => { loadingPromises.delete(ALL_KEY); });
  loadingPromises.set(ALL_KEY, promise);
  return promise;
}

/** Reset cache (logout). */
export function resetFoldersCache(): void {
  cache.clear();
  loadedKeys.clear();
  loadingPromises.clear();
  emit();
}
