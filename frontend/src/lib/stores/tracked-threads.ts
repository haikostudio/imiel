"use client";

import { create } from "zustand";
import { toast } from "sonner";
import { trackingItems } from "@/lib/pocketbase";
import { t as tStatic } from "@/lib/i18n";

/** Suivi OUVERT qui ressemble a la conversation qu'on s'apprete a suivre
 * (POST /worker/tracking/candidates, signaux gratuits). */
export interface TrackingCandidate {
  id: string;
  title: string;
  merchant?: string;
  sender_domain?: string;
  type?: string;
  last_message_date?: string;
  reason: "number" | "carrier" | "counterpart" | "domain" | "similar";
}

export type TrackChoice = { action: "attach"; itemId: string } | { action: "create" } | { action: "cancel" };

type PendingChoice = {
  messageId: string;
  threadId?: string | null;
  candidates: TrackingCandidate[];
  resolve: (choice: TrackChoice) => void;
};

/** Delai max de la recherche de suivis ressemblants : au-dela, on cree
 * directement (le clic "Suivre" ne doit jamais paraitre bloque). */
const CANDIDATES_TIMEOUT_MS = 5000;

async function fetchCandidates(messageId: string): Promise<TrackingCandidate[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CANDIDATES_TIMEOUT_MS);
  try {
    const r = await fetch("/worker/tracking/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId }),
      signal: ctrl.signal,
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { candidates?: TrackingCandidate[] };
    return Array.isArray(data.candidates) ? data.candidates : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Source unique de l'etat "cette conversation est-elle suivie ?" cote front.
 *
 * Le SUIVI est decouple de l'etoile/favori (depuis 2026-06-30) : l'etoile ne
 * sert plus qu'aux Favoris. Une conversation est suivie quand il existe une
 * fiche de suivi NON archivee dont le thread_id (ou un des thread_ids fusionnes)
 * correspond. Ce store garde en RAM l'ensemble des thread_id suivis pour que la
 * liste (badge colis) et l'en-tete de conversation (bouton Suivre) partagent le
 * meme etat et se mettent a jour ensemble apres un track/untrack.
 */

type TrackedThreadsState = {
  ids: Set<string>;
  loaded: boolean;
  loading: boolean;
  /** Charge une fois si pas deja fait (no-op si deja charge/en cours). */
  ensureLoaded: () => void;
  /** Recharge l'ensemble depuis PocketBase. */
  refresh: () => Promise<void>;
  /** Vrai si le thread donne est suivi. */
  isTracked: (threadId?: string | null) => boolean;
  /** Suit la conversation d'un message (action explicite, decouplee de l'etoile). */
  track: (messageId: string, threadId?: string | null) => Promise<boolean>;
  /** Ne suit plus la conversation d'un message (archive ses fiches). */
  untrack: (messageId: string, threadId?: string | null) => Promise<boolean>;
  /**
   * Action "Suivre" : cherche d'abord un suivi OUVERT qui ressemble ; s'il y en
   * a, l'utilisateur choisit (ajouter a ce suivi / creer un nouveau) dans
   * TrackingChoicePanel. Toasts centralises ici (jamais aux points d'appel).
   */
  requestTrack: (messageId: string, threadId?: string | null) => Promise<"created" | "attached" | "cancelled" | "failed">;
  /** Choix en attente (panneau "Un suivi ressemble a celui-ci"). */
  pendingChoice: PendingChoice | null;
  resolveChoice: (choice: TrackChoice) => void;
  /** Nombre d'anciens mails rattaches lors de la derniere creation. */
  lastGathered: number;
};

/** Collecte thread_id + thread_ids (fusion par sujet) d'une fiche. */
function collectThreadIds(item: Record<string, unknown>): string[] {
  const out: string[] = [];
  const primary = item.thread_id;
  if (typeof primary === "string" && primary) out.push(primary);
  const extra = item.thread_ids;
  if (Array.isArray(extra)) {
    for (const t of extra) if (typeof t === "string" && t) out.push(t);
  }
  return out;
}

export const useTrackedThreads = create<TrackedThreadsState>((set, get) => ({
  ids: new Set<string>(),
  loaded: false,
  loading: false,

  ensureLoaded: () => {
    const s = get();
    if (s.loaded || s.loading) return;
    void s.refresh();
  },

  refresh: async () => {
    set({ loading: true });
    try {
      const items = await trackingItems().getFullList({
        filter: "archived = false",
        fields: "thread_id,thread_ids",
        requestKey: "tracked-threads",
      });
      const ids = new Set<string>();
      for (const it of items) {
        for (const t of collectThreadIds(it as unknown as Record<string, unknown>)) {
          ids.add(t);
        }
      }
      set({ ids, loaded: true, loading: false });
    } catch {
      // collection absente / non authentifie : etat vide, on retentera plus tard
      set({ loading: false });
    }
  },

  isTracked: (threadId) => (threadId ? get().ids.has(threadId) : false),

  pendingChoice: null,
  lastGathered: 0,

  resolveChoice: (choice) => {
    const pending = get().pendingChoice;
    set({ pendingChoice: null });
    pending?.resolve(choice);
  },

  requestTrack: async (messageId, threadId) => {
    const candidates = await fetchCandidates(messageId);
    let choice: TrackChoice = { action: "create" };
    if (candidates.length > 0) {
      // Un choix deja ouvert (double clic) est annule au profit du nouveau.
      get().pendingChoice?.resolve({ action: "cancel" });
      choice = await new Promise<TrackChoice>((resolve) => {
        set({ pendingChoice: { messageId, threadId, candidates, resolve } });
      });
    }
    if (choice.action === "cancel") return "cancelled";

    if (choice.action === "attach") {
      if (threadId) {
        set((s) => {
          const ids = new Set(s.ids);
          ids.add(threadId);
          return { ids };
        });
      }
      try {
        const r = await fetch("/worker/tracking/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId: choice.itemId, messageIds: [messageId] }),
        });
        if (!r.ok) throw new Error(String(r.status));
        toast.success(tStatic("tracking.addedToExisting"));
        setTimeout(() => void get().refresh(), 2000);
        return "attached";
      } catch {
        if (threadId) {
          set((s) => {
            const ids = new Set(s.ids);
            ids.delete(threadId);
            return { ids };
          });
        }
        toast.error(tStatic("tracking.addToExistingError"));
        return "failed";
      }
    }

    const ok = await get().track(messageId, threadId);
    if (!ok) {
      toast.error(tStatic("tracking.createError"));
      return "failed";
    }
    const gathered = get().lastGathered;
    toast.success(
      gathered > 0
        ? tStatic(gathered > 1 ? "tracking.createdWithOlderMany" : "tracking.createdWithOlderOne", {
            count: String(gathered),
          })
        : tStatic("tracking.created")
    );
    return "created";
  },

  track: async (messageId, threadId) => {
    // Optimiste : on marque suivi immediatement (la fiche est creee en async par
    // le worker, extraction LLM incluse), puis on reconcilie.
    if (threadId) {
      set((s) => {
        const ids = new Set(s.ids);
        ids.add(threadId);
        return { ids };
      });
    }
    try {
      const r = await fetch("/worker/tracking/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
      });
      if (!r.ok) throw new Error(String(r.status));
      try {
        const data = (await r.json()) as { gathered?: number };
        set({ lastGathered: typeof data.gathered === "number" ? data.gathered : 0 });
      } catch {
        set({ lastGathered: 0 });
      }
      // Reconciliation differee (la fiche peut mettre quelques secondes a exister).
      setTimeout(() => void get().refresh(), 4000);
      return true;
    } catch {
      // Rollback de l'optimisme
      if (threadId) {
        set((s) => {
          const ids = new Set(s.ids);
          ids.delete(threadId);
          return { ids };
        });
      }
      return false;
    }
  },

  untrack: async (messageId, threadId) => {
    if (threadId) {
      set((s) => {
        const ids = new Set(s.ids);
        ids.delete(threadId);
        return { ids };
      });
    }
    try {
      const r = await fetch("/worker/tracking/untrack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setTimeout(() => void get().refresh(), 2000);
      return true;
    } catch {
      if (threadId) {
        set((s) => {
          const ids = new Set(s.ids);
          ids.add(threadId);
          return { ids };
        });
      }
      return false;
    }
  },
}));
