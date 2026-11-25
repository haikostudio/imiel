"use client";

import React, { useEffect, useRef, useState } from "react";
import { Archive, CheckCircle2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

// Deplacement pour decider entre swipe horizontal et scroll vertical.
const DIRECTION_LOCK_PX = 8;
// Seuil de declenchement de l'action (un seul palier par sens).
const TRIGGER_PX = 72;
// Plafond visuel pendant le drag (rubber-band au-dela du seuil).
const MAX_SINGLE_PX = 120;
// Apres un geste tactile, on ignore les events souris synthetiques (compat).
const SYNTHETIC_MOUSE_MS = 600;

interface SwipeableTrackingRowProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onSelect"> {
  /** Fiche cloturee : pilote le libelle/icone/couleur du panneau statut. */
  isClosed: boolean;
  /** Swipe GAUCHE->DROITE (contenu vers la droite) : cloturer / rouvrir. */
  onSwipeToggleStatus?: () => void;
  /** Swipe DROITE->GAUCHE (contenu vers la gauche) : archiver. */
  onSwipeArchive?: () => void;
  /** Desactive completement les gestes. Defaut: true. */
  enabled?: boolean;
}

/**
 * Ligne de suivi balayable au doigt OU a la souris (desktop), a UN palier par
 * sens :
 * - Swipe GAUCHE->DROITE (le contenu glisse vers la droite) -> panneau a gauche :
 *   bascule le statut Ouvert/Cloture (vert "Cloturer" si ouverte, bleu "Rouvrir"
 *   si cloturee).
 * - Swipe DROITE->GAUCHE (le contenu glisse vers la gauche) -> panneau a droite :
 *   archive la fiche (ambre "Archiver").
 *
 * Les deux actions retirent la ligne de la vue courante (changement d'onglet ou
 * archivage) : au relachement au-dela du seuil, la ligne sort dans le sens du
 * geste puis l'action est declenchee.
 *
 * Les listeners touch sont natifs (`passive:false`) pour pouvoir `preventDefault`
 * le scroll vertical pendant un swipe horizontal — impossible via les handlers
 * React (passifs par defaut). Les listeners souris (desktop) sont ajoutes sur
 * `window` le temps du glisser, avec neutralisation de la selection de texte.
 */
