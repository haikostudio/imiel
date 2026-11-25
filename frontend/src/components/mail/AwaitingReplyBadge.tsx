"use client";

import { useSyncExternalStore } from "react";
import { Hourglass } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import { formatWaitingDuration } from "@/lib/utils/awaiting-reply";
import { cn } from "@/lib/utils";

// Horloge partagee a la minute : UN seul intervalle pour toutes les lignes
// (50+ badges dans une liste), la duree avance sans aucun refetch.
let minuteNow = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    minuteNow = Date.now();
    timer = setInterval(() => {
      minuteNow = Date.now();
      for (const l of listeners) l();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => minuteNow;

/**
 * "Attend depuis 3 h" : remplace la date en haut a droite d'une ligne de
 * conversation dont le dernier message recu attend une reponse
 * (regle : lib/utils/awaiting-reply.ts).
 */
export function AwaitingReplyBadge({
  since,
  selectedColored,
  className,
}: {
  since: string;
  selectedColored?: boolean;
  className?: string;
}) {
  const t = useT();
  const language = useSettingsStore((s) => s.language);
  const now = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const duration = formatWaitingDuration(since, language, Math.max(now, Date.now()));
  return (
    <span
      title={t("mail.awaitingReplyTitle")}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium",
        selectedColored ? "text-white" : "text-amber-600 dark:text-amber-400",
        className
      )}
    >
      <Hourglass className="size-3 shrink-0" aria-hidden />
      {t("mail.awaitingSince", { duration })}
    </span>
  );
}
