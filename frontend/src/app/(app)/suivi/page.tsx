"use client";

import { useIsMiel } from "@/lib/hooks/useSettings";
import { useEffect, useMemo, useState } from "react";
import { hashBack, hashSetParams, useHashRouter, useHashSelection } from "@/lib/hash-router";
import { useT } from "@/lib/i18n";
import { useTracking } from "@/lib/hooks/useTracking";
import { TrackingDetail, type TrackingView } from "@/components/suivi/TrackingDetail";
import {
  Chip,
  ChipIconButton,
  ChipRow,
  EmptyState,
  EntityAvatar,
  SearchField,
  TagPill,
  UnreadDot,
} from "@/components/ui/kit";
import { SwipeableTrackingRow } from "@/components/suivi/SwipeableTrackingRow";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Drawer, DrawerContent, DrawerHandle, DrawerSheetHeader, DrawerTitle } from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import { CollapsibleTop } from "@/components/ui/collapsible-top";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/utils/date";
import { CalendarClock, CheckCircle2, PackageSearch, RefreshCw, RotateCcw, SlidersHorizontal, Sparkles, Trash2, type LucideIcon } from "lucide-react";
import { MobileFooterBar, MobileFooterButton } from "@/components/layout/MobileFooterBar";
import type { TrackingItem } from "@/lib/pocketbase";
import { useSuggestionsDrawer } from "@/lib/hooks/useCalendarSuggestions";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [query]);
  return matches;
}

type FilterKey = "open" | "done";

// Deux statuts seulement : ouvert vs cloture (done/cancelled = cloture).
const isClosedItem = (it: TrackingItem) =>
  it.status === "done" || it.status === "cancelled";

// Sous-ecran de la fiche ouverte (`?fv=details|timeline`), EMPILE dans
// l'historique : "precedent" revient a l'ecran d'avant, le rechargement
// retombe sur le meme ecran. Fermer depile quand c'est nous qui avons empile.
let subViewPushes = 0;
function openSubView(view: Exclude<TrackingView, "mails">) {
  subViewPushes += 1;
  hashSetParams({ fv: view });
}
function closeSubView() {
  if (subViewPushes > 0) {
    subViewPushes -= 1;
    hashBack();
    return;
  }
  hashSetParams({ fv: null }, { replace: true });
}

/** Etat de la ligne : emoji eventuel du libelle mis a part. */
function splitEmoji(label: string): { emoji: string; text: string } {
  const m = label.match(/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*(.*)$/u);
  return m ? { emoji: m[1], text: m[2] } : { emoji: "", text: label };
}

function TrackingRow({
  item,
  statusLine,
  selected,
  onSelect,
  isClosed,
  onToggleStatus,
  onArchive,
  toCloseLabel,
}: {
  item: TrackingItem;
  statusLine?: string;
  selected: boolean;
  onSelect: () => void;
  isClosed: boolean;
  onToggleStatus: () => void;
  onArchive: () => void;
  toCloseLabel: string;
}) {
  // Dernier statut connu : label de l'evenement du dernier message, sinon le
  // status_label de synthese de la fiche.
  const status = statusLine || item.status_label;
  const { emoji, text } = splitEmoji(status || "");
  const label = item.merchant || item.sender_domain || item.title;
  const correspondent =
    item.merchant && !(item.title || "").toLowerCase().includes(item.merchant.toLowerCase())
      ? item.merchant
      : item.merchant || item.sender_domain;
  return (
    <SwipeableTrackingRow
      isClosed={isClosed}
      onSwipeToggleStatus={onToggleStatus}
      onSwipeArchive={onArchive}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "relative flex w-full cursor-pointer items-start gap-3.5 px-[10px] py-3.5 text-left transition-colors hover:bg-accent/60 md:px-4",
        "row-divider",
        selected && "bg-accent"
      )}
    >
      {/* Un dossier de suivi est TOUJOURS un carre arrondi. */}
      <EntityAvatar name={label} domain={item.sender_domain} shape="folder" size="lg" className="bg-muted" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[0.9375rem]", item.is_read ? "font-medium" : "font-semibold")}>
            {item.title}
          </span>
          <time className="shrink-0 text-xs text-muted-foreground">
            {item.last_message_date ? formatRelativeDate(item.last_message_date) : ""}
          </time>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground/85">
            {emoji && <span className="mr-1.5">{emoji}</span>}
            {text}
          </span>
          {!item.is_read && <UnreadDot />}
        </div>
        <div className="flex min-w-0 items-end gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {item.type && <span className="capitalize">{item.type}</span>}
            {item.type && correspondent && <span className="mx-1.5 opacity-60">&middot;</span>}
            {correspondent}
          </span>
          {item.closure_suggested && !isClosed && <TagPill>{toCloseLabel}</TagPill>}
        </div>
      </div>
    </SwipeableTrackingRow>
  );
}

