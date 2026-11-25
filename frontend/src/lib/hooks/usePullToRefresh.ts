"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/* Tirer pour rafraichir : distance (px) a tirer pour declencher le refresh. */
export const PTR_THRESHOLD = 70;
/* Etirement visuel maximal (resistance : on amortit le geste au-dela). */
const PTR_MAX = 96;
/* Amortissement applique au deplacement du doigt -> effet elastique. */
const PTR_RESIST = 0.5;
/* Duree minimale d'affichage du loader : un refresh instantane reste lisible. */
const PTR_MIN_VISIBLE = 450;

export interface PullToRefreshState {
  /** Deplacement courant du contenu (px), 0 hors geste. */
  pull: number;
  /** Refresh en cours (loader visible). */
  refreshing: boolean;
  /** Doigt en train de tirer (desactive les transitions de retour). */
  dragging: boolean;
}

/**
 * Tirer-pour-rafraichir (mobile). Attache des listeners tactiles natifs sur le
 * conteneur scrollable `scrollRef` : le geste ne s'amorce qu'en haut de liste
 * (scrollTop = 0), le deplacement est amorti (resistance) et le touchmove est
 * capture (passive:false) pour empecher le rebond elastique natif iOS. Au
 * relachement au-dela du seuil, `onRefresh` est appele et le loader reste
 * visible au moins PTR_MIN_VISIBLE ms. Inerte sur desktop (aucun evenement
 * tactile) et tant que `onRefresh` est absent / `disabled`.
 *
 * Logique partagee avec la liste mail (VirtualMailList) : meme ressenti partout.
 */
export function usePullToRefresh(
  scrollRef: RefObject<HTMLElement | null>,
  onRefresh?: (() => Promise<unknown> | void) | null,
  disabled = false
): PullToRefreshState {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let startY = 0;
    let active = false;
    let current = 0;

    const reset = () => {
      active = false;
      current = 0;
      setDragging(false);
      setPull(0);
    };

    const begin = (e: TouchEvent) => {
      if (disabledRef.current || !onRefreshRef.current) return;
      if (refreshingRef.current || e.touches.length !== 1) return;
      if (el.scrollTop > 0) return; // on n'amorce qu'en haut de liste
      startY = e.touches[0].clientY;
      active = true;
      current = 0;
    };

    const move = (e: TouchEvent) => {
      if (!active) return;
      // Un defilement reel a repris la main : on abandonne le tirage.
      if (el.scrollTop > 0) {
        active = false;
        setDragging(false);
        setPull(0);
        return;
      }
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0) {
        current = 0;
        setPull(0);
        return;
      }
      // On capture le geste pour empecher le rebond elastique natif.
      e.preventDefault();
      current = Math.min(dy * PTR_RESIST, PTR_MAX);
      setDragging(true);
      setPull(current);
    };

    const end = () => {
      if (!active) return;
      active = false;
      setDragging(false);

      if (current >= PTR_THRESHOLD && !refreshingRef.current && onRefreshRef.current) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPull(PTR_THRESHOLD);
        const started = Date.now();
        Promise.resolve(onRefreshRef.current()).finally(() => {
          const wait = Math.max(0, PTR_MIN_VISIBLE - (Date.now() - started));
          window.setTimeout(() => {
            refreshingRef.current = false;
            setRefreshing(false);
            setPull(0);
          }, wait);
        });
      } else {
        setPull(0);
      }
      current = 0;
    };

    el.addEventListener("touchstart", begin, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", reset);
    return () => {
      el.removeEventListener("touchstart", begin);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", reset);
    };
  }, [scrollRef]);

  return { pull, refreshing, dragging };
}
