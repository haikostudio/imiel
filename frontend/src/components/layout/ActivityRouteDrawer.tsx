"use client";

import { useEffect } from "react";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import { hashNavigate } from "@/lib/hash-router";
import { useT } from "@/lib/i18n";
import { useActivityStore, activityHashPath } from "@/lib/hooks/useActivity";
import { ActivityFeed } from "@/components/activity/ActivityFeed";

/**
 * Route `#/activity` rendue en TIROIR (modal-as-route), pas en page dediee :
 * meme surface que l'apercu de la cloche, mais avec le flux COMPLET (onglets de
 * filtre + chargement infini). Pilote par le hash via HashRouter (background
 * gele pendant l'ouverture, comme les Reglages). Ouvrir marque tout comme vu
 * (badge cloche -> 0).
 */
export function ActivityRouteDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const markSeen = useActivityStore((s) => s.markSeen);

  useEffect(() => {
    if (open) markSeen();
  }, [open, markSeen]);

  const go = (url: string) => {
    onOpenChange(false);
    hashNavigate(activityHashPath(url));
  };

  return (
    <ResponsivePanel
      open={open}
      onOpenChange={onOpenChange}
      title={t("activity.title")}
    >
      <ActivityFeed showFilters onNavigate={go} />
    </ResponsivePanel>
  );
}
