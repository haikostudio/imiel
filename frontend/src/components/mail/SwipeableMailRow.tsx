"use client";

import { IMPORTANCE_COLORS, isImportance } from "@/lib/importance";
import React, { useEffect, useRef, useState } from "react";
import { Ban, ShieldAlert, Mail, MailOpen, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const LONG_PRESS_MS = 500;
// Deplacement pour decider entre swipe horizontal et scroll vertical.
const DIRECTION_LOCK_PX = 8;
// Palier 1 (gauche = lu/non lu, droite = bloquer) : seuil de declenchement.
const STAGE1_PX = 72;
// Palier 2 (gauche au max = suppression, droite au max = spam) : seuil absolu
// mini + ratio largeur.
const STAGE2_MIN_PX = 200;
const STAGE2_RATIO = 0.5;
// Plafond visuel pour un geste a un seul palier (lu, ou bloquer si pas de spam).
const MAX_SINGLE_PX = 120;
// Apres un geste tactile, on ignore les events souris synthetiques (compat).
const SYNTHETIC_MOUSE_MS = 600;

interface SwipeableMailRowProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onSelect"> {
  /** Etat lu courant : true = deja lu (le swipe gauche marquera non lu). */
  readState: boolean;
  /** Swipe GAUCHE palier 1 : bascule lu/non lu. */
  onSwipeLeft?: () => void;
  /** Swipe GAUCHE palier 2 (au max) : supprime (absent => pas de 2e palier). */
  onSwipeLeftFull?: () => void;
  /** Swipe DROITE palier 1 : bloque l'expediteur (absent => geste desactive). */
  onSwipeRight?: () => void;
  /** Swipe DROITE palier 2 (au max) : deplace en spam (absent => pas de 2e palier). */
  onSwipeRightFull?: () => void;
  /** Desactive completement les gestes (et l'appui long). Defaut: true. */
  enabled?: boolean;
  /** Niveau du tri en trois niveaux : trait de couleur de 4 px a gauche. */
  importance?: string | null;
}

/**
 * Ligne de mail balayable au doigt OU a la souris (desktop) + appui long pour
 * le menu contextuel (tactile uniquement ; clic droit natif sur desktop).
 *
 * Les deux sens sont a DEUX PALIERS :
 * - Swipe DROITE (le contenu glisse vers la droite) -> panneau a gauche :
 *   palier 1 (orange) bloque l'expediteur ; palier 2 (ambre, balayage au max)
 *   deplace en spam.
 * - Swipe GAUCHE (le contenu glisse vers la gauche) -> panneau a droite :
 *   palier 1 (bleu) bascule Lu/Non lu ; palier 2 (rouge, balayage au max)
 *   supprime le message.
 *
 * Le `ref` est transmis a la racine pour que Radix (`ContextMenuTrigger asChild`)
 * y attache son listener ; l'appui long dispatch un `contextmenu` synthetique
 * sur cette racine.
 *
 * Les listeners touch sont natifs (`passive:false`) pour pouvoir `preventDefault`
 * le scroll vertical pendant un swipe horizontal — impossible via les handlers
 * React (passifs par defaut). Les listeners souris (desktop) sont ajoutes sur
 * `window` le temps du glisser, avec neutralisation de la selection de texte.
 */
export const SwipeableMailRow = React.forwardRef<
  HTMLDivElement,
  SwipeableMailRowProps
