"use client";

import { create } from "zustand";
import pb, { users } from "@/lib/pocketbase";
import {
  AI_COMPOSE_MODEL_STORAGE_KEY,
  DEFAULT_AI_COMPOSE_MODEL,
  isAiComposeModel,
  pricedCatalog,
  type AiModelPrice,
} from "@/lib/ai-models";

// Modele choisi dans le menu IA de la fenetre d'ecriture (ligne "Modele"),
// partage par toutes les fenetres ouvertes. Retenu sur le COMPTE
// (users.ai_compose_model, identique sur tous les appareils) avec un repli
// localStorage pour le premier rendu et tant que le champ n'existe pas encore
// cote serveur. Prix du jour lus une fois par session via /api/ai/models.

function readInitial(): string {
  const fromAccount = (pb.authStore.record as { ai_compose_model?: unknown } | null)?.ai_compose_model;
  if (isAiComposeModel(fromAccount)) return fromAccount;
  try {
    const local = typeof window !== "undefined" ? window.localStorage.getItem(AI_COMPOSE_MODEL_STORAGE_KEY) : null;
    if (isAiComposeModel(local)) return local;
  } catch {
    // stockage indisponible (navigation privee) : defaut
  }
  return DEFAULT_AI_COMPOSE_MODEL;
}

interface AiComposeModelState {
  model: string;
  models: AiModelPrice[];
  loaded: boolean;
  setModel: (id: string) => void;
  loadModels: () => void;
}

let loading = false;

export const useAiComposeModel = create<AiComposeModelState>((set, get) => ({
  model: readInitial(),
  models: pricedCatalog(),
  loaded: false,
  setModel: (id) => {
    if (!isAiComposeModel(id) || id === get().model) return;
    set({ model: id });
    try {
      window.localStorage.setItem(AI_COMPOSE_MODEL_STORAGE_KEY, id);
    } catch {
      // ignore
    }
    const userId = pb.authStore.record?.id;
    if (userId) {
      users()
        .update(userId, { ai_compose_model: id })
        .catch((err) => console.warn("[ai-model] preference non enregistree sur le compte:", err?.message || err));
    }
  },
  loadModels: () => {
    if (get().loaded || loading) return;
    loading = true;
    // Le compte peut porter un choix fait sur un autre appareil.
    const fromAccount = (pb.authStore.record as { ai_compose_model?: unknown } | null)?.ai_compose_model;
    if (isAiComposeModel(fromAccount) && fromAccount !== get().model) set({ model: fromAccount });
    fetch("/api/ai/models")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { models?: AiModelPrice[] }) => {
        const models = (d.models || []).filter((m) => isAiComposeModel(m.id));
        if (!models.length) return;
        // Modele retire du catalogue du fournisseur : le serveur retombe sur
        // le defaut, l'ecran l'affiche aussi (sans toucher au choix enregistre).
        const model = models.some((m) => m.id === get().model) ? get().model : DEFAULT_AI_COMPOSE_MODEL;
        set({ models, model, loaded: true });
      })
      .catch(() => {
        // prix de repli deja en place
      })
      .finally(() => {
        loading = false;
      });
  },
}));

/** Le modele courant, tel qu'il est affiche (repli sur le catalogue statique). */
export function currentAiModel(state: Pick<AiComposeModelState, "model" | "models">): AiModelPrice {
  return (
    state.models.find((m) => m.id === state.model) ||
    pricedCatalog().find((m) => m.id === state.model) ||
    pricedCatalog().find((m) => m.id === DEFAULT_AI_COMPOSE_MODEL)!
  );
}
