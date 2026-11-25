"use client";

import { create } from "zustand";
import pb from "@/lib/pocketbase";

/**
 * Adresses auxquelles l'utilisateur a DEJA ecrit (GET /api/mail/correspondents,
 * index couvrant des mails envoyes). Alimente le rappel "attend une reponse" :
 * seul un vrai correspondant declenche le rappel, jamais une alerte ou une
 * confirmation automatique a laquelle on n'a jamais repondu.
 *
 * `addresses` reste null tant que rien n'est charge : le rappel ne s'affiche
 * alors pas du tout (mieux vaut aucun rappel qu'un faux).
 */

// Rechargement au plus toutes les 10 min (un nouveau correspondant n'apparait
// qu'apres lui avoir ecrit, et ce fil-la n'attend alors plus de reponse).
const STALE_MS = 10 * 60_000;

type CorrespondentsState = {
  addresses: Set<string> | null;
  loading: boolean;
  lastLoaded: number;
  ensureLoaded: () => void;
};

export const useCorrespondents = create<CorrespondentsState>((set, get) => ({
  addresses: null,
  loading: false,
  lastLoaded: 0,
  ensureLoaded: () => {
    const { loading, lastLoaded } = get();
    if (loading || Date.now() - lastLoaded < STALE_MS) return;
    set({ loading: true });
    pb.send<{ addresses: string[] }>("/api/mail/correspondents", { method: "GET" })
      .then((res) => {
        set({ addresses: new Set(res.addresses || []), lastLoaded: Date.now() });
      })
      .catch(() => {
        /* best effort : sans liste, pas de rappel */
      })
      .finally(() => set({ loading: false }));
  },
}));
