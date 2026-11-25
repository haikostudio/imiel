"use client";

import { useRef, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  usePullToRefresh,
  PTR_THRESHOLD,
  type PullToRefreshState,
} from "@/lib/hooks/usePullToRefresh";

/**
 * Pastille indicateur du tirer-pour-rafraichir (overlay absolu centre en haut).
 * A placer dans un parent `position: relative`. Reutilise les classes .ptr de
 * globals.css pour un rendu identique a la liste mail.
 */
export function PullToRefreshIndicator({ pull, refreshing, dragging }: PullToRefreshState) {
  if (!(pull > 0 || refreshing)) return null;
  const ptrGap = refreshing ? PTR_THRESHOLD : pull;
  const progress = Math.min(pull / PTR_THRESHOLD, 1);
  const style = {
    "--ptr-y": `${ptrGap / 2 - 23}px`,
    "--ptr-o": refreshing ? 1 : Math.min(pull / (PTR_THRESHOLD * 0.5), 1),
    "--ptr-s": refreshing ? 1 : 0.55 + progress * 0.45,
    "--ptr-r": `${progress * 270}deg`,
  } as React.CSSProperties;
  return (
    <div
      className={`ptr ${refreshing ? "ptr--spin" : ""} ${dragging ? "" : "ptr--snap"}`}
      style={style}
      aria-hidden
    >
      <RefreshCw className="ptr__icon" size={18} strokeWidth={2.4} />
    </div>
  );
}

/** Decalage applique au contenu pendant le geste (px). */
export function ptrGapOf({ pull, refreshing }: PullToRefreshState): number {
  return refreshing ? PTR_THRESHOLD : pull;
}

/**
 * Conteneur scrollable avec tirer-pour-rafraichir (mobile). Remplace un simple
 * `<div className="overflow-y-auto">` : le contenu glisse vers le bas pendant le
 * geste et une pastille animee apparait en haut. Inerte sur desktop.
 *
 * Le composant occupe le slot flex de son parent (`flex-1 min-h-0`) et fournit
 * lui-meme la zone scrollable (`absolute inset-0 overflow-y-auto`).
 */
export function PullToRefresh({
  onRefresh,
  children,
  className,
  dataRef,
  contentClassName,
  disabled,
}: {
  onRefresh?: (() => Promise<unknown> | void) | null;
  children: ReactNode;
  /** Classes du conteneur scrollable (padding, etc.). */
  className?: string;
  /** Repere de la zone (styles par apparence, essais). */
  dataRef?: string;
  /** Classes du wrapper de contenu translate. */
  contentClassName?: string;
  disabled?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const state = usePullToRefresh(scrollRef, onRefresh, disabled);
  const ptrGap = ptrGapOf(state);
  return (
    <div data-ref={dataRef} className="relative min-h-0 flex-1">
      <PullToRefreshIndicator {...state} />
      <div ref={scrollRef} className={cn("absolute inset-0 overflow-y-auto", className)}>
        <div
          className={cn(state.dragging ? undefined : "ptr-content--snap", contentClassName)}
          style={ptrGap > 0 ? { transform: `translateY(${ptrGap}px)` } : undefined}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
