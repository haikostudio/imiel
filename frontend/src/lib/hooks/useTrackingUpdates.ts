"use client";

import { useEffect, useRef } from "react";
import { create } from "zustand";
import { trackingItems, getCurrentUserId } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";

/**
 * Compteur partage des suivis OUVERTS non lus (fiches avec du neuf : rattachement
 * live, changement de statut...). Sert au bandeau "X suivi(s) mis a jour" affiche
 * SOUS la barre de recherche sur toutes les pages SAUF la page Suivi (ou le neuf
 * est deja visible dans la liste). Meme critere que le `unreadOpen` de la page
 * Suivi : archived = false && is_read = false && statut ouvert (ni done ni
 * cancelled), filtre par compte actif comme la liste.
 *
 * Une SEULE source de verite (zustand) pour que le compteur et le bouton "Tout
 * marquer comme lu" restent coherents d'une page a l'autre (meme pattern que
 * useSuggestionsStore).
 */

// Fiches OUVERTES non lues (memes bornes que `unreadOpen` de la page Suivi).
const OPEN_UNREAD =
  `archived = false && is_read = false && status != "done" && status != "cancelled"`;

interface TrackingUpdatesStore {
  /** Ids des fiches ouvertes non lues (leur nombre = compteur du bandeau). */
  ids: string[];
  refresh: (accountId?: string | null) => Promise<void>;
  markAllRead: () => Promise<void>;
}

export const useTrackingUpdatesStore = create<TrackingUpdatesStore>((set, get) => ({
  ids: [],

  refresh: async (accountId) => {
    const accountFilter =
      accountId && accountId !== "all" ? `account = "${accountId}" && ` : "";
    try {
      const items = await trackingItems().getFullList({
        filter: `${accountFilter}${OPEN_UNREAD}`,
        fields: "id",
        requestKey: "tracking-updates",
      });
      set({ ids: items.map((it) => it.id) });
    } catch {
      /* collection absente ou non authentifie : on garde l'etat courant */
    }
  },

  markAllRead: async () => {
    const ids = get().ids;
    set({ ids: [] }); // optimiste : le bandeau disparait immediatement
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await trackingItems().update(id, { is_read: true }, { requestKey: null });
      } catch {
        /* best effort */
      }
    }
  },
}));

/**
 * Alimente le store : refresh au montage + a chaque changement de compte actif,
 * realtime PocketBase (nouveau suivi / lecture d'une fiche ailleurs) et poll de
 * secours (60s) si le SSE n'est pas etabli. Monte une seule fois via le bandeau
 * global (TrackingUpdatesBanner) dans le layout.
 */
export function useTrackingUpdates() {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const refresh = useTrackingUpdatesStore((s) => s.refresh);

  // Compte actif courant, lisible depuis les callbacks realtime/poll sans avoir
  // a re-souscrire a chaque changement (cf useAgendaEvents).
  const accountRef = useRef(activeAccountId);
  accountRef.current = activeAccountId;

  useEffect(() => {
    void refresh(activeAccountId);
  }, [activeAccountId, refresh]);

  useEffect(() => {
    const userId = getCurrentUserId();
    if (!userId) return;

    let unsub: (() => void) | undefined;
    let cancelled = false;
    trackingItems()
      .subscribe("*", (e) => {
        if (e.record?.user === userId) void refresh(accountRef.current);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unsub = fn;
      })
      .catch(() => {
        /* SSE indisponible : le poll de secours prend le relais */
      });

    const poll = setInterval(() => void refresh(accountRef.current), 60_000);

    return () => {
      cancelled = true;
      if (unsub) unsub();
      clearInterval(poll);
    };
  }, [refresh]);
}