export default function SuiviPage() {
  const t = useT();
  const isMobile = useMediaQuery("(max-width: 767px)");
  // Miel ordinateur : le texte d'aide nomme la page (« Rechercher dans les suivis »).
  const mielDesktop = useIsMiel() && !isMobile;
  const {
    items,
    statusLines,
    loading,
    hasMore,
    loadMore,
    markRead,
    setStatus,
    archive,
    remove,
    refresh,
    purge,
    rebuildEstimate,
    rebuildAll,
    rebuildOne,
    reprocessEstimate,
    reprocessRecent,
    rebuilding,
    rebuildProgress,
  } = useTracking();

  const openAndAnalyze = useSuggestionsDrawer((s) => s.openAndAnalyze);

  // La fiche ouverte vit dans l'ADRESSE (`#/suivi?f=<fiche>`) : recharger la
  // page ou revenir en arriere retombe sur la meme fiche.
  const { value: selectedId, open: openFiche, close: closeFiche } = useHashSelection("f");
  const setSelectedId = (id: string | null) => (id ? openFiche(id) : closeFiche());
  const [filter, setFilter] = useState<FilterKey>("open");
  const [query, setQuery] = useState("");
  // Sous-ecran de la fiche ouverte : mails (defaut), details, chronologie.
  const { searchParams } = useHashRouter();
  const fvParam = searchParams.get("fv");
  const view: TrackingView = fvParam === "details" || fvParam === "timeline" ? fvParam : "mails";
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuildCount, setRebuildCount] = useState<number | null>(null);
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const [reprocessCount, setReprocessCount] = useState<number | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);

  async function openRebuildAll() {
    setRebuildCount(null);
    setRebuildOpen(true);
    const n = await rebuildEstimate();
    setRebuildCount(n);
  }

  async function openReprocessRecent() {
    setReprocessCount(null);
    setReprocessOpen(true);
    const n = await reprocessEstimate(30);
    setReprocessCount(n);
  }

  // Reconstruit UNE fiche puis rafraichit la liste (event_count / champs a jour).
  async function handleRebuildOne(id: string): Promise<number> {
    const n = await rebuildOne(id);
    refresh();
    return n;
  }

  const openCount = useMemo(() => items.filter((it) => !isClosedItem(it)).length, [items]);
  const filtered = useMemo(() => {
    const byStatus =
      filter === "done" ? items.filter(isClosedItem) : items.filter((it) => !isClosedItem(it));
    const q = query.trim().toLowerCase();
    if (!q) return byStatus;
    return byStatus.filter((it) =>
      [it.title, it.merchant, it.sender_domain, it.type, it.status_label, statusLines[it.id]]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [items, filter, query, statusLines]);

  const selected = useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId]
  );

  // Une fiche ouverte passe en vu QUEL QUE SOIT le chemin (liste, lien direct,
  // notification) : on suit la selection, pas le clic. Ses mails gardent leur
  // etat. `is_read` patche localement par markRead -> l'effet ne reboucle pas.
  useEffect(() => {
    if (selected && !selected.is_read) void markRead(selected.id);
  }, [selected, markRead]);

  function handleSelect(item: TrackingItem) {
    openFiche(item.id);
  }

  const filterTabs: { key: FilterKey; label: string }[] = [
    { key: "open", label: t("tracking.filterOpen") },
    { key: "done", label: t("tracking.filterDone") },
  ];

  // Actions de l'en-tete factorisees : rendues soit en DropdownMenu ancre
  // (desktop), soit en bottom sheet Drawer (mobile, "..."), pas de duplication.
  const headerActions: {
    key: string;
    Icon: LucideIcon;
    label: string;
    onSelect: () => void;
    disabled?: boolean;
    destructive?: boolean;
    spin?: boolean;
  }[] = [
    { key: "dates", Icon: CalendarClock, label: t("suggestions.detect"), onSelect: () => openAndAnalyze() },
    { key: "refresh", Icon: RefreshCw, label: t("tracking.refresh"), onSelect: refresh },
    {
      key: "reprocess",
      Icon: Sparkles,
      label: t("tracking.reprocessRecent"),
      onSelect: openReprocessRecent,
      disabled: rebuilding,
      spin: rebuilding,
    },
    {
      key: "rebuild",
      Icon: RotateCcw,
      label: t("tracking.rebuildAll"),
      onSelect: openRebuildAll,
      disabled: rebuilding,
      spin: rebuilding,
    },
    {
      key: "purge",
      Icon: Trash2,
      label: t("tracking.purge"),
      onSelect: () => setPurgeOpen(true),
      destructive: true,
    },
  ];

  const listPanel = (
    <div data-ref="tracking-list-panel" className="flex h-full flex-col bg-background">
      {/* Telephone : recherche, onglets et progression se replient quand on
          descend dans la liste, et reviennent des qu'on remonte. */}
      <CollapsibleTop forceVisible={actionsOpen} data-ref="tracking-list-top">
      {/* Recherche dans les suivis (le titre vit dans la barre du haut) */}
      <div className="px-[10px] pt-1 pb-3 md:px-4 md:pt-4">
        <SearchField
          value={query}
          onValueChange={setQuery}
          placeholder={mielDesktop ? t("searchIn.tracking") : t("tracking.searchPlaceholder")}
          data-ref="tracking-search"
        />
      </div>

      {/* Onglets Ouverts / Clotures + reglages (actions du suivi). Telephone :
          dans la barre du pied (MobileFooterBar), plus sous l'entete. */}
      {!isMobile && (
      <div className="flex items-center gap-2 px-[10px] pb-2.5 md:px-4">
        <ChipRow className="min-w-0 flex-1">
          {filterTabs.map((tab) => (
            <Chip
              key={tab.key}
              active={filter === tab.key}
              count={tab.key === "open" ? openCount : null}
              onClick={() => setFilter(tab.key)}
              data-ref={`tracking-tab-${tab.key}`}
            >
              {tab.label}
            </Chip>
          ))}
        </ChipRow>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ChipIconButton aria-label={t("tracking.actions")} title={t("tracking.actions")} marked={rebuilding}>
                <SlidersHorizontal />
              </ChipIconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {headerActions.map((action) => (
                <DropdownMenuItem
                  key={action.key}
                  disabled={action.disabled}
                  onClick={action.onSelect}
                  className={cn(action.destructive && "text-destructive focus:text-destructive")}
                >
                  <action.Icon className={cn("mr-2 size-4", action.spin && "animate-spin")} />
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
      </div>
      )}

      {/* Progression de la reconstruction de masse */}
      {rebuilding && (
        <div className="mx-[10px] mb-2 rounded-xl bg-muted md:mx-4 px-3 py-2 text-xs text-muted-foreground">
          {t("tracking.rebuildProgress", {
            done: String(rebuildProgress?.done ?? 0),
            total: String(rebuildProgress?.total ?? 0),
          })}
        </div>
      )}
      </CollapsibleTop>

      {/* Liste (tirer-pour-rafraichir sur mobile) */}
      <PullToRefresh onRefresh={refresh} dataRef="tracking-list-scroll">
        {filtered.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title={loading ? t("loading") : query.trim() ? t("search.noResults") : t("tracking.empty")}
            className="py-16"
          />
        ) : (
          <>
            {filtered.map((item) => {
              const closed = isClosedItem(item);
              return (
                <TrackingRow
                  key={item.id}
                  item={item}
                  statusLine={statusLines[item.id]}
                  selected={selectedId === item.id && !isMobile}
                  onSelect={() => handleSelect(item)}
                  isClosed={closed}
                  onToggleStatus={() =>
                    setStatus(
                      item,
                      closed ? "active" : "done",
                      closed ? t("tracking.eventReopened") : t("tracking.eventClosed")
                    )
                  }
                  onArchive={() => {
                    if (selectedId === item.id) setSelectedId(null);
                    void archive(item.id);
                  }}
                  toCloseLabel={t("tracking.toClose")}
                />
              );
            })}
            {hasMore && (
              <div className="p-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={loadMore}
                  disabled={loading}
                >
                  {t("tracking.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </PullToRefresh>

      {/* Mobile : "..." ouvre les actions en bottom sheet (vaul). Inerte sur
          desktop (le bouton qui l'ouvre n'existe qu'en mobile). */}
      <Drawer
        open={actionsOpen}
        onOpenChange={setActionsOpen}
        repositionInputs={false}
        noBodyStyles
      >
        <DrawerContent hideGrip className="sheet-max-h" data-ref="tracking-actions-sheet">
          <DrawerSheetHeader
            title={t("tracking.title")}
          />
          <div className="flex flex-col px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {headerActions.map((action) => (
              <button
                key={action.key}
                type="button"
                disabled={action.disabled}
                onClick={() => {
                  setActionsOpen(false);
                  action.onSelect();
                }}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-3 text-left text-sm transition-colors active:bg-muted disabled:pointer-events-none disabled:opacity-50",
                  action.destructive && "text-destructive active:bg-destructive/10"
                )}
              >
                <action.Icon className={cn("size-4", action.spin && "animate-spin")} />
                {action.label}
              </button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );

  const purgeDialog = (
    <AlertDialog open={purgeOpen} onOpenChange={setPurgeOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("tracking.purge")}</AlertDialogTitle>
          <AlertDialogDescription>{t("tracking.purgeConfirm")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setPurgeOpen(false);
              setSelectedId(null);
              void purge();
            }}
          >
            {t("tracking.purge")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const rebuildDialog = (
    <AlertDialog open={rebuildOpen} onOpenChange={setRebuildOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("tracking.rebuildAll")}</AlertDialogTitle>
          <AlertDialogDescription>
            {rebuildCount === null
              ? t("loading")
              : t("tracking.rebuildAllConfirm", { count: String(rebuildCount) })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={rebuildCount === null || rebuildCount === 0}
            onClick={() => {
              setRebuildOpen(false);
              void rebuildAll();
            }}
          >
            {t("tracking.rebuildRun")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const reprocessDialog = (
    <AlertDialog open={reprocessOpen} onOpenChange={setReprocessOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("tracking.reprocessRecent")}</AlertDialogTitle>
          <AlertDialogDescription>
            {reprocessCount === null
              ? t("loading")
              : t("tracking.reprocessConfirm", { count: String(reprocessCount) })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={reprocessCount === null || reprocessCount === 0}
            onClick={() => {
              setReprocessOpen(false);
              void reprocessRecent(30);
            }}
          >
            {t("tracking.reprocessRun")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  // Mobile : liste plein ecran + fiche detail en bottom sheet
  if (isMobile) {
    return (
      <div className="h-full">
        {listPanel}
        <MobileFooterBar>
          {filterTabs.map((tab) => (
            <MobileFooterButton
              key={tab.key}
              icon={tab.key === "open" ? PackageSearch : CheckCircle2}
              label={tab.key === "open" && openCount ? `${tab.label} ${openCount}` : tab.label}
              active={filter === tab.key}
              onClick={() => setFilter(tab.key)}
              data-ref={`tracking-tab-${tab.key}`}
            />
          ))}
          <MobileFooterButton
            icon={SlidersHorizontal}
            label={t("tracking.actionsShort")}
            aria-label={t("tracking.actions")}
            onClick={() => setActionsOpen(true)}
            data-ref="tracking-footer-actions"
          />
        </MobileFooterBar>
        <Drawer
          open={!!selected}
          onOpenChange={(open) => {
            if (!open) setSelectedId(null);
          }}
          repositionInputs={false}
          noBodyStyles
          handleOnly
        >
          <DrawerContent
            hideGrip
            data-ref="tracking-detail-sheet"
            className="drawer-scroll-native top-[var(--app-top)] mt-0 flex flex-col overflow-hidden"
            onInteractOutside={(e) => {
              // Ne pas fermer la fiche quand l'interaction vient d'un tiroir
              // empile par-dessus (et son voile) : "plus d'actions", apercu mail
              // (ThreadView), ou les sous-tiroirs que ThreadView peut ouvrir
              // (reponse, pieces jointes, "..."). Tous les voiles maison portent
              // data-slot="drawer-overlay-manual".
              const target = e.detail.originalEvent.target as HTMLElement | null;
              if (
                target &&
                target.closest(
                  '[data-ref="tracking-more-sheet"], .tracking-more-overlay, [data-ref="tracking-mail-sheet"], [data-ref="thread-drawer"], .tracking-mail-overlay, [data-ref="thread-reply-drawer"], [data-ref="thread-attachments-drawer"], [data-ref="thread-reply-more-sheet"], .reply-more-overlay, [data-slot="drawer-overlay-manual"], [data-slot="dialog-overlay"], [data-slot="dialog-content"]'
                )
              ) {
                e.preventDefault();
              }
            }}
          >
            <DrawerTitle className="sr-only">
              {selected?.title || t("tracking.title")}
            </DrawerTitle>
            {/* Prise du tiroir (seule zone qui le fait glisser) au-dessus de
                l'en-tete propre a la fiche (croix, marchand, "⋮"), comme le
                tiroir de conversation. */}
            <DrawerHandle className="shrink-0 pt-0.5 pb-0.5" data-ref="tracking-detail-handle" data-drawer-header="custom" />
            <div className="flex min-h-0 flex-1 flex-col">
              {selected && (
                <TrackingDetail
                  key={selected.id}
                  item={selected}
                  view={view}
                  isMobile
                  onBack={() => setSelectedId(null)}
                  onOpenView={openSubView}
                  onCloseView={closeSubView}
                  onSetStatus={setStatus}
                  onArchive={(id) => {
                    archive(id);
                    setSelectedId(null);
                  }}
                  onRemove={(id) => {
                    remove(id);
                    setSelectedId(null);
                  }}
                  onRebuild={handleRebuildOne}
                />
              )}
            </div>
          </DrawerContent>
        </Drawer>
        {purgeDialog}
        {rebuildDialog}
        {reprocessDialog}
      </div>
    );
  }

  // Desktop : panneaux redimensionnables, meme gabarit que la page des mails
  // (two-block-page) : en Miel, la liste et la fiche sont deux blocs flottants
  // separes (bloc clair a gauche, bloc de lecture translucide a droite).
  return (
    <>
      <ResizablePanelGroup data-ref="two-block-page" orientation="horizontal" className="h-full">
        <ResizablePanel defaultSize="35%" minSize="22%" maxSize="50%">
          <div data-ref="two-block-list" className="h-full border-r border-border">{listPanel}</div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="65%" minSize="30%">
          <div data-ref="two-block-read" className="h-full">
            {selected ? (
              <TrackingDetail
                key={selected.id}
                item={selected}
                view={view}
                onOpenView={openSubView}
                onCloseView={closeSubView}
                onSetStatus={setStatus}
                onArchive={(id) => {
                  archive(id);
                  setSelectedId(null);
                }}
                onRemove={(id) => {
                  remove(id);
                  setSelectedId(null);
                }}
                onRebuild={handleRebuildOne}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <EmptyState icon={PackageSearch} title={t("tracking.noSelection")} />
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {purgeDialog}
      {rebuildDialog}
      {reprocessDialog}
    </>
  );
}
