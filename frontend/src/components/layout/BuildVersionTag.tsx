"use client";

import { cn } from "@/lib/utils";

// Version injectee au build via next.config.ts (NEXT_PUBLIC_BUILD_VERSION).
// Format : "<git-short-hash>-YYYYMMDD-HHmm". Sert a verifier visuellement
// quel build est servi par le navigateur (debug cache, service worker,
// deploiement Docker).
const VERSION = process.env.NEXT_PUBLIC_BUILD_VERSION || "dev";

export function BuildVersionTag({
  className,
  variant = "block",
}: {
  className?: string;
  variant?: "block" | "inline";
}) {
  if (variant === "inline") {
    return (
      <span
        data-ref="build-version"
        title={`Build : ${VERSION}`}
        className={cn(
          "font-mono text-[10px] text-muted-foreground/70 tabular-nums",
          className,
        )}
      >
        v{VERSION}
      </span>
    );
  }
  return (
    <div
      data-ref="build-version"
      title={`Build : ${VERSION}`}
      className={cn(
        "shrink-0 border-t px-2 py-1.5 text-center font-mono text-[10px] text-muted-foreground/70 tabular-nums truncate",
        className,
      )}
    >
      v{VERSION}
    </div>
  );
}
