"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { t as tStatic } from "@/lib/i18n";
import {
  calendarSuggestions,
  getCurrentUserId,
  type CalendarSuggestion,
} from "@/lib/pocketbase";

/**
 * Store partage des propositions d'echeances (calendar_suggestions, statut
 * pending) detectees dans le suivi. Une SEULE source de verite pour :
 *  - la barre affichee en haut des conversations (SuggestionsBanner) ;
 *  - le drawer de validation (CalendarSuggestionsDrawer) ;
 *  - la page Suivi (qui declenche l'analyse via `openAndAnalyze`).
 * Avant, le drawer detenait les donnees dans un useState local : la barre
 * n'aurait pas pu refleter le meme compteur ni se mettre a jour apres un
 * accept/refuse. Tout vit donc ici (etat reactif via zustand).
 */
interface SuggestionsStore {
  /** Ouverture du drawer de validation. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Demande au drawer de lancer l'analyse des echeances a son ouverture. */
  autoRun: boolean;
  setAutoRun: (v: boolean) => void;
  /** Ouvre le drawer et lance l'analyse (depuis la page Suivi). */
  openAndAnalyze: () => void;

  /** Propositions en attente (a ajouter a l'agenda ou a refuser). */
  pending: CalendarSuggestion[];
  loading: boolean;
  analyzing: boolean;
  analyzeProgress: { done: number; total: number } | null;

  refresh: () => Promise<void>;
  accept: (id: string) => Promise<void>;
  refuse: (id: string) => Promise<void>;
  /** Estimation GRATUITE (nb de fiches ouvertes = nb d'appels LLM). */
  estimate: () => Promise<number | null>;
  runAnalysis: () => Promise<void>;
}

export const useSuggestionsStore = create<SuggestionsStore>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  autoRun: false,
  setAutoRun: (v) => set({ autoRun: v }),
  openAndAnalyze: () => set({ open: true, autoRun: true }),

  pending: [],
  loading: true,
  analyzing: false,
  analyzeProgress: null,

  refresh: async () => {
    set({ loading: true });
    const read = async () =>
      (
        await calendarSuggestions().getList(1, 100, {
          filter: `status = "pending"`,
          sort: "start",
          requestKey: "calendar-suggestions",
        })
      ).items;
    try {
      const items = await read();
      set({ pending: items });
      // Auto-nettoyage best-effort : s'il reste des propositions, retire celles
      // deja presentes dans l'agenda (doublons Google/ICS/manuel) cote worker,
      // puis recharge la liste si quelque chose a ete supprime. Pas d'appel si
      // aucune proposition en attente (cas courant -> zero charge worker).
      if (items.length > 0) {
        const userId = getCurrentUserId();
        if (userId) {
          try {
            const r = await fetch("/worker/tracking/dates/prune", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId }),
            });
            const data = (await r.json().catch(() => ({}))) as { pruned?: number };
            if (data.pruned && data.pruned > 0) {
              set({ pending: await read() });
            }
          } catch {
            /* worker indispo : on garde la liste deja lue */
          }
        }
      }
    } catch {
      /* collection absente ou non authentifie */
    } finally {
      set({ loading: false });
    }
  },

  accept: async (id) => {
    set({ pending: get().pending.filter((s) => s.id !== id) });
    try {
      await fetch(`/worker/tracking/dates/${id}/accept`, { method: "POST" });
      toast.success(tStatic("suggestions.acceptedToast"));
    } catch {
      toast.error(tStatic("message.actionFailed"));
      void get().refresh(); // remet la proposition si l'appel a echoue
    }
  },

  refuse: async (id) => {
    set({ pending: get().pending.filter((s) => s.id !== id) });
    try {
      await fetch(`/worker/tracking/dates/${id}/refuse`, { method: "POST" });
      toast.success(tStatic("suggestions.refusedToast"));
    } catch {
      toast.error(tStatic("message.actionFailed"));
      void get().refresh();
    }
  },

  estimate: async () => {
    const userId = getCurrentUserId();
    if (!userId) return null;
    try {
      const r = await fetch(
        `/worker/tracking/dates/estimate?userId=${encodeURIComponent(userId)}`
      );
      const s = (await r.json()) as { fiches?: number };
      return typeof s.fiches === "number" ? s.fiches : null;
    } catch {
      return null;
    }
  },

  // Lance l'analyse des echeances sur les fiches ouvertes + suit la progression.
  runAnalysis: async () => {
    const userId = getCurrentUserId();
    if (!userId) return;
    set({ analyzing: true, analyzeProgress: null });
    try {
      await fetch("/worker/tracking/dates/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const r = await fetch(
            `/worker/tracking/dates/analyze-status?userId=${encodeURIComponent(userId)}`
          );
          const s = (await r.json()) as { running?: boolean; done?: number; total?: number };
          set({ analyzeProgress: { done: s.done ?? 0, total: s.total ?? 0 } });
          if (!s.running) break;
        } catch {
          /* on continue d'essayer */
        }
      }
      await get().refresh();
    } catch {
      /* worker indisponible */
    } finally {
      set({ analyzing: false });
    }
  },
}));

/**
 * Etat d'ouverture du drawer (+ declenchement de l'analyse), partage entre la
 * page Suivi et le montage global. Alias du store complet : les selecteurs
 * existants (`s.open`, `s.openAndAnalyze`, ...) restent valides.
 */
export const useSuggestionsDrawer = useSuggestionsStore;

/**
 * Hook de compat : declenche un refresh des propositions au montage et expose
 * l'etat partage du store. Utilise par le drawer (proprietaire de l'analyse)
 * et, indirectement, par tout consommateur ayant besoin d'un refresh initial.
 */
export function useCalendarSuggestions() {
  const refresh = useSuggestionsStore((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = useSuggestionsStore((s) => s.pending);
  const loading = useSuggestionsStore((s) => s.loading);
  const accept = useSuggestionsStore((s) => s.accept);
  const refuse = useSuggestionsStore((s) => s.refuse);
  const estimate = useSuggestionsStore((s) => s.estimate);
  const runAnalysis = useSuggestionsStore((s) => s.runAnalysis);
  const analyzing = useSuggestionsStore((s) => s.analyzing);
  const analyzeProgress = useSuggestionsStore((s) => s.analyzeProgress);

  return {
    pending,
    count: pending.length,
    loading,
    refresh,
    accept,
    refuse,
    estimate,
    runAnalysis,
    analyzing,
    analyzeProgress,
  };
}
