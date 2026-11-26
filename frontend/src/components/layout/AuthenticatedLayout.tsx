"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { StatusBar } from "@/components/layout/StatusBar";
import { useKeyboardShortcuts } from "@/lib/hooks/useKeyboardShortcuts";
import { useSync } from "@/lib/hooks/useSync";
import { useIsMiel, useSettings } from "@/lib/hooks/useSettings";
import { useActiveAccount } from "@/lib/hooks/useActiveAccount";
import { useMailListPreload } from "@/lib/hooks/useMailListPreload";
import { initWsChannel } from "@/lib/ws-channel";
import { isAuthenticated, refreshAuth } from "@/lib/pocketbase";
import { bootMark, bootTime } from "@/lib/boot-perf";
import { ComposeDialog } from "@/components/mail/ComposeDialog";
import { ImageLightbox } from "@/components/mail/ImageLightbox";
import { AiChatPanel } from "@/components/ai/AiChatPanel";
import { MielAiFab } from "@/components/layout/MielAiFab";
import { SearchCommand } from "@/components/mail/SearchCommand";
import { FilterRuleDialog } from "@/components/mail/FilterRuleDialog";
import { SpamScanProgress } from "@/components/mail/SpamScanProgress";
import { CalendarSuggestionsDrawer } from "@/components/mail/CalendarSuggestionsDrawer";
import { LinkViewerDrawer } from "@/components/layout/LinkViewerDrawer";
import { TrackingChoicePanel } from "@/components/mail/TrackingChoicePanel";
import { PushPromptDialog } from "@/components/layout/PushPromptDialog";
import { VersionWatcher } from "@/components/layout/VersionWatcher";
import { TitleTooltips } from "@/components/ui/title-tooltips";
import { AccountErrorBanner } from "@/components/layout/AccountErrorBanner";
import { DesktopDownloadBanner } from "@/components/layout/DesktopDownloadBanner";
import { TrackingUpdatesBanner } from "@/components/layout/TrackingUpdatesBanner";
import { DesktopUpdateBanner } from "@/components/layout/DesktopUpdateBanner";
import { CloudHost } from "@/components/cloud/CloudHost";
import { CollapsibleTop } from "@/components/ui/collapsible-top";
import { useListChromeAutoHide } from "@/lib/hooks/useListChromeAutoHide";
import { useHashRouter } from "@/lib/hash-router";
import { useActivityUnread } from "@/lib/hooks/useActivity";
import { useMailStore } from "@/lib/stores/mail-store";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { usePanelSizes } from "@/lib/hooks/usePanelSizes";

