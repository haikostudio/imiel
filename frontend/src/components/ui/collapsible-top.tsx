"use client";

import { useEffect, useState, type FocusEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useListChromeStore } from "@/lib/stores/list-chrome";

const TEXT_ENTRY = "input, textarea, [contenteditable='true']";

/**
 * Haut de liste repliable du telephone (bandeaux, recherche, filtres) : se
 * replie quand on descend dans la liste et revient des qu'on remonte (etat
 * partage `list-chrome`, pilote par useListChromeAutoHide dans le layout).
 *
 * Repli DANS la mise en page (grille 1fr -> 0fr) : la liste recupere la place
 * liberee. Jamais de position fixe ni de flou.
 *  - `forceVisible` : garde le haut affiche (selection multiple, tiroir ouvert).
 *  - `passive` : se replie avec l'ecran sans declarer d'ecran repliable (bandeau
 *    du layout, qui ne doit bouger que sur un ecran qui a la mecanique).
 * Un champ de saisie actif a l'interieur force aussi l'affichage. Sur
 * ordinateur l'etat reste "affiche" : le composant est inerte.
 */
export function CollapsibleTop({
  children,
  forceVisible = false,
  passive = false,
  className,
  "data-ref": dataRef,
}: {
  children: ReactNode;
  forceVisible?: boolean;
  passive?: boolean;
  className?: string;
  "data-ref"?: string;
}) {
  const hidden = useListChromeStore((s) => s.hidden);
  const registerScreen = useListChromeStore((s) => s.registerScreen);
  const force = useListChromeStore((s) => s.forceVisible);
  const [typing, setTyping] = useState(false);
  const forced = forceVisible || typing;

  useEffect(() => {
    if (passive) return;
    return registerScreen();
  }, [passive, registerScreen]);

  useEffect(() => {
    if (!forced) return;
    return force();
  }, [forced, force]);

  const collapsed = hidden && !forced;

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.matches(TEXT_ENTRY)) setTyping(true);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (!(next instanceof Node) || !e.currentTarget.contains(next)) setTyping(false);
  };

  return (
    <div
      data-collapsible-top=""
      data-passive={passive ? "" : undefined}
      data-collapsed={collapsed ? "oui" : "non"}
      data-ref={dataRef}
      onFocus={onFocus}
      onBlur={onBlur}
      className={cn(
        "grid shrink-0 transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden" inert={collapsed} aria-hidden={collapsed || undefined}>
        {children}
      </div>
    </div>
  );
}
