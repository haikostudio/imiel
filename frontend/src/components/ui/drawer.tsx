"use client";

import * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";

import { cn } from "@/lib/utils";

function Drawer(props: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger(
  props: React.ComponentProps<typeof DrawerPrimitive.Trigger>
) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal(
  props: React.ComponentProps<typeof DrawerPrimitive.Portal>
) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose(props: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    // PAS de classes d'animation Tailwind (data-[state]:animate-in/fade) ici :
    // vaul controle lui-meme l'opacite de l'overlay -> fondu a l'ouverture/
    // fermeture (CSS injecte [data-vaul-overlay]) ET surtout opacite =
    // 1 - distanceGlissee EN DIRECT pendant le drag. Une animation Tailwind avec
    // fill-mode bloquerait cette opacite inline et tuerait le fondu progressif.
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 backdrop-blur-xl",
        className
      )}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  container,
  contained,
  overlayClassName,
  manualOverlay,
  onOverlayClick,
  hideGrip,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & {
  // Confiner le tiroir a un conteneur (ex: le panneau de lecture sur desktop)
  // plutot que la fenetre entiere : position absolute + portal dans `container`.
  container?: HTMLElement | null;
  contained?: boolean;
  overlayClassName?: string;
  // En mode `modal={false}`, vaul ne rend PAS son overlay (Drawer.Overlay
  // retourne null) -> pas de fond grise. `manualOverlay` rend un backdrop
  // maison (meme portal, juste sous le contenu) pour retrouver le voile.
  manualOverlay?: boolean;
  onOverlayClick?: () => void;
  // Le tiroir rend sa propre zone de prise (DrawerHandle, avec `handleOnly`) :
  // on n'affiche pas la poignee decorative par defaut.
  hideGrip?: boolean;
}) {
  const overlayElRef = React.useRef<HTMLDivElement>(null);
  const observerRef = React.useRef<MutationObserver | null>(null);
  const bodyGuardRef = React.useRef<MutationObserver | null>(null);

  // vaul n'estompe PAS l'overlay au drag pour un tiroir sans snap points
  // (l'opacite n'est touchee que si shouldFade). Pour un backdrop maison, on
  // suit le `transform: translate3d(0, Ypx, 0)` que vaul applique en direct au
  // contenu (drag + animations open/close) et on en derive l'opacite -> fondu
  // progressif au lieu d'une disparition binaire. Ref CALLBACK : le DOM du
  // contenu vaul n'existe qu'a l'ouverture (pas au montage de DrawerContent),
  // donc on branche l'observer quand le noeud apparait et on le coupe a sa
  // disparition.
  const setContentEl = React.useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      bodyGuardRef.current?.disconnect();
      bodyGuardRef.current = null;
      if (!manualOverlay) return;

      // GARDE POINTER-EVENTS DU BODY. vaul est construit sur Radix Dialog.Root
      // mais ne lui transmet PAS `modal={false}` : le Dialog sous-jacent reste
      // donc modal et verrouille toute la page via `body { pointer-events:none }`.
      // vaul tente de l'annuler par UN rAF, mais avec des tiroirs empiles/confines
      // (contained) cette course est perdue et l'arriere-plan reste mort (on ne
      // peut plus cliquer la sidebar / la liste a cote du tiroir). Nos tiroirs
      // `manualOverlay` sont NON modaux par choix : le reste de l'app doit rester
      // cliquable. Tant que le contenu est monte, on reforce donc pointer-events
      // du body (Radix le repose parfois apres notre reset). Le noeud vaul
      // n'existe qu'a l'ouverture -> l'observer suit exactement l'ouverture/
      // fermeture du tiroir.
      if (node) {
        const body = document.body;
        const clearBody = () => {
          if (body.style.pointerEvents === "none") body.style.pointerEvents = "auto";
        };
        clearBody();
        const bodyObs = new MutationObserver(clearBody);
        bodyObs.observe(body, { attributes: true, attributeFilter: ["style"] });
        bodyGuardRef.current = bodyObs;
      }

      const overlay = overlayElRef.current;
      if (!node || !overlay) return;
      const update = () => {
        const tr = node.style.transform;
        const m = /translate3d\(\s*0(?:px)?,\s*(-?[\d.]+)px/.exec(tr);
        const y = m ? parseFloat(m[1]) : 0;
        const h = node.offsetHeight || 1;
        const progress = Math.min(Math.max(y / h, 0), 1); // 0 ouvert .. 1 ferme
        overlay.style.opacity = String(1 - progress);
        // Mirroir du timing de vaul : pas de transition pendant le drag
        // (transition:none), meme courbe/duree au relacher/fermeture.
        const ct = node.style.transition;
        overlay.style.transition = ct && ct !== "none" ? ct.replace(/transform/g, "opacity") : "none";
      };
      update();
      const obs = new MutationObserver(update);
      obs.observe(node, { attributes: true, attributeFilter: ["style"] });
      observerRef.current = obs;
    },
    [manualOverlay]
  );

  return (
    <DrawerPortal container={container ?? undefined}>
      {manualOverlay ? (
        <div
          ref={overlayElRef}
          data-slot="drawer-overlay-manual"
          aria-hidden
          onClick={onOverlayClick}
          className={cn(
            "z-50 bg-black/50 backdrop-blur-xl pointer-events-auto",
            contained ? "absolute inset-0" : "fixed inset-0",
            overlayClassName
          )}
        />
      ) : (
        <DrawerOverlay
          className={cn(contained && "absolute", overlayClassName)}
        />
      )}
      <DrawerPrimitive.Content
        ref={manualOverlay ? setContentEl : undefined}
        data-slot="drawer-content"
        // Repere CSS : un tiroir confine au volet de lecture (ordinateur) garde
        // son plafond en part d'ecran au lieu de monter jusqu'a la barre d'etat
        // (variante `data-[contained=true]:` cote appelant).
        data-contained={contained ? "true" : undefined}
        className={cn(
          "group/drawer-content z-50 mt-24 flex h-auto flex-col rounded-t-2xl border-t bg-background shadow-xl outline-none",
          contained ? "absolute inset-x-0 bottom-0" : "fixed inset-x-0 bottom-0",
          className
        )}
        {...props}
      >
        {/* Poignee de glissement (drag-to-close) */}
        {!hideGrip && (
          <div className="mx-auto mt-2 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
        )}
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

/**
 * Zone de prise d'un tiroir `handleOnly` : seul ce bloc fait glisser/fermer le
 * tiroir, le reste du contenu garde le defilement natif (vaul n'y pose plus ni
 * capture de pointeur ni transform). Le style par defaut de vaul (pastille
 * 32x5px, zone de clic centree en absolu) est neutralise par `.drawer-handle-area`
 * dans globals.css pour que la zone couvre ses enfants (poignee + titre).
 */
function DrawerHandle({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Handle>) {
  return (
    <DrawerPrimitive.Handle
      data-slot="drawer-handle"
      className={cn("drawer-handle-area", className)}
      {...props}
    >
      {/* Poignee SERREE (6 px au-dessus, 2 px dessous) : le titre suit de pres
          le bord du tiroir, lui-meme colle a l'heure (DEC-381). */}
      <span className="mx-auto mt-1.5 mb-0.5 block h-1.5 w-12 rounded-full bg-muted-foreground/30" />
      {children}
    </DrawerPrimitive.Handle>
  );
}

/**
 * EN-TETE COMMUN de TOUS les tiroirs du telephone (grands tiroirs et petits
 * menus) : poignee + titre CENTRE dans la prise (seul ce bloc fait glisser le
 * tiroir) et actions a DROITE posees HORS de la prise (un tap dessus ne lance
 * jamais de glisser). PAS de croix de fermeture : un tiroir du telephone se
 * ferme en glissant sa poignee vers le bas (vaul -> onOpenChange(false)), et
 * par Echap / clic sur le voile la ou il y en a un. Le Drawer qui le recoit
 * DOIT donc fermer son etat parent dans `onOpenChange`.
 * Un nouveau tiroir s'ecrit avec cet en-tete, jamais avec un titre maison :
 * le test `drawer-contract.test.ts` (npm test) refuse un DrawerContent sans
 * lui (ou sans `data-drawer-header="custom"` explicite, cas du fil de
 * conversation et de la fiche du suivi), et toute croix `data-drawer-close`.
 * Le DrawerContent qui le recoit pose `hideGrip` (sinon deux poignees).
 */
function DrawerSheetHeader({
  title,
  actions,
  actionsRef,
  className,
  titleClassName,
  srOnlyTitle,
  wideActions,
  dataRef,
  handleDataRef,
  titleDataRef,
  actionsDataRef,
}: {
  title: React.ReactNode;
  /** Bouton(s) d'action a droite (hors de la prise). */
  actions?: React.ReactNode;
  /** Hote d'actions rendu par portail (ex: menu "⋮" de la redaction). */
  actionsRef?: React.Ref<HTMLDivElement>;
  className?: string;
  titleClassName?: string;
  /** Titre reserve aux lecteurs d'ecran (la prise reste, sans texte). */
  srOnlyTitle?: boolean;
  /** Deux boutons d'action a droite : marge du titre elargie (symetrique). */
  wideActions?: boolean;
  dataRef?: string;
  handleDataRef?: string;
  titleDataRef?: string;
  actionsDataRef?: string;
}) {
  const hasActions = Boolean(actions || actionsRef);
  // Marge SYMETRIQUE calculee sur les seules actions de droite : le titre
  // reste centre sur l'ecran sans jamais passer sous les boutons.
  const titlePad = wideActions ? "px-24" : hasActions ? "px-16" : "px-4";
  return (
    <div
      className={cn("relative shrink-0 rounded-t-[inherit] bg-background", className)}
      data-ref={dataRef}
      data-drawer-header=""
    >
      <DrawerHandle data-ref={handleDataRef}>
        <div className={cn("flex h-11 items-center justify-center", titlePad)}>
          <DrawerTitle
            data-ref={titleDataRef}
            className={cn(
              "min-w-0 truncate text-center text-[1rem] font-semibold text-foreground",
              srOnlyTitle && "sr-only",
              titleClassName
            )}
          >
            {title}
          </DrawerTitle>
        </div>
      </DrawerHandle>
      {hasActions && (
        <div
          ref={actionsRef}
          className="absolute right-2.5 bottom-1 flex items-center gap-1"
          data-ref={actionsDataRef}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerTrigger,
  DrawerPortal,
  DrawerClose,
  DrawerOverlay,
  DrawerContent,
  DrawerHandle,
  DrawerSheetHeader,
  DrawerTitle,
  DrawerDescription,
};
