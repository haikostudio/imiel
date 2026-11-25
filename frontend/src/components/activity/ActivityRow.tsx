"use client";

import type { ComponentType } from "react";
import {
  Mail,
  Send,
  Newspaper,
  PackagePlus,
  PackageSearch,
  CalendarClock,
  CalendarPlus,
} from "lucide-react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Activity, ActivityType } from "@/lib/pocketbase";

interface TypeStyle {
  icon: ComponentType<{ className?: string }>;
  /** Classe du chip d'icone (fond tinte + couleur). */
  chip: string;
  /** Cle i18n du libelle court du type. */
  labelKey: string;
}

const TYPE_STYLES: Record<ActivityType, TypeStyle> = {
  new_email: {
    icon: Mail,
    chip: "bg-muted text-muted-foreground",
    labelKey: "activity.type.new_email",
  },
  mail_sent: {
    icon: Send,
    chip: "bg-muted text-muted-foreground",
    labelKey: "activity.type.mail_sent",
  },
  newsletter: {
    icon: Newspaper,
    chip: "bg-muted text-muted-foreground",
    labelKey: "activity.type.newsletter",
  },
  tracking_new: {
    icon: PackagePlus,
    chip: "bg-muted text-muted-foreground",
    labelKey: "activity.type.tracking_new",
  },
  tracking_status: {
    icon: PackageSearch,
    chip: "bg-muted text-muted-foreground",
    labelKey: "activity.type.tracking_status",
  },
  calendar_reminder: {
    icon: CalendarClock,
    chip: "bg-muted text-muted-foreground",
    labelKey: "activity.type.calendar_reminder",
  },
  calendar_suggestion: {
    icon: CalendarPlus,
    chip: "bg-muted text-muted-foreground",
    labelKey: "activity.type.calendar_suggestion",
  },
};

/**
 * Une ligne du flux d'activite : chip d'icone colore par type, auteur/titre en
 * gras (le "par qui"), detail en muted, heure a droite, point de nouveaute a
 * gauche si l'activite est plus recente que la derniere ouverture. Clic ->
 * deep-link (activity.url) via onNavigate.
 */
export function ActivityRow({
  activity,
  isNew,
  onNavigate,
}: {
  activity: Activity;
  isNew: boolean;
  onNavigate: (url: string) => void;
}) {
  const t = useT();
  const style = TYPE_STYLES[activity.type] ?? TYPE_STYLES.new_email;
  const Icon = style.icon;
  const time = activity.event_date
    ? format(new Date(activity.event_date), "HH:mm", { locale: fr })
    : "";

  return (
    <button
      type="button"
      onClick={() => activity.url && onNavigate(activity.url)}
      className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/60"
    >
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
          style.chip
        )}
      >
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {activity.title}
          </span>
          <time className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {time}
          </time>
          {isNew && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t(style.labelKey)}
          </span>
          {activity.body && (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {activity.body}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
