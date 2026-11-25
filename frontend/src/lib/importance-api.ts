import pb from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import type { Importance } from "@/lib/importance";

export interface ImportanceChangeResult {
  ok: boolean;
  scope: "message" | "sender";
  importance: Importance;
  updated: number;
  sender?: string;
}

/**
 * "Changer le niveau" : ce mail seulement, ou tous les mails de l'expediteur
 * (regle + reclassement). Mise a jour locale immediate de la ligne ; pour un
 * expediteur, la liste est rafraichie en douceur (d'autres lignes changent).
 */
export async function changeMessageImportance(
  messageId: string,
  importance: Importance,
  scope: "message" | "sender"
): Promise<ImportanceChangeResult> {
  const store = useMailStore.getState();
  store.notifyMessageUpdate(messageId, {
    importance,
    importance_source: scope === "message" ? "user" : "rule",
  });
  const res = await pb.send<ImportanceChangeResult>("/api/mail/importance", {
    method: "POST",
    body: { message_id: messageId, importance, scope },
  });
  if (scope === "sender") store.invalidateMessages();
  return res;
}
