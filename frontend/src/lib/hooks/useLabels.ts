"use client";

import { useEffect, useSyncExternalStore } from "react";
import { labels as labelsCollection, type Label, getCurrentUserId } from "@/lib/pocketbase";
import { onPbEvent } from "@/lib/ws-channel";
import { bootMark } from "@/lib/boot-perf";
import { useMailStore } from "@/lib/stores/mail-store";

// Cache module-level partage : un seul fetch pour tous les composants qui
// consomment useLabels(). Refresh sur evenements PB realtime + au login.

let cache: Map<string, Label> = new Map();
let loaded = false;
let loadingPromise: Promise<void> | null = null;
// IDs deja cherches sans succes : on ne re-fetch pas pour eux (sinon boucle
// infinie si un message reference un label supprime / d'un autre user).
const knownMissingIds = new Set<string>();
const subscribers = new Set<() => void>();

function emit() {
  for (const fn of subscribers) fn();
}

export async function loadLabels(): Promise<void> {
  // Dedup : si un fetch est deja en cours, on attend celui-la au lieu d'en
  // empiler des dizaines (cause de la saturation reseau au boot).
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const userId = getCurrentUserId();
    if (!userId) {
      cache = new Map();
      loaded = true;
      emit();
      return;
    }
    const t0 = performance.now();
    bootMark("labels:fetch-start");
    try {
      const result = await labelsCollection().getFullList<Label>({
        filter: `user = "${userId}"`,
        sort: "name",
      });
      const next = new Map<string, Label>();
      const secondaryIds: string[] = [];
      for (const lbl of result) {
        next.set(lbl.id, lbl);
        if (lbl.is_secondary) secondaryIds.push(lbl.id);
      }
      cache = next;
      loaded = true;
      // Mirror dans le store Zustand : tous les hooks de liste (useThreads,
      // useMessages) lisent depuis le store, garantissant un re-render synchrone
      // sur toggle (sans dependre d'un re-fetch reseau).
      useMailStore.getState().setSecondaryLabelIds(secondaryIds);
      bootMark("labels:fetch-done", { dur_ms: Math.round(performance.now() - t0), count: result.length });
      emit();
    } catch {
      bootMark("labels:fetch-error", { dur_ms: Math.round(performance.now() - t0) });
      loaded = true;
      emit();
    }
  })().finally(() => { loadingPromise = null; });
  return loadingPromise;
}

function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  return loadLabels();
}

function getSnapshot(): Map<string, Label> {
  return cache;
}

function getServerSnapshot(): Map<string, Label> {
  return cache;
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

let wsHooked = false;
function ensureWsHook() {
  if (wsHooked) return;
  wsHooked = true;
  onPbEvent((collection, action, record) => {
    if (collection !== "labels") return;
    const currentUserId = getCurrentUserId();
    if (!currentUserId) return;
    const recordUser = (record as { user?: string } | null)?.user;
    if (recordUser && recordUser !== currentUserId) return;
    // Nouveau label cote serveur : on redonne une chance aux IDs blackliste.
    knownMissingIds.clear();
    void loadLabels();
  });
}

export interface UseLabelsReturn {
  byId: Map<string, Label>;
  list: Label[];
  resolve: (ids: string[] | undefined | null) => Label[];
  refresh: () => Promise<void>;
  toggleSecondary: (id: string) => Promise<void>;
  removeLabel: (id: string) => Promise<void>;
  renameLabel: (id: string, name: string) => Promise<void>;
  setLabelColor: (id: string, color: string) => Promise<void>;
}

// Suppression optimiste : on retire le label du cache (et de la liste des
// secondaires du store) immediatement, puis on supprime cote PB. Rollback si
// echec. Evite la fenetre "rien ne se passe" pendant le refetch de tous les
// labels (perPage=1000) sur reseau lent.
async function removeLabel(id: string): Promise<void> {
  const current = cache.get(id);
  if (!current) return;
  cache = new Map(cache);
  cache.delete(id);
  emit();
  if (current.is_secondary) {
    useMailStore.getState().setSecondaryLabelIds(
      useMailStore.getState().secondaryLabelIds.filter((x) => x !== id)
    );
  }
  try {
    await labelsCollection().delete(id);
  } catch {
    cache = new Map(cache);
    cache.set(id, current);
    emit();
    if (current.is_secondary) {
      useMailStore.getState().setSecondaryLabelIds([
        ...useMailStore.getState().secondaryLabelIds,
        id,
      ]);
    }
    throw new Error("removeLabel failed");
  }
}

// Renommage optimiste.
async function renameLabel(id: string, name: string): Promise<void> {
  const current = cache.get(id);
  if (!current) return;
  cache = new Map(cache);
  cache.set(id, { ...current, name });
  emit();
  try {
    await labelsCollection().update(id, { name });
  } catch {
    cache = new Map(cache);
    cache.set(id, current);
    emit();
    throw new Error("renameLabel failed");
  }
}

// Changement de couleur optimiste.
async function setLabelColor(id: string, color: string): Promise<void> {
  const current = cache.get(id);
  if (!current) return;
  cache = new Map(cache);
  cache.set(id, { ...current, color });
  emit();
  try {
    await labelsCollection().update(id, { color });
  } catch {
    cache = new Map(cache);
    cache.set(id, current);
    emit();
    throw new Error("setLabelColor failed");
  }
}

async function toggleSecondary(id: string): Promise<void> {
  const current = cache.get(id);
  if (!current) return;
  const next = !current.is_secondary;
  // Optimistic : 1) store Zustand (toutes les listes filtrent instantanement),
  // 2) cache useLabels (pour l'UI LabelsNav qui rend lbl.is_secondary).
  useMailStore.getState().toggleSecondaryLabel(id);
  cache = new Map(cache);
  cache.set(id, { ...current, is_secondary: next });
  emit();
  try {
    await labelsCollection().update(id, { is_secondary: next });
  } catch {
    // rollback : on remet l'etat initial dans le store ET le cache
    useMailStore.getState().toggleSecondaryLabel(id);
    cache = new Map(cache);
    cache.set(id, current);
    emit();
    throw new Error("toggleSecondary failed");
  }
}

export function useLabels(): UseLabelsReturn {
  const byId = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    ensureWsHook();
    void ensureLoaded();
  }, []);

  const list = Array.from(byId.values());

  function resolve(ids: string[] | undefined | null): Label[] {
    if (!ids || ids.length === 0) return [];
    const out: Label[] = [];
    let hasNewMissing = false;
    for (const id of ids) {
      const lbl = byId.get(id);
      if (lbl) out.push(lbl);
      else if (!knownMissingIds.has(id)) {
        // Premiere fois qu'on voit cet id manquant : on le note et on declenche
        // un fetch unique. Sans ce garde-fou, MessageLabels (rendu pour chaque
        // ligne) declenche une boucle infinie loadLabels -> emit -> render ->
        // resolve -> loadLabels...
        knownMissingIds.add(id);
        hasNewMissing = true;
      }
    }
    if (hasNewMissing && loaded) void loadLabels();
    return out;
  }

  const refresh = async () => {
    knownMissingIds.clear();
    await loadLabels();
  };

  return { byId, list, resolve, refresh, toggleSecondary, removeLabel, renameLabel, setLabelColor };
}

/** Reset cache (logout). */
export function resetLabelsCache(): void {
  cache = new Map();
  loaded = false;
  loadingPromise = null;
  knownMissingIds.clear();
  emit();
}
