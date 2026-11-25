"use client";

import { useCallback, useRef } from "react";

const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD_PX = 10;

/**
 * Ouvre un menu contextuel (Radix ContextMenu) sur appui long tactile.
 * Dispatch un event `contextmenu` synthetique sur la cible apres LONG_PRESS_MS.
 */
export function useLongPressContextMenu() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number; target: HTMLElement } | null>(null);
  const firedRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    firedRef.current = false;
    const target = e.currentTarget as HTMLElement;
    startRef.current = { x: touch.clientX, y: touch.clientY, target };
    timerRef.current = setTimeout(() => {
      if (!startRef.current) return;
      firedRef.current = true;
      const { x, y, target } = startRef.current;
      const ev = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 2,
        clientX: x,
        clientY: y,
      });
      target.dispatchEvent(ev);
      try {
        if (navigator.vibrate) navigator.vibrate(15);
      } catch {
        // ignore
      }
    }, LONG_PRESS_MS);
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    const start = startRef.current;
    if (!touch || !start) return;
    if (
      Math.abs(touch.clientX - start.x) > MOVE_THRESHOLD_PX ||
      Math.abs(touch.clientY - start.y) > MOVE_THRESHOLD_PX
    ) {
      cancel();
    }
  }, [cancel]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (firedRef.current) {
      e.preventDefault();
      e.stopPropagation();
    }
    cancel();
  }, [cancel]);

  const onTouchCancel = useCallback(() => {
    cancel();
  }, [cancel]);

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  };
}
