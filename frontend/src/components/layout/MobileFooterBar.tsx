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
 * a la page quittent la rangee sous l'entete pour cette barre fixe ; sur la vue
 * d'ensemble et les listes de mails, « Rediger » est un ROND au centre qui
 * depasse un peu par le haut tout en restant aligne sur les autres libelles.
 * Une page sans bouton ne la monte pas.
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
  if (compose) {
    const composeBtn = (
      <button
        key="compose"
        type="button"
        data-ref="compose-fab"
        onClick={onCompose}
        aria-label={t("compose.fab")}
        className="mobile-footer-item flex min-w-0 flex-1 flex-col items-center justify-end gap-1 text-[11px] font-semibold leading-none text-foreground"
      >
        <span
          data-ref="compose-fab-disc"
          className="-mt-6 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-black/20 ring-4 ring-background transition-transform active:scale-95"
        >
          <PenSquare className="size-6" strokeWidth={1.8} />
        </span>
        <span>{t("compose.fab")}</span>
      </button>
    );
    items.splice(Math.ceil(items.length / 2), 0, composeBtn);
  }

  return createPortal(
    <nav
      data-ref="mobile-footer-bar"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 flex items-end border-t border-border/60 bg-background/95 px-1 pt-1.5 backdrop-blur-xl md:hidden",
        "pb-[max(0.5rem,env(safe-area-inset-bottom))]",
        className
      )}
    >
      {items}
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
        "mobile-footer-item flex min-w-0 flex-1 flex-col items-center gap-1 rounded-2xl px-1 py-1.5 text-[11px] leading-none text-muted-foreground transition-colors active:bg-accent disabled:opacity-50",
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
 *  (hauteur de la barre + debord du rond + barre d'accueil). */
export const MOBILE_FOOTER_CLEARANCE = "calc(4.5rem + env(safe-area-inset-bottom))";
