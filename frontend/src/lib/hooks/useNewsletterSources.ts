"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import pb, { getCurrentUserId, type NewsletterSource } from "@/lib/pocketbase";

/**
 * Sources newsletter designees par l'utilisateur (newsletter_sources).
 * Etat partage au niveau module : un thread rend plusieurs MessageAccordion,
 * on ne veut pas N fetchs. Chaque hook s'abonne aux changements.
 */
let cache: NewsletterSource[] | null = null;
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function ensureLoaded(force = false): Promise<void> {
  if (loaded && !force) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await pb
        .collection<NewsletterSource>("newsletter_sources")
        .getFullList({ sort: "name", requestKey: "newsletter-sources" });
      cache = res;
      loaded = true;
      emit();
    } catch {
      cache = cache ?? [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Recharge la liste partagee (apres un ajout/retrait fait hors du hook, ex: assistant IA). */
export function reloadNewsletterSources(): Promise<void> {
  return ensureLoaded(true);
}

export function useNewsletterSources() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    void ensureLoaded();
    return () => {
      listeners.delete(l);
    };
  }, []);

  const sources = cache ?? [];
  const emails = useMemo(
    () => new Set(sources.map((s) => (s.email || "").toLowerCase())),
    [sources]
  );

  const isSource = useCallback(
    (email: string) => emails.has((email || "").toLowerCase()),
    [emails]
  );

  const addSource = useCallback(
    async (email: string, name?: string) => {
      const userId = getCurrentUserId();
      const e = (email || "").trim().toLowerCase();
      if (!userId || !e || emails.has(e)) return;
      const rec = await pb
        .collection<NewsletterSource>("newsletter_sources")
        .create({ user: userId, email: e, name: name || "" });
      cache = [...(cache ?? []), rec];
      emit();
      // Agrege immediatement l'historique recent de cette source.
      void fetch("/worker/newsletters/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, email: e }),
      }).catch(() => {});
    },
    [emails]
  );

  const removeSource = useCallback(async (email: string) => {
    const e = (email || "").toLowerCase();
    const found = (cache ?? []).find((s) => (s.email || "").toLowerCase() === e);
    if (!found) return;
    await pb.collection("newsletter_sources").delete(found.id);
    cache = (cache ?? []).filter((s) => s.id !== found.id);
    emit();
  }, []);

  return { sources, isSource, addSource, removeSource, loading: !loaded };
}
