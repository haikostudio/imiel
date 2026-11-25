"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import pb, { getCurrentUserId, uploadDraftAttachments, deleteDraftAttachment, deleteMessageViaWorker } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import { sendAction } from "@/lib/ws-channel";
import { toast } from "sonner";

export interface DraftData {
  to_addresses?: { name?: string; address: string }[];
  cc_addresses?: { name?: string; address: string }[];
  bcc_addresses?: { name?: string; address: string }[];
  subject?: string;
  html_body?: string;
  text_body?: string;
}

export interface SavedAttachment {
  id: string;
  filename: string;
  size: number;
  /** Nom du fichier stocke (adresse servie) */
  file?: string;
  /** Image placee dans le texte du message */
  is_inline?: boolean;
}

interface UseAutoSaveOptions {
  accountId?: string;
  initialDraftId?: string | null;
  threadId?: string;
  replyTo?: string;
  debounceMs?: number;
  intervalMs?: number;
}

interface UseAutoSaveReturn {
  saving: boolean;
  lastSaved: Date | null;
  saveDraft: (data: DraftData) => void;
  flushSave: () => Promise<string | null>;
  deleteDraft: () => Promise<void>;
  clearDraftState: () => void;
  draftId: string | null;
  sourceId: string;
  uploadFiles: (files: File[], opts?: { inline?: boolean }) => Promise<SavedAttachment[]>;
  removeAttachment: (attachmentId: string) => Promise<void>;
  notifyAttachmentsChange: (attachments: SavedAttachment[]) => void;
}

