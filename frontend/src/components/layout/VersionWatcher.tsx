"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

// Version bakee dans CE bundle au build (next.config.ts -> env). On la compare a
// la version renvoyee en direct par /build-version : si le serveur a ete
// redeploye, l'onglet ouvert tourne encore sur l'ancien JS -> on recharge.
const CURRENT_VERSION = process.env.NEXT_PUBLIC_BUILD_VERSION ?? "";

const POLL_MS = 60_000;

// Un seul toast a la fois : sonner remplace un toast de meme id au lieu d'empiler.
const TOAST_ID = "app-update";
// Version deja visee par un rechargement automatique dans cette session. Si le
// rechargement ressert l'ancien bundle (cache du service worker), on ne
// recharge pas une deuxieme fois pour la meme version : boucle evitee.
const RELOAD_TRIED_KEY = "imiel:reloadTriedFor";

// On evite de recharger brutalement si l'utilisateur est en train d'ecrire :
// champ editable focus, fenetre de composition ouverte, ou tiroir de reponse
// ouvert. Dans ce cas on propose un rechargement manuel via un toast persistant.
function isBusyComposing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (el) {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable) return true;
  }
  if (document.querySelector('[data-ref="compose-panel"]')) return true;
  if (document.querySelector('[data-ref="thread-reply-drawer"]')) return true;
  return false;
}

export function VersionWatcher() {
  const handledRef = useRef(false);
  // Au retour d'une PWA iOS, montage + focus + visibilitychange tombent ensemble :
  // sans ce verrou pose AVANT le fetch, les trois appels passent la garde et
  // affichent trois toasts.
  const inflightRef = useRef(false);

  useEffect(() => {
    if (!CURRENT_VERSION) return;
    let stopped = false;

    async function check() {
      if (stopped || handledRef.current || inflightRef.current) return;
      inflightRef.current = true;
      let latest = "";
      try {
        const res = await fetch("/build-version", { cache: "no-store" });
        if (!res.ok) return;
        latest = (await res.json())?.version ?? "";
      } catch {
        return;
      } finally {
        inflightRef.current = false;
      }
      if (stopped || handledRef.current) return;
      if (!latest || latest === CURRENT_VERSION) return;

      handledRef.current = true;

      let alreadyTried = false;
      try {
        alreadyTried = sessionStorage.getItem(RELOAD_TRIED_KEY) === latest;
      } catch {
        // sessionStorage indisponible : on garde le comportement normal
      }

      if (alreadyTried || isBusyComposing()) {
        // Ne pas interrompre la saisie (ou un rechargement deja tente a servi
        // l'ancien bundle) : laisser l'utilisateur recharger quand il veut.
        // Toast persistant avec action.
        toast("Nouvelle version disponible", {
          description: "Recharge pour appliquer la derniere mise a jour.",
          id: TOAST_ID,
          duration: Infinity,
          action: { label: "Recharger", onClick: () => window.location.reload() },
        });
      } else {
        // Idle : mise a jour automatique apres un court delai.
        try {
          sessionStorage.setItem(RELOAD_TRIED_KEY, latest);
        } catch {
          // ignore
        }
        toast("Mise a jour de l'application...", { id: TOAST_ID, duration: 2000 });
        setTimeout(() => window.location.reload(), 1500);
      }
    }

    const intervalId = window.setInterval(check, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    // Premier check au montage (rattrape un onglet laisse ouvert pendant un deploy)
    check();

    return () => {
      stopped = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, []);

  return null;
}
