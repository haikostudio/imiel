"use client";

import { useEffect, useRef } from "react";
import { getCurrentUserId } from "@/lib/pocketbase";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { onPbEvent } from "@/lib/ws-channel";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { canNativeNotify, sendNativeNotification } from "@/lib/desktop-notify";

const STARTUP_GRACE_MS = 5_000;
const BATCH_WINDOW_MS = 2_000;
const MAX_AGE_MS = 5 * 60 * 1000;
const BATCH_THRESHOLD = 4;

interface MessageRecord {
  id: string;
  is_draft: boolean;
  is_sent: boolean;
  is_read: boolean;
  date: string;
  from_address?: { name?: string; address?: string };
  subject?: string;
}

/**
 * Hook global qui affiche des toasts in-app quand de nouveaux emails arrivent.
 * A utiliser une seule fois dans AuthenticatedLayout.
 */
export function useNewMailNotifications() {
  const { accounts: userAccounts } = useAccounts();
  const userEmailsRef = useRef(new Set<string>());
  const mountedAtRef = useRef(Date.now());
  const batchRef = useRef<MessageRecord[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Garder les emails utilisateur a jour
  useEffect(() => {
    const emails = new Set<string>();
    for (const acc of userAccounts) {
      if (acc.email) emails.add(acc.email.toLowerCase());
    }
    userEmailsRef.current = emails;
  }, [userAccounts]);

  useEffect(() => {
    const userId = getCurrentUserId();
    if (!userId) return;

    mountedAtRef.current = Date.now();

    function flushBatch() {
      const batch = batchRef.current;
      batchRef.current = [];
      batchTimerRef.current = null;

      if (batch.length === 0) return;

      // App de bureau Tauri : notifications OS natives (le Web Push ne marche
      // pas dans la WKWebView). Tant que l'app tourne, le WS alimente ces alertes.
      const native = canNativeNotify();

      if (batch.length < BATCH_THRESHOLD) {
        for (const msg of batch) {
          const sender = msg.from_address?.name || msg.from_address?.address || t("notification.unknownSender");
          const subject = msg.subject || t("notification.noSubject");
          toast(sender, {
            description: subject,
            duration: 5000,
          });
          if (native) void sendNativeNotification(sender, subject);
        }
      } else {
        const title = t("notification.newMessages", { count: String(batch.length) });
        toast(title, {
          duration: 5000,
        });
        if (native) void sendNativeNotification(title);
      }
    }

    // Listen to PB events via WebSocket channel
    const unsubscribe = onPbEvent((collection, action, record) => {
      if (collection !== "messages" || action !== "create") return;

      const msg = record as unknown as MessageRecord;

      // Ignorer brouillons et messages envoyes
      if (msg.is_draft || msg.is_sent) return;

      // Ignorer messages deja lus
      if (msg.is_read) return;

      // Ignorer messages trop anciens (sync initiale)
      const messageAge = Date.now() - new Date(msg.date).getTime();
      if (messageAge > MAX_AGE_MS) return;

      // Grace period au demarrage (evite flood au chargement)
      if (Date.now() - mountedAtRef.current < STARTUP_GRACE_MS) return;

      // Ignorer messages envoyes par l'utilisateur lui-meme
      const fromEmail = msg.from_address?.address?.toLowerCase();
      if (fromEmail && userEmailsRef.current.has(fromEmail)) return;

      // Ajouter au batch
      batchRef.current.push(msg);

      // Reset le timer de batch
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
      batchTimerRef.current = setTimeout(flushBatch, BATCH_WINDOW_MS);
    });

    return () => {
      unsubscribe();
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
      batchRef.current = [];
    };
  }, []);
}