export function SwipeableTrackingRow({
  children,
  className,
  style,
  onClick,
  onKeyDown,
  isClosed,
  onSwipeToggleStatus,
  onSwipeArchive,
  enabled = true,
  ...rest
}: SwipeableTrackingRowProps) {
  const t = useT();
  const contentRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [animate, setAnimate] = useState(false);
  const offsetRef = useRef(0);

  // Refs tenant les derniers callbacks/etats pour des listeners attaches une
  // seule fois (les closures inline changent a chaque render).
  const cbRef = useRef({
    onSwipeToggleStatus,
    onSwipeArchive,
    toggleAvail: !!onSwipeToggleStatus,
    archiveAvail: !!onSwipeArchive,
  });
  cbRef.current = {
    onSwipeToggleStatus,
    onSwipeArchive,
    toggleAvail: !!onSwipeToggleStatus,
    archiveAvail: !!onSwipeArchive,
  };

  const apply = (v: number) => {
    offsetRef.current = v;
    setOffset(v);
  };

  // Etat ephemere du geste.
  const g = useRef({
    startX: 0,
    startY: 0,
    locked: null as null | "h" | "v",
    pointer: "touch" as "touch" | "mouse",
    didMove: false,
    active: false,
    width: 0,
    armed: false,
    lastTouch: 0,
  });
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || !enabled) return;

    const vibrate = (ms: number) => {
      try {
        navigator.vibrate?.(ms);
      } catch {
        // ignore
      }
    };

    // Neutralise la selection de texte pendant un glisser souris (le contenu est
    // selectionnable sur desktop : md:select-auto).
    const setBodySelect = (off: boolean) => {
      const s = document.body.style as CSSStyleDeclaration & {
        webkitUserSelect?: string;
      };
      s.userSelect = off ? "none" : "";
      s.webkitUserSelect = off ? "none" : "";
    };

    // Demarre un geste (tactile ou souris).
    const beginGesture = (x: number, y: number, pointer: "touch" | "mouse") => {
      g.current.startX = x;
      g.current.startY = y;
      g.current.locked = null;
      g.current.pointer = pointer;
      g.current.didMove = false;
      g.current.active = true;
      g.current.width = el.offsetWidth || 400;
      g.current.armed = false;
      setAnimate(false);
    };

    // Traite un deplacement ; `preventDefault` bloque le scroll (tactile) ou la
    // selection de texte (souris) une fois le sens horizontal verrouille.
    const moveGesture = (dx: number, dy: number, preventDefault: () => void) => {
      if (!g.current.active) return;

      if (!g.current.locked) {
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > DIRECTION_LOCK_PX) {
          g.current.locked = "h";
          if (g.current.pointer === "mouse") {
            setBodySelect(true);
            window.getSelection?.()?.removeAllRanges();
          }
        } else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > DIRECTION_LOCK_PX) {
          g.current.locked = "v";
          return;
        } else {
          return;
        }
      }
      if (g.current.locked !== "h") return;

      // Geste horizontal confirme : on bloque le scroll vertical / la selection.
      preventDefault();

      const cb = cbRef.current;
      let off = dx;
      if (off > 0 && !cb.toggleAvail) off = 0; // pas d'action statut dispo
      if (off < 0 && !cb.archiveAvail) off = 0; // pas d'archivage dispo

      // Un seul palier par sens : rubber-band au-dela du seuil, plafonne.
      let abs = Math.abs(off);
      if (abs > TRIGGER_PX) abs = TRIGGER_PX + (abs - TRIGGER_PX) * 0.35;
      abs = Math.min(abs, MAX_SINGLE_PX);
      off = off < 0 ? -abs : abs;

      apply(off);
      if (Math.abs(off) > 6) g.current.didMove = true;

      // Retour haptique en armant l'action (seuil franchi).
      const armed = Math.abs(off) >= TRIGGER_PX;
      if (armed && !g.current.armed) {
        g.current.armed = true;
        vibrate(12);
      } else if (!armed && g.current.armed) {
        g.current.armed = false;
      }
    };

    // Finalise le geste : declenche l'action ou revient a la position de repos.
    const endGesture = () => {
      setAnimate(true);
      const cb = cbRef.current;
      const off = offsetRef.current;
      const width = contentRef.current?.offsetWidth ?? 400;

      if (off >= TRIGGER_PX && cb.onSwipeToggleStatus) {
        // Cloturer / rouvrir : sort par la droite puis declenche (la ligne
        // change d'onglet, donc quitte la vue courante).
        apply(width + 40);
        commitTimerRef.current = setTimeout(() => {
          cb.onSwipeToggleStatus?.();
        }, 180);
      } else if (off <= -TRIGGER_PX && cb.onSwipeArchive) {
        // Archiver : sort par la gauche puis declenche.
        apply(-(width + 40));
        commitTimerRef.current = setTimeout(() => {
          cb.onSwipeArchive?.();
        }, 180);
      } else {
        apply(0);
      }
    };

    // --- Tactile ---
    const onTouchStart = (e: TouchEvent) => {
      const tch = e.touches[0];
      if (!tch) return;
      g.current.lastTouch = Date.now();
      beginGesture(tch.clientX, tch.clientY, "touch");
    };

    const onTouchMove = (e: TouchEvent) => {
      const tch = e.touches[0];
      if (!tch) return;
      moveGesture(
        tch.clientX - g.current.startX,
        tch.clientY - g.current.startY,
        () => e.preventDefault()
      );
    };

    const onTouchEnd = () => {
      g.current.lastTouch = Date.now();
      g.current.active = false;
      const wasHorizontal = g.current.locked === "h";
      g.current.locked = null;
      if (!wasHorizontal) return;
      endGesture();
    };

    const onTouchCancel = () => {
      g.current.active = false;
      if (g.current.locked === "h") {
        setAnimate(true);
        apply(0);
      }
      g.current.locked = null;
    };

    // --- Souris (desktop) ---
    const endMouse = () => {
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      const wasMouse = g.current.pointer === "mouse";
      if (!g.current.active || !wasMouse) {
        setBodySelect(false);
        return;
      }
      g.current.active = false;
      const wasHorizontal = g.current.locked === "h";
      g.current.locked = null;
      setBodySelect(false);
      if (wasHorizontal) endGesture();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!g.current.active || g.current.pointer !== "mouse") return;
      if (e.buttons === 0) {
        endMouse();
        return;
      }
      moveGesture(
        e.clientX - g.current.startX,
        e.clientY - g.current.startY,
        () => e.preventDefault()
      );
    };

    const onMouseUp = () => endMouse();

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // clic gauche uniquement
      // Ignore les events souris synthetiques emis apres un geste tactile.
      if (Date.now() - g.current.lastTouch < SYNTHETIC_MOUSE_MS) return;
      beginGesture(e.clientX, e.clientY, "mouse");
      window.addEventListener("mousemove", onMouseMove, true);
      window.addEventListener("mouseup", onMouseUp, true);
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", onTouchCancel, { passive: true });
    el.addEventListener("mousedown", onMouseDown);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      setBodySelect(false);
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    };
  }, [enabled]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Un swipe ne doit pas declencher la selection.
    if (g.current.didMove) {
      e.preventDefault();
      e.stopPropagation();
      g.current.didMove = false;
      return;
    }
    onClick?.(e);
  };

  // Panneau statut (gauche) : rouvrir si cloturee, cloturer sinon.
  const ToggleIcon = isClosed ? RotateCcw : CheckCircle2;
  const toggleLabel = isClosed ? t("tracking.reopen") : t("tracking.close");
  const togglePanelClass = isClosed ? "bg-sky-600" : "bg-emerald-600";

  return (
    <div className="relative overflow-hidden" {...rest}>
      {/* Panneau gauche : statut (Cloturer / Rouvrir), revele en swipant a droite */}
      {offset > 0 && (
        <div
          className={cn(
            "absolute inset-y-0 left-0 z-0 flex items-center overflow-hidden text-white",
            togglePanelClass
          )}
          style={{ width: Math.max(0, offset) }}
          aria-hidden="true"
        >
          <div className="flex items-center gap-2 pl-4 whitespace-nowrap">
            <ToggleIcon className="size-5 shrink-0" />
            <span className="text-sm font-medium">{toggleLabel}</span>
          </div>
        </div>
      )}
      {/* Panneau droit : Archiver, revele en swipant a gauche */}
      {offset < 0 && (
        <div
          className="absolute inset-y-0 right-0 z-0 flex items-center justify-end overflow-hidden bg-amber-600 text-white"
          style={{ width: Math.max(0, -offset) }}
          aria-hidden="true"
        >
          <div className="flex items-center gap-2 pr-4 whitespace-nowrap">
            <span className="text-sm font-medium">{t("tracking.archive")}</span>
            <Archive className="size-5 shrink-0" />
          </div>
        </div>
      )}

      <div
        ref={contentRef}
        role="button"
        tabIndex={0}
        data-ref="tracking-row"
        onClick={handleClick}
        onKeyDown={onKeyDown}
        className={cn(
          "relative z-10 select-none [-webkit-touch-callout:none] md:select-auto bg-background",
          className
        )}
        style={{
          ...style,
          transform: `translateX(${offset}px)`,
          transition: animate ? "transform 0.18s ease" : "none",
          touchAction: "pan-y",
        }}
      >
        {children}
      </div>
    </div>
  );
}
