"use client";

import { useLabels } from "@/lib/hooks/useLabels";
import { cn } from "@/lib/utils";

interface MessageLabelsProps {
  labelIds: string[] | undefined | null;
  className?: string;
  max?: number;
}

export function MessageLabels({ labelIds, className, max = 3 }: MessageLabelsProps) {
  const { resolve } = useLabels();
  const items = resolve(labelIds);
  if (items.length === 0) return null;
  const visible = items.slice(0, max);
  const extra = items.length - visible.length;

  return (
    <div data-ref="message-labels" className={cn("flex shrink-0 items-center gap-1", className)}>
      {/* Charte : petite pastille grise ; la couleur choisie pour l'etiquette
          reste lisible par un point devant son nom. */}
      {visible.map((lbl) => (
        <span
          key={lbl.id}
          className="inline-flex h-5 max-w-[8rem] items-center gap-1 rounded-md bg-muted px-1.5 text-[11px] leading-none text-muted-foreground"
          title={lbl.name}
        >
          {lbl.color && lbl.color.toLowerCase() !== "#6b7280" && (
            <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: lbl.color }} aria-hidden />
          )}
          <span className="truncate">{lbl.name}</span>
        </span>
      ))}
      {extra > 0 && (
        <span className="text-[10px] text-muted-foreground" title={items.slice(max).map((l) => l.name).join(", ")}>
          +{extra}
        </span>
      )}
    </div>
  );
}
