"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Planificateur de rafraichissement temps reel.
 *
 * Les events WebSocket arrivent par rafales (une sync qui ramene 12 mails
 * emet 12 events `messages.create`). Ce hook les COALESCE en un seul appel
 * (debounce) et DIFFERE le travail quand l'onglet est cache : la mise a jour
 * est rejouee au retour au premier plan, sans marteler PocketBase en arriere
 * plan.
 *
 * Retourne une fonction `schedule()` stable a appeler depuis les effets qui
 * ecoutent les signaux du store (`newMessagesSignal`, `localMessageUpdate`...)
 * ou `onSyncStatus`.
 */
export function useLiveRefresh(fn: () => void, delayMs = 1_000): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);

  const arm = useCallback((delay: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      pendingRef.current = false;
      fnRef.current();
    }, delay);
  }, []);

  const schedule = useCallback(() => {
    pendingRef.current = true;
    // Onglet cache : on garde la demande en attente, le retour au premier plan
    // la rejouera (evite les fetchs inutiles sur un onglet non regarde).
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    arm(delayMs);
  }, [arm, delayMs]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!pendingRef.current) return;
      arm(200);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [arm]);

  return schedule;
}
