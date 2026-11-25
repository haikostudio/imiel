"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { usePullToRefresh } from "@/lib/hooks/usePullToRefresh";
import { PullToRefreshIndicator, ptrGapOf } from "@/components/ui/pull-to-refresh";

// Distance restante (en pixels) sous laquelle on demande la page suivante.
// Volontairement genereuse : sur mobile, une page de liste fait plusieurs
// milliers de pixels, et declencher trop tard donne l'impression que la liste
// s'arrete.
const SCROLL_THRESHOLD_PX = 800;
// Nombre maximal de chargements automatiques (sans geste de l'utilisateur)
// enchainables pour remplir l'ecran. Garde-fou : si le conteneur a une hauteur
// nulle (liste masquee), on ne boucle pas indefiniment.
const MAX_AUTO_FILL = 10;
// Filet de securite : si un appel de chargement est ignore par le hook (garde
// interne), `loadingMore` ne bascule jamais et le verrou resterait bloque.
const PENDING_LOAD_TIMEOUT_MS = 4000;
// Arrivee de nouveaux mails en tete : sous cette distance du haut, la liste
// remonte seule pour les montrer ; plus bas, une pastille "Nouveaux mails"
// propose d'y remonter d'un clic (on ne deplace pas une lecture en cours).
const NEW_MAIL_AUTO_SCROLL_PX = 200;

interface VirtualMailListProps<T> {
  items: T[];
  hasMoreBottom: boolean;
  hasMoreTop: boolean;
  loadingMore: boolean;
  loadingDirection: "top" | "bottom" | null;
  onLoadMoreBottom: () => void;
  onLoadMoreTop: () => void;
  renderItem: (item: T, index: number) => ReactNode;
  getItemKey: (item: T) => string;
  estimatedItemHeight: number;
  preserveScrollKey?: string | null;
  /** Tirer-pour-rafraichir : appele quand on tire la liste depuis le haut.
   *  Doit renvoyer une promesse pour garder le loader visible jusqu'a la fin. */
  onRefresh?: () => Promise<unknown> | void;
  /** Espace vide sous la derniere ligne (valeur CSS) : laisse la derniere ligne
   *  remonter au-dessus d'un bouton flottant (pilule "Rediger" du telephone). */
  bottomInset?: string;
}

/**
 * Petite scrollbar mobile toujours visible (les overlays iOS/Android se masquent
 * automatiquement) : track fin sur le bord droit, thumb cliquable/draggable
 * qui reflete et controle scrollTop.
 */
function MobileScrollIndicator({
  scrollRef,
  scrollVersion,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  scrollVersion: number;
}) {
  const [metrics, setMetrics] = useState({ visible: false, thumbTop: 0, thumbHeight: 24 });
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ y: 0, scrollTop: 0 });
  const rafRef = useRef<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const updateMetrics = () => {
    const el = scrollRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 4) {
      setMetrics((m) => (m.visible ? { ...m, visible: false } : m));
      return;
    }
    const trackH = track.clientHeight;
    const minThumb = 24;
    const thumbHeight = Math.max(minThumb, (clientHeight / scrollHeight) * trackH);
    const maxThumbTop = trackH - thumbHeight;
    const ratio = scrollTop / (scrollHeight - clientHeight);
    const thumbTop = Math.max(0, Math.min(maxThumbTop, ratio * maxThumbTop));
    setMetrics({ visible: true, thumbTop, thumbHeight });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        updateMetrics();
      });
    };
    updateMetrics();
    el.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(updateMetrics);
    ro.observe(el);

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef]);

  useEffect(() => {
    updateMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollVersion]);

  const onTouchStart = (e: React.TouchEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    draggingRef.current = true;
    dragStartRef.current = { y: e.touches[0].clientY, scrollTop: el.scrollTop };
    e.stopPropagation();
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const el = scrollRef.current;
    const track = trackRef.current;
    if (!el || !track || !draggingRef.current) return;
    const dy = e.touches[0].clientY - dragStartRef.current.y;
    const trackH = track.clientHeight;
    const maxThumbTop = trackH - metrics.thumbHeight;
    const scrollRange = el.scrollHeight - el.clientHeight;
    if (maxThumbTop <= 0 || scrollRange <= 0) return;
    const delta = (dy / maxThumbTop) * scrollRange;
    el.scrollTop = dragStartRef.current.scrollTop + delta;
    e.preventDefault();
  };

  const onTouchEnd = () => {
    draggingRef.current = false;
  };

  if (!metrics.visible) return null;

  return (
    <div
      className="pointer-events-auto absolute right-0.5 top-1 bottom-1 z-20 w-1.5 md:hidden"
      aria-hidden="true"
    >
      <div ref={trackRef} className="relative h-full rounded-full bg-muted/30">
        <div
          className="absolute left-0 right-0 rounded-full bg-foreground/40"
          style={{ top: metrics.thumbTop, height: metrics.thumbHeight }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        />
      </div>
    </div>
  );
}

