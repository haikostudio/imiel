"use client";

import { useEffect, useRef, useState } from "react";
import { useHashRouter, hashReplace, hashNavigate, HashOverrideProvider } from "@/lib/hash-router";
import MailFolderPage from "@/app/(app)/mail/[folder]/page";
import ThreadPage from "@/app/(app)/mail/thread/[id]/page";
import SettingsPage from "@/app/(app)/settings/page";
import EditAccountPage from "@/app/(app)/settings/accounts/[id]/page";
import IntroPage from "@/app/(app)/intro/page";
import DashboardPage from "@/app/(app)/dashboard/page";
import ContactsPage from "@/app/(app)/contacts/page";
import CalendarPage from "@/app/(app)/calendar/page";
import NewslettersPage from "@/app/(app)/newsletters/page";
import NewsletterStatsPage from "@/components/newsletters/NewsletterStatsPage";
import SuiviPage from "@/app/(app)/suivi/page";
import { ActivityRouteDrawer } from "@/components/layout/ActivityRouteDrawer";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";

const SETTINGS_ROUTES = new Set(["settings", "accounts", "account-edit"]);
const DEFAULT_BACKGROUND_HASH = "#/intro";

function renderForRoute(route: string) {
  switch (route) {
    case "mail":
    case "label":
      return <MailFolderPage />;
    case "thread":
      return <ThreadPage />;
    case "intro":
      return <IntroPage />;
    case "dashboard":
      return <DashboardPage />;
    case "contacts":
      return <ContactsPage />;
    case "calendar":
      return <CalendarPage />;
    case "newsletters":
      return <NewslettersPage />;
    case "newsletter-stats":
      return <NewsletterStatsPage />;
    case "suivi":
      return <SuiviPage />;
    case "settings":
    case "accounts":
      return <SettingsPage />;
    case "account-edit":
      return <EditAccountPage />;
    default:
      return <MailFolderPage />;
  }
}

export function HashRouter() {
  const t = useT();
  const { route, pathname, searchParams } = useHashRouter();
  const isSettings = SETTINGS_ROUTES.has(route);
  // L'activite est un TIROIR modal-as-route (pas une page) : elle gele aussi le
  // fond, comme les Reglages.
  const isActivity = route === "activity";
  const isOverlay = isSettings || isActivity;
  // Cle stable pour les query params : sans ca, naviguer de
  // `#/mail/inbox` vers `#/mail/inbox?q=...` (meme pathname) ne declenche
  // pas le rafraichissement de backgroundHash, donc la page enfant lit le
  // hash gele d'avant la recherche et ignore `?q=`.
  const searchKey = searchParams.toString();

  // Redirect empty hash or root to inbox
  useEffect(() => {
    if (!pathname || pathname === "/") {
      hashReplace("/intro");
    }
  }, [pathname]);

  // Freeze the underlying hash when the settings modal is active, so the
  // background page keeps its state (folder, scroll, etc.) while routes
  // like #/settings or #/settings/accounts/:id remain in the URL.
  const [backgroundHash, setBackgroundHash] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_BACKGROUND_HASH;
    return isOverlay ? DEFAULT_BACKGROUND_HASH : window.location.hash || DEFAULT_BACKGROUND_HASH;
  });
  const liveHashRef = useRef<string>(DEFAULT_BACKGROUND_HASH);

  useEffect(() => {
    if (typeof window === "undefined") return;
    liveHashRef.current = window.location.hash || DEFAULT_BACKGROUND_HASH;
    if (!isOverlay) setBackgroundHash(liveHashRef.current);
  }, [pathname, searchKey, isOverlay]);

  // Background route (frozen while settings is open)
  // We derive it from the (potentially frozen) hash via the override context.
  const backgroundRouteName = (() => {
    const raw = backgroundHash.startsWith("#") ? backgroundHash.slice(1) : backgroundHash;
    const qIndex = raw.indexOf("?");
    const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
    if (path.startsWith("/mail/thread/")) return "thread";
    if (path.startsWith("/mail/label/")) return "label";
    if (path.startsWith("/mail/")) return "mail";
    if (path === "/intro") return "intro";
    if (path === "/dashboard") return "dashboard";
    if (path === "/contacts") return "contacts";
    if (path === "/calendar") return "calendar";
    if (path === "/newsletters") return "newsletters";
    if (path === "/newsletters/stats") return "newsletter-stats";
    if (path === "/suivi") return "suivi";
    return "mail";
  })();

  // Restore the frozen background hash so the URL matches the visible page.
  const restoreBackground = () => {
    const target = backgroundHash || DEFAULT_BACKGROUND_HASH;
    const targetPath = target.startsWith("#") ? target.slice(1) : target;
    hashNavigate(targetPath || "/mail/all");
  };

  const handleSettingsClose = (open: boolean) => {
    if (open) return;
    restoreBackground();
  };

  const handleActivityClose = (open: boolean) => {
    if (open) return;
    restoreBackground();
  };

  return (
    <>
      <HashOverrideProvider hash={backgroundHash}>
        {renderForRoute(backgroundRouteName)}
      </HashOverrideProvider>

      <Dialog open={isSettings} onOpenChange={handleSettingsClose}>
        <DialogContent
          className="fullscreen-mobile !w-screen !max-w-none !h-full !max-h-full !top-0 !left-0 !translate-x-0 !translate-y-0 !rounded-none !border-0 p-0 overflow-hidden gap-0 flex flex-col pt-[var(--app-top)] [&>[data-slot=dialog-close]]:right-2.5 [&>[data-slot=dialog-close]]:rounded-md [&>[data-slot=dialog-close]]:p-1.5 [&>[data-slot=dialog-close]]:opacity-100 [&>[data-slot=dialog-close]]:text-muted-foreground [&>[data-slot=dialog-close]]:hover:bg-accent [&>[data-slot=dialog-close]]:top-[calc(var(--app-top)+0.625rem)] sm:!max-w-[90vw] sm:!w-[90vw] sm:!h-[90vh] sm:!max-h-[90vh] sm:!top-1/2 sm:!left-1/2 sm:!-translate-x-1/2 sm:!-translate-y-1/2 sm:!rounded-lg sm:!border sm:!pt-0 sm:[&>[data-slot=dialog-close]]:top-2.5"
        >
          <DialogTitle className="sr-only">{t("settings")}</DialogTitle>
          <div className="flex min-h-0 flex-1 flex-col">
            {route === "account-edit" ? <EditAccountPage /> : <SettingsPage />}
          </div>
        </DialogContent>
      </Dialog>

      <ActivityRouteDrawer open={isActivity} onOpenChange={handleActivityClose} />
    </>
  );
}
