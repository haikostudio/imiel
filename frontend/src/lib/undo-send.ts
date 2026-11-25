"use client";

import { toast } from "sonner";
import { sendMessage, updateMessageViaWorker } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import { sendAction } from "@/lib/ws-channel";
import { t as tStatic } from "@/lib/i18n";

/**
 * Delai d'annulation de l'envoi (facon Gmail "Annuler l'envoi").
 * On ne contacte le worker SMTP qu'a l'expiration de ce delai : pendant la
 * fenetre, le mail reste un brouillon, donc "Annuler" n'a rien a rappeler.
 */
export const UNDO_SEND_DELAY_MS = 15000;

interface PendingSend {
  timer: ReturnType<typeof setTimeout>;
  /** Tick du decompte affiche dans le toast. */
  interval: ReturnType<typeof setInterval>;
  /** Id du toast (pour le mettre a jour / le fermer). */
  toastId: string;
  /** Rouvre la fenetre de composition avec le brouillon (annulation / echec). */
  reopen: () => void;
}

/** Envois en attente d'expiration, indexes par id de brouillon. */
const pending = new Map<string, PendingSend>();

export interface UndoableSendParams {
  /** Id du brouillon (message) a envoyer. */
  draftId: string;
  accountId: string;
  /** Reponse (reply/reply-all) : le message d'origine sera marque comme repondu. */
  isReply: boolean;
  /** Id du message d'origine (pour is_answered). */
  replyMsgId?: string;
  /** Ids de brouillons a retirer des listes/compteurs a l'envoi effectif. */
  draftIdsToClear: string[];
  /** Identifiant de la source compose (broadcast lifecycle). */
  sourceId: string;
  /** Rouvre le brouillon en composition (annulation ou echec d'envoi). */
  reopen: () => void;
}

/**
 * Programme un envoi differe de {@link UNDO_SEND_DELAY_MS} et affiche un toast
 * "Message envoye / Annuler l'envoi". Cliquer "Annuler" avant l'expiration
 * rouvre simplement le brouillon (rien n'a ete envoye).
 */
export function beginUndoableSend(params: UndoableSendParams): void {
  const { draftId } = params;

  // Un envoi differe deja en cours pour ce brouillon ? On le nettoie pour eviter
  // un double envoi (l'utilisateur a relance depuis une reouverture).
  const existing = pending.get(draftId);
  if (existing) {
    clearTimeout(existing.timer);
    clearInterval(existing.interval);
    toast.dismiss(existing.toastId);
  }

  const toastId = `undo-send:${draftId}`;
  const totalSec = Math.round(UNDO_SEND_DELAY_MS / 1000);
  let remaining = totalSec;

  // Toast persistant (duration: Infinity) mis a jour chaque seconde pour
  // afficher le decompte. On le ferme nous-memes (envoi effectif / annulation).
  const showToast = () => {
    toast.success(`${tStatic("compose.messageSent")} · ${remaining} s`, {
      id: toastId,
      duration: Infinity,
      action: {
        label: tStatic("compose.cancelSend"),
        onClick: () => cancelUndoableSend(draftId),
      },
    });
  };
  showToast();

  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      // A 0 le setTimeout ci-dessous prend le relais (envoi + fermeture toast) :
      // on evite d'afficher "0 s".
      clearInterval(interval);
      return;
    }
    showToast();
  }, 1000);

  const timer = setTimeout(() => {
    const p = pending.get(draftId);
    if (p) clearInterval(p.interval);
    pending.delete(draftId);
    toast.dismiss(toastId);
    void performSend(params);
  }, UNDO_SEND_DELAY_MS);

  pending.set(draftId, { timer, interval, toastId, reopen: params.reopen });
}

/** Annule un envoi differe et rouvre le brouillon qu'on venait de fermer. */
export function cancelUndoableSend(draftId: string): void {
  const p = pending.get(draftId);
  if (!p) return;
  clearTimeout(p.timer);
  clearInterval(p.interval);
  pending.delete(draftId);
  toast.dismiss(p.toastId);
  // A la fermeture, handleSend a appele clearDraftState() qui a laisse dans le
  // store un evenement `draftLifecycleEvent = { draftId, event: "deleted" }`.
  // Sans le purger, la fenetre qu'on rouvre (meme draftId, nouveau sourceId)
  // le rejoue via useDraftSync -> onDeleted() -> onClose() et se referme
  // instantanement. On l'efface donc AVANT de rouvrir.
  useMailStore.setState({ draftLifecycleEvent: null });
  // Rouvrir immediatement le brouillon (mode edit) pour reprendre l'ecriture.
  p.reopen();
  toast.info(tStatic("compose.sendCancelled"));
}

/** Envoi effectif via le worker SMTP + bookkeeping + rafraichissement. */
async function performSend(params: UndoableSendParams): Promise<void> {
  const { draftId, accountId, isReply, replyMsgId, draftIdsToClear, sourceId } = params;
  try {
    // Les PJ ont ete uploadees avant la fenetre : le worker reprend les PJ deja
    // persistees dans PB (pas de files a repasser ici).
    await sendMessage(accountId, draftId);

    // Marquer le message d'origine comme repondu (best-effort, non bloquant).
    if (isReply && replyMsgId) {
      try {
        await updateMessageViaWorker(replyMsgId, { is_answered: true });
      } catch {
        // L'envoi a deja reussi.
      }
    }

    const store = useMailStore.getState();
    const { adjustSidebarCount } = store;
    for (const id of draftIdsToClear) {
      store.notifyDraftLifecycle(id, "sent", sourceId);
      adjustSidebarCount("drafts", -1);
      sendAction({ action: "sidebar-adjust", key: "drafts", delta: -1 });
      store.notifyMessageRemoval(id);
      sendAction({ action: "message-removal", id });
      sendAction({ action: "draft-lifecycle", draftId: id, event: "sent", sourceId });
    }
    adjustSidebarCount("sent", 1);
    sendAction({ action: "sidebar-adjust", key: "sent", delta: 1 });

    // Rafraichir la conversation ouverte + la liste : la reponse envoyee passe
    // de brouillon -> Envoyes (meme thread_id) mais n'entre pas dans la liste
    // "Tous les messages" (is_sent=false). signalNewMessages declenche le
    // refetch cross-folder de ThreadView (et le fetch incremental de la liste
    // si on est dans Envoyes), donc la reponse apparait sans quitter le fil.
    store.signalNewMessages();
    store.invalidateFolders();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : tStatic("compose.sendError"));
    // Echec d'envoi : rouvrir le brouillon pour re-tenter.
    params.reopen();
  }
}
