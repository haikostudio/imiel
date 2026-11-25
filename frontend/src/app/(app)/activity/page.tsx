"use client";

import { useEffect } from "react";
import { Activity as ActivityIcon } from "lucide-react";
import { hashNavigate } from "@/lib/hash-router";
import { useT } from "@/lib/i18n";
import { useActivityStore, activityHashPath } from "@/lib/hooks/useActivity";
import { ActivityFeed } from "@/components/activity/ActivityFeed";

/**
 * Page Activite : historique 30 jours de "ce qui s'est passe, par qui et quand"
 * (mails recus/envoyes, suivis, newsletters, agenda), groupe par jour avec
 * onglets par type. Ouvrir la page marque tout comme vu (badge cloche -> 0).
 */
export default function ActivityPage() {
  const t = useT();
  const markSeen = useActivityStore((s) => s.markSeen);

  useEffect(() => {
    markSeen();
  }, [markSeen]);

  const go = (url: string) => hashNavigate(activityHashPath(url));

  return (
    <div className="flex h-full flex-col bg-muted">
      {/* Telephone : le titre est dans l'entete unique, pas de seconde bande. */}
      <header className="hidden shrink-0 items-center gap-2 border-b bg-background px-4 py-3 md:flex">
        <ActivityIcon className="size-5 shrink-0" />
        <h1 className="truncate text-lg font-semibold">{t("activity.title")}</h1>
      </header>

      <ActivityFeed showFilters onNavigate={go} />
    </div>
  );
}
