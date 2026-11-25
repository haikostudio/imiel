"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Info-bulles de TOUTE l'application (choix utilisateur 2026-10-20) : noires,
 * texte blanc, a la place de la bulle native du navigateur. Une seule couche
 * deleguee reprend chaque attribut `title` survole a la SOURIS (jamais au
 * doigt) ou atteint au clavier : l'attribut est mis de cote le temps du survol
 * (la bulle native ne parait pas), puis rendu a la sortie. Aucun `title` n'est
 * donc a reecrire ecran par ecran, et les nouveaux ecrans en profitent seuls.
 *
 * Sous un navigateur pilote (`navigator.webdriver`), l'attribut reste en place
 * (les controles automatiques le relisent) ; la bulle maison s'affiche quand
 * meme. Le composant Radix `TooltipContent` (ui/tooltip.tsx) a le meme dessin.
 * Couleurs en dur (noir / blanc) : exception assumee a la charte, demandee
 * explicitement par l'utilisateur.
 */

const STASH = "data-hint-title";
const SHOW_DELAY = 200;
const GAP = 6;
const MARGIN = 8;

type Hint = { el: Element; text: string; id: number };

function findTitled(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(`[title], [${STASH}]`);
  // Les cadres (iframe d'un mail) portent un title d'accessibilite : pas de bulle.
  if (el && el.tagName !== "IFRAME") return el;
  // Bouton a ICONE SEULE sans title : son aria-label sert de bulle (chaque
  // bouton de l'application en a une, sans rien ajouter ecran par ecran).
  const btn = target.closest("button[aria-label], a[aria-label], [role='button'][aria-label]");
  if (btn && !(btn as HTMLElement).innerText?.trim()) return btn;
  return null;
}

/** La cible est-elle (dans) un declencheur d'info-bulle Radix qui contient
 *  aussi l'element titre ? Alors c'est la bulle Radix qui parle. */
function isRadixTooltipTarget(target: EventTarget | null, el: Element): boolean {
  if (!(target instanceof Element)) return false;
  const trig = target.closest("[data-tooltip-trigger]");
  return !!trig && (trig === el || trig.contains(el) || el.contains(trig));
}

function hintText(el: Element): string {
  return (el.getAttribute("title") ?? el.getAttribute(STASH) ?? el.getAttribute("aria-label") ?? "").trim();
}

export function TitleTooltips() {
  const [hint, setHint] = useState<Hint | null>(null);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<Element | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastHideRef = useRef(0);
  const idRef = useRef(0);

  useEffect(() => {
    const piloted = typeof navigator !== "undefined" && navigator.webdriver === true;

    const restore = (el: Element) => {
      const stashed = el.getAttribute(STASH);
      if (stashed === null) return;
      el.removeAttribute(STASH);
      // Un nouveau title pose entre-temps par React gagne.
      if (!el.hasAttribute("title")) el.setAttribute("title", stashed);
    };

    const hide = () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const el = currentRef.current;
      if (el) {
        restore(el);
        currentRef.current = null;
        lastHideRef.current = Date.now();
      }
      setVisible(false);
    };

    // `silent` : element deja muni d'une info-bulle Radix (<TooltipTrigger>,
    // repere data-tooltip-trigger) -> elle suffit. On range seulement son title
    // (sinon la bulle native du navigateur s'y ajoutait) sans afficher la
    // notre : avant, deux bulles s'affichaient l'une apres l'autre.
    const show = (el: Element, silent = false) => {
      if (currentRef.current === el) return;
      hide();
      const text = hintText(el);
      if (!text) return;
      if (!piloted && el.hasAttribute("title")) {
        el.setAttribute(STASH, el.getAttribute("title") ?? "");
        el.removeAttribute("title");
      }
      currentRef.current = el;
      if (silent) return;
      // Une bulle vient de se fermer : on lit une rangee d'icones d'un geste.
      const delay = Date.now() - lastHideRef.current < 400 ? 0 : SHOW_DELAY;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (currentRef.current !== el || !el.isConnected) return;
        idRef.current += 1;
        setPos(null);
        setHint({ el, text, id: idRef.current });
        setVisible(true);
      }, delay);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const el = findTitled(e.target);
      if (el) show(el, isRadixTooltipTarget(e.target, el));
      else if (currentRef.current) hide();
    };
    const onOut = (e: PointerEvent) => {
      const el = currentRef.current;
      if (!el) return;
      const to = e.relatedTarget;
      if (to instanceof Node && el.contains(to)) return;
      hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = findTitled(e.target);
      if (!el || el !== e.target) return;
      if (isRadixTooltipTarget(e.target, el)) return;
      // Clavier seulement (focus-visible) : un clic de souris ne doit pas
      // relancer la bulle qu'il vient de fermer.
      try {
        if (!(e.target as Element).matches(":focus-visible")) return;
      } catch {
        return;
      }
      show(el);
    };
    const onFocusOut = () => hide();

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Placement : au-dessus de l'element, centree, tenue dans l'ecran ; en
  // dessous faute de place.
  useLayoutEffect(() => {
    if (!hint || !bubbleRef.current) return;
    const r = hint.el.getBoundingClientRect();
    const b = bubbleRef.current.getBoundingClientRect();
    let top = r.top - b.height - GAP;
    if (top < MARGIN) top = r.bottom + GAP;
    let left = r.left + r.width / 2 - b.width / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - b.width - MARGIN));
    setPos({ left, top });
  }, [hint]);

  if (!hint || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={bubbleRef}
      role="tooltip"
      data-ref="title-tooltip"
      onTransitionEnd={() => {
        if (!visible) setHint(null);
      }}
      style={{
        position: "fixed",
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        opacity: visible && pos ? 1 : 0,
      }}
      className="pointer-events-none z-[300] max-w-[min(20rem,calc(100vw-1rem))] rounded-md bg-black px-2.5 py-1.5 text-xs leading-snug font-medium break-words whitespace-pre-line text-white shadow-md transition-opacity duration-150 dark:ring-1 dark:ring-white/15"
    >
      {hint.text}
    </div>,
    document.body
  );
}
