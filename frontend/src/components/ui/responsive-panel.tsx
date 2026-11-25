"use client";

import * as React from "react";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

interface ResponsivePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Titre du panneau (visible dans le header + lecteur d'ecran). */
  title: React.ReactNode;
  /** Pastille de couleur optionnelle a gauche du titre (ex: groupe calendrier). */
  accentColor?: string;
  /** Actions optionnelles a droite du header (ex: bouton editer). */
  headerActions?: React.ReactNode;
  children: React.ReactNode;
  /** Largeur max du tiroir sur desktop (centre en bas d'ecran). */
  desktopWidthClass?: string;
  /** Hauteur du tiroir. */
  mobileHeightClass?: string;
  /** Classes ajoutees au contenu (ex: `z-[60]` pour empiler au-dessus d'un autre panneau). */
  contentClassName?: string;
  /** Classes de l'overlay (ex: `z-[60]` pour empiler le voile). */
  overlayClassName?: string;
}

/**
 * Panneau responsive : tiroir bas draggable (vaul Drawer) partout -- comme
 * AiChatPanel / ReplyBox. Sur desktop le tiroir vient AUSSI d'en bas (jamais
 * de la droite), simplement centre et borne en largeur (`desktopWidthClass`).
 * Evite le Sheet plein ecran sur mobile (titre sous la status bar, allure de
 * page) et le volet lateral droit sur desktop.
 *
 * Gotchas mobiles geres une fois ici : `noBodyStyles` (le body de l'app est
 * deja verrouille -> evite la bande blanche sous la status bar) et
 * `repositionInputs={false}`. Le caller fournit juste le titre + le contenu.
 */
export function ResponsivePanel({
  open,
  onOpenChange,
  title,
  accentColor,
  headerActions,
  children,
  desktopWidthClass = "sm:max-w-[790px]",
  mobileHeightClass = "h-[calc(var(--app-height,100dvh)*0.9)] max-sm:sheet-h-full",
  contentClassName,
  overlayClassName,
}: ResponsivePanelProps) {
  // En-tete COMMUN des tiroirs (poignee + titre centre, actions a droite,
  // sans croix : on ferme en glissant la prise vers le bas, handleOnly), le
  // contenu garde le defilement natif.
  const body = <div className="flex min-h-0 flex-1 flex-col">{children}</div>;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false} noBodyStyles handleOnly>
      <DrawerContent
        hideGrip
        className={cn(
          "drawer-scroll-native flex flex-col gap-0 p-0",
          mobileHeightClass,
          // Desktop : centre + largeur bornee (le tiroir vient toujours d'en bas)
          "sm:mx-auto sm:w-full sm:max-h-[calc(var(--app-height,100dvh)*0.9)]",
          desktopWidthClass,
          contentClassName
        )}
        overlayClassName={overlayClassName}
      >
        {/* En-tete COMMUN (meme code que tous les tiroirs). */}
        <DrawerSheetHeader
          title={
            accentColor ? (
              <span className="inline-flex max-w-full items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: accentColor }} />
                <span className="truncate">{title}</span>
              </span>
            ) : (
              title
            )
          }
          actions={headerActions || undefined}
          className="border-b"
        />
        {body}
      </DrawerContent>
    </Drawer>
  );
}
