"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { useHashRouter } from "@/lib/hash-router";
import { Settings, Mail, Bell, Ban, Filter, Folder, Tag, RefreshCw, Bot, CalendarDays, KeyRound, Monitor, LogOut, PenLine, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { logout } from "@/lib/pocketbase";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import GeneralSettings from "@/components/settings/GeneralSettings";
import NotificationSettings from "@/components/settings/NotificationSettings";
import BlockedSettings from "@/components/settings/BlockedSettings";
import FilterRulesSettings from "@/components/settings/FilterRulesSettings";
import FolderSettings from "@/components/settings/FolderSettings";
import LabelsSettings from "@/components/settings/LabelsSettings";
import SyncSettings from "@/components/settings/SyncSettings";
import CalendarSettings from "@/components/settings/CalendarSettings";
import AiSettings from "@/components/settings/AiSettings";
import DesktopSettings from "@/components/settings/DesktopSettings";
import SubscriptionSettings from "@/components/settings/SubscriptionSettings";
import { cloudDisponible } from "@/lib/cloud/config";
import SignatureSettings from "@/components/settings/SignatureSettings";
import ConnectivitySettings from "@/components/settings/ConnectivitySettings";
import AccountsPage from "@/app/(app)/settings/accounts/page";
import { BuildVersionTag } from "@/components/layout/BuildVersionTag";
import { useT } from "@/lib/i18n";

const NAV_ITEMS = [
  { value: "general", icon: Settings, labelKey: "settings.general" },
  { value: "accounts", icon: Mail, labelKey: "settings.emailAccounts" },
  { value: "signatures", icon: PenLine, labelKey: "settings.signatures" },
  { value: "folders", icon: Folder, labelKey: "settings.folders" },
  { value: "labels", icon: Tag, labelKey: "settings.labels" },
  { value: "notifications", icon: Bell, labelKey: "settings.notifications" },
  { value: "blocked", icon: Ban, labelKey: "settings.blockedSenders" },
  { value: "filters", icon: Filter, labelKey: "settings.filterRules" },
  { value: "sync", icon: RefreshCw, labelKey: "settings.sync" },
  { value: "calendar", icon: CalendarDays, labelKey: "settings.calendar" },
  { value: "ai", icon: Bot, labelKey: "settings.ai" },
  { value: "connectivity", icon: KeyRound, labelKey: "settings.connectivity" },
  { value: "desktop", icon: Monitor, labelKey: "settings.desktop" },
  { value: "abonnement", icon: CreditCard, labelKey: "settings.subscription" },
] as const;

// « Abonnement » : seulement dans les apps reliees a iMiel Cloud (ordinateur en
// mode Cloud, iPhone, app web).
const navItems = () => NAV_ITEMS.filter((i) => i.value !== "abonnement" || cloudDisponible());

export default function SettingsPage() {
  const t = useT();
  const router = useRouter();
  const { searchParams, replace } = useHashRouter();
  const activeTab = searchParams.get("tab") ?? "general";
  const actionsRef = useRef<HTMLDivElement>(null);

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  function handleNav(value: string) {
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", value);
    replace(`/settings?${p.toString()}`);
  }

  return (
    <div data-ref="settings-page" className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex h-12 shrink-0 items-center justify-center border-b px-12 md:px-6">
        <h1 data-ref="settings-title" className="text-xs font-medium text-muted-foreground">{t("settings")}</h1>
      </div>

      {/* Mobile tab selector (dropdown) */}
      <div className="shrink-0 border-b p-3 md:hidden">
        <Select value={activeTab} onValueChange={handleNav}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          {/* position=popper : le menu s'ouvre SOUS le trigger (au lieu de
              l'alignement sur l'item selectionne qui deborde en haut sous la
              status bar iOS). collisionPadding.top garde une marge safe-area. */}
          <SelectContent position="popper" collisionPadding={{ top: 8, bottom: 8 }}>
            {navItems().map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <span className="flex items-center gap-2">
                  <item.icon className="size-4 shrink-0" />
                  {t(item.labelKey)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar nav (desktop only) */}
        <nav data-ref="settings-nav" className="hidden shrink-0 flex-col border-r md:flex">
          <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-1.5 md:p-2">
            {navItems().map((item) => (
              <Tooltip key={item.value}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => handleNav(item.value)}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors md:px-3",
                      "hover:bg-accent hover:text-accent-foreground",
                      activeTab === item.value
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span className="hidden md:inline">{t(item.labelKey)}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="md:hidden">
                  {t(item.labelKey)}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          <button
            onClick={handleLogout}
            data-ref="settings-logout"
            className="flex items-center gap-2 border-t px-2.5 py-2.5 text-sm font-medium text-destructive transition-colors hover:bg-accent md:px-3"
          >
            <LogOut className="size-4 shrink-0" />
            <span className="hidden md:inline">{t("logout")}</span>
          </button>
          <BuildVersionTag />
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-4xl p-4 md:p-6">
            {activeTab === "general" && <GeneralSettings actionsContainer={actionsRef} />}
            {activeTab === "accounts" && <AccountsPage />}
            {activeTab === "signatures" && <SignatureSettings />}
            {activeTab === "folders" && <FolderSettings />}
            {activeTab === "labels" && <LabelsSettings />}
            {activeTab === "notifications" && <NotificationSettings />}
            {activeTab === "blocked" && <BlockedSettings />}
            {activeTab === "filters" && <FilterRulesSettings />}
            {activeTab === "sync" && <SyncSettings />}
            {activeTab === "calendar" && <CalendarSettings />}
            {activeTab === "ai" && <AiSettings />}
            {activeTab === "connectivity" && <ConnectivitySettings />}
            {activeTab === "desktop" && <DesktopSettings />}
            {activeTab === "abonnement" && <SubscriptionSettings />}
          </div>
        </div>
      </div>

      {/* Footer : la deconnexion n'apparait ici que sur mobile (la nav sidebar
          qui la porte est masquee < md) ; le bouton Sauvegarder y est porte
          via portal par GeneralSettings. */}
      <div ref={actionsRef} className="flex items-center justify-between gap-2 border-t bg-background px-4 py-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLogout}
          className="text-destructive hover:text-destructive md:hidden"
          data-ref="settings-logout-mobile"
        >
          <LogOut className="size-4" />
          {t("logout")}
        </Button>
      </div>
    </div>
  );
}
