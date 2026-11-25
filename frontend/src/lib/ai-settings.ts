import pb from "@/lib/pocketbase";

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
