"use client";

import { useEffect, useState } from "react";

// Breakpoint mobile aligne sur le reste de l'app (cf ThreadView, ReplyBox).
const MOBILE_QUERY = "(max-width: 767px)";

/**
 * True quand le viewport est <= 767px (mobile). Retourne `false` au premier
 * rendu (SSR / client) puis se met a jour apres montage et sur changement de
 * media query. Les composants (app) etant montes en `ssr:false`, pas de risque
 * de mismatch d'hydratation.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return isMobile;
}