const AUTH_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // Si on a deja un token valide en localStorage, on demarre directement en
  // "authenticated" et le refresh tourne en background. Sans ca, on cachait
  // toute l'UI derriere un spinner pendant ~500ms (le temps du refresh) avant
  // meme que les composants ne se montent pour lancer leurs fetchs.
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "redirecting">(
    () => (typeof window !== "undefined" && isAuthenticated() ? "authenticated" : "checking")
  );

  useKeyboardShortcuts();
  useSync();
  useSettings();
  useActiveAccount();
  useMailListPreload();
  useActivityUnread();

  // WebSocket channel for cross-tab real-time sync
  useEffect(() => {
    const cleanup = initWsChannel();
    return cleanup;
  }, []);

  // Application iPhone : cle d'appareil des widgets rangee dans le trousseau
  // des la session ouverte (sans effet dans un navigateur).
  useEffect(() => {
    void import("@/lib/native-app").then((m) => {
      if (m.isNativeApp()) void m.ensureDeviceKey();
    });
  }, []);

  const sidebarCollapsed = useMailStore((s) => s.sidebarCollapsed);
  const isMiel = useIsMiel();
  const { sizes, updateSize } = usePanelSizes();

  // Mobile vs desktop pilote par JS : evite de monter {children} deux fois
  // (un id="account-form" cache + un visible cassait la soumission du formulaire)
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  // Telephone : le haut des listes (bandeaux, recherche, filtres) se replie au
  // defilement. Ecouteur unique pose sur le document (cf. CollapsibleTop).
  const { pathname } = useHashRouter();
  useListChromeAutoHide(!isDesktop, pathname);

  const handleSidebarLayout = useCallback((layout: Record<string, number>) => {
    const firstValue = Object.values(layout)[0];
    if (firstValue !== undefined) {
      updateSize("sidebarWidth", firstValue);
    }
  }, [updateSize]);

  // Verification auth initiale avec refresh du token. Le refresh tourne en
  // background ; l'UI est deja visible si on avait un token local valide.
  useEffect(() => {
    bootMark("layout-mount");
    async function checkAuth() {
      if (!isAuthenticated()) {
        bootMark("auth-missing-redirect");
        setAuthState("redirecting");
        router.replace("/login");
        return;
      }
      const refreshed = await bootTime("auth-refresh", () => refreshAuth());
      if (refreshed) {
        bootMark("auth-ok");
        setAuthState("authenticated");
      } else {
        // refreshAuth ne retourne false que sur 401/403 explicite : vraie deco.
        bootMark("auth-refresh-failed-redirect");
        setAuthState("redirecting");
        router.replace("/login");
      }
    }
    checkAuth();
  }, [router]);

  // Refresh periodique du token pour eviter l'expiration
  useEffect(() => {
    if (authState !== "authenticated") return;
    const interval = setInterval(async () => {
      const ok = await refreshAuth();
      // refreshAuth ne retourne false que sur 401/403 (vraie deco serveur).
      // Les erreurs reseau / timeouts sont absorbees et retentees au prochain
      // intervalle pour eviter les deconnexions intempestives.
      if (!ok) router.replace("/login");
    }, AUTH_REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [authState, router]);

  if (authState !== "authenticated") {
    return (
      <div data-ref="app-loading" className="flex h-dvh items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">
            {authState === "redirecting" ? "Redirection..." : "Chargement..."}
          </p>
        </div>
      </div>
    );
  }

  const mainContent = (
    <div data-ref="app-wrapper" className="flex flex-1 flex-col overflow-hidden">
      <Header />
      {/* Le bandeau des suivis se replie avec le haut de l'ecran qui defile,
          sans activer seul la mecanique (passive). */}
      <CollapsibleTop passive data-ref="tracking-updates-collapsible">
        <TrackingUpdatesBanner />
      </CollapsibleTop>
      <main data-ref="app-main" className="flex-1 overflow-y-auto">{children}</main>
      <StatusBar />
    </div>
  );

  // Apparence Miel sur ordinateur : une grande fenetre arrondie (fond illustre)
  // SANS barre du haut (carte « Finitions Miel : blocs, espace, lisibilite ») :
  // logo en tete du menu, cloche en pied de menu, recherche dans la barre
  // d'etat (pilule), assistant en rond flottant en bas a droite (MielAiFab).
  // Rendu conditionnel (jamais un deplacement du DOM) ; en Minimaliste le cadre
  // est en `display: contents` : la mise en page d'origine reste identique.
  const mielDesktop = isMiel && isDesktop;

  return (
    <div data-ref="app-root" className="flex h-dvh flex-col safe-area-top">
      {/* iMiel Cloud : ecran de compte, synchro, bandeau d'abonnement arrete. */}
      <CloudHost />
      <AccountErrorBanner />
      <DesktopDownloadBanner />
      <DesktopUpdateBanner />
      <div data-ref={mielDesktop ? "miel-frame" : undefined} className={mielDesktop ? undefined : "contents"}>
      <div data-ref="app-layout" className="flex min-h-0 flex-1">
      {!isDesktop ? (
        /* Mobile : pas de sidebar, juste le contenu. min-w-0 obligatoire :
           sans ca ce flex-item refuse de retrecir sous le min-content de son
           contenu (ex: lignes d'agenda en vue liste), deborde la largeur de
           l'ecran et body{overflow:hidden} coupe la partie droite (header,
           barre d'outils, bouton X des panneaux fixed pousse hors ecran). */
        <div className="flex min-w-0 flex-1 flex-col">
          {mainContent}
        </div>
      ) : sidebarCollapsed ? (
        /* Menu replie : meme garde-fou min-w-0/min-h-0 que la branche mobile.
           Sans lui, la colonne de contenu refuse de retrecir sous le
           min-content de la page (agenda semaine/mois, tableaux) et s'etire
           bien au-dela de l'ecran ; menu deplie, le panneau redimensionnable
           impose deja sa largeur, d'ou un defaut visible seulement replie. */
        <div className="flex min-h-0 min-w-0 flex-1">
          <Sidebar />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {!mielDesktop && <Header />}
            <TrackingUpdatesBanner />
            <main data-ref="app-main-desktop" className="flex-1 overflow-y-auto">{children}</main>
            <StatusBar />
          </div>
        </div>
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1"
          onLayoutChanged={handleSidebarLayout}
        >
          <ResizablePanel
            data-ref="sidebar-panel"
            defaultSize={`${sizes.sidebarWidth}%`}
            minSize="200px"
            maxSize="360px"
          >
            <Sidebar />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel data-ref="main-panel" defaultSize={`${100 - sizes.sidebarWidth}%`}>
            <div className="flex h-full flex-col">
              {!mielDesktop && <Header />}
              <TrackingUpdatesBanner />
              <main data-ref="app-main-desktop" className="flex-1 overflow-y-auto">{children}</main>
              <StatusBar />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      <AiChatPanel />
      {mielDesktop && <MielAiFab />}

      <ComposeDialog />
      <ImageLightbox />
      <SearchCommand />
      <FilterRuleDialog />
      <SpamScanProgress />
      <PushPromptDialog />
      <CalendarSuggestionsDrawer />
      {/* Liens de l'app installee : tiroir + ecouteur de clics global unique. */}
      <LinkViewerDrawer />
      <TrackingChoicePanel />
      <VersionWatcher />
      {/* Info-bulles noires de toute l'application (reprend chaque `title`). */}
      <TitleTooltips />
      </div>
      </div>
    </div>
  );
}
