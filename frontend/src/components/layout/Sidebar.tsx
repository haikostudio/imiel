"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { hashNavigate } from "@/lib/hash-router";
import { Bell, LogOut, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Settings, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { AccountSwitcher } from "@/components/layout/AccountSwitcher";
import { FolderNav } from "@/components/layout/FolderNav";
import { LabelsNav } from "@/components/layout/LabelsNav";
import { SidebarActivityButton } from "@/components/layout/ActivityBell";
import { useMailStore } from "@/lib/stores/mail-store";
import { logout } from "@/lib/pocketbase";
import { cn } from "@/lib/utils";
import { toggleTheme, useIsMiel } from "@/lib/hooks/useSettings";
import { useT } from "@/lib/i18n";
import { usePanelSizes } from "@/lib/hooks/usePanelSizes";

export function Sidebar() {
  const router = useRouter();
  const t = useT();
  const sidebarCollapsed = useMailStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useMailStore((s) => s.toggleSidebar);
  const openCompose = useMailStore((s) => s.openCompose);
  const [isDark, setIsDark] = useState(false);
  const [hovering, setHovering] = useState(false);
  const { sizes, updateSize } = usePanelSizes();
  // Miel : menu pose sur le fond, sans separateurs ; les etiquettes quittent
  // le menu pour le filtre "Etiquettes" de la liste (FilterBar).
  const isMiel = useIsMiel();

  // En mode replie (rail d'icones), approcher le curseur deploie la sidebar
  // en overlay au-dessus du contenu sans decaler la mise en page. Le survol du
  // panneau deploye (enfant DOM du rail) ne declenche pas mouseleave, donc il
  // reste ouvert tant qu'on est dessus.
  const expandedOnHover = sidebarCollapsed && hovering;
  const collapsed = sidebarCollapsed && !hovering;

  const handleFolderLayout = useCallback((layout: Record<string, number>) => {
    const firstValue = Object.values(layout)[0];
    if (firstValue !== undefined) {
      updateSize("folderNavSize", firstValue);
    }
  }, [updateSize]);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  function handleToggleTheme() {
    toggleTheme();
    setIsDark(!isDark);
  }

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  const content = (
    <aside
      data-ref="sidebar"
      className={cn(
        "flex h-full flex-col bg-sidebar text-sidebar-foreground",
        collapsed && "w-14 border-r",
        expandedOnHover &&
          "absolute inset-y-0 left-0 z-50 w-64 border-r shadow-xl"
      )}
    >
      {/* Miel : la barre du haut est retiree, le logo passe en tete du menu
          (centre sur l'axe des boutons de 44 px en menu replie). */}
      {isMiel && (
        <div data-ref="sidebar-logo-wrap" className="shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- logo d'origine (DEC-580), image statique */}
          <img src="/icons/imiel-logo-120.png" alt="iMiel" data-ref="sidebar-logo" />
        </div>
      )}
      <div className={cn("p-2", collapsed && "px-1.5")} data-ref="sidebar-header">
        <AccountSwitcher collapsed={collapsed} />
      </div>

      <div className={cn("py-2", collapsed ? "px-1.5" : "px-2")} data-ref="sidebar-compose-wrap">
        <Button
          onClick={() => openCompose("new")}
          className={cn(collapsed ? "w-full px-0" : "w-full")}
          size={collapsed ? "icon" : "default"}
          data-ref="sidebar-compose-btn"
        >
          <Pencil className="size-4 shrink-0" />
          {!collapsed && <span>{t("newMessage")}</span>}
        </Button>
      </div>

      <Separator />

      {collapsed || isMiel ? (
        <div data-ref="sidebar-nav-scroll" className="min-h-0 flex-1 overflow-y-auto py-2">
          <FolderNav collapsed={collapsed} />
        </div>
      ) : (
        <ResizablePanelGroup
          orientation="vertical"
          className="flex-1 overflow-hidden"
          onLayoutChanged={handleFolderLayout}
        >
          <ResizablePanel
            defaultSize={`${sizes.folderNavSize}%`}
            minSize="25%"
          >
            <div className="h-full overflow-y-auto py-2">
              <FolderNav collapsed={false} />
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel
            defaultSize={`${100 - sizes.folderNavSize}%`}
            minSize="15%"
          >
            <LabelsNav />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      <Separator />
      <div className={cn("p-2 space-y-1", collapsed && "px-1.5")} data-ref="sidebar-footer">
        {/* Miel : la cloche de la barre du haut (retiree) descend ici. */}
        {isMiel && <SidebarActivityButton collapsed={collapsed} />}
        <Button
          variant="ghost"
          size={collapsed ? "icon" : "sm"}
          className={cn(
            collapsed ? "w-full" : "w-full justify-start gap-2"
          )}
          onClick={toggleSidebar}
          data-ref="sidebar-toggle-btn"
        >
          {collapsed ? <PanelLeftOpen className="size-4 shrink-0" /> : <PanelLeftClose className="size-4 shrink-0" />}
          {!collapsed && <span className="text-sm">{t("collapseMenu")}</span>}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size={collapsed ? "icon" : "sm"}
              className={cn(
                collapsed ? "w-full" : "w-full justify-start gap-2"
              )}
              data-ref="sidebar-footer-menu"
            >
              <MoreHorizontal className="size-4 shrink-0" />
              {!collapsed && <span className="text-sm">{t("more")}</span>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-52">
            <DropdownMenuItem onClick={handleToggleTheme}>
              {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              {isDark ? t("lightMode") : t("darkMode")}
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Bell className="size-4" />
              {t("notifications")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => hashNavigate("/settings")}>
              <Settings className="size-4" />
              {t("settings")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>
              <LogOut className="size-4" />
              {t("logout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );

  // En mode replie : un rail w-14 sert d'ancre positionnee ; le panneau se
  // deploie en overlay (absolute) au survol sans pousser le contenu. En mode
  // deploye classique (toggle), on rend directement l'aside dans son panneau.
  if (sidebarCollapsed) {
    return (
      <div
        className="relative h-full w-14 shrink-0"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        data-ref="sidebar-hover-zone"
      >
        {content}
      </div>
    );
  }

  return content;
}
