"use client";

import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { hashNavigate } from "@/lib/hash-router";
import { useT } from "@/lib/i18n";
import { useActivityStore } from "@/lib/hooks/useActivity";

/**
 * Cloche du header : ouvre le centre de notifications (tiroir #/activity), le
 * MEME que la nav laterale "Activite". Pastille = nombre d'activites arrivees
 * depuis la derniere ouverture (badge "vu depuis", cf useActivity). L'ouverture
 * retombe le badge a zero (markSeen, aussi fait a l'ouverture du tiroir).
 */
export function ActivityBell() {
  const t = useT();
  const unread = useActivityStore((s) => s.unreadCount);
  const markSeen = useActivityStore((s) => s.markSeen);

  const open = () => {
    markSeen();
    hashNavigate("/activity");
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={open}
          aria-label={t("activity.title")}
          className="relative md:size-9"
          data-ref="header-activity-bell"
        >
          <Bell className="size-5" strokeWidth={1.7} />
          {unread > 0 && (
            <span
              data-ref="header-activity-badge"
              className="absolute -right-1 -top-0.5 flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground ring-2 ring-background tabular-nums"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("activity.title")}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Apparence Miel, ordinateur : la barre du haut est retiree, la cloche descend
 * en tete du pied du menu (meme action, meme pastille). Ligne du menu deplie
 * (icone + libelle), bouton carre en menu replie.
 */
export function SidebarActivityButton({ collapsed }: { collapsed: boolean }) {
  const t = useT();
  const unread = useActivityStore((s) => s.unreadCount);
  const markSeen = useActivityStore((s) => s.markSeen);
  const badge = unread > 0 && (
    <span
      data-ref="header-activity-badge"
      className={
        collapsed
          ? "absolute -right-1 -top-0.5 flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground ring-2 ring-background tabular-nums"
          : "ml-auto flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground tabular-nums"
      }
    >
      {unread > 99 ? "99+" : unread}
    </span>
  );
  return (
    <Button
      variant="ghost"
      size={collapsed ? "icon" : "sm"}
      className={collapsed ? "relative w-full" : "relative w-full justify-start gap-2"}
      onClick={() => {
        markSeen();
        hashNavigate("/activity");
      }}
      aria-label={t("activity.title")}
      title={collapsed ? t("activity.title") : undefined}
      data-ref="sidebar-activity-bell"
    >
      <Bell className="size-4 shrink-0" />
      {!collapsed && <span className="text-sm">{t("activity.title")}</span>}
      {badge}
    </Button>
  );
}
