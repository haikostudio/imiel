"use client";

import { PageSearchField } from "@/components/layout/PageSearchField";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Newspaper,
  RefreshCw,
  Mail,
  Loader2,
  Trash2,
  Settings2,
  MoreVertical,
  BellRing,
  BarChart3,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import { useNewsletters } from "@/lib/hooks/useNewsletters";
import { AlertTopicsPanel } from "@/components/newsletters/AlertTopicsPanel";
import {
  NewsletterTagChips,
  invalidateKnownNewsletterTags,
  useKnownNewsletterTags,
} from "@/components/newsletters/NewsletterTags";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import { useNewsletterSources } from "@/lib/hooks/useNewsletterSources";
import { sanitizeHtml } from "@/lib/utils/sanitize";
import { newsletterSynthesisText, reorderNewsletterSummary } from "@/lib/utils/newsletter-summary";
import { formatRelativeDate, formatFullDate } from "@/lib/utils/date";
import { hashNavigate, hashSetParams, useHashRouter } from "@/lib/hash-router";
import pb from "@/lib/pocketbase";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ChipIconButton, EmptyState } from "@/components/ui/kit";
import { MobileFooterBar, MobileFooterButton } from "@/components/layout/MobileFooterBar";
import { MobileThreadDrawer } from "@/components/mail/MobileThreadDrawer";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { NewsletterPost } from "@/lib/pocketbase";

function NewsletterCard({
  post,
  onOpen,
  knownTags,
  activeTag,
  onFilterTag,
  onTagsChange,
  variant = "card",
  selected = false,
}: {
  post: NewsletterPost;
  onOpen: (post: NewsletterPost) => void;
  knownTags: string[];
  activeTag: string | null;
  onFilterTag: (tag: string) => void;
  onTagsChange: (post: NewsletterPost, tags: string[]) => void;
  /** card = carte du telephone ; row = ligne de la liste ordinateur (two-block-list). */
  variant?: "card" | "row";
  selected?: boolean;
}) {
  const isRow = variant === "row";
  const t = useT();
  const excerpt = useMemo(
    // Description de la carte = la synthese seule (sans "Source : ... Resume :").
    () => (post.summary ? newsletterSynthesisText(post.summary) : ""),
    [post.summary]
  );

  const alerts = (post.matched_alerts || []).filter((a) => a && a.name);

  const card = (
    <article
      role="button"
      tabIndex={0}
      data-ref={isRow ? "newsletter-row" : "newsletter-card"}
      data-selected={isRow ? (selected ? "true" : "false") : undefined}
      aria-current={selected || undefined}
      className={
        isRow
          ? // Ligne de liste (gabarit des lignes de mails/suivi) : `mail-row-selected`
            // dessine la pastille de selection arrondie en Miel (miel.css).
            cn(
              "group/row row-divider relative isolate cursor-pointer px-4 py-3.5 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60",
              selected && "mail-row-selected bg-accent hover:bg-accent"
            )
          : "cursor-pointer rounded-3xl border border-border bg-card p-4 transition-colors hover:bg-accent/50"
      }
      onClick={() => onOpen(post)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(post);
        }
      }}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          {!post.is_read && (
            <span className="size-2 shrink-0 rounded-full bg-unread" />
          )}
          <Newspaper className="size-3.5 shrink-0" />
          <span className="truncate">{post.source_name || post.source_address}</span>
        </div>
        <time className="shrink-0 text-xs text-muted-foreground">
          {formatRelativeDate(post.message_date)}
        </time>
      </header>

      {/* Titre en entier : il passe a la ligne autant qu'il le faut. */}
      <h2 data-ref="newsletter-title" className="mt-1.5 break-words text-[0.9375rem] font-semibold">{post.title}</h2>

      {post.status === "pending" ? (
        <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("newsletters.pending")}
        </div>
      ) : post.status === "error" || !excerpt ? (
        <p className="mt-1 text-sm text-muted-foreground">{t("newsletters.error")}</p>
      ) : (
        <p className={cn("mt-1 text-sm leading-relaxed text-muted-foreground", isRow ? "line-clamp-2" : "line-clamp-6")}>
          {excerpt}
        </p>
      )}

      {isRow && alerts.length > 0 && (
        <p data-ref="newsletter-alert-banner" className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
          <BellRing className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {t("newsletters.alertBanner", { topics: alerts.map((a) => `\u00ab ${a.name} \u00bb`).join(", ") })}
          </span>
        </p>
      )}

      {post.status === "done" && (
        <NewsletterTagChips
          tags={Array.isArray(post.tags) ? post.tags : []}
          known={knownTags}
          activeTag={activeTag}
          onFilter={onFilterTag}
          onChange={(tags) => onTagsChange(post, tags)}
        />
      )}
    </article>
  );

  if (!alerts.length || isRow) return card;
  // Bandeau "decroche" sous la carte, a la LARGEUR de la carte (pas de marge
  // laterale) : la newsletter touche un sujet d'alerte.
  return (
    <div>
      <div className="relative z-10">{card}</div>
      <div data-ref="newsletter-alert-banner" className="-mt-4 flex items-center gap-1.5 rounded-b-3xl bg-muted px-4 pt-5 pb-2.5 text-xs font-medium text-foreground">
        <BellRing className="size-3.5 shrink-0" />
        <span className="min-w-0">
          {t("newsletters.alertBanner", { topics: alerts.map((a) => `\u00ab ${a.name} \u00bb`).join(", ") })}
        </span>
      </div>
    </div>
  );
}

