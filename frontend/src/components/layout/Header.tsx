"use client";

import { useIaDisponible } from "@/lib/ai-settings";
import { ArrowLeft, Bot, Menu, PenSquare, Settings } from "lucide-react";
import { HashLink, useHashRouter } from "@/lib/hash-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RemoveScroll } from "react-remove-scroll";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import { SearchField } from "@/components/ui/kit";
import { AccountSwitcher } from "@/components/layout/AccountSwitcher";
import { FolderNav } from "@/components/layout/FolderNav";
import { ActivityBell } from "@/components/layout/ActivityBell";
import { useMailStore } from "@/lib/stores/mail-store";
import { usePageTitleStore } from "@/lib/stores/page-title";
import { useT } from "@/lib/i18n";
import { useIsMiel } from "@/lib/hooks/useSettings";
import { cn } from "@/lib/utils";

// Titre par defaut de chaque route (les pages mail posent leur propre titre :
// nom du dossier ou de l'etiquette, via usePageTitle).
const ROUTE_TITLE_KEYS: Record<string, string> = {
  intro: "intro.title",
  dashboard: "dashboard.title",
  contacts: "contacts",
  calendar: "calendar",
  newsletters: "newsletters.title",
  "newsletter-stats": "newsletters.stats",
  suivi: "tracking.title",
  activity: "activity.title",
  settings: "settings",
  accounts: "settings",
  "account-edit": "settings",
  mail: "folder.allMail",
  label: "labels",
  thread: "folder.allMail",
};

/**
 * Barre du haut UNIQUE de l'application (charte des maquettes) :
 * menu (telephone) — ou fleche de retour sur un ecran de second niveau
 * (usePageBack) —, titre de l'ecran - ou champ de recherche sur la vue
 * d'ensemble -, cloche des notifications, assistant et, sur ordinateur, le
 * bouton noir "Ecrire". Sur telephone, le menu monte du BAS (tiroir) et
 * "Rediger" est le rond central de la barre du pied (MobileFooterBar, vue
 * d'ensemble + listes de mails) ; les boutons propres a chaque page vivent
 * dans cette meme barre. Sur ordinateur, le titre passe a gauche et la
 * recherche reste au centre.
 */
