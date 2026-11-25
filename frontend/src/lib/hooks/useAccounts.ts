"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Account, accounts, getCurrentUserId } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import { bootMark } from "@/lib/boot-perf";

// Cache module-level partage : tous les composants qui consomment useAccounts()
// se branchent sur le meme cache. Un seul fetch reseau au boot, meme si 10
// composants l'appellent (Sidebar, Header, FolderNav, ThreadView, etc).

let cache: Account[] = [];
let loaded = false;
let loadError: string | null = null;
let loadingPromise: Promise<void> | null = null;
const subscribers = new Set<() => void>();

function emit() {
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

function getSnapshot(): Account[] {
  return cache;
}

export async function loadAccounts(): Promise<void> {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const userId = getCurrentUserId();
    if (!userId) {
      cache = [];
      loaded = true;
      emit();
      return;
    }
    bootMark("accounts:fetch-start");
    const t0 = performance.now();
    try {
      const result = await accounts().getFullList<Account>({
        filter: `user = "${userId}"`,
        sort: "label",
      });
      cache = Array.isArray(result) ? result : [];
      loadError = null;
      loaded = true;
      bootMark("accounts:fetch-done", {
        dur_ms: Math.round(performance.now() - t0),
        count: cache.length,
      });
      emit();
    } catch (err) {
      bootMark("accounts:fetch-error", { dur_ms: Math.round(performance.now() - t0) });
      loadError = err instanceof Error ? err.message : "Erreur lors du chargement des comptes";
      loaded = true;
      emit();
    }
  })().finally(() => { loadingPromise = null; });
  return loadingPromise;
}

interface UseAccountsReturn {
  accounts: Account[];
  loading: boolean;
  error: string | null;
  createAccount: (
    data: Partial<Omit<Account, "id" | "created" | "updated" | "user">>
  ) => Promise<Account>;
  updateAccount: (
    id: string,
    data: Partial<Omit<Account, "id" | "created" | "updated" | "user">>
  ) => Promise<Account>;
  deleteAccount: (id: string) => Promise<void>;
  refreshAccounts: () => Promise<void>;
}

export function useAccounts(): UseAccountsReturn {
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const messagesRefreshKey = useMailStore((s) => s.messagesRefreshKey);

  useEffect(() => {
    if (!loaded) void loadAccounts();
  }, []);

  // Refresh sur invalidation (WS update). Pas de fetch si rien n'a change
  // (premiere valeur ignoree pour eviter le double boot fetch).
  useEffect(() => {
    if (messagesRefreshKey === 0) return;
    void loadAccounts();
  }, [messagesRefreshKey]);

  const createAccount = useCallback(
    async (
      data: Partial<Omit<Account, "id" | "created" | "updated" | "user">>
    ) => {
      const userId = getCurrentUserId();
      if (!userId) throw new Error("Non authentifié");
      const created = await accounts().create<Account>({ ...data, user: userId });
      await loadAccounts();
      return created;
    },
    []
  );

  const updateAccount = useCallback(
    async (
      id: string,
      data: Partial<Omit<Account, "id" | "created" | "updated" | "user">>
    ) => {
      const updated = await accounts().update<Account>(id, data);
      await loadAccounts();
      return updated;
    },
    []
  );

  const deleteAccount = useCallback(async (id: string) => {
    await accounts().delete(id);
    await loadAccounts();
  }, []);

  const refreshAccounts = useCallback(async () => {
    await loadAccounts();
  }, []);

  return {
    accounts: items,
    loading: !loaded,
    error: loadError,
    createAccount,
    updateAccount,
    deleteAccount,
    refreshAccounts,
  };
}

/** Reset cache (logout). */
export function resetAccountsCache(): void {
  cache = [];
  loaded = false;
  loadError = null;
  loadingPromise = null;
  emit();
}
