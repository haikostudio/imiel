"use client";

import { useEffect } from "react";
import { useListChromeStore } from "@/lib/stores/list-chrome";
import {
  clampScrollPosition,
  initialHideOnScrollState,
  stepHideOnScroll,
  type HideOnScrollState,
} from "@/lib/utils/hide-on-scroll";

// Fenetre (ms) pendant laquelle un `scroll` compte encore comme le geste de
// l'utilisateur apres le dernier signal (doigt, molette, scroll d'elan).
const GESTURE_TAIL_MS = 200;

const SCREEN_TOP = "[data-collapsible-top]:not([data-passive])";

/**
 * Une zone qui defile pilote le repli seulement si un haut repliable d'ecran
 * vit a cote d'elle (meme ecran : page de liste, ou tiroir comme l'Activite).
 * Le corps de la page ne compte pas : un tiroir sans haut repliable (fil de
 * conversation, fiche) est ignore.
 */
function drivesCollapsibleTop(el: HTMLElement): boolean {
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    if (a.querySelector(SCREEN_TOP)) return true;
  }
  return false;
}

/**
 * Pilote le repli du haut des listes du telephone (store list-chrome).
 *
 * Un seul ecouteur, en CAPTURE sur le document : il voit le `scroll` de chaque
 * liste (VirtualMailList, PullToRefresh, ContactList, ActivityFeed du tiroir
 * Activite...) sans qu'aucune n'ait a exposer son conteneur.
 *
 * Actif seulement sur telephone et quand au moins un ecran a monte un
 * <CollapsibleTop> ; sinon l'etat reste "affiche".
 */
export function useListChromeAutoHide(enabled: boolean, routeKey: string) {
  const screens = useListChromeStore((s) => s.screens);
  const active = enabled && screens > 0;

  // Changement d'ecran : tout est de nouveau visible.
  useEffect(() => {
    useListChromeStore.getState().setHidden(false);
  }, [routeKey]);

  useEffect(() => {
    if (!active) {
      useListChromeStore.getState().setHidden(false);
      return;
    }
    let state: HideOnScrollState = initialHideOnScrollState;
    let target: EventTarget | null = null;
    let targetDrives = false;
    let touching = false;
    let gestureUntil = 0;
    let raf: number | null = null;
    let pending: HTMLElement | null = null;

    const openGesture = () => {
      gestureUntil = performance.now() + GESTURE_TAIL_MS;
    };
    const onTouchStart = () => {
      touching = true;
      openGesture();
    };
    const onTouchEnd = () => {
      touching = false;
      openGesture();
    };

    const evaluate = () => {
      raf = null;
      const el = pending;
      pending = null;
      if (!el) return;
      const store = useListChromeStore.getState();
      const pos = clampScrollPosition(el.scrollTop, el.scrollHeight, el.clientHeight);
      const now = performance.now();
      // Nouvelle zone qui defile (autre liste, ecran change) : recaler sans basculer.
      if (el !== target) {
        target = el;
        targetDrives = drivesCollapsibleTop(el);
        if (!targetDrives) return;
        // Recaler sans basculer (hors geste), sauf pres du haut : affiche.
        state = stepHideOnScroll({ ...state, ref: pos }, pos, now, { gesture: false });
        store.setHidden(state.hidden);
        return;
      }
      if (!targetDrives) return;
      // Contrainte d'affichage (selection, tiroir, saisie) ou menu deroule dans
      // un haut repliable : rester affiche et suivre la position.
      const menuOpen = !!document.querySelector('[data-collapsible-top] [aria-expanded="true"]');
      if (store.forced > 0 || menuOpen) {
        state = { hidden: false, ref: pos, frozenUntil: state.frozenUntil };
        store.setHidden(false);
        return;
      }
      // Etat remis a "affiche" ailleurs (changement d'ecran) : se realigner.
      if (state.hidden && !store.hidden) state = { ...state, hidden: false, ref: pos };
      const gesture = touching || now < gestureUntil;
      if (gesture) gestureUntil = now + GESTURE_TAIL_MS; // l'elan prolonge le geste
      state = stepHideOnScroll(state, pos, now, { gesture });
      store.setHidden(state.hidden);
    };

    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      if (el instanceof HTMLTextAreaElement) return;
      // Rangees horizontales (pastilles) : rien a voir avec le sens vertical.
      if (el.scrollHeight <= el.clientHeight + 1) return;
      if (el.closest("[data-collapsible-top]")) return;
      pending = el;
      if (raf == null) raf = requestAnimationFrame(evaluate);
    };

    const opts = { capture: true, passive: true } as const;
    document.addEventListener("scroll", onScroll, opts);
    document.addEventListener("touchstart", onTouchStart, opts);
    document.addEventListener("touchmove", openGesture, opts);
    document.addEventListener("touchend", onTouchEnd, opts);
    document.addEventListener("touchcancel", onTouchEnd, opts);
    document.addEventListener("wheel", openGesture, opts);
    return () => {
      document.removeEventListener("scroll", onScroll, opts);
      document.removeEventListener("touchstart", onTouchStart, opts);
      document.removeEventListener("touchmove", openGesture, opts);
      document.removeEventListener("touchend", onTouchEnd, opts);
      document.removeEventListener("touchcancel", onTouchEnd, opts);
      document.removeEventListener("wheel", openGesture, opts);
      if (raf != null) cancelAnimationFrame(raf);
      useListChromeStore.getState().setHidden(false);
    };
  }, [active]);
}