>(function SwipeableMailRow(
  {
    children,
    className,
    style,
    onClick,
    onKeyDown,
    readState,
    onSwipeLeft,
    onSwipeLeftFull,
    onSwipeRight,
    onSwipeRightFull,
    enabled = true,
    importance,
    ...rest
  },
  ref
) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [animate, setAnimate] = useState(false);
  const offsetRef = useRef(0);

  // Refs tenant les derniers callbacks/etats pour des listeners attaches une
  // seule fois (les closures inline changent a chaque render).
  const cbRef = useRef({
    onSwipeLeft,
    onSwipeLeftFull,
    onSwipeRight,
    onSwipeRightFull,
    leftAvail: !!onSwipeLeft || !!onSwipeLeftFull,
    leftFullAvail: !!onSwipeLeftFull,
    rightAvail: !!onSwipeRight || !!onSwipeRightFull,
    rightFullAvail: !!onSwipeRightFull,
  });
  cbRef.current = {
    onSwipeLeft,
    onSwipeLeftFull,
    onSwipeRight,
    onSwipeRightFull,
    leftAvail: !!onSwipeLeft || !!onSwipeLeftFull,
    leftFullAvail: !!onSwipeLeftFull,
    rightAvail: !!onSwipeRight || !!onSwipeRightFull,
    rightFullAvail: !!onSwipeRightFull,
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
    lpTimer: null as ReturnType<typeof setTimeout> | null,
    lpFired: false,
    didMove: false,
    active: false,
    width: 0,
    stage2: STAGE2_MIN_PX,
    fullArmed: false,
    lastTouch: 0,
  });
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setRootRef = (node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
  };

  useEffect(() => {
    const el = contentRef.current;
    if (!el || !enabled) return;

    const clearLp = () => {
      if (g.current.lpTimer) {
        clearTimeout(g.current.lpTimer);
        g.current.lpTimer = null;
      }
    };

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
      g.current.lpFired = false;
      g.current.didMove = false;
      g.current.active = true;
      g.current.width = el.offsetWidth || 400;
      g.current.stage2 = Math.max(STAGE2_MIN_PX, g.current.width * STAGE2_RATIO);
      g.current.fullArmed = false;
      setAnimate(false);
      clearLp();
      if (pointer !== "touch") return;
      g.current.lpTimer = setTimeout(() => {
        if (!g.current.active || g.current.locked === "h") return;
        g.current.lpFired = true;
        g.current.didMove = true;
        const ev = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 2,
          clientX: g.current.startX,
          clientY: g.current.startY,
        });
        rootRef.current?.dispatchEvent(ev);
        vibrate(15);
      }, LONG_PRESS_MS);
    };

    // Traite un deplacement ; `preventDefault` bloque le scroll (tactile) ou la
    // selection de texte (souris) une fois le sens horizontal verrouille.
    const moveGesture = (dx: number, dy: number, preventDefault: () => void) => {
      if (!g.current.active) return;

      if (!g.current.locked) {
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > DIRECTION_LOCK_PX) {
          g.current.locked = "h";
          clearLp();
          if (g.current.pointer === "mouse") {
            setBodySelect(true);
            window.getSelection?.()?.removeAllRanges();
          }
        } else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > DIRECTION_LOCK_PX) {
          g.current.locked = "v";
          clearLp();
          return;
        } else {
          if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearLp();
          return;
        }
      }
      if (g.current.locked !== "h") return;

      // Geste horizontal confirme : on bloque le scroll vertical / la selection.
      preventDefault();

      const cb = cbRef.current;
      let off = dx;
      if (off > 0 && !cb.rightAvail) off = 0; // pas d'action droite dispo
      if (off < 0 && !cb.leftAvail) off = 0; // pas d'action gauche dispo

      if (off > 0) {
        if (cb.rightFullAvail) {
          // Droite a deux paliers : suit le doigt jusqu'a ~90% de la largeur.
          off = Math.min(off, g.current.width * 0.9);
        } else {
          // Droite palier unique (bloquer) avec rubber-band.
          let abs = off;
          if (abs > STAGE1_PX) abs = STAGE1_PX + (abs - STAGE1_PX) * 0.35;
          off = Math.min(abs, MAX_SINGLE_PX);
        }
      } else if (off < 0) {
        if (cb.leftFullAvail) {
          // Gauche a deux paliers : suit le doigt jusqu'a ~90% de la largeur.
          off = -Math.min(-off, g.current.width * 0.9);
        } else {
          // Gauche palier unique (lu/non lu) avec rubber-band.
          let abs = -off;
          if (abs > STAGE1_PX) abs = STAGE1_PX + (abs - STAGE1_PX) * 0.35;
          off = -Math.min(abs, MAX_SINGLE_PX);
        }
      }

      apply(off);
      if (Math.abs(off) > 6) g.current.didMove = true;

      // Retour haptique en entrant dans le palier 2 (suppression / spam).
      const inFull =
        (off < 0 && cb.leftFullAvail && -off >= g.current.stage2) ||
        (off > 0 && cb.rightFullAvail && off >= g.current.stage2);
      if (inFull && !g.current.fullArmed) {
        g.current.fullArmed = true;
        vibrate(12);
      } else if (!inFull && g.current.fullArmed) {
        g.current.fullArmed = false;
      }
    };

    // Finalise le geste : declenche l'action ou revient a la position de repos.
    const endGesture = () => {
      setAnimate(true);
      const cb = cbRef.current;
      const off = offsetRef.current;
      const width = contentRef.current?.offsetWidth ?? 400;

      if (off > 0) {
        if (cb.rightFullAvail && off >= g.current.stage2) {
          // Spam (palier 2) : sort par la droite puis declenche.
          apply(width + 40);
          commitTimerRef.current = setTimeout(() => {
            cb.onSwipeRightFull?.();
          }, 180);
        } else if (off >= STAGE1_PX && cb.onSwipeRight) {
          // Bloquer (palier 1) : le message reste, on revient a zero.
          cb.onSwipeRight();
          apply(0);
        } else {
          apply(0);
        }
      } else if (off < 0) {
        const abs = -off;
        if (cb.leftFullAvail && abs >= g.current.stage2) {
          // Suppression (palier 2) : sort par la gauche puis declenche.
          apply(-(width + 40));
          commitTimerRef.current = setTimeout(() => {
            cb.onSwipeLeftFull?.();
          }, 180);
        } else if (abs >= STAGE1_PX && cb.onSwipeLeft) {
          cb.onSwipeLeft();
          apply(0);
        } else {
          apply(0);
        }
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

    const onTouchEnd = (e: TouchEvent) => {
      clearLp();
      g.current.lastTouch = Date.now();
      g.current.active = false;
      const wasHorizontal = g.current.locked === "h";
      g.current.locked = null;

      if (g.current.lpFired) {
        e.preventDefault();
        setAnimate(true);
        apply(0);
        return;
      }
      if (!wasHorizontal) return;
      endGesture();
    };

    const onTouchCancel = () => {
      clearLp();
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
      clearLp();
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    };
  }, [enabled]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Un swipe (ou appui long) ne doit pas declencher la selection.
    if (g.current.didMove) {
      e.preventDefault();
      e.stopPropagation();
      g.current.didMove = false;
      return;
    }
    onClick?.(e);
  };

  const willMarkUnread = readState; // si deja lu -> le geste marquera non lu
  const ReadIcon = willMarkUnread ? Mail : MailOpen;
  const readLabel = willMarkUnread ? t("mail.swipeUnread") : t("mail.swipeRead");
  // Palier 2 atteint cote gauche : panneau rouge "Supprimer".
  const isDeleteStage =
    !!onSwipeLeftFull && offset < 0 && -offset >= g.current.stage2;
  // Palier 2 atteint cote droit : panneau ambre "Spam".
  const isSpamStage =
    !!onSwipeRightFull && offset > 0 && offset >= g.current.stage2;

  return (
    <div ref={setRootRef} className="relative overflow-hidden" {...rest}>
      {/* Panneau gauche : Bloquer (palier 1) ou Spam (palier 2), revele en swipant a droite */}
      {offset > 0 && (
        <div
          className={cn(
            "absolute inset-y-0 left-0 z-0 flex items-center overflow-hidden text-white transition-colors",
            isSpamStage ? "bg-amber-600" : "bg-orange-500"
          )}
          style={{ width: Math.max(0, offset) }}
          aria-hidden="true"
        >
          <div className="flex items-center gap-2 pl-4 whitespace-nowrap">
            {isSpamStage ? (
              <ShieldAlert className="size-5 shrink-0" />
            ) : (
              <Ban className="size-5 shrink-0" />
            )}
            <span className="text-sm font-medium">
              {isSpamStage ? t("folder.spam") : t("mail.swipeBlock")}
            </span>
          </div>
        </div>
      )}
      {/* Panneau droit : Lu/Non lu (palier 1) ou Supprimer (palier 2) */}
      {offset < 0 && (
        <div
          className={cn(
            "absolute inset-y-0 right-0 z-0 flex items-center justify-end overflow-hidden text-white transition-colors",
            isDeleteStage ? "bg-red-600" : "bg-blue-500"
          )}
          style={{ width: Math.max(0, -offset) }}
          aria-hidden="true"
        >
          <div className="flex items-center gap-2 pr-4 whitespace-nowrap">
            <span className="text-sm font-medium">
              {isDeleteStage ? t("delete") : readLabel}
            </span>
            {isDeleteStage ? (
              <Trash2 className="size-5 shrink-0" />
            ) : (
              <ReadIcon className="size-5 shrink-0" />
            )}
          </div>
        </div>
      )}

      <div
        ref={contentRef}
        role="button"
        tabIndex={0}
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
        {isImportance(importance) && (
          <span
            aria-hidden
            data-ref="mail-row-importance"
            data-importance={importance}
            className="pointer-events-none absolute inset-y-0 left-0 w-1"
            style={{ backgroundColor: IMPORTANCE_COLORS[importance] }}
          />
        )}
        {children}
      </div>
    </div>
  );
});
