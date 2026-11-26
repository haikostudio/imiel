"use client";

import { Children, forwardRef, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PenSquare, type LucideIcon } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Barre d'actions du PIED de l'ecran (telephone seulement, < 768 px).
 *
 * Choix utilisateur (carte « Finitions Miel sur mobile ») : les boutons PROPRES
 * a la page quittent la rangee sous l'entete pour ce pied fixe. Carte « Menu du
 * bas en bouton flottant » : la barre n'a PLUS ni fond ni bordure. Vue
 * d'ensemble et listes de mails = le rond « Rediger » SEUL, flottant, sans
 * libelle (aria-label garde) ; Newsletters / Suivi = leurs boutons dans une
 * PILULE flottante centree (data-ref mobile-footer-pill). Une page sans bouton
 * ne la monte pas.
 *
 * - Rendue en PORTAIL dans <body> (aucun contexte d'empilement d'un ancetre
 *   ne la recouvre), z-40 : SOUS les tiroirs et fenetres (z-50), au-dessus du
 *   contenu.
 * - Tant qu'elle est montee, <html data-mobile-footer> fait reserver sa
 *   hauteur en bas de la zone principale (globals.css) : la fin des listes
 *   n'est jamais cachee.
 * - Respecte la barre d'accueil de l'iPhone (safe-area-inset-bottom, DEC-382).
 */
export function MobileFooterBar({
  children,
  compose,
  onCompose,
  className,
}: {
  children?: React.ReactNode;
  /** Rond « Rediger » au centre de la barre. */
  compose?: boolean;
  onCompose?: () => void;
  className?: string;
}) {
  const t = useT();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const root = document.documentElement;
    const n = Number(root.dataset.mobileFooter || "0") + 1;
    root.dataset.mobileFooter = String(n);
    return () => {
      const left = Number(root.dataset.mobileFooter || "1") - 1;
      if (left <= 0) delete root.dataset.mobileFooter;
      else root.dataset.mobileFooter = String(left);
    };
  }, []);

  if (!mounted) return null;

  const items = Children.toArray(children);
  const composeBtn = compose ? (
    <button
      key="compose"
      type="button"
      data-ref="compose-fab"
      onClick={onCompose}
      aria-label={t("compose.fab")}
      className="mobile-footer-item pointer-events-auto flex shrink-0 items-center justify-center rounded-full"
    >
      <span
        data-ref="compose-fab-disc"
        className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_10px_28px_-8px_rgba(0,0,0,0.45)] transition-transform active:scale-95"
      >
        <PenSquare className="size-6" strokeWidth={1.8} />
      </span>
    </button>
  ) : null;

  // Rond seul (vue d'ensemble, listes de mails) : rien d'autre que lui.
  // Sinon les boutons de la page tiennent dans une pilule flottante, le rond
  // (s'il y en a un) au milieu.
  let content: React.ReactNode;
  if (items.length === 0) {
    content = composeBtn;
  } else {
    if (composeBtn) items.splice(Math.ceil(items.length / 2), 0, composeBtn);
    content = (
      <div
        data-ref="mobile-footer-pill"
        className="pointer-events-auto inline-flex max-w-[calc(100%-24px)] items-center gap-1 rounded-full border border-border/60 bg-background/90 p-1 shadow-lg shadow-black/15 backdrop-blur-xl"
      >
        {items}
      </div>
    );
  }

  // La barre elle-meme n'a ni fond ni bordure : elle ne fait que poser le rond
  // ou la pilule au-dessus de la barre d'accueil, et laisse passer les touchers
  // vers la liste a cote (pointer-events-none).
  return createPortal(
    <nav
      data-ref="mobile-footer-bar"
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 z-40 flex items-end justify-center px-3 md:hidden",
        "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        className
      )}
    >
      {content}
    </nav>,
    document.body
  );
}

/** Bouton de la barre du pied : picto au-dessus de son libelle. Transmet sa
 *  ref (declencheur d'un menu Radix en `asChild`). */
export const MobileFooterButton = forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & { icon: LucideIcon; label: React.ReactNode; active?: boolean; spin?: boolean }
>(function MobileFooterButton({ icon: Icon, label, active, spin, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-active={active ? "" : undefined}
      className={cn(
        "mobile-footer-item flex w-[4.25rem] min-w-0 shrink-0 flex-col items-center gap-1 rounded-full px-1 py-2 text-[11px] leading-none text-muted-foreground transition-colors active:bg-accent disabled:opacity-50",
        active && "bg-accent font-semibold text-foreground",
        className
      )}
      {...props}
    >
      <Icon className={cn("size-[1.35rem]", spin && "animate-spin")} strokeWidth={1.7} />
      <span className="max-w-full truncate">{label}</span>
    </button>
  );
});

/** Place reservee en bas d'une zone qui defile sous la barre du pied
 *  (rond de 56 px ou pilule + marge + barre d'accueil). */
export const MOBILE_FOOTER_CLEARANCE = "calc(4.75rem + max(0.75rem, env(safe-area-inset-bottom)))";