export function Header() {
  const t = useT();
  const iaDispo = useIaDisponible();
  const { route } = useHashRouter();
  const openSearch = useMailStore((s) => s.openSearch);
  const openCompose = useMailStore((s) => s.openCompose);
  const toggleAiChat = useMailStore((s) => s.toggleAiChat);
  const aiChatOpen = useMailStore((s) => s.aiChatOpen);
  const pageTitle = usePageTitleStore((s) => s.title);
  const pageCount = usePageTitleStore((s) => s.count);
  const listChrome = usePageTitleStore((s) => s.listChrome);
  const pageBack = usePageTitleStore((s) => s.back);
  // Miel : la barre du haut est rendue PLEINE LARGEUR par AuthenticatedLayout
  // (ordinateur) avec le logo a gauche ; le titre des pages de mails passe en
  // tete du bloc de la liste (listChrome), les autres pages le gardent ici.
  const isMiel = useIsMiel();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isIntro = route === "intro";
  const title = pageTitle ?? t(ROUTE_TITLE_KEYS[route] ?? "intro.title");

  return (
    <header
      data-ref="header"
      className="relative flex h-11 shrink-0 items-center gap-0.5 bg-background px-2 md:h-14 md:gap-2 md:border-b md:px-4"
    >
      {/* Telephone : menu, ou fleche de retour sur un ecran de second niveau
          (entete UNIQUE : la page ne pose plus sa propre bande de retour). */}
      {pageBack ? (
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={pageBack}
          data-ref="header-back"
          aria-label={t("back")}
        >
          <ArrowLeft className="size-5" strokeWidth={1.8} />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={() => setMobileMenuOpen(true)}
          data-ref="header-mobile-menu"
          aria-label={t("menu")}
        >
          <Menu className="size-5" strokeWidth={1.8} />
        </Button>
      )}

      {/* Telephone : recherche sur la vue d'ensemble, titre ailleurs */}
      {isIntro ? (
        <SearchField
          onActivate={openSearch}
          placeholder={t("search")}
          className="mx-1 h-9 flex-1 px-3.5 md:hidden"
          data-ref="header-search-mobile"
        />
      ) : (
        // Titre centre sur l'ECRAN (pas dans l'espace restant) : pose en absolu
        // avec la meme marge des deux cotes (inset-x-24 = 96px, plus large que la
        // grappe de droite cloche + assistant), il se raccourcit avant les boutons.
        <h1
          data-ref="header-title"
          className="pointer-events-none absolute inset-x-24 top-1/2 -translate-y-1/2 truncate text-center text-base font-semibold md:hidden"
        >
          {title}
        </h1>
      )}

      {/* Telephone : le titre est en absolu, cet espaceur garde cloche et
          assistant collés au bord droit */}
      {!isIntro && <div className="flex-1 md:hidden" aria-hidden />}

      {/* Ordinateur : titre a gauche (avec le compteur de la liste a cote, en
          gris ; le titre se raccourcit avant lui), recherche au centre. */}
      {isMiel && (
        // eslint-disable-next-line @next/next/no-img-element -- logo d'origine (DEC-580), image statique
        <img
          src="/icons/imiel-logo-120.png"
          alt="iMiel"
          data-ref="header-logo"
          className="hidden md:block"
        />
      )}
      {!(isMiel && listChrome) && (
        <div className="hidden w-72 min-w-0 shrink items-baseline gap-2 md:flex">
          <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
          {pageCount && (
            <span data-ref="mail-folder-count" className="shrink-0 text-sm text-muted-foreground">
              {pageCount}
            </span>
          )}
        </div>
      )}
      {isMiel && <div className="hidden flex-1 md:block" aria-hidden />}
      <div data-ref="header-search-slot" className="hidden min-w-0 flex-1 justify-center md:flex">
        <SearchField
          onActivate={openSearch}
          placeholder={t("search")}
          className="h-9 max-w-xl"
          data-ref="header-search"
        />
      </div>

      {/* Centre de notifications / activite */}
      <ActivityBell />

      {/* Assistant IA (masque dans la version pour tous tant qu'aucune cle) */}
      {iaDispo && (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn("md:size-9", aiChatOpen && "bg-accent")}
            onClick={toggleAiChat}
            data-ref="header-ai-chat"
            aria-label={t("aiChat.open")}
          >
            <Bot className="size-5" strokeWidth={1.7} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("aiChat.open")}</TooltipContent>
      </Tooltip>
      )}

      {/* Ecrire : bouton noir carre-arrondi (ordinateur ; sur telephone c'est
          la pilule flottante du bas) */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => openCompose("new")}
            data-ref="header-compose"
            aria-label={t("newMessage")}
            className="ml-1 hidden size-9 shrink-0 items-center justify-center rounded-xl bg-primary md:inline-flex text-primary-foreground transition-opacity active:opacity-80"
          >
            <PenSquare className="size-4" strokeWidth={1.8} />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t("newMessage")}</TooltipContent>
      </Tooltip>

      {/* Menu du telephone : tiroir qui MONTE DU BAS (choix utilisateur,
          carte « Finitions Miel sur mobile »). En-tete commun (poignee seule a
          glisser), liste des dossiers qui defile au doigt, et pied colle :
          « Nouveau message » + Parametres. */}
      <Drawer
        open={mobileMenuOpen}
        onOpenChange={setMobileMenuOpen}
        handleOnly
        repositionInputs={false}
        noBodyStyles
      >
        <DrawerContent
          hideGrip
          data-ref="header-mobile-sheet"
          className="drawer-scroll-native sheet-max-h flex flex-col overflow-hidden md:hidden"
        >
          <DrawerSheetHeader title={t("menu")} srOnlyTitle handleDataRef="header-mobile-sheet-handle" />
          <RemoveScroll removeScrollBar={false} allowPinchZoom className="flex min-h-0 flex-1 flex-col">
            <div className="px-3 pt-1 pb-2">
              <AccountSwitcher />
            </div>
            <div data-ref="header-mobile-nav" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
              <FolderNav onNavigate={() => setMobileMenuOpen(false)} />
            </div>
            <div
              data-ref="header-mobile-actions"
              className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            >
              <Button
                data-ref="header-mobile-compose"
                onClick={() => {
                  openCompose("new");
                  setMobileMenuOpen(false);
                }}
                className="h-11 flex-1 rounded-full text-[0.9375rem]"
              >
                <PenSquare className="size-4" />
                {t("newMessage")}
              </Button>
              <HashLink
                href="/settings"
                data-ref="header-mobile-settings"
                onClick={() => setMobileMenuOpen(false)}
                aria-label={t("settings")}
                title={t("settings")}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-colors active:bg-accent"
              >
                <Settings className="size-5" strokeWidth={1.8} />
              </HashLink>
            </div>
          </RemoveScroll>
        </DrawerContent>
      </Drawer>
    </header>
  );
}
