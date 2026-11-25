"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// Meme rythme que la couche des `title` (ui/title-tooltips.tsx) : un court
// delai pour ne pas clignoter en balayant une rangee d'icones.
function TooltipProvider({
  delayDuration = 200,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  // `data-tooltip-trigger` : repere que l'enfant d'un `asChild` ne peut pas
  // ecraser (contrairement a data-slot, que Button redefinit). La couche des
  // info-bulles maison (title-tooltips.tsx) l'ignore : UNE seule bulle.
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" data-tooltip-trigger="" {...props} />
}

// Info-bulle NOIRE a texte BLANC dans les deux themes (choix utilisateur
// 2026-10-20 : exception assumee a la charte) ; en sombre un liseré clair la
// detache d'un fond quasi noir.
function TooltipContent({
  className,
  sideOffset = 0,
  children,
  arrowClassName,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & { arrowClassName?: string }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-black text-white dark:ring-1 dark:ring-white/15 animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-2.5 py-1.5 text-xs font-medium text-balance shadow-md",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className={cn("bg-black fill-black z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]", arrowClassName)} />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