export function useAutoSave(
  options: UseAutoSaveOptions = {}
): UseAutoSaveReturn {
  const { accountId: accountIdOverride, initialDraftId, threadId, replyTo, debounceMs = 1000, intervalMs = 10000 } = options;

  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [draftId, setDraftId] = useState<string | null>(initialDraftId ?? null);
  const draftIdRef = useRef<string | null>(initialDraftId ?? null);
  const savingLockRef = useRef(false);

  const pendingDataRef = useRef<DraftData | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isFirstSaveRef = useRef(true);

  const sourceIdRef = useRef(crypto.randomUUID());

  const storeAccountId = useMailStore((s) => s.activeAccountId);
  const activeFolder = useMailStore((s) => s.activeFolder);
  const setDraftSaveStatus = useMailStore((s) => s.setDraftSaveStatus);
  const notifyMessageUpdate = useMailStore((s) => s.notifyMessageUpdate);
  const notifyDraftContentUpdate = useMailStore((s) => s.notifyDraftContentUpdate);
  const notifyDraftLifecycle = useMailStore((s) => s.notifyDraftLifecycle);
  const notifyDraftThread = useMailStore((s) => s.notifyDraftThread);
  const notifyMessageInsert = useMailStore((s) => s.notifyMessageInsert);

  // Utiliser l'accountId passe en parametre, sinon celui du store
  const resolvedAccountId =
    accountIdOverride ||
    (storeAccountId && storeAccountId !== "all" ? storeAccountId : undefined);

  // Reset au demontage du composant (fermeture de l'instance)
  useEffect(() => {
    return () => {
      setDraftSaveStatus(false, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Synchroniser l'etat de sauvegarde avec le store pour la StatusBar
  useEffect(() => {
    setDraftSaveStatus(saving, lastSaved);
  }, [saving, lastSaved, setDraftSaveStatus]);

  const persistDraft = useCallback(
    async (data: DraftData, forceCreate = false) => {
      const userId = getCurrentUserId();

      if (!userId || !resolvedAccountId) return;

      // Empecher les sauvegardes concurrentes (cause de doublons)
      if (savingLockRef.current) return;

      // Ne pas creer de brouillon si le contenu est vide (sauf forceCreate pour les PJ)
      const body = (data.html_body ?? "").replace(/<[^>]*>/g, "").trim();
      if (!forceCreate && !draftIdRef.current && !body && !data.subject?.trim()) return;

      savingLockRef.current = true;
      setSaving(true);
      try {
        const isUpdate = !!draftIdRef.current;

        // Endpoint auto-save : gere upsert, from_address, drafts folder cote serveur
        const autoSaveBody: Record<string, unknown> = {
          account_id: resolvedAccountId,
          to: data.to_addresses ?? [],
          cc: data.cc_addresses ?? [],
          bcc: data.bcc_addresses ?? [],
          subject: data.subject ?? "",
          html_body: data.html_body ?? "",
          text_body: data.text_body ?? "",
        };
        if (draftIdRef.current) {
          autoSaveBody.draft_id = draftIdRef.current;
        }
        if (replyTo) {
          autoSaveBody.draft_reply_to = replyTo;
          autoSaveBody.in_reply_to = replyTo;
        }
        // Rattacher le brouillon a la conversation : sans thread_id, le brouillon
        // n'est plus retrouve par la vue thread (existingDraft) ni par le badge
        // brouillon de la liste (is_draft && thread_id != ""), il apparait detache.
        if (threadId) {
          autoSaveBody.thread_id = threadId;
        }

        const result = await pb.send("/api/mail/auto-save", {
          method: "POST",
          body: autoSaveBody,
        });

        const savedDraftId = result.draft_id as string;

        const now = new Date().toISOString();
        const snippet = (data.html_body ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 200);

        // Le serveur peut REUTILISER un brouillon existant (meme sujet + memes
        // destinataires) au lieu d'en creer un : dans ce cas status == "updated".
        // On suit le serveur pour ne pas inserer un doublon dans la liste ni
        // sur-compter le badge brouillons.
        const serverReused = !isUpdate && result.status === "updated";
        if (serverReused) {
          draftIdRef.current = savedDraftId;
          setDraftId(savedDraftId);
        }

        if (isUpdate || serverReused) {
          const updatedId = savedDraftId;
          queueMicrotask(() => {
            notifyMessageUpdate(updatedId, { ...data, snippet, is_draft: true, date: now });
            notifyDraftContentUpdate(updatedId, data, sourceIdRef.current, undefined, resolvedAccountId);
            // Broadcast aux autres fenetres via WS
            sendAction({
              action: "draft-content-update",
              draftId: updatedId,
              data,
              date: now,
              sourceId: sourceIdRef.current,
              fromAccountId: resolvedAccountId,
            });
          });
        } else {
          draftIdRef.current = savedDraftId;
          setDraftId(savedDraftId);
          if (threadId) notifyDraftThread(threadId, "add");
          // Incrementer le compteur de brouillons
          useMailStore.getState().adjustSidebarCount("drafts", 1);
          sendAction({ action: "sidebar-adjust", key: "drafts", delta: 1 });
          queueMicrotask(() => {
            // Inserer le brouillon directement dans la liste avec une date
            notifyMessageInsert({
              id: savedDraftId,
              date: now,
              subject: data.subject ?? "",
              snippet,
              is_draft: true,
              is_read: true,
              is_starred: false,
              is_sent: false,
              from_address: { name: "", address: "" },
              to_addresses: data.to_addresses ?? [],
              cc_addresses: data.cc_addresses ?? [],
              bcc_addresses: data.bcc_addresses ?? [],
              html_body: data.html_body ?? "",
              text_body: data.text_body ?? "",
              account: resolvedAccountId,
            });
            notifyDraftContentUpdate(savedDraftId, data, sourceIdRef.current, undefined, resolvedAccountId);
            // Broadcast aux autres fenetres via WS
            sendAction({
              action: "draft-insert",
              draftId: savedDraftId,
              data,
              date: now,
              snippet,
              sourceId: sourceIdRef.current,
              fromAccountId: resolvedAccountId,
            });
          });
        }
        setLastSaved(new Date());
      } catch (err) {
        console.warn("[useAutoSave] persistDraft failed:", err);
      } finally {
        savingLockRef.current = false;
        setSaving(false);
      }
    },
    [resolvedAccountId, notifyMessageUpdate, notifyMessageInsert, notifyDraftContentUpdate, threadId, replyTo, notifyDraftThread]
  );

  // Ref stable pour acceder a la derniere version de persistDraft (evite les closures perimees)
  const persistDraftRef = useRef(persistDraft);
  persistDraftRef.current = persistDraft;

  const deleteDraft = useCallback(async () => {
    if (!draftIdRef.current) return;
    const deletedId = draftIdRef.current;
    // Annuler toute sauvegarde en cours pour eviter de re-creer le brouillon
    pendingDataRef.current = null;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    try {
      await deleteMessageViaWorker(deletedId);
    } catch {
      // Silencieux si deja supprime
    }
    draftIdRef.current = null;
    setDraftId(null);
    setLastSaved(null);
    if (threadId) notifyDraftThread(threadId, "remove");
    notifyDraftLifecycle(deletedId, "deleted", sourceIdRef.current);
    // Decrementer le compteur de brouillons
    useMailStore.getState().adjustSidebarCount("drafts", -1);
    sendAction({ action: "sidebar-adjust", key: "drafts", delta: -1 });
    // Broadcast aux autres fenetres via WS
    sendAction({
      action: "draft-lifecycle",
      draftId: deletedId,
      event: "deleted",
      sourceId: sourceIdRef.current,
    });
    // Retirer immediatement de la liste si on est dans les brouillons
    useMailStore.getState().notifyMessageRemoval(deletedId);
    sendAction({ action: "message-removal", id: deletedId });
  }, [notifyDraftLifecycle, notifyDraftThread, threadId]);

  // Nettoyer l'etat local du brouillon sans supprimer le record PB
  // (utilise quand le brouillon est reutilise pour l'envoi)
  const clearDraftState = useCallback(() => {
    const clearedId = draftIdRef.current;
    pendingDataRef.current = null;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    draftIdRef.current = null;
    setDraftId(null);
    setLastSaved(null);
    if (threadId && clearedId) notifyDraftThread(threadId, "remove");
    if (clearedId) {
      notifyDraftLifecycle(clearedId, "deleted", sourceIdRef.current);
      sendAction({
        action: "draft-lifecycle",
        draftId: clearedId,
        event: "deleted",
        sourceId: sourceIdRef.current,
      });
    }
  }, [notifyDraftLifecycle, notifyDraftThread, threadId]);

  // Upload des fichiers vers le brouillon PB
  const uploadFiles = useCallback(
    async (files: File[], opts?: { inline?: boolean }): Promise<SavedAttachment[]> => {
      if (files.length === 0) return [];

      // S'assurer qu'un brouillon existe avant d'uploader
      if (!draftIdRef.current) {
        // Attendre si une sauvegarde est en cours (elle va creer le brouillon)
        if (savingLockRef.current) {
          await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
              if (!savingLockRef.current || draftIdRef.current) {
                clearInterval(interval);
                resolve();
              }
            }, 100);
            setTimeout(() => { clearInterval(interval); resolve(); }, 5000);
          });
        }

        // Si toujours pas de brouillon, forcer la creation
        if (!draftIdRef.current) {
          await persistDraftRef.current({}, true);
          if (!draftIdRef.current) return [];
        }
      }

      try {
        return await uploadDraftAttachments(draftIdRef.current, files, opts);
      } catch (err) {
        console.error("Draft attachment upload failed:", err);
        toast.error(err instanceof Error ? err.message : "Erreur lors de l'upload");
        return [];
      }
    },
    []
  );

  // Supprimer une piece jointe du brouillon PB
  const removeAttachment = useCallback(async (attachmentId: string) => {
    try {
      await deleteDraftAttachment(attachmentId);
    } catch {
      // Erreur silencieuse
    }
  }, []);

  // Notifier les autres editeurs d'un changement de pieces jointes
  const notifyAttachmentsChange = useCallback((attachments: SavedAttachment[]) => {
    if (!draftIdRef.current) return;
    const id = draftIdRef.current;
    queueMicrotask(() => {
      notifyDraftContentUpdate(id, {}, sourceIdRef.current, attachments, resolvedAccountId);
      sendAction({
        action: "draft-content-update",
        draftId: id,
        data: {},
        attachments,
        sourceId: sourceIdRef.current,
        fromAccountId: resolvedAccountId,
      });
    });
  }, [notifyDraftContentUpdate, resolvedAccountId]);

  const saveDraft = useCallback(
    (data: DraftData) => {
      pendingDataRef.current = data;

      // Premier changement : sauvegarde immediate (pas de debounce)
      if (isFirstSaveRef.current) {
        isFirstSaveRef.current = false;
        persistDraftRef.current(data);
        pendingDataRef.current = null;
        return;
      }

      // Debounce pour les changements suivants
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        if (pendingDataRef.current) {
          persistDraftRef.current(pendingDataRef.current);
          pendingDataRef.current = null;
        }
      }, debounceMs);
    },
    [debounceMs]
  );

  // Forcer un flush immediat des donnees en attente + attendre toute sauvegarde
  // en vol. Utilise par handleSend pour eviter la race entre l'auto-save de
  // fond et l'upsert d'envoi (creation de brouillons doublons + 400 PB).
  const flushSave = useCallback(async (): Promise<string | null> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const pending = pendingDataRef.current;
    pendingDataRef.current = null;
    if (pending) {
      await persistDraftRef.current(pending);
    }
    // Attendre la fin d'une sauvegarde deja en vol (au plus 5s)
    if (savingLockRef.current) {
      await new Promise<void>((resolve) => {
        const start = Date.now();
        const interval = setInterval(() => {
          if (!savingLockRef.current || Date.now() - start > 5000) {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });
    }
    return draftIdRef.current;
  }, []);

  // Sauvegarde periodique + flush au demontage
  useEffect(() => {
    intervalTimerRef.current = setInterval(() => {
      if (pendingDataRef.current) {
        persistDraftRef.current(pendingDataRef.current);
        pendingDataRef.current = null;
      }
    }, intervalMs);

    return () => {
      if (intervalTimerRef.current) {
        clearInterval(intervalTimerRef.current);
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      // Flusher les donnees en attente au demontage (fermeture du compose)
      if (pendingDataRef.current) {
        persistDraftRef.current(pendingDataRef.current);
        pendingDataRef.current = null;
      }
    };
  }, [intervalMs]);

  return { saving, lastSaved, saveDraft, flushSave, deleteDraft, clearDraftState, draftId, sourceId: sourceIdRef.current, uploadFiles, removeAttachment, notifyAttachmentsChange };
}
