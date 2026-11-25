"use client";

import { useEffect, useState } from "react";
import { Clock, X } from "lucide-react";
import { toast } from "sonner";
import pb from "@/lib/pocketbase";
import { useT } from "@/lib/i18n";
import { useMailStore } from "@/lib/stores/mail-store";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

interface ScheduledSendCountdownProps {
  draftId: string;
  scheduledAt: string;
}

function formatCountdown(msLeft: number, t: (key: string, params?: Record<string, string>) => string): string {
  if (msLeft <= 0) return t("message.scheduledSendingNow");
  const totalSeconds = Math.floor(msLeft / 1000);
  if (totalSeconds < 60) {
    return t("message.scheduledCountdownSeconds", { s: String(totalSeconds) });
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return t("message.scheduledCountdownMinutes", { m: String(totalMinutes) });
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const remMinutes = totalMinutes % 60;
    return remMinutes > 0
      ? t("message.scheduledCountdownHoursMinutes", { h: String(totalHours), m: String(remMinutes) })
      : t("message.scheduledCountdownHours", { h: String(totalHours) });
  }
  const totalDays = Math.floor(totalHours / 24);
  return t("message.scheduledCountdownDays", { d: String(totalDays) });
}

/**
 * Compte a rebours en direct avant l'envoi programme d'un brouillon, avec
 * bouton pour annuler l'envoi (POST /api/mail/schedule, scheduled_at: "").
 */
export function ScheduledSendCountdown({ draftId, scheduledAt }: ScheduledSendCountdownProps) {
  const t = useT();
  const target = new Date(scheduledAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  const [canceling, setCanceling] = useState(false);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const intervalMs = target - Date.now() < 60_000 ? 1000 : 30_000;
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [target]);

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (canceling) return;
    setCanceling(true);
    try {
      await pb.send("/api/mail/schedule", {
        method: "POST",
        body: { draft_id: draftId, scheduled_at: "" },
      });
      toast.success(t("compose.scheduleCanceled"));
      useMailStore.getState().invalidateMessages();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("compose.scheduleError"));
      setCanceling(false);
    }
  };

  if (isNaN(target)) return null;

  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-foreground">
      <span className="inline-flex items-center gap-1" data-ref="scheduled-countdown">
        <Clock className="size-3 shrink-0" />
        {formatCountdown(target - now, t)}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-ref="scheduled-cancel"
            disabled={canceling}
            onClick={handleCancel}
            className="rounded-full p-0.5 text-amber-700 hover:bg-accent disabled:opacity-50 dark:text-amber-300"
            aria-label={t("compose.cancelSchedule")}
          >
            <X className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t("compose.cancelSchedule")}</TooltipContent>
      </Tooltip>
    </span>
  );
}