export function VirtualMailList<T>({
  items,
  hasMoreBottom,
  hasMoreTop,
  loadingMore,
  loadingDirection,
  onLoadMoreBottom,
  onLoadMoreTop,
  renderItem,
  getItemKey,
  estimatedItemHeight,
  preserveScrollKey = null,
  onRefresh,
  bottomInset,
}: VirtualMailListProps<T>) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [newOnTop, setNewOnTop] = useState(0);
  // hasMoreTop du rendu precedent : la page du haut qui ARRIVE au sommet en
  // remontant fait passer hasMoreTop a false dans le meme rendu que son ajout,
  // ce n'est pas un nouveau mail.
  const prevHasMoreTopRef = useRef(hasMoreTop);
  const prevFirstKeyRef = useRef<string | null>(null);
  const prevKeysRef = useRef<string[]>([]);
  const pendingLoadRef = useRef(false);

  // Refs stables pour le scroll handler (pas de re-attach a chaque render)
  const hasMoreBottomRef = useRef(hasMoreBottom);
  hasMoreBottomRef.current = hasMoreBottom;
  const hasMoreTopRef = useRef(hasMoreTop);
  hasMoreTopRef.current = hasMoreTop;
  const loadingMoreRef = useRef(loadingMore);
  loadingMoreRef.current = loadingMore;
  const onLoadMoreBottomRef = useRef(onLoadMoreBottom);
  onLoadMoreBottomRef.current = onLoadMoreBottom;
  const onLoadMoreTopRef = useRef(onLoadMoreTop);
  onLoadMoreTopRef.current = onLoadMoreTop;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatedItemHeight,
    overscan: 10,
    getItemKey: (index) => getItemKey(items[index]),
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoFillCountRef = useRef(0);

  const clearPendingTimer = () => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  };

  /** Poser le verrou de chargement + son filet de securite, puis demander la page. */
  const requestLoadRef = useRef<(fn: () => void) => void>(null!);
  requestLoadRef.current = (fn: () => void) => {
    pendingLoadRef.current = true;
    clearPendingTimer();
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      pendingLoadRef.current = false;
    }, PENDING_LOAD_TIMEOUT_MS);
    fn();
  };

  // Reset le guard quand loadingMore repasse a false
  useEffect(() => {
    if (!loadingMore) {
      clearPendingTimer();
      pendingLoadRef.current = false;
    }
  }, [loadingMore]);

  useEffect(() => clearPendingTimer, []);

  // Scroll listener base sur la position en pixels
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (el.scrollTop < 40) setNewOnTop(0);
      if (loadingMoreRef.current || pendingLoadRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } = el;
      const remainingBottom = scrollHeight - scrollTop - clientHeight;
      const remainingTop = scrollTop;

      if (hasMoreBottomRef.current && remainingBottom < SCROLL_THRESHOLD_PX) {
        requestLoadRef.current(onLoadMoreBottomRef.current);
        return;
      }

      if (hasMoreTopRef.current && remainingTop < SCROLL_THRESHOLD_PX) {
        requestLoadRef.current(onLoadMoreTopRef.current);
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-remplissage : tant que la liste chargee ne remplit pas l'ecran, AUCUN
  // event `scroll` ne peut se produire -> la pagination infinie ne demarre
  // jamais et la liste reste bloquee sur la premiere page (cas des dossiers ou
  // une page de messages donne peu de lignes : Envoyes en mode conversation).
  // On complete donc automatiquement jusqu'a rendre la liste defilable.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!hasMoreBottom || loadingMore || pendingLoadRef.current) return;
    if (autoFillCountRef.current >= MAX_AUTO_FILL) return;

    // On ne complete QUE tant que rien n'est defilable : une fois la liste
    // defilable, c'est le geste de l'utilisateur qui pilote la suite.
    if (el.scrollHeight > el.clientHeight + 4) return;

    autoFillCountRef.current += 1;
    requestLoadRef.current(onLoadMoreBottom);
  }, [items, totalSize, hasMoreBottom, loadingMore, onLoadMoreBottom]);

  // Preserver la position de scroll quand des items sont prepend en haut
  useLayoutEffect(() => {
    if (items.length === 0) {
      prevFirstKeyRef.current = null;
      prevKeysRef.current = [];
      return;
    }

    const currentKeys = items.map(getItemKey);
    const prevKeys = prevKeysRef.current;
    prevKeysRef.current = currentKeys;

    // Nouveaux mails arrives EN TETE (pas une page du haut rechargee : la
    // fenetre est au sommet et ce n'est pas un chargement vers le haut).
    // L'ancien premier element se retrouve plus bas -> autant de nouveaux.
    const el0 = scrollRef.current;
    const added = prevKeys.length > 0 ? currentKeys.indexOf(prevKeys[0]) : -1;
    const wasAtWindowTop = !prevHasMoreTopRef.current;
    prevHasMoreTopRef.current = hasMoreTop;
    const newOnTopNow =
      added > 0 && !hasMoreTop && wasAtWindowTop && loadingDirection !== "top" && !!el0;
    const nearTop = !!el0 && el0.scrollTop < NEW_MAIL_AUTO_SCROLL_PX;
    if (newOnTopNow && el0) {
      if (nearTop) {
        // Remonte seule apres la compensation eventuelle (frame suivante).
        // Saut direct : un defilement doux est interrompu par les re-mesures
        // du virtualiseur (lignes qui changent de taille pendant l'animation).
        requestAnimationFrame(() => {
          el0.scrollTop = 0;
        });
      } else {
        setNewOnTop((n) => n + added);
      }
    }

    if (preserveScrollKey && scrollRef.current) {
      const prevIndex = prevKeys.indexOf(preserveScrollKey);
      const currentIndex = currentKeys.indexOf(preserveScrollKey);
      if (prevIndex >= 0 && currentIndex >= 0 && prevIndex !== currentIndex) {
        scrollRef.current.scrollTop += (currentIndex - prevIndex) * estimatedItemHeight;
      }
      prevFirstKeyRef.current = currentKeys[0];
      return;
    }

    const currentFirstKey = getItemKey(items[0]);
    const prevKey = prevFirstKeyRef.current;
    prevFirstKeyRef.current = currentFirstKey;

    if (prevKey === null || currentFirstKey === prevKey) return;

    const prevIndex = items.findIndex((item) => getItemKey(item) === prevKey);

    // Cas symetrique du prepend : les pages du HAUT ont ete retirees (fenetre
    // glissante, cf. trimTop dans useThreads/useMessages). Sans compensation,
    // tout le contenu remonte d'un bloc entier au moment ou l'utilisateur
    // pagine vers le bas : la liste "saute" en avant de plusieurs ecrans.
    if (prevIndex === -1 && scrollRef.current) {
      const dropped = prevKeys.indexOf(currentFirstKey);
      if (dropped > 0) {
        const el = scrollRef.current;
        el.scrollTop = Math.max(0, el.scrollTop - dropped * estimatedItemHeight);
      }
      return;
    }

    if (prevIndex > 0 && scrollRef.current) {
      // PIEGE : ne preserver la position QUE si l'utilisateur a reellement
      // scrolle (ou si on pagine vers le haut, hasMoreTop). Avant, un nouveau
      // mail prepend PENDANT que la liste etait au sommet decalait scrollTop
      // d'une hauteur de ligne : le mail etait insere mais restait CACHE juste
      // au-dessus du viewport (l'utilisateur devait rafraichir pour le voir).
      // Au sommet, on laisse le mail apparaitre en place (animation slide-in).
      const el = scrollRef.current;
      const atTop = !hasMoreTop && el.scrollTop < estimatedItemHeight;
      if (!atTop && !(newOnTopNow && nearTop)) {
        el.scrollTop += prevIndex * estimatedItemHeight;
      }
    }
  }, [items, getItemKey, estimatedItemHeight, preserveScrollKey, hasMoreTop, loadingDirection]);

  // Liste videe / changee de dossier : plus de pastille.
  useEffect(() => {
    if (items.length === 0) setNewOnTop(0);
  }, [items.length]);

  // Re-mesurer quand l'estimation change (density/previewLines)
  useEffect(() => {
    virtualizer.measure();
  }, [estimatedItemHeight, virtualizer]);

  // --- Tirer pour rafraichir (mobile) : logique partagee via le hook ---
  const ptrState = usePullToRefresh(scrollRef, onRefresh);
  const ptrGap = ptrGapOf(ptrState);

  return (
    <div data-ref="mail-virtual-list" className="relative min-h-0 flex-1">
      {onRefresh && <PullToRefreshIndicator {...ptrState} />}
      <div ref={scrollRef} className="absolute inset-0 overflow-y-auto">
        <div
          className={ptrState.dragging ? undefined : "ptr-content--snap"}
          style={ptrGap > 0 ? { transform: `translateY(${ptrGap}px)` } : undefined}
        >
        {loadingDirection === "top" && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        <div className="relative w-full" style={{ height: `${totalSize}px` }}>
          {virtualItems.map((virtualRow) => (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 w-full"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {renderItem(items[virtualRow.index], virtualRow.index)}
            </div>
          ))}
        </div>
        {loadingDirection === "bottom" && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {bottomInset && <div aria-hidden style={{ height: bottomInset }} data-ref="mail-list-bottom-inset" />}
        </div>
      </div>
      {newOnTop > 0 && (
        <button
          type="button"
          data-ref="new-mails-pill"
          onClick={() => {
            setNewOnTop(0);
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
          }}
          className="absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-md transition-opacity hover:opacity-90"
        >
          <ArrowUp className="size-3.5" />
          {t("mail.newMailsPill")}
        </button>
      )}
      <MobileScrollIndicator scrollRef={scrollRef} scrollVersion={items.length + totalSize} />
    </div>
  );
}
