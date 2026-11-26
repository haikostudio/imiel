import { useSyncExternalStore } from "react";
import pb from "@/lib/pocketbase";

// Version POUR TOUS (app d'ordinateur, iPhone en copie complete) : aucune cle
// d'IA de l'editeur n'est livree (DEC-331). L'IA n'apparait qu'une fois la cle
// OpenRouter de l'utilisateur saisie (Reglages > IA).
export const EDITION_POUR_TOUS = process.env.NEXT_PUBLIC_IMIEL_EDITION === "tous";

// App web iMiel Cloud : pas de serveur d'app derriere l'interface (la base vit
// dans le navigateur), donc pas d'IA, meme avec une cle.
const APP_WEB = process.env.NEXT_PUBLIC_IMIEL_WEB === "1";

export function iaDisponible(): boolean {
  if (APP_WEB) return false;
  return !EDITION_POUR_TOUS || !!getOpenRouterKey();
}

/** Vrai si les fonctions d'IA peuvent s'afficher (suit la session en direct). */
export function useIaDisponible(): boolean {
  return useSyncExternalStore(
    (cb) => pb.authStore.onChange(cb),
    iaDisponible,
    () => !EDITION_POUR_TOUS && !APP_WEB
  );
}

const LEGACY_LS_KEY = "imiel:openrouterApiKey";

export function getOpenRouterKey(): string {
  const rec = pb.authStore.record as { openrouter_api_key?: string } | null;
  return (rec?.openrouter_api_key ?? "").trim();
}

export async function setOpenRouterKey(key: string): Promise<void> {
  const userId = pb.authStore.record?.id;
  if (!userId) throw new Error("not authenticated");
  const trimmed = key.trim();
  await pb.collection("users").update(userId, { openrouter_api_key: trimmed });
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(LEGACY_LS_KEY);
    } catch {
      // ignore
    }
  }
}

export function getCerveauKey(): string {
  const rec = pb.authStore.record as { cerveau_api_key?: string } | null;
  return (rec?.cerveau_api_key ?? "").trim();
}

export async function setCerveauKey(key: string): Promise<void> {
  const userId = pb.authStore.record?.id;
  if (!userId) throw new Error("not authenticated");
  await pb.collection("users").update(userId, { cerveau_api_key: key.trim() });
}

export type PauseFlag =
  | "sync_paused"
  | "ai_embeddings_paused"
  | "ai_categorize_paused"
  | "cerveau_paused"
  | "tracking_paused";

export function getPauseFlag(flag: PauseFlag): boolean {
  const rec = pb.authStore.record as Record<string, unknown> | null;
  return !!rec?.[flag];
}

export async function setPauseFlag(flag: PauseFlag, value: boolean): Promise<void> {
  const userId = pb.authStore.record?.id;
  if (!userId) throw new Error("not authenticated");
  await pb.collection("users").update(userId, { [flag]: value });
}