type TagProps = {
  knownTags: string[];
  activeTag: string | null;
  onFilterTag: (tag: string) => void;
  onTagsChange: (post: NewsletterPost, tags: string[]) => void;
};

/**
 * Lecture d'une newsletter : synthese complete qui defile + pied epingle avec
 * le bouton "Ouvrir l'email". Partagee par le volet de lecture (ordinateur,
 * two-block-read) et le tiroir (telephone).
 */
function NewsletterReader({
  post,
  onOpenOriginal,
  showSource = false,
  tagProps,
}: {
  post: NewsletterPost;
  onOpenOriginal: () => void;
  /** Volet ordinateur : la source s'affiche au-dessus du titre (le tiroir l'a dans son en-tete). */
  showSource?: boolean;
  tagProps?: TagProps;
}) {
  const t = useT();
  const safeHtml = useMemo(
    // Anciennes syntheses reordonnees a l'affichage : Resume, A retenir, sommaire.
    () => (post.summary ? sanitizeHtml(reorderNewsletterSummary(post.summary)) : ""),
    [post.summary]
  );

  return (
    <div data-ref="newsletter-reader" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("p-4", showSource && "mx-auto w-full max-w-3xl px-6 py-6")}>
          {showSource && (
            <div className="mb-1.5 flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
              <Newspaper className="size-3.5 shrink-0" />
              <span className="truncate">{post.source_name || post.source_address}</span>
            </div>
          )}
          <h2 data-ref="newsletter-reader-title" className={cn("font-semibold break-words", showSource ? "text-xl" : "text-base")}>
            {post.title}
          </h2>
          <time className="mt-1 block text-xs text-muted-foreground">
            {formatFullDate(post.message_date)}
          </time>
          {tagProps && post.status === "done" && (
            <NewsletterTagChips
              tags={Array.isArray(post.tags) ? post.tags : []}
              known={tagProps.knownTags}
              activeTag={tagProps.activeTag}
              onFilter={tagProps.onFilterTag}
              onChange={(tags) => tagProps.onTagsChange(post, tags)}
            />
          )}

          {post.status === "pending" ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("newsletters.pending")}
            </div>
          ) : post.status === "error" || !safeHtml ? (
            <p className="py-4 text-sm text-muted-foreground">
              {t("newsletters.error")}
            </p>
          ) : (
            <div
              data-ref="newsletter-reader-summary"
              className="mt-4 text-sm leading-relaxed space-y-1.5 [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-1 [&_strong]:font-semibold [&_ul]:mt-1 [&_ul]:mb-2"
              dangerouslySetInnerHTML={{ __html: safeHtml }}
            />
          )}
        </div>
      </div>

      {/* Pied epingle : ouvrir l'email d'origine. `bottom-action-bar` : sans
          bande opaque dans le volet de lecture Miel (miel.css). */}
      <div
        data-slot="bottom-action-bar"
        className="flex shrink-0 items-center gap-2 border-t bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        {/* Volet ordinateur : bouton a sa largeur, aligne sur le texte, loin
            du bouton rond de l'assistant (coin bas droit). */}
        <div className={cn("flex", showSource ? "mx-auto w-full max-w-3xl px-2" : "flex-1")}>
          <Button
            size="sm"
            className={cn("gap-1.5", !showSource && "flex-1")}
            data-ref="newsletter-open-original"
            onClick={onOpenOriginal}
            disabled={!post.thread_id}
          >
            <Mail className="size-4" />
            {t("newsletters.openOriginal")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Telephone : la lecture dans un tiroir (convention drawers de l'app). */
function NewsletterDetailDrawer({
  post,
  open,
  onOpenChange,
  onOpenThread,
}: {
  post: NewsletterPost | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Telephone : ouvre le mail d'origine dans le tiroir de conversation. */
  onOpenThread?: (threadId: string) => void;
}) {
  function openOriginal() {
    if (post?.thread_id) {
      if (onOpenThread) onOpenThread(post.thread_id);
      else hashNavigate(`/mail/thread/${post.thread_id}`);
    }
    onOpenChange(false);
  }

  return (
    <ResponsivePanel
      open={open}
      onOpenChange={onOpenChange}
      title={post ? post.source_name || post.source_address : ""}
    >
      {post && <NewsletterReader post={post} onOpenOriginal={openOriginal} />}
    </ResponsivePanel>
  );
}

/**
 * Ordinateur ou telephone, juste des le PREMIER rendu (useIsMobile rend
 * `false` au premier rendu : sur telephone, la page ordinateur aurait selectionne
 * d'office une newsletter, puis le tiroir l'aurait ouverte).
 */
const DESKTOP_QUERY = "(min-width: 768px)";
function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(DESKTOP_QUERY).matches
  );
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const update = () => setDesktop(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return desktop;
}

export default function NewslettersPage() {
  const t = useT();
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const { posts, loading, hasMore, loadMore, markRead, refresh, setTags, triggerBackfill, backfilling, purge } =
    useNewsletters(tagFilter);
  const knownTags = useKnownNewsletterTags();
  const handleTagsChange = useCallback(
    async (post: NewsletterPost, tags: string[]) => {
      const ok = await setTags(post.id, tags);
      if (!ok) toast.error(t("newsletters.tagSaveFailed"));
      else invalidateKnownNewsletterTags();
    },
    [setTags, t]
  );
  const handleFilterTag = useCallback(
    (tag: string) => setTagFilter((cur) => (cur && cur.toLowerCase() === tag.toLowerCase() ? null : tag)),
    []
  );
  const { sources, removeSource, loading: sourcesLoading } = useNewsletterSources();
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [detailPost, setDetailPost] = useState<NewsletterPost | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  // Ordinateur : liste a gauche + volet de lecture a droite (two-block-page).
  // Telephone : cartes + tiroir de lecture ; le mail d'origine s'ouvre dans le
  // tiroir de conversation commun.
  const isDesktop = useIsDesktop();
  const isMobile = !isDesktop;
  const [originalThreadId, setOriginalThreadId] = useState<string | null>(null);

  const isEmpty = !loading && posts.length === 0;
  const hasSources = sources.length > 0;

  const { searchParams, replace } = useHashRouter();
  const postParam = searchParams.get("post");

  // --- Ordinateur : la newsletter lue vit dans l'ADRESSE (`#/newsletters?post=<id>`).
  const selectedId = isDesktop ? postParam : null;
  const selectPost = useCallback((id: string | null) => {
    hashSetParams({ post: id }, { replace: true });
  }, []);
  // Lien direct vers une newsletter hors de la page chargee (vue d'ensemble) :
  // lue a part pour l'afficher quand meme.
  const [linkedPost, setLinkedPost] = useState<NewsletterPost | null>(null);
  const listedSelected = selectedId ? posts.find((p) => p.id === selectedId) ?? null : null;
  const selectedPost = listedSelected ?? (linkedPost && linkedPost.id === selectedId ? linkedPost : null);
  useEffect(() => {
    if (!isDesktop || !selectedId || loading || listedSelected || linkedPost?.id === selectedId) return;
    let cancelled = false;
    pb.collection("newsletter_posts")
      .getOne<NewsletterPost>(selectedId, { requestKey: null })
      .then((post) => {
        if (!cancelled) setLinkedPost(post);
      })
      .catch(() => {
        // Newsletter supprimee ou introuvable : retour a la plus recente.
        if (!cancelled) selectPost(posts[0]?.id ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktop, selectedId, loading, listedSelected, linkedPost, posts, selectPost]);
  // Arrivee sans selection : la plus recente est ouverte d'office.
  useEffect(() => {
    if (!isDesktop || selectedId || loading || posts.length === 0) return;
    selectPost(posts[0].id);
  }, [isDesktop, selectedId, loading, posts, selectPost]);
  // Filtre d'etiquette qui retire la newsletter lue de la liste : la premiere
  // de la liste filtree prend sa place.
  // (Le rendu qui suit le changement de filtre montre encore l'ancienne liste,
  // pas encore en chargement : on attend un chargement complet.)
  const filterCheckRef = useRef({ tag: tagFilter, pending: false, sawLoading: false });
  useEffect(() => {
    const check = filterCheckRef.current;
    if (check.tag !== tagFilter) {
      filterCheckRef.current = { tag: tagFilter, pending: true, sawLoading: loading };
      return;
    }
    if (!check.pending) return;
    if (loading) {
      check.sawLoading = true;
      return;
    }
    if (!check.sawLoading) return;
    check.pending = false;
    if (isDesktop && !listedSelected) selectPost(posts[0]?.id ?? null);
  }, [tagFilter, loading, isDesktop, listedSelected, posts, selectPost]);
  // Newsletter lue = marquee lue, une seule fois par newsletter.
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedPost || markedRef.current === selectedPost.id) return;
    markedRef.current = selectedPost.id;
    if (!selectedPost.is_read) void markRead(selectedPost.id);
  }, [selectedPost, markRead]);

  const openDetail = useCallback(
    (post: NewsletterPost) => {
      if (isDesktop) {
        selectPost(post.id);
        return;
      }
      setDetailPost(post);
      setDetailOpen(true);
      if (!post.is_read) markRead(post.id);
    },
    [isDesktop, markRead, selectPost]
  );

  // Telephone, lien direct `#/newsletters?post=<id>` (clic depuis la vue
  // d'ensemble) : ouvre la synthese visee dans le tiroir, meme hors de la page
  // chargee, puis retire le parametre pour ne pas la rouvrir (meme mecanique
  // que `?event=` de l'agenda). Sur ordinateur, le parametre EST la selection.
  useEffect(() => {
    if (!postParam || isDesktop) return;
    let cancelled = false;
    (async () => {
      let post = posts.find((p) => p.id === postParam) ?? null;
      if (!post) {
        try {
          post = await pb.collection("newsletter_posts").getOne<NewsletterPost>(postParam, { requestKey: null });
        } catch {
          post = null;
        }
      }
      // Rendu abandonne (page remontee au passage ordinateur -> telephone) :
      // ne PAS consommer le parametre, c'est le nouveau rendu qui ouvre la
      // synthese (meme correctif que ?event= de l'agenda).
      if (cancelled) return;
      if (post) openDetail(post);
      replace("/newsletters");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postParam, isDesktop]);

  // Rafraichissement explicite (bouton) : toast a la fin. Le filet de securite
  // auto (effet ci-dessous) reste muet pour ne pas surprendre.
  const handleManualBackfill = useCallback(async () => {
    await triggerBackfill();
    toast.success(t("newsletters.backfillDone"));
  }, [triggerBackfill, t]);

  const handleRemoveSource = useCallback(async (email: string) => {
    try {
      await removeSource(email);
      toast.success(t("newsletters.sourceRemoved"));
    } catch {
      toast.error(t("newsletters.sourceError"));
    }
  }, [removeSource, t]);

  // Filet de securite : flux vide alors que des sources existent = le backfill
  // declenche au moment du "Suivre" a echoue ou n'a jamais tourne. On agrege
  // automatiquement l'historique recent (une seule fois) pour que la page ne
  // reste jamais vide a tort ; l'utilisateur n'a rien a cliquer. Les nouveaux
  // mails restent geres en direct par la sync, l'historique par ce filet.
  const autoTriggeredRef = useRef(false);
  const [autoAggDone, setAutoAggDone] = useState(false);
  useEffect(() => {
    // Une liste vide sous un filtre d'etiquette n'est pas un flux vide.
    if (loading || sourcesLoading || !hasSources || tagFilter) return;
    if (posts.length > 0 || backfilling || autoTriggeredRef.current) return;
    autoTriggeredRef.current = true;
    void (async () => {
      await triggerBackfill();
      setAutoAggDone(true);
    })();
  }, [loading, sourcesLoading, hasSources, posts.length, backfilling, triggerBackfill, tagFilter]);

  const tagFilterChip = tagFilter && (
    <div data-ref="newsletters-tag-filter" className="flex min-w-0 items-center gap-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{t("newsletters.filteredBy")}</span>
      <button
        type="button"
        onClick={() => setTagFilter(null)}
        className="inline-flex min-w-0 items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground"
      >
        <span className="truncate">{tagFilter}</span>
        <X className="size-3 shrink-0" />
      </button>
    </div>
  );

  // Etats vides (communs aux deux mises en page).
  const emptyContent = isEmpty ? (
    tagFilter ? (
      <p className="py-10 text-center text-sm text-muted-foreground">{t("newsletters.noPostForTag")}</p>
    ) : hasSources && (backfilling || !autoAggDone) ? (
      // Sources connues mais flux encore vide : on agrege en arriere-plan.
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-20 text-center">
        <Loader2 className="size-8 animate-spin text-muted-foreground/60" />
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("newsletters.aggregating")}
        </p>
      </div>
    ) : (
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-20 text-center">
        <Newspaper className="size-10 text-muted-foreground/50" />
        <p className="max-w-sm text-sm text-muted-foreground">
          {hasSources ? t("newsletters.empty") : t("newsletters.emptyNoSources")}
        </p>
        {hasSources && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleManualBackfill}
            disabled={backfilling}
          >
            <RefreshCw className={cn("size-4", backfilling && "animate-spin")} />
            {t("newsletters.refresh")}
          </Button>
        )}
      </div>
    )
  ) : null;

  const loadMoreAndSpinner = (
    <>
      {hasMore && (
        <div className="flex justify-center py-2">
          <Button variant="ghost" size="sm" onClick={loadMore} disabled={loading} data-ref="newsletters-load-more">
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              t("newsletters.loadMore")
            )}
          </Button>
        </div>
      )}
      {loading && posts.length === 0 && (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </>
  );

  const overlays = (
    <>
      {/* Telephone : lecture d'une newsletter dans un tiroir. */}
      {isMobile && (
        <>
          <NewsletterDetailDrawer
            post={detailPost}
            open={detailOpen}
            onOpenChange={setDetailOpen}
            onOpenThread={setOriginalThreadId}
          />
          <MobileThreadDrawer
            open={!!originalThreadId}
            onClose={() => setOriginalThreadId(null)}
            controlled
            threadId={originalThreadId}
          />
        </>
      )}

      {/* Gestion des sources : tiroir (Sheet desktop / Drawer mobile) avec
          suppression par source. */}
      <ResponsivePanel
        open={sourcesOpen}
        onOpenChange={setSourcesOpen}
        title={t("newsletters.sources")}
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <p className="px-1 pb-2 text-xs text-muted-foreground">
            {t("newsletters.sourcesHint")}
          </p>
          {!hasSources ? (
            <p className="px-1 py-3 text-sm text-muted-foreground">
              {t("newsletters.noSources")}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {sources.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-sm"
                >
                  <Newspaper className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{s.name || s.email}</p>
                    {s.name && (
                      <p className="truncate text-xs text-muted-foreground">{s.email}</p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleRemoveSource(s.email)}
                    aria-label={t("newsletters.unfollowSource")}
                    title={t("newsletters.unfollowSource")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </ResponsivePanel>

      <AlertTopicsPanel open={alertsOpen} onOpenChange={setAlertsOpen} />

      <Dialog open={purgeOpen} onOpenChange={setPurgeOpen}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("newsletters.clearConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("newsletters.clearConfirmDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPurgeOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                setPurgeOpen(false);
                await purge();
                toast.success(t("newsletters.purged"));
              }}
            >
              {t("newsletters.clear")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (isDesktop) {
    // Ordinateur : meme gabarit que Suivi et Contacts (two-block-page, enfant
    // DIRECT de la zone principale, sans enveloppe : sinon le grand bloc clair
    // de l'apparence Miel revient autour). Recherche et actions en tete de la
    // liste ; volet de lecture a droite.
    const listPanel = (
      <div data-ref="newsletters-list-panel" className="flex h-full flex-col bg-background">
        <h1 className="sr-only">{t("newsletters.title")}</h1>
        <div data-ref="newsletters-list-top" className="flex shrink-0 flex-col gap-3 px-4 pt-4 pb-3">
          {/* Miel : recherche globale en tete (rien en Minimaliste). */}
          <PageSearchField placeholder={t("searchIn.newsletters")} className="w-full" />
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">{tagFilterChip}</div>
            <ChipIconButton
              data-ref="newsletters-stats-button"
              aria-label={t("newsletters.stats")}
              title={t("newsletters.stats")}
              onClick={() => hashNavigate("/newsletters/stats")}
            >
              <BarChart3 />
            </ChipIconButton>
            <ChipIconButton
              data-ref="newsletters-alerts-button"
              aria-label={t("newsletters.alerts")}
              title={t("newsletters.alerts")}
              onClick={() => setAlertsOpen(true)}
            >
              <BellRing />
            </ChipIconButton>
            <ChipIconButton
              data-ref="newsletters-sources-button"
              aria-label={t("newsletters.sources")}
              title={hasSources ? `${t("newsletters.sources")} (${sources.length})` : t("newsletters.sources")}
              onClick={() => setSourcesOpen(true)}
            >
              <Settings2 />
            </ChipIconButton>
            <ChipIconButton
              data-ref="newsletters-refresh-button"
              aria-label={t("newsletters.refresh")}
              title={t("newsletters.refresh")}
              onClick={handleManualBackfill}
              disabled={backfilling}
            >
              <RefreshCw className={cn(backfilling && "animate-spin")} />
            </ChipIconButton>
            <ChipIconButton
              data-ref="newsletters-clear-button"
              aria-label={t("newsletters.clear")}
              title={t("newsletters.clear")}
              onClick={() => setPurgeOpen(true)}
            >
              <Trash2 />
            </ChipIconButton>
          </div>
        </div>
        <div data-ref="newsletters-list-scroll" className="min-h-0 flex-1 overflow-y-auto pb-2">
          {emptyContent ?? (
            <>
              {posts.map((post) => (
                <NewsletterCard
                  key={post.id}
                  post={post}
                  variant="row"
                  selected={post.id === selectedId}
                  onOpen={openDetail}
                  knownTags={knownTags}
                  activeTag={tagFilter}
                  onFilterTag={handleFilterTag}
                  onTagsChange={handleTagsChange}
                />
              ))}
              {loadMoreAndSpinner}
            </>
          )}
        </div>
      </div>
    );

    return (
      <>
        <ResizablePanelGroup data-ref="two-block-page" orientation="horizontal" className="h-full">
          <ResizablePanel defaultSize="35%" minSize="22%" maxSize="50%">
            <div data-ref="two-block-list" className="h-full border-r border-border">{listPanel}</div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="65%" minSize="30%">
            <div data-ref="two-block-read" className="h-full">
              {selectedPost ? (
                <NewsletterReader
                  key={selectedPost.id}
                  post={selectedPost}
                  showSource
                  onOpenOriginal={() => {
                    if (selectedPost.thread_id) hashNavigate(`/mail/thread/${selectedPost.thread_id}`);
                  }}
                  tagProps={{
                    knownTags,
                    activeTag: tagFilter,
                    onFilterTag: handleFilterTag,
                    onTagsChange: handleTagsChange,
                  }}
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  {selectedId ? (
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  ) : (
                    <EmptyState icon={Newspaper} title={t("newsletters.noSelection")} />
                  )}
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
        {overlays}
      </>
    );
  }

  return (
    <div data-ref="newsletters-page" className="flex h-full flex-col bg-background">
      {/* Le titre vit dans la barre du haut ; les actions du flux dans la
          barre du pied (MobileFooterBar). */}
      <h1 className="sr-only">{t("newsletters.title")}</h1>
      <MobileFooterBar>
        <MobileFooterButton
          icon={BarChart3}
          label={t("newsletters.stats")}
          data-ref="newsletters-footer-stats"
          onClick={() => hashNavigate("/newsletters/stats")}
        />
        <MobileFooterButton
          icon={BellRing}
          label={t("newsletters.alerts")}
          data-ref="newsletters-footer-alerts"
          onClick={() => setAlertsOpen(true)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <MobileFooterButton icon={MoreVertical} label={t("more")} data-ref="newsletters-footer-more" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" sideOffset={8} className="w-52">
            <DropdownMenuItem onClick={handleManualBackfill} disabled={backfilling}>
              <RefreshCw className={cn("size-4", backfilling && "animate-spin")} />
              {t("newsletters.refresh")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSourcesOpen(true)}>
              <Settings2 className="size-4" />
              {t("newsletters.sources")}
              {hasSources ? ` (${sources.length})` : ""}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setPurgeOpen(true)}
              className="text-destructive"
            >
              <Trash2 className="size-4" />
              {t("newsletters.clear")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </MobileFooterBar>

      <PullToRefresh onRefresh={refresh} dataRef="newsletters-scroll">
        <div className="mx-auto w-full max-w-2xl space-y-3 px-3 pt-2 pb-6">
          {tagFilterChip}
          {emptyContent ?? (
            <>
              {posts.map((post) => (
                <NewsletterCard
                  key={post.id}
                  post={post}
                  onOpen={openDetail}
                  knownTags={knownTags}
                  activeTag={tagFilter}
                  onFilterTag={handleFilterTag}
                  onTagsChange={handleTagsChange}
                />
              ))}
              {loadMoreAndSpinner}
            </>
          )}
        </div>
      </PullToRefresh>

      {overlays}
    </div>
  );
}
