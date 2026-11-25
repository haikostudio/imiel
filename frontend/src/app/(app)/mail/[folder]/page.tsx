"use client";

import { MailListEmptyState } from "@/components/mail/ImportanceEmptyState";
import { threadImportance } from "@/lib/importance";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hashBack, hashSetParams, useHashRouter } from "@/lib/hash-router";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";
import { useMailStore, STORAGE_KEY_SELECTION, type FolderType } from "@/lib/stores/mail-store";
import { scheduleMarkRead, cancelPendingMarkRead, flushMarkReadOnContentClick } from "@/lib/mark-read-timer";
import { useTrackedThreads } from "@/lib/stores/tracked-threads";
import { useBriefedThreads } from "@/lib/stores/briefed-threads";
import { useSpamScanStore } from "@/lib/stores/spam-scan-store";
import { getMessageComparator, useMessages } from "@/lib/hooks/useMessages";
import { useThreads, type Thread } from "@/lib/hooks/useThreads";
import { messages as messagesCollection, retryUpdate, updateMessageFlags, type Message } from "@/lib/pocketbase";
import { useFolders } from "@/lib/hooks/useFolders";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { cn } from "@/lib/utils";
import { formatListDate, formatRelativeDate } from "@/lib/utils/date";
import { stripReplacementChars } from "@/lib/utils/sanitize";
import { applySenderGrouping, senderGroupAvatars, threadSenderAddress } from "@/lib/utils/sender-grouping";
import { PenSquare, ShieldAlert, Inbox, Mail, MailOpen, PackageSearch, Paperclip, RefreshCw, Search, ShieldCheck, Star, ListChecks, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import { triggerSync } from "@/lib/hooks/useSync";
import { Button } from "@/components/ui/button";
import { buildSearchFilter, parseSearchQuery } from "@/lib/hooks/useSearch";
import { useSettings, useIsMiel, blockSender, groupSenders } from "@/lib/hooks/useSettings";
import { usePanelSizes } from "@/lib/hooks/usePanelSizes";
import { useMessageActions } from "@/lib/hooks/useMessageActions";
import { SwipeableMailRow } from "@/components/mail/SwipeableMailRow";
import { sendAction } from "@/lib/ws-channel";

import { useT } from "@/lib/i18n";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
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
import { MessageContextMenu } from "@/components/mail/MessageContextMenu";
import { VirtualMailList } from "@/components/mail/VirtualMailList";
import { ThreadView, ParticipantsPopover } from "@/components/mail/ThreadView";
import { MobileThreadDrawer } from "@/components/mail/MobileThreadDrawer";
import { FilterBar } from "@/components/mail/FilterBar";
import { SearchField, UnreadDot } from "@/components/ui/kit";
import { MobileFooterBar } from "@/components/layout/MobileFooterBar";
import { useListChrome, usePageTitle } from "@/lib/stores/page-title";
import { CollapsibleTop } from "@/components/ui/collapsible-top";
import { SuggestionsBanner } from "@/components/mail/SuggestionsBanner";
import { MessageLabels } from "@/components/mail/MessageLabels";
import { SenderAvatar, SenderAvatarPair } from "@/components/mail/SenderAvatar";
import { ReadStatusChecks } from "@/components/mail/ReadStatusChecks";
import { ScheduledSendCountdown } from "@/components/mail/ScheduledSendCountdown";
import { AwaitingReplyBadge } from "@/components/mail/AwaitingReplyBadge";
import { getAwaitingReplySince } from "@/lib/utils/awaiting-reply";
import { useCorrespondents } from "@/lib/stores/correspondents-store";
import { useReadStatus } from "@/lib/stores/read-status-store";
import { useLabels } from "@/lib/hooks/useLabels";

const FOLDER_KEYS: Record<string, string> = {
  all: "folder.allMail",
  inbox: "folder.inbox",
  unread: "folder.unread",
  starred: "folder.favorites",
  sent: "folder.sent",
  drafts: "folder.drafts",
  trash: "folder.trash",
  spam: "folder.spam",
  archive: "folder.archive",
};

type PinnedListPlacement = { id: string; index: number };

function pinItemAtPreviousIndex<T extends { id: string }>(
  items: T[],
  pin: PinnedListPlacement | null,
  activeId: string | null
): T[] {
  if (!pin || activeId !== pin.id) return items;
  const currentIndex = items.findIndex((item) => item.id === pin.id);
  if (currentIndex === -1) return items;

  const next = [...items];
  const [item] = next.splice(currentIndex, 1);
  next.splice(Math.min(pin.index, next.length), 0, item);
  return next;
}

function sortThreadsForDisplay(threads: Thread[], unreadFirst: boolean): Thread[] {
  const sorted = [...threads];
  sorted.sort((a, b) => {
    if (unreadFirst) {
      const au = a.unreadCount > 0 ? 0 : 1;
      const bu = b.unreadCount > 0 ? 0 : 1;
      if (au !== bu) return au - bu;
    }
    // Date du DERNIER message reel du fil (sa propre reponse comprise).
    return new Date(b.displayMessage.date).getTime() - new Date(a.displayMessage.date).getTime();
  });
  return sorted;
}

// Ligne de la liste de mails (charte des maquettes) : fond blanc, marge 10px
// sur telephone (1rem ordinateur), filet en fondu `row-divider` (globals.css),
// survol gris.
const MAIL_ROW_CLASS =
  "group/row relative flex w-full items-start gap-3 px-[10px] md:px-4 text-left transition-colors cursor-pointer hover:bg-accent/60 row-divider";
// Fonds d'etat d'une ligne, OPAQUES (la ligne glissable cache ses actions de
// balayage sous son fond) : non lue = gris (choix utilisateur 2026-10-19, le
// point seul ne suffisait pas), ouverte = gris plus soutenu pour ne pas se
// confondre avec une non lue. Melanges de jetons : suivent le theme sombre.
const ROW_UNREAD_CLASS =
  "bg-muted hover:bg-[color-mix(in_oklab,var(--foreground)_6%,var(--background))]";
// `mail-row-selected` : repere sans style, lu par l'apparence Miel (globals.css)
// qui dessine la selection en pastille arrondie a l'interieur de la ligne.
const ROW_SELECTED_CLASS =
  "mail-row-selected bg-[color-mix(in_oklab,var(--foreground)_10%,var(--background))] hover:bg-[color-mix(in_oklab,var(--foreground)_10%,var(--background))]";

function MailRowStarButton({
  starred,
  selectedColored,
  removeLabel,
  onToggle,
}: {
  starred: boolean;
  selectedColored: boolean;
  removeLabel: string;
  onToggle: () => void;
}) {
  if (!starred) return null;

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }
      }}
      className="inline-flex shrink-0 cursor-pointer p-0.5"
      aria-label={removeLabel}
    >
      <Star
        className={cn(
          "size-3.5 fill-starred",
          selectedColored ? "text-white" : "text-starred"
        )}
      />
    </span>
  );
}

/**
 * Indicateur "conversation suivie" dans la liste (decouple de l'etoile/favori).
 * S'affiche quand un des thread_id du fil correspond a une fiche de suivi active.
 */
function MailRowTrackedBadge({
  threadIds,
  selectedColored,
  label,
}: {
  threadIds: (string | undefined)[];
  selectedColored: boolean;
  label: string;
}) {
  const tracked = useTrackedThreads((s) => threadIds.some((id) => !!id && s.ids.has(id)));
  if (!tracked) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex shrink-0 p-0.5",
            selectedColored ? "text-white" : "text-tracking"
          )}
          aria-label={label}
        >
          <PackageSearch className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Indicateur "conversation avec une note IA" (violet), a cote de l'etoile et du
 * suivi : seulement quand un des thread_id du fil a une note (choix utilisateur
 * 2026-10-18). Source : store briefed-threads (une requete pour toute la liste).
 */
function MailRowBriefBadge({
  threadIds,
  selectedColored,
  label,
}: {
  threadIds: (string | undefined)[];
  selectedColored: boolean;
  label: string;
}) {
  const briefed = useBriefedThreads((s) => threadIds.some((id) => !!id && s.ids.has(id)));
  if (!briefed) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-ref="message-row-brief"
          className={cn("inline-flex shrink-0 p-0.5", selectedColored ? "text-white" : "text-note-strong")}
          aria-label={label}
        >
          <ListChecks className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function useMediaQuery(query: string): boolean {
  // Etat initial SYNCHRONE (page montee en ssr:false) : demarrer a false
  // faisait voir au premier rendu un passage ordinateur -> telephone, que
  // l'effet de bascule prenait pour une rotation et qui refermait le fil
  // demande par un lien direct (#/mail/all?t=... depuis la vue d'ensemble,
  // une notification ou la recherche).
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [query]);

  return matches;
}

/** Lit un parametre de l'adresse LIVE (hash), hors closure React. */
function readLiveHashParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const q = raw.indexOf("?");
  return new URLSearchParams(q >= 0 ? raw.slice(q + 1) : "").get(name);
}

export default function MailFolderPage() {
  const t = useT();
  const { params, searchParams, replace, route } = useHashRouter();
  const isLabelRoute = route === "label";
  const routeLabelId = isLabelRoute ? (params.labelId ?? null) : null;
  const folderSlug = isLabelRoute ? "label" : (params.folder || "all");
  const isMobile = useMediaQuery("(max-width: 767px)");
  const ensureTrackedLoaded = useTrackedThreads((s) => s.ensureLoaded);
  const trackThread = useTrackedThreads((s) => s.track);
  const ensureBriefsLoaded = useBriefedThreads((s) => s.ensureLoaded);
  useEffect(() => {
    ensureTrackedLoaded();
    ensureBriefsLoaded();
  }, [ensureTrackedLoaded, ensureBriefsLoaded]);
  const searchQuery = searchParams.get("q") ?? "";
  // La liste recherchee ("Voir tout", rechargement, lien direct ?q=) passe par
  // le MEME moteur que la palette : le worker (POST /worker/search/mail), a
  // qui la requete est envoyee telle quelle avec le perimetre du dossier. Les
  // deux resultats concordent donc toujours, sans plafond.
  // searchText / searchFilter ne sont qu'un REPLI si le worker est injoignable :
  //  - searchText : terme libre -> /api/mail/list (LIKE sujet/expediteur) ;
  //  - searchFilter : operateurs avances -> filtre PocketBase (record API).
  const { searchFilter, searchText } = useMemo<{
    searchFilter?: string;
    searchText?: string;
  }>(() => {
    if (!searchQuery) return {};
    const parsed = parseSearchQuery(searchQuery);
    const hasAdvancedOperators =
      parsed.from.length > 0 || parsed.to.length > 0 || parsed.subject.length > 0 ||
      !!parsed.after || !!parsed.before || parsed.errors.length > 0 ||
      parsed.hasAttachment || parsed.isUnread || parsed.isRead || parsed.isStarred;
    if (parsed.freeText && !hasAdvancedOperators) {
      return { searchText: parsed.freeText };
    }
    return { searchFilter: buildSearchFilter(searchQuery) };
  }, [searchQuery]);

  const setActiveFolder = useMailStore((s) => s.setActiveFolder);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const { folders } = useFolders();
  const { byId: labelsById } = useLabels();
  // Correspondants (adresses deja ecrites) : alimente le rappel "attend depuis".
  const correspondents = useCorrespondents((s) => s.addresses);
  const ensureCorrespondentsLoaded = useCorrespondents((s) => s.ensureLoaded);
  useEffect(() => {
    ensureCorrespondentsLoaded();
  }, [ensureCorrespondentsLoaded]);
  const { accounts: accountsList } = useAccounts();
  // Coches de suivi de lecture sur les mails envoyes (charge une fois).
  const ensureReadStatusLoaded = useReadStatus((s) => s.ensureLoaded);
  useEffect(() => {
    ensureReadStatusLoaded();
  }, [ensureReadStatusLoaded]);
  // Emails de mes comptes : un mail est "a moi" (donc porte des coches) s'il est
  // envoye (is_sent) ou si son expediteur est l'un de mes comptes.
  const myEmails = useMemo(() => {
    const s = new Set<string>();
    for (const a of accountsList) if (a.email) s.add(a.email.toLowerCase());
    return s;
  }, [accountsList]);
  const isMineMessage = useCallback(
    (m: { is_sent?: boolean; from_address?: { address?: string } | null }) =>
      !!m.is_sent || myEmails.has((m.from_address?.address || "").toLowerCase()),
    [myEmails]
  );
  const selectedMessageId = useMailStore((s) => s.selectedMessageId);
  const selectedThreadId = useMailStore((s) => s.selectedThreadId);
  const selectMessage = useMailStore((s) => s.selectMessage);
  const lockSelection = useMailStore((s) => s.lockSelection);
  const registerCloseThread = useMailStore((s) => s.registerCloseThread);
  const openCompose = useMailStore((s) => s.openCompose);
  const { density, previewLines, readingPane, conversationView: rawConversationView, groupedSenders, uiScale, language, autoMarkReadSeconds } = useSettings();
  // Les brouillons et la corbeille sont des messages individuels, pas des conversations.
  // En recherche on GARDE le regroupement par conversation (une ligne = une discussion),
  // mais on identifie le message qui matche la requete (findThreadMatch) pour : afficher
  // son extrait dans la ligne, le marquer d'une loupe, et ouvrir le thread directement
  // dessus (scroll + highlight dans ThreadView) plutot que sur le dernier message.
  const conversationView = rawConversationView && folderSlug !== "drafts" && folderSlug !== "trash" && folderSlug !== "spam";
  const setSearchMatch = useMailStore((s) => s.setSearchMatch);

  // Termes libres de la requete (pour marquer le message qui matche dans un thread).
  const searchTerms = useMemo(() => {
    if (!searchQuery) return null;
    const text = (parseSearchQuery(searchQuery).freeText || "").toLowerCase().trim();
    return text ? text.split(/\s+/).filter(Boolean) : null;
  }, [searchQuery]);

  // Trouve, dans un thread, le message le plus recent qui correspond a la recherche.
  const findThreadMatch = useCallback(
    (thread: Thread): Message | null => {
      if (!searchQuery) return null;
      const ordered = [...thread.messages].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
      if (searchTerms) {
        const m = ordered.find((mm) => {
          const hay = [
            mm.subject,
            mm.from_address?.name,
            mm.from_address?.address,
            ...(mm.to_addresses ?? []).flatMap((a) => [a.name, a.address]),
            mm.snippet,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return searchTerms.every((term) => hay.includes(term));
        });
        if (m) return m;
      }
      // La liste recherchee ne contient QUE des messages trouves par le moteur
      // (y compris ceux dont le mot n'apparait que dans le corps, absent des
      // champs de liste) : a defaut de correspondance visible, le plus recent.
      return ordered[0] ?? null;
    },
    [searchQuery, searchTerms]
  );

  // Nettoyer le highlight de recherche quand la requete est effacee.
  useEffect(() => {
    if (!searchQuery) setSearchMatch(null);
  }, [searchQuery, setSearchMatch]);

  const { sizes, updateSize } = usePanelSizes();
  const checkedIds = useMailStore((s) => s.checkedIds);
  const removingMessageIds = useMailStore((s) => s.removingMessageIds);
  const toggleChecked = useMailStore((s) => s.toggleChecked);
  const checkAll = useMailStore((s) => s.checkAll);
  const uncheckAll = useMailStore((s) => s.uncheckAll);
  const { bulkMoveToTrash, bulkMoveToInbox, bulkPermanentDelete, bulkMarkAsRead, bulkMoveToSpam, moveToSpam, moveToTrash } = useMessageActions();
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Le delai courant, lu par les effets sans les faire dependre du reglage.
  const autoMarkReadSecondsRef = useRef(autoMarkReadSeconds);
  const [pinnedReadThreadPlacement, setPinnedReadThreadPlacement] = useState<PinnedListPlacement | null>(null);
  const [pinnedReadMessagePlacement, setPinnedReadMessagePlacement] = useState<PinnedListPlacement | null>(null);

  // Timestamp de la derniere selection manuelle (protection contre l'auto-advance et restore)
  const userSelectionTsRef = useRef(0);
  const selectionWasUserInitiatedRef = useRef(false);
  const prevIsMobileRef = useRef(isMobile);
  const AUTO_ADVANCE_LOCK_MS = 2000;

  const handleRefresh = useCallback(() => {
    triggerSync();
  }, []);

  const [rescanning, setRescanning] = useState(false);
  const handleRescanSpam = useCallback(async () => {
    if (!activeAccountId) return;
    const targets =
      activeAccountId === "all"
        ? accountsList
            .filter((a) => a.is_active)
            .map((a) => ({ id: a.id, email: a.email }))
        : (() => {
            const acc = accountsList.find((a) => a.id === activeAccountId);
            return acc ? [{ id: acc.id, email: acc.email }] : [];
          })();
    if (targets.length === 0) {
      toast.error(t("error"));
      return;
    }
    const scan = useSpamScanStore.getState();
    setRescanning(true);
    scan.begin(targets);
    try {
      let anyOk = false;
      let lastError = "";
      // Lance tous les comptes en parallele pour que chaque section
      // d'accordeon progresse en meme temps.
      await Promise.all(
        targets.map(async ({ id }) => {
          try {
            const res = await fetch(`/worker/rescan-spam-folder/${id}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ days: 90 }),
            });
            if (!res.ok || !res.body) {
              const d = await res.json().catch(() => ({}));
              const errMsg = (d as { error?: string }).error || t("error");
              useSpamScanStore.getState().failAccount(id, errMsg);
              lastError = errMsg;
              return;
            }
            anyOk = true;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let perAccountError = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let nl: number;
              while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                let evt: {
                  t?: string;
                  total?: number;
                  account?: string;
                  subject?: string;
                  from?: string;
                  status?: "recovered" | "kept";
                  error?: string;
                };
                try {
                  evt = JSON.parse(line);
                } catch {
                  continue;
                }
                const s = useSpamScanStore.getState();
                if (evt.t === "start") {
                  s.setAccountStart(id, evt.total ?? 0, evt.account ?? null);
                } else if (evt.t === "item") {
                  s.addItem(id, {
                    subject: evt.subject ?? "",
                    from: evt.from ?? "",
                    status: evt.status === "recovered" ? "recovered" : "kept",
                  });
                } else if (evt.t === "error") {
                  perAccountError = evt.error || "";
                }
              }
            }
            if (perAccountError) {
              useSpamScanStore.getState().failAccount(id, perAccountError);
              lastError = perAccountError;
            } else {
              useSpamScanStore.getState().finishAccount(id);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            useSpamScanStore.getState().failAccount(id, msg || t("error"));
            lastError = msg || t("error");
          }
        })
      );
      if (!anyOk) {
        scan.fail(lastError || t("error"));
        return;
      }
      scan.finishAll();
      triggerSync();
    } finally {
      setRescanning(false);
    }
  }, [activeAccountId, accountsList, t]);

  // En mode conversation, useMessages n'est pas utilise pour le listing
  const {
    threads,
    loading: threadsLoading,
    loadingMore: threadsLoadingMore,
    loadingDirection: threadsLoadingDirection,
    hasMoreBottom: threadsHasMoreBottom,
    hasMoreTop: threadsHasMoreTop,
    loadMoreBottom: threadsLoadMoreBottom,
    loadMoreTop: threadsLoadMoreTop,
    getThread,
    totalItems: threadsTotalItems,
    markAsRead: markThreadRead,
    markAsStarred: markThreadStarred,
    updateMessageLocal,
    newThreadIds,
  } = useThreads({ searchQuery: searchQuery || undefined, searchFilter, searchText });
  const {
    messages,
    totalItems: messagesTotalItems,
    loading: messagesLoading,
    loadingMore: messagesLoadingMore,
    loadingDirection: messagesLoadingDirection,
    hasMoreBottom: messagesHasMoreBottom,
    hasMoreTop: messagesHasMoreTop,
    loadMoreBottom: messagesLoadMoreBottom,
    loadMoreTop: messagesLoadMoreTop,
    markAsRead,
    markAsStarred: markMsgStarred,
  } = useMessages({ enabled: !conversationView, searchQuery: searchQuery || undefined, searchFilter, searchText });

  const loading = conversationView ? threadsLoading : messagesLoading;

  // Compact = UNE ligne par mail (avatar reduit, nom, sujet, heure, sans
  // apercu) ; confortable et spacieux gardent 2-3 lignes.
  const isCompact = density === "compact";
  const rowPadding = isCompact ? "py-1.5" : density === "spacious" ? "py-3.5" : "py-3";
  const compactRowClass = isCompact ? "items-center gap-2.5" : undefined;


  // IDs des dossiers spam pour detecter les messages spam dans toutes les vues
  const spamFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const f of folders) {
      if (f.type === "spam") ids.add(f.id);
    }
    return ids;
  }, [folders]);

  // IDs des dossiers brouillons pour detecter les brouillons dans toutes les vues
  const draftFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const f of folders) {
      if (f.type === "drafts") ids.add(f.id);
    }
    return ids;
  }, [folders]);

  // Map folder ID -> type pour les badges dans la vue "Tous les messages"
  const folderTypeMap = useMemo(() => {
    const map = new Map<string, { type: string; name: string }>();
    for (const f of folders) {
      map.set(f.id, { type: f.type, name: f.name });
    }
    return map;
  }, [folders]);

  const isAllMail = folderSlug === "all";

  const headerTitle = useMemo(() => {
    if (isLabelRoute) {
      return (routeLabelId && labelsById.get(routeLabelId)?.name) || t("labels");
    }
    return FOLDER_KEYS[folderSlug]
      ? t(FOLDER_KEYS[folderSlug])
      : folders.find((f) => f.id === folderSlug)?.name ?? folderSlug;
  }, [isLabelRoute, routeLabelId, labelsById, folderSlug, folders, t]);

  const openSearch = useMailStore((s) => s.openSearch);

  // Texte d'aide de la recherche (Miel ordinateur) : « Rechercher dans les
  // brouillons », « ... dans l'etiquette "X" », « ... dans "Dossier" ».
  const searchInPlaceholder = useMemo(() => {
    if (isLabelRoute) {
      const name = routeLabelId ? labelsById.get(routeLabelId)?.name : undefined;
      return name ? t("searchIn.label", { name }) : t("mail.searchPlaceholder");
    }
    if (FOLDER_KEYS[folderSlug]) return t(`searchIn.${folderSlug}`);
    return t("searchIn.folder", { name: headerTitle });
  }, [isLabelRoute, routeLabelId, labelsById, folderSlug, headerTitle, t]);

  // Thread IDs ayant un brouillon en cours (pour afficher le badge jaune)
  const [draftThreadIds, setDraftThreadIds] = useState<Set<string>>(new Set());
  const draftThreadSignal = useMailStore((s) => s.draftThreadSignal);

  useEffect(() => {
    if (folderSlug === "drafts") {
      setDraftThreadIds(new Set());
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const buildFilter = () => {
      const parts = ['is_draft = true', 'thread_id != ""'];
      if (activeAccountId && activeAccountId !== "all") {
        parts.push(`account = "${activeAccountId}"`);
      }
      return parts.join(" && ");
    };

    const fetchDrafts = () => {
      messagesCollection()
        .getFullList<Message>({ filter: buildFilter(), fields: "id,thread_id" })
        .then((drafts) => {
          if (cancelled) return;
          const ids = new Set<string>();
          for (const d of drafts) {
            if (d.thread_id) ids.add(d.thread_id);
          }
          setDraftThreadIds(ids);
        })
        .catch(() => {
          if (!cancelled) setDraftThreadIds(new Set());
        });
    };

    fetchDrafts();

    // Real-time draft updates handled by draftThreadSignal effect below

    return () => {
      cancelled = true;
    };
  }, [activeAccountId, folderSlug]);

  // Reagir au signal du store quand un brouillon est cree/supprime (fallback si realtime PB echoue)
  useEffect(() => {
    if (!draftThreadSignal || folderSlug === "drafts") return;
    const { threadId, action } = draftThreadSignal;
    if (!threadId) return;
    if (action === "add") {
      setDraftThreadIds((prev) => {
        if (prev.has(threadId)) return prev;
        const next = new Set(prev);
        next.add(threadId);
        return next;
      });
    } else {
      // Pour "remove", refetch car il peut rester d'autres brouillons pour ce thread
      const parts = ['is_draft = true', 'thread_id != ""'];
      if (activeAccountId && activeAccountId !== "all") {
        parts.push(`account = "${activeAccountId}"`);
      }
      messagesCollection()
        .getFullList<Message>({ filter: parts.join(" && "), fields: "id,thread_id" })
        .then((drafts) => {
          const ids = new Set<string>();
          for (const d of drafts) {
            if (d.thread_id) ids.add(d.thread_id);
          }
          setDraftThreadIds(ids);
        })
        .catch(() => {});
    }
  }, [draftThreadSignal, folderSlug, activeAccountId]);

  // Estimation de la hauteur d'un item selon les reglages
  const estimatedItemHeight = useMemo(() => {
    // Hauteurs de ligne ramenees a 16px de base (compact = une seule ligne,
    // confortable 2-3 lignes, spacieux 3-4) ; la base reelle suit le reglage
    // (globals.css : 14 / 15 / 16.5px) ; le virtualiseur mesure ensuite
    // chaque ligne reelle.
    const base = density === "compact" ? 36 : density === "spacious" ? 112 : 90;
    const root = uiScale === "medium" ? 15 : uiScale === "large" ? 16.5 : 14;
    const scale = root / 16;
    return Math.round(base * scale);
  }, [density, uiScale]);
  // Apercu : une ligne en confortable, deux en large, aucune en compact.
  const snippetClamp = density === "spacious" ? "line-clamp-2" : "truncate";

  // Groupement par expediteur : fusionner les threads des expediteurs designes
  const EXCLUDED_FOLDERS = useMemo(() => new Set(["sent", "drafts"]), []);
  const displayThreads = useMemo(() => {
    // Tri non-lus-en-tete desactive : liste triee par date decroissante.
    const unreadFirst = false;
    const sortedThreads =
      !conversationView || groupedSenders.length === 0 || EXCLUDED_FOLDERS.has(folderSlug)
        ? sortThreadsForDisplay(threads, unreadFirst)
        : applySenderGrouping(threads, groupedSenders, { unreadFirst });

    return pinItemAtPreviousIndex(sortedThreads, pinnedReadThreadPlacement, selectedThreadId);
  }, [threads, groupedSenders, conversationView, folderSlug, EXCLUDED_FOLDERS, pinnedReadThreadPlacement, selectedThreadId]);

  const displayMessages = useMemo(() => {
    const sortedMessages = [...messages].sort(getMessageComparator(folderSlug));
    return pinItemAtPreviousIndex(sortedMessages, pinnedReadMessagePlacement, selectedMessageId);
  }, [messages, folderSlug, pinnedReadMessagePlacement, selectedMessageId]);

  // Separateur "Deja lus" retire : les listes sont triees par date sans
  // regroupement non-lus/lus, donc plus de separateur a afficher.
  const firstReadThreadIndex = -1;
  const firstReadMessageIndex = -1;

  // Wrapper getThread pour aussi trouver les threads virtuels (sg:)
  const getThreadWrapped = useCallback((id: string) => {
    const original = getThread(id);
    if (original) return original;
    return displayThreads.find((t) => t.id === id);
  }, [getThread, displayThreads]);

  // Synchroniser le dossier actif avec la route
  // Ref pour eviter les appels redondants a setActiveFolder quand seul le metadata des dossiers change
  const lastFolderSyncRef = useRef<string>("");
  const setActiveLabel = useMailStore((s) => s.setActiveLabel);
  useEffect(() => {
    if (isLabelRoute) {
      const syncKey = `label|${routeLabelId ?? ""}`;
      if (syncKey === lastFolderSyncRef.current) return;
      lastFolderSyncRef.current = syncKey;
      setActiveLabel(routeLabelId);
      return;
    }

    let ids: string[];
    let type: FolderType;

    if (folderSlug === "starred") {
      ids = [];
      type = "starred";
    } else if (folderSlug === "unread") {
      ids = [];
      type = "unread";
    } else if (folderSlug === "all") {
      ids = [];
      type = "all_mail";
    } else {
      const folderById = folders.find((f) => f.id === folderSlug);
      if (folderById) {
        ids = [folderById.id];
        type = folderById.type as FolderType;
      } else {
        type = folderSlug as FolderType;
        ids = folders
          .filter((f) => f.type === type)
          .map((f) => f.id);
      }
    }

    // Ne pas rappeler setActiveFolder si les IDs et le type n'ont pas change
    const syncKey = `${type}|${ids.join(",")}`;
    if (syncKey === lastFolderSyncRef.current) return;
    lastFolderSyncRef.current = syncKey;

    setActiveFolder(ids, type);
  }, [folderSlug, folders, setActiveFolder, isLabelRoute, routeLabelId, setActiveLabel]);

  // La boite ouverte reste inscrite dans l'ADRESSE de l'ecran mail, meme apres
  // un changement de dossier (les liens de dossiers ne portent pas les
  // parametres) : sans ca, choisir une boite puis cliquer un dossier perdait la
  // boite au rechargement. Remplacement d'entree : ce n'est pas une navigation.
  useEffect(() => {
    if (!activeAccountId) return;
    const rawHash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    // L'ecran mail peut etre le FOND d'une modale (reglages, activite) : on ne
    // touche alors pas a l'adresse, qui appartient a la modale.
    if (!rawHash.startsWith("/mail")) return;
    const qIndex = rawHash.indexOf("?");
    const current = new URLSearchParams(qIndex >= 0 ? rawHash.slice(qIndex + 1) : "").get("a");
    const wanted = activeAccountId === "all" ? null : activeAccountId;
    if ((current || null) === wanted) return;
    hashSetParams({ a: wanted }, { replace: true });
  }, [activeAccountId, searchParams]);

  // Mettre a jour l'URL avec les IDs de selection (sans navigation).
  // On lit le chemin REEL depuis le hash live au moment de l'appel au lieu de
  // le reconstruire depuis folderSlug (closure). Sinon, une mise a jour de
  // selection encore en vol depuis le rendu du dossier precedent ecrase la
  // navigation qui vient d'avoir lieu (clic "Boite de reception" -> l'URL
  // revient sur /mail/all, d'ou l'obligation de cliquer deux fois). Ici on ne
  // touche qu'aux params t/m du dossier courant, jamais au chemin.
  const updateSelectionUrl = useCallback(
    (threadId: string | null, messageId: string | null) => {
      const rawHash = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;
      const qIndex = rawHash.indexOf("?");
      const livePath = qIndex >= 0 ? rawHash.slice(0, qIndex) : rawHash;
      const liveSearch = qIndex >= 0 ? rawHash.slice(qIndex + 1) : "";
      const p = new URLSearchParams(liveSearch);
      if (threadId) p.set("t", threadId);
      else p.delete("t");
      if (messageId) p.set("m", messageId);
      else p.delete("m");
      const qs = p.toString();
      replace(`${livePath}${qs ? `?${qs}` : ""}`);
    },
    [replace]
  );

  // MOBILE : l'ouverture d'une conversation est une vraie NAVIGATION (le fil
  // s'affiche en plein ecran par-dessus la liste). On empile donc une entree
  // d'historique -> le bouton "precedent" du navigateur / le geste de retour
  // referme le fil au lieu de quitter l'app, et un rechargement rouvre le fil.
  // Passer d'un fil a l'autre REMPLACE l'entree (sinon l'historique se remplit
  // d'une entree par conversation parcourue).
  const mobileSelectionPushedRef = useRef(false);
  const pushSelectionUrl = useCallback((threadId: string | null, messageId: string | null) => {
    const rawHash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const qIndex = rawHash.indexOf("?");
    const hadSelection = new URLSearchParams(qIndex >= 0 ? rawHash.slice(qIndex + 1) : "").get("t");
    if (!hadSelection) mobileSelectionPushedRef.current = true;
    hashSetParams({ t: threadId, m: messageId }, { replace: !!hadSelection });
  }, []);

  // Fermeture du drawer thread mobile : deselectionne (vaul joue l'animation de
  // sortie tout seul). La liste de fond n'est jamais demontee -> elle garde sa
  // position de scroll exacte.
  // Fil en cours de fermeture (id lu dans l'adresse au geste). Entre le geste
  // et l'arrivee du popstate de hashBack (asynchrone), `?t=` est ENCORE dans
  // l'adresse : sans ce garde, l'effet "adresse -> selection" (plus bas) voyait
  // une conversation dans l'adresse et rien de selectionne, et ROUVRAIT le fil
  // qu'on venait de fermer. Libere des que l'adresse perd (ou change) de fil.
  const closingThreadRef = useRef<string | null>(null);
  const closeThreadDrawer = useCallback(() => {
    const liveThread = readLiveHashParam("t");
    // Idempotent : X + onOpenChange du tiroir, ou double tap, pendant que le
    // retour arriere est en vol -> un seul hashBack (sinon on recule de 2 pas).
    if (liveThread && closingThreadRef.current === liveThread) {
      selectMessage(null, null, true);
      return;
    }
    closingThreadRef.current = liveThread;
    selectionWasUserInitiatedRef.current = false;
    // Un fil referme avant la fin du compte a rebours reste NON LU.
    cancelPendingMarkRead();
    setPinnedReadThreadPlacement(null);
    setPinnedReadMessagePlacement(null);
    selectMessage(null, null, true);
    // Retour en arriere quand c'est nous qui avions empile l'entree (ouverture
    // depuis la liste) : l'adresse redevient celle de la liste sans laisser
    // d'entree morte. Sinon (arrivee directe par un lien ou une notification),
    // on retire simplement la selection de l'adresse.
    if (mobileSelectionPushedRef.current) {
      mobileSelectionPushedRef.current = false;
      hashBack();
      // Filet : si l'entree precedente portait encore ce fil (historique
      // inattendu), on retire le parametre pour ne pas laisser le fil "ouvert"
      // dans l'adresse.
      window.setTimeout(() => {
        if (liveThread && readLiveHashParam("t") === liveThread) {
          updateSelectionUrl(null, null);
        }
      }, 600);
      return;
    }
    updateSelectionUrl(null, null);
  }, [selectMessage, updateSelectionUrl]);

  // Toute action qui doit refermer la conversation (blocage d'un expediteur,
  // marquage "non lu" depuis le fil ouvert) passe par le magasin et retombe sur
  // CE geste : meme resultat sur telephone (ou l'adresse tient le fil ouvert)
  // et sur ordinateur.
  useEffect(() => {
    autoMarkReadSecondsRef.current = autoMarkReadSeconds;
  }, [autoMarkReadSeconds]);

  // Quitter l'ecran annule un marquage "lu" encore en attente.
  useEffect(() => () => cancelPendingMarkRead(), []);

  useEffect(() => {
    registerCloseThread(closeThreadDrawer);
    return () => registerCloseThread(null);
  }, [closeThreadDrawer, registerCloseThread]);

  // Restaurer la selection persistee (mode conversation) - pas pour les brouillons
  const urlThreadId = searchParams.get("t");
  const urlMessageId = searchParams.get("m");

  useEffect(() => {
    if (!selectedThreadId && !selectedMessageId) {
      selectionWasUserInitiatedRef.current = false;
    }
  }, [selectedThreadId, selectedMessageId]);

  useEffect(() => {
    const wasMobile = prevIsMobileRef.current;
    prevIsMobileRef.current = isMobile;
    if (!isMobile || wasMobile) return;
    if (!selectedThreadId && !selectedMessageId) return;
    if (selectionWasUserInitiatedRef.current) return;

    selectMessage(null, null);
    updateSelectionUrl(null, null);
  }, [isMobile, selectedThreadId, selectedMessageId, selectMessage, updateSelectionUrl]);

  useEffect(() => {
    if (!conversationView || threadsLoading || selectedThreadId || displayThreads.length === 0 || folderSlug === "drafts" || isMobile) return;

    // Ne pas overrider une selection manuelle recente (ex: markAsRead declenche un rebuild)
    if (Date.now() - userSelectionTsRef.current < AUTO_ADVANCE_LOCK_MS) return;

    // 1. Priorite : URL params
    if (urlThreadId) {
      const thread = displayThreads.find((th) => th.id === urlThreadId);
      if (thread) {
        selectionWasUserInitiatedRef.current = false;
        selectMessage(urlMessageId || thread.lastMessage.id, thread.id);
        return;
      }
      // Le thread du URL n'est pas dans la fenetre de pagination courante.
      // Ne PAS fallback au premier thread — laisser ThreadView le charger depuis PB.
      return;
    }

    // 2. localStorage par compte/dossier
    if (activeAccountId) {
      try {
        const raw = localStorage.getItem(`imiel:lastThread:${activeAccountId}:${folderSlug}`);
        if (raw) {
          const saved = JSON.parse(raw) as { threadId: string };
          const thread = displayThreads.find((th) => th.id === saved.threadId);
          if (thread) {
            selectionWasUserInitiatedRef.current = false;
            selectMessage(thread.lastMessage.id, thread.id);
            updateSelectionUrl(thread.id, thread.lastMessage.id);
            return;
          }
        }
      } catch {}
    }

    // 3. localStorage global
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SELECTION);
      if (raw) {
        const saved = JSON.parse(raw) as { messageId: string; threadId: string | null } | null;
        if (saved?.threadId) {
          const thread = displayThreads.find((th) => th.id === saved.threadId);
          if (thread) {
            selectionWasUserInitiatedRef.current = false;
            selectMessage(thread.lastMessage.id, thread.id);
            updateSelectionUrl(thread.id, thread.lastMessage.id);
            return;
          }
        }
      }
    } catch {}

    // 4. Fallback : selectionner le premier thread (le plus recent)
    const firstThread = displayThreads[0];
    if (firstThread) {
      selectionWasUserInitiatedRef.current = false;
      selectMessage(firstThread.lastMessage.id, firstThread.id);
      updateSelectionUrl(firstThread.id, firstThread.lastMessage.id);
    }
  }, [conversationView, threadsLoading, displayThreads, selectedThreadId, selectMessage, activeAccountId, folderSlug, urlThreadId, urlMessageId, updateSelectionUrl]);

  // Restaurer la selection persistee (mode messages individuels)
  useEffect(() => {
    if (conversationView || messagesLoading || selectedMessageId || messages.length === 0 || isMobile) return;

    // Ne pas overrider une selection manuelle recente
    if (Date.now() - userSelectionTsRef.current < AUTO_ADVANCE_LOCK_MS) return;

    // 1. Priorite : URL params
    if (urlMessageId) {
      if (messages.some((m) => m.id === urlMessageId)) {
        selectionWasUserInitiatedRef.current = false;
        selectMessage(urlMessageId, urlThreadId || null);
        return;
      }
      // Le message du URL n'est pas dans la fenetre courante — ne pas fallback
      return;
    }

    // 2. localStorage par compte/dossier
    if (activeAccountId) {
      try {
        const raw = localStorage.getItem(`imiel:lastMessage:${activeAccountId}:${folderSlug}`);
        if (raw) {
          const saved = JSON.parse(raw) as { messageId: string; threadId: string | null };
          if (saved?.messageId && messages.some((m) => m.id === saved.messageId)) {
            selectionWasUserInitiatedRef.current = false;
            selectMessage(saved.messageId, saved.threadId);
            updateSelectionUrl(saved.threadId, saved.messageId);
            return;
          }
        }
      } catch {}
    }

    // 3. localStorage global
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SELECTION);
      if (raw) {
        const saved = JSON.parse(raw) as { messageId: string; threadId: string | null } | null;
        if (saved?.messageId && messages.some((m) => m.id === saved.messageId)) {
          selectionWasUserInitiatedRef.current = false;
          selectMessage(saved.messageId, saved.threadId);
          updateSelectionUrl(saved.threadId, saved.messageId);
          return;
        }
      }
    } catch {}

    // 4. Fallback : selectionner le premier message (le plus recent)
    const firstMsg = messages[0];
    if (firstMsg) {
      selectionWasUserInitiatedRef.current = false;
      selectMessage(firstMsg.id, firstMsg.thread_id || null);
      updateSelectionUrl(firstMsg.thread_id || null, firstMsg.id);
    }
  }, [conversationView, messagesLoading, messages, selectedMessageId, selectMessage, activeAccountId, folderSlug, urlMessageId, urlThreadId, updateSelectionUrl]);

  // MOBILE : l'adresse PORTE la conversation ouverte. `?t=<thread>&m=<message>`
  // arrive aussi bien d'un clic sur notification, d'un resultat de recherche,
  // d'un lien partage, d'un rechargement de page que de notre propre ouverture
  // depuis la liste : dans tous les cas on ouvre le fil et on le marque lu. Les
  // params ne sont PLUS consommes (c'est eux qui font tenir l'ecran ouvert au
  // rechargement) ; ils sont retires a la fermeture du fil.
  useEffect(() => {
    // L'adresse a perdu (ou change) le fil qu'on fermait : garde levee.
    if (closingThreadRef.current && urlThreadId !== closingThreadRef.current) {
      closingThreadRef.current = null;
    }
  }, [urlThreadId]);

  useEffect(() => {
    if (!isMobile) return;
    if (!urlThreadId || threadsLoading) return;
    if (selectedThreadId === urlThreadId) return;
    // Fil en cours de fermeture : `?t=` n'a pas encore quitte l'adresse.
    if (closingThreadRef.current === urlThreadId) return;

    lockSelection();
    userSelectionTsRef.current = Date.now();
    selectionWasUserInitiatedRef.current = true;

    const thread = getThreadWrapped(urlThreadId);
    selectMessage(urlMessageId || thread?.lastMessage.id || null, urlThreadId, true);

    // Marquer la conversation lue. Le thread peut etre hors fenetre de
    // pagination : on marque alors le message cible par la notification
    // (markAsRead persiste par id quoi qu'il arrive).
    const unread = thread
      ? thread.messages.filter((m) => !m.is_read)
      : urlMessageId
        ? [{ id: urlMessageId }]
        : [];
    if (unread.length === 0) {
      cancelPendingMarkRead();
      return;
    }
    scheduleMarkRead(`thread:${urlThreadId}`, autoMarkReadSecondsRef.current, () => {
      for (const m of unread) markThreadRead(m.id, true);
    });
  }, [
    isMobile,
    urlThreadId,
    urlMessageId,
    threadsLoading,
    selectedThreadId,
    getThreadWrapped,
    selectMessage,
    markThreadRead,
    lockSelection,
  ]);

  // MOBILE : l'adresse vient de perdre sa conversation (bouton "precedent" du
  // navigateur, geste de retour du telephone, fermeture du fil) -> on referme le
  // fil. On ne reagit qu'a la TRANSITION "il y avait une conversation dans
  // l'adresse -> il n'y en a plus" : une selection posee autrement (ouverture
  // depuis une fiche contact, par exemple) n'est jamais refermee par erreur.
  const prevUrlThreadIdRef = useRef<string | null>(urlThreadId);
  useEffect(() => {
    const had = prevUrlThreadIdRef.current;
    prevUrlThreadIdRef.current = urlThreadId;
    if (!isMobile) return;
    if (urlThreadId || !had) return;
    if (!selectedThreadId && !selectedMessageId) return;
    mobileSelectionPushedRef.current = false;
    selectionWasUserInitiatedRef.current = false;
    selectMessage(null, null, true);
  }, [isMobile, urlThreadId, selectedThreadId, selectedMessageId, selectMessage]);

  // Sauvegarder la selection par compte + dossier
  useEffect(() => {
    if (conversationView) {
      if (!selectedThreadId) return;
      try {
        const thread = getThreadWrapped(selectedThreadId);
        const accountId = thread?.lastMessage.account ?? activeAccountId;
        if (accountId) {
          localStorage.setItem(
            `imiel:lastThread:${accountId}:${folderSlug}`,
            JSON.stringify({ threadId: selectedThreadId })
          );
        }
        if (activeAccountId === "all") {
          localStorage.setItem(
            `imiel:lastThread:all:${folderSlug}`,
            JSON.stringify({ threadId: selectedThreadId })
          );
        }
      } catch {}
    } else {
      if (!selectedMessageId) return;
      const msg = messages.find((m) => m.id === selectedMessageId);
      if (!msg) return;
      try {
        localStorage.setItem(
          `imiel:lastMessage:${msg.account}:${folderSlug}`,
          JSON.stringify({ messageId: selectedMessageId, threadId: msg.thread_id || null })
        );
        if (activeAccountId === "all") {
          localStorage.setItem(
            `imiel:lastMessage:all:${folderSlug}`,
            JSON.stringify({ messageId: selectedMessageId, threadId: msg.thread_id || null })
          );
        }
      } catch {}
    }
  }, [conversationView, selectedMessageId, selectedThreadId, messages, getThreadWrapped, folderSlug, activeAccountId]);

  // Auto-advance : selectionner le voisin quand le thread/message selectionne disparait
  const prevThreadIdsRef = useRef<string[]>([]);
  const prevMessageIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!conversationView || threadsLoading || displayThreads.length === 0) {
      prevThreadIdsRef.current = displayThreads.map((t) => t.id);
      return;
    }

    if (selectedThreadId && !displayThreads.some((t) => t.id === selectedThreadId)) {
      // Ne pas auto-avancer si l'utilisateur vient de selectionner manuellement
      if (Date.now() - userSelectionTsRef.current < AUTO_ADVANCE_LOCK_MS) {
        prevThreadIdsRef.current = displayThreads.map((t) => t.id);
        return;
      }
      const prevIndex = prevThreadIdsRef.current.indexOf(selectedThreadId);
      const nextIndex = Math.min(prevIndex >= 0 ? prevIndex : 0, displayThreads.length - 1);
      const nextThread = displayThreads[nextIndex];
      if (nextThread) {
        selectionWasUserInitiatedRef.current = false;
        selectMessage(nextThread.lastMessage.id, nextThread.id);
      }
    }

    prevThreadIdsRef.current = displayThreads.map((t) => t.id);
  }, [conversationView, threadsLoading, selectedThreadId, displayThreads, selectMessage]);

  useEffect(() => {
    if (conversationView || messagesLoading || messages.length === 0) {
      prevMessageIdsRef.current = messages.map((m) => m.id);
      return;
    }

    if (selectedMessageId && !messages.some((m) => m.id === selectedMessageId)) {
      // Ne pas auto-avancer si l'utilisateur vient de selectionner manuellement
      if (Date.now() - userSelectionTsRef.current < AUTO_ADVANCE_LOCK_MS) {
        prevMessageIdsRef.current = messages.map((m) => m.id);
        return;
      }
      const prevIndex = prevMessageIdsRef.current.indexOf(selectedMessageId);
      const nextIndex = Math.min(prevIndex >= 0 ? prevIndex : 0, messages.length - 1);
      const nextMsg = messages[nextIndex];
      if (nextMsg) {
        selectionWasUserInitiatedRef.current = false;
        selectMessage(nextMsg.id, nextMsg.thread_id || null);
      }
    }

    prevMessageIdsRef.current = messages.map((m) => m.id);
  }, [conversationView, messagesLoading, selectedMessageId, messages, selectMessage]);

  // Handler pour le context menu : mise a jour visuelle directe + appel API
  const handleContextMarkAsRead = useCallback(async (messageId: string, read: boolean) => {
    updateMessageLocal(messageId, { is_read: read });
    sendAction({ action: "message-update", id: messageId, changes: { is_read: read } });
    const { activeFolder } = useMailStore.getState();
    if (activeFolder === "inbox") {
      useMailStore.getState().adjustSidebarCount("inboxUnread", read ? -1 : 1);
      sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: read ? -1 : 1 });
    }
    try {
      await updateMessageFlags(messageId, { is_read: read });
      useMailStore.getState().invalidateFolders();
      sendAction({ action: "invalidate-folders" });
    } catch {
      if (activeFolder === "inbox") {
        useMailStore.getState().adjustSidebarCount("inboxUnread", read ? 1 : -1);
        sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: read ? 1 : -1 });
      }
      sendAction({ action: "message-update", id: messageId, changes: { is_read: !read } });
    }
  }, [updateMessageLocal]);

  // Swipe vers la droite (palier 1) : bloque l'expediteur ET retire ses
  // messages du flux courant avec animation (blockSender -> notifySenderRemoval,
  // toast inclus ; le serveur filtrera ensuite via blocked_senders).
  const handleSwipeBlock = useCallback(async (email?: string) => {
    if (!email) return;
    await blockSender(email);
  }, []);

  // Swipe vers la droite au maximum (palier 2) : deplace en spam (toast via hook).
  const handleSwipeSpam = useCallback((id: string) => {
    moveToSpam(id);
  }, [moveToSpam]);

  // Swipe gauche au maximum (palier 2) : supprime (corbeille, toast via hook).
  const handleSwipeDelete = useCallback((id: string) => {
    moveToTrash(id);
  }, [moveToTrash]);

  const handleMailLayout = useCallback((layout: Record<string, number>) => {
    const firstValue = Object.values(layout)[0];
    if (firstValue !== undefined) {
      updateSize("mailListSize", firstValue);
    }
  }, [updateSize]);

  // Marquer tous les messages non lus d'un thread comme lus
  async function markThreadAsRead(threadId: string) {
    const thread = getThreadWrapped(threadId);
    if (!thread) return;
    for (const msg of thread.messages) {
      if (!msg.is_read) {
        await markThreadRead(msg.id, true);
      }
    }
  }

  async function handleSelectThread(threadId: string, matchMessageId?: string | null) {
    const thread = getThreadWrapped(threadId);
    if (!thread) return;

    // Ouvrir les brouillons dans le compose
    if (thread.lastMessage.is_draft) {
      openCompose("edit", thread.lastMessage.id);
      return;
    }

    // En recherche : ouvrir directement sur le message qui matche (scroll +
    // highlight dans ThreadView), sinon sur le dernier message du thread.
    const targetMessageId = matchMessageId || thread.lastMessage.id;
    setSearchMatch(matchMessageId ?? null);

    // Verrouiller la selection au niveau du store — aucun effet ne peut l'overrider
    lockSelection();
    userSelectionTsRef.current = Date.now();
    selectionWasUserInitiatedRef.current = true;
    const threadIndex = displayThreads.findIndex((item) => item.id === threadId);
    setPinnedReadThreadPlacement(
      thread.unreadCount > 0 && threadIndex >= 0 ? { id: threadId, index: threadIndex } : null
    );

    // Le passage en lu n'est plus immediat : on arme un compte a rebours
    // (reglage "Marquer lu apres", 5 s par defaut) annule des qu'on referme, ou
    // qu'on ouvre autre chose. Delai 0 = comportement immediat d'avant.
    if (thread.unreadCount > 0) {
      scheduleMarkRead(`thread:${threadId}`, autoMarkReadSeconds, () => {
        void markThreadAsRead(threadId);
      });
    } else {
      cancelPendingMarkRead();
    }

    if (isMobile) {
      selectMessage(targetMessageId, threadId, true);
      pushSelectionUrl(threadId, targetMessageId);
      return;
    }

    selectMessage(targetMessageId, threadId, true);
    updateSelectionUrl(threadId, targetMessageId);
  }

  async function handleSelectMessage(messageId: string) {
    const msg = messages.find((m) => m.id === messageId);

    // Ouvrir les brouillons dans le compose
    if (msg?.is_draft) {
      openCompose("edit", msg.id);
      return;
    }

    // Verrouiller la selection au niveau du store — aucun effet ne peut l'overrider
    lockSelection();
    userSelectionTsRef.current = Date.now();
    selectionWasUserInitiatedRef.current = true;
    const messageIndex = displayMessages.findIndex((item) => item.id === messageId);
    setPinnedReadMessagePlacement(
      msg && !msg.is_read && messageIndex >= 0 ? { id: messageId, index: messageIndex } : null
    );

    if (msg && !msg.is_read) {
      scheduleMarkRead(`message:${messageId}`, autoMarkReadSeconds, () => {
        void markAsRead(messageId);
      });
    } else {
      cancelPendingMarkRead();
    }

    if (isMobile && msg) {
      selectMessage(messageId, msg?.thread_id || null, true);
      pushSelectionUrl(msg.thread_id || null, messageId);
      return;
    }

    selectMessage(messageId, msg?.thread_id || null, true);
    updateSelectionUrl(msg?.thread_id || null, messageId);
  }

  // Formater les noms des participants pour l'affichage dans la liste
  function formatParticipants(thread: { participantNames: { name: string; address: string }[] }) {
    // Mes propres adresses s'affichent "Moi" (comme Gmail), une seule fois.
    const names: { name: string; address: string }[] = [];
    let meAdded = false;
    for (const p of thread.participantNames) {
      if (myEmails.has((p.address || "").toLowerCase())) {
        if (meAdded) continue;
        meAdded = true;
        names.push({ name: t("thread.me"), address: p.address });
      } else {
        names.push(p);
      }
    }
    if (names.length === 0) return "";
    if (names.length === 1) return stripReplacementChars(names[0].name);
    if (names.length === 2) return `${stripReplacementChars(names[0].name)}, ${stripReplacementChars(names[1].name)}`;
    return `${stripReplacementChars(names[0].name)}, ${stripReplacementChars(names[1].name)} +${names.length - 2}`;
  }

  function formatSentDisplay(
    from: { name?: string; address: string } | undefined,
    recipients: { name?: string; address: string }[] | undefined
  ) {
    const sender = stripReplacementChars(from?.name || from?.address || "");
    const to = recipients?.[0];
    const recipientName = stripReplacementChars(to?.name || to?.address || "");
    if (!recipientName) return sender;
    if (recipients && recipients.length > 1) {
      return `${sender} \u2192 ${recipientName} +${recipients.length - 1}`;
    }
    return `${sender} \u2192 ${recipientName}`;
  }

  const handleClearSearch = () => {
    const basePath =
      isLabelRoute && routeLabelId
        ? `/mail/label/${routeLabelId}`
        : `/mail/${folderSlug}`;
    replace(basePath);
  };



  const isTrashOrSpam = folderSlug === "trash" || folderSlug === "spam";
  // Le swipe-droite "Spam" n'a de sens que hors spam/corbeille/envoyes/brouillons.
  const spamSwipeAllowed =
    folderSlug !== "spam" &&
    folderSlug !== "trash" &&
    folderSlug !== "sent" &&
    folderSlug !== "drafts";
  // Le 2e palier du swipe gauche (suppression -> corbeille) est dispo partout
  // sauf dans la corbeille (ou la seule suppression serait definitive).
  const deleteSwipeAllowed = folderSlug !== "trash";
  const allItemIds = conversationView
    ? displayThreads.map((th) => th.lastMessage.id)
    : displayMessages.map((m) => m.id);
  const checkedCount = checkedIds.size;
  const allChecked = checkedCount > 0 && checkedCount === allItemIds.length;

  async function handleBulkDelete() {
    const ids = Array.from(checkedIds);
    if (ids.length === 0) return;
    if (isTrashOrSpam) {
      await bulkPermanentDelete(ids);
    } else {
      await bulkMoveToTrash(ids);
    }
    uncheckAll();
    setBulkDeleteOpen(false);
  }

  async function handleBulkNotSpam() {
    const ids = Array.from(checkedIds);
    if (ids.length === 0) return;
    await bulkMoveToInbox(ids);
    uncheckAll();
  }

  async function handleBulkRestore() {
    const ids = Array.from(checkedIds);
    if (ids.length === 0) return;
    await bulkMoveToInbox(ids);
    uncheckAll();
  }

  async function handleBulkMarkRead(read: boolean) {
    const checked = Array.from(checkedIds);
    if (checked.length === 0) return;

    const isReadById = new Map<string, boolean>();
    if (conversationView) {
      for (const th of displayThreads) {
        isReadById.set(th.lastMessage.id, th.lastMessage.is_read);
      }
    } else {
      for (const m of messages) {
        isReadById.set(m.id, m.is_read);
      }
    }
    const ids = checked.filter((id) => isReadById.get(id) !== read);

    if (ids.length > 0) {
      await bulkMarkAsRead(ids, read);
    }
    uncheckAll();
  }

  async function handleBulkSpam() {
    const ids = Array.from(checkedIds);
    if (ids.length === 0) return;
    await bulkMoveToSpam(ids);
    uncheckAll();
  }

  // Regrouper : reunit les expediteurs des conversations cochees en UN groupe
  // (ou complete le groupe existant de l'un d'eux). Seulement en vue
  // conversation, la ou le groupement s'applique.
  const groupingAvailable = conversationView && !EXCLUDED_FOLDERS.has(folderSlug);
  async function handleBulkGroup() {
    const checked = new Set(checkedIds);
    if (checked.size === 0) return;
    const addresses = new Set<string>();
    for (const th of displayThreads) {
      if (!checked.has(th.lastMessage.id)) continue;
      const addr = threadSenderAddress(th);
      if (addr) addresses.add(addr);
    }
    uncheckAll();
    if (addresses.size === 0) return;
    await groupSenders(Array.from(addresses));
    toast.success(t("message.senderGrouped"));
  }

  async function handleBulkTrack() {
    const ids = Array.from(checkedIds);
    if (ids.length === 0) return;
    uncheckAll();
    // Suivi decouple de l'etoile (favori) : on suit explicitement les
    // conversations selectionnees (le worker cree la fiche + analyse le fil).
    let ok = 0;
    for (const id of ids) {
      if (await trackThread(id)) ok++;
    }
    if (ok > 0) toast.success(t("tracking.addedCount", { count: String(ok) }));
  }

  const bulkBar = checkedCount > 0 ? (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/50 px-3 py-1.5 md:px-4">
      <span className="shrink-0 text-xs font-medium">
        {t("bulk.selected", { count: String(checkedCount) })}
      </span>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={() => handleBulkMarkRead(true)}
              aria-label={t("bulk.markAsRead")}
            >
              <MailOpen className="size-3.5 shrink-0" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("bulk.markAsRead")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={() => handleBulkMarkRead(false)}
              aria-label={t("bulk.markAsUnread")}
            >
              <Mail className="size-3.5 shrink-0" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("bulk.markAsUnread")}</TooltipContent>
        </Tooltip>
        {folderSlug !== "spam" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={handleBulkSpam}
                aria-label={t("bulk.moveToSpam")}
              >
                <ShieldAlert className="size-3.5 shrink-0" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("bulk.moveToSpam")}</TooltipContent>
          </Tooltip>
        )}
        {folderSlug === "spam" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 gap-1 px-2 text-xs"
                onClick={handleBulkNotSpam}
                aria-label={t("message.notSpam")}
              >
                <Inbox className="size-3.5 shrink-0" />
                <span className="hidden sm:inline">{t("message.notSpam")}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("message.notSpam")}</TooltipContent>
          </Tooltip>
        )}
        {folderSlug === "trash" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 gap-1 px-2 text-xs"
                onClick={handleBulkRestore}
                aria-label={t("message.restore")}
              >
                <Inbox className="size-3.5 shrink-0" />
                <span className="hidden sm:inline">{t("message.restore")}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("message.restore")}</TooltipContent>
          </Tooltip>
        )}
        {folderSlug !== "spam" && folderSlug !== "trash" && folderSlug !== "drafts" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={handleBulkTrack}
                aria-label={t("tracking.createFromMail")}
              >
                <PackageSearch className="size-3.5 shrink-0" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("tracking.createFromMail")}</TooltipContent>
          </Tooltip>
        )}
        {groupingAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={handleBulkGroup}
                aria-label={t("bulk.group")}
                data-ref="bulk-group"
              >
                <Users className="size-3.5 shrink-0" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("bulk.group")}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-destructive hover:text-destructive"
              onClick={() => setBulkDeleteOpen(true)}
              aria-label={t("bulk.delete")}
            >
              <Trash2 className="size-3.5 shrink-0" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("bulk.delete")}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  ) : null;

  const bulkDeleteDialog = (
    <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isTrashOrSpam
              ? t("bulk.deletePermanentlyConfirmTitle", { count: String(checkedCount) })
              : t("bulk.deleteConfirmTitle", { count: String(checkedCount) })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isTrashOrSpam
              ? t("bulk.deletePermanentlyConfirmDescription")
              : t("bulk.deleteConfirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={handleBulkDelete}>
            {t("bulk.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const listCount = conversationView
    ? `${displayThreads.length}${threadsHasMoreBottom ? "+" : ""} ${displayThreads.length !== 1 ? t("thread.conversations") : t("thread.conversation")}`
    : `${messagesTotalItems} ${messagesTotalItems !== 1 ? t("thread.messages") : t("thread.message")}`;

  // Barre du haut : nom du dossier ou de l'etiquette, et sur ordinateur le
  // compteur de la liste juste a cote (plus de rangee vide au-dessus des filtres).
  usePageTitle(headerTitle, listCount);

  // Apparence Miel sur ordinateur : le titre (avec son compteur) et la barre
  // de synchronisation entrent dans le bloc de la liste (maquette validee) ;
  // la barre du haut et le layout les omettent (useListChrome).
  const isMiel = useIsMiel();
  const mielListChrome = isMiel && !isMobile;
  useListChrome(mielListChrome);

  // "Reanalyser le spam" : dans la rangee de recherche sur telephone, au bout
  // de la rangee des filtres sur ordinateur.
  const rescanSpamButton = folderSlug === "spam" && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          onClick={handleRescanSpam}
          disabled={rescanning}
          aria-label={t("mail.rescanSpam")}
          data-ref="mail-rescan-spam"
        >
          <ShieldCheck className={cn("size-4", rescanning && "animate-spin")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {rescanning ? t("mail.rescanSpamRunning") : t("mail.rescanSpam")}
      </TooltipContent>
    </Tooltip>
  );

  // En-tete de liste (charte) : le titre et le compteur vivent dans la barre du
  // haut ; ici, sur telephone, le champ de recherche (palette globale), puis la
  // rangee de pastilles.
  const listHeader = (
    <>
      {mielListChrome ? (
        // Miel ordinateur : la recherche prend la place du titre, en tete du
        // bloc de la liste. Son texte d'aide nomme la page mais elle ouvre la
        // recherche GLOBALE (tous les mails, decision utilisateur) ; le titre
        // et le compteur restent pour les lecteurs d'ecran.
        <div data-ref="mail-list-title" className="flex min-w-0 items-center gap-2 pt-4 pr-[18px] pb-1 pl-4">
          <h1 data-ref="folder-title" className="sr-only">
            {headerTitle}
          </h1>
          <span data-ref="mail-folder-count" className="sr-only">
            {listCount}
          </span>
          <div className="relative min-w-0 flex-1">
            <SearchField
              onActivate={openSearch}
              placeholder={searchQuery || searchInPlaceholder}
              className={cn(searchQuery && "pr-11 text-foreground")}
              data-ref="mail-list-search"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={handleClearSearch}
                aria-label={t("filter.clear")}
                className="absolute top-1/2 right-3 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>
      ) : (
        <h1 data-ref="folder-title" className="sr-only">
          {headerTitle}
        </h1>
      )}
      <div className="flex items-center gap-2 px-[10px] pt-1 pb-3 md:hidden">
        {/* Telephone : champ de recherche de la liste (sur ordinateur, la
            recherche vit au centre de la barre du haut). */}
        <div className="relative min-w-0 flex-1 md:hidden">
          <SearchField
            onActivate={openSearch}
            placeholder={searchQuery || t("mail.searchPlaceholder")}
            className={cn(searchQuery && "pr-11 text-foreground")}
            data-ref="mail-search"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={handleClearSearch}
              aria-label={t("filter.clear")}
              className="absolute top-1/2 right-2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        {rescanSpamButton}
      </div>
      <FilterBar
        allItemIds={allItemIds}
        activeLabelId={isLabelRoute ? routeLabelId : null}
        onRefresh={handleRefresh}
        trailing={rescanSpamButton ? <div className="hidden md:block">{rescanSpamButton}</div> : undefined}
      />
    </>
  );

  const listContent = conversationView ? (
    // Mode conversation : afficher les threads
    <div data-ref="mail-list-block" className="flex h-full flex-col overflow-hidden">
      {/* Telephone : bandeau des echeances, recherche et filtres se replient
          quand on descend dans la liste (sauf pendant une selection). */}
      <CollapsibleTop forceVisible={checkedCount > 0} data-ref="mail-list-top">
        <SuggestionsBanner />
        {listHeader}
      </CollapsibleTop>
      {bulkBar}
      {bulkDeleteDialog}

      {loading ? (
        <div className="flex flex-1 flex-col gap-1 p-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <MessageSkeleton key={i} />
          ))}
        </div>
      ) : displayThreads.length === 0 ? (
        <div data-ref="mail-folder-empty" className="flex flex-1 flex-col items-center justify-center py-12 text-muted-foreground">
          <MailListEmptyState />
        </div>
      ) : (
        <VirtualMailList
          items={displayThreads}
          hasMoreBottom={threadsHasMoreBottom}
          hasMoreTop={threadsHasMoreTop}
          loadingMore={threadsLoadingMore}
          loadingDirection={threadsLoadingDirection}
          onLoadMoreBottom={threadsLoadMoreBottom}
          onLoadMoreTop={threadsLoadMoreTop}
          onRefresh={triggerSync}
          estimatedItemHeight={estimatedItemHeight}
          getItemKey={(thread) => thread.id}
          preserveScrollKey={selectedThreadId}
          bottomInset={undefined}
          renderItem={(thread, index) => {
            const showReadSeparator = index === firstReadThreadIndex;
            const isSelected = selectedThreadId === thread.id && !isMobile;
            // Ligne en cours de retrait (suppression/blocage) : tous les
            // messages visibles du thread sont marques -> animation slide-out.
            const isRemoving =
              removingMessageIds.size > 0 &&
              thread.messages.every((m) => removingMessageIds.has(m.id));
            const isDrafts = folderSlug === "drafts";
            const isSent = folderSlug === "sent";
            const isSpam = spamFolderIds.has(thread.lastMessage.folder);
            const isUnreadRow = thread.unreadCount > 0 && !isSpam;
            const isDraft = !isDrafts && draftFolderIds.has(thread.lastMessage.folder);
            const hasDraftInThread = !isDrafts && (
              draftThreadIds.has(thread.id) ||
              thread.messages.some(m => m.thread_id && draftThreadIds.has(m.thread_id))
            );
            const msgId = thread.lastMessage.id;
            const isChecked = checkedIds.has(msgId);
            const folderInfo = isAllMail ? folderTypeMap.get(thread.lastMessage.folder) : null;

            if (isDrafts) {
              const recipientDisplay = (thread.lastMessage.to_addresses ?? [])
                .map((r) => r.name || r.address)
                .filter(Boolean)
                .join(", ");
              return (
                <>
                  {showReadSeparator && <ReadSectionSeparator label={t("mail.sectionRead")} />}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectThread(thread.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelectThread(thread.id); } }}
                    className={cn(
                      MAIL_ROW_CLASS,
                      rowPadding,
                      compactRowClass,
                      isSelected && ROW_SELECTED_CLASS,
                      isRemoving && "animate-message-slide-out"
                    )}
                  >
                    {/* Brouillon : avatar du premier destinataire (meme colonne
                        que les autres lignes) ; un clic dessus coche la ligne. */}
                    <SenderAvatar
                      name={thread.lastMessage.to_addresses?.[0]?.name || thread.lastMessage.to_addresses?.[0]?.address || recipientDisplay}
                      email={thread.lastMessage.to_addresses?.[0]?.address || ""}
                      size={isCompact ? "sm" : "default"}
                      isDraft
                      isScheduled={!!thread.lastMessage.scheduled_at}
                      checked={isChecked}
                      onClick={() => toggleChecked(msgId)}
                      className="self-center"
                    />
                    <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[0.9375rem] font-medium">
                        {stripReplacementChars(thread.subject) || t("message.noSubject")}
                      </span>
                      {thread.lastMessage.scheduled_at ? (
                        <ScheduledSendCountdown
                          draftId={thread.lastMessage.id}
                          scheduledAt={thread.lastMessage.scheduled_at}
                        />
                      ) : (
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {formatRelativeDate(thread.lastMessage.date)}
                        </span>
                      )}
                    </div>
                    {recipientDisplay && (
                      <span className="truncate text-sm text-muted-foreground">
                        {stripReplacementChars(recipientDisplay)}
                      </span>
                    )}
                    </div>
                  </div>
                </>
              );
            }

            const isSenderGroup = thread.id.startsWith("sg:");
            // Message qui matche la recherche (pour marquer la ligne + ouvrir dessus).
            const matchedMsg = searchQuery && !isSenderGroup ? findThreadMatch(thread) : null;
            // Extrait/date : dernier message REEL du fil (sa reponse comprise).
            const previewMsg = matchedMsg ?? thread.displayMessage;
            const awaitingSince = getAwaitingReplySince(thread.displayMessage, {
              myEmails,
              correspondents,
              answered: thread.displayAnswered,
              labelName: (id) => labelsById.get(id)?.name,
              isSpam,
            });
            const displayName = isSenderGroup
              ? stripReplacementChars(thread.subject)
              : isSent
                ? formatSentDisplay(thread.lastMessage.from_address, thread.lastMessage.to_addresses)
                : formatParticipants(thread);
            const subjectDisplay = isSenderGroup
              ? t("senderGroup.conversations", {
                  count: String(new Set(thread.messages.map((m) => m.thread_id).filter(Boolean)).size || 1),
                })
              : stripReplacementChars(thread.subject) || t("message.noSubject");
            // Favicon : sur "Envoyes" l'auteur est l'utilisateur -> on ancre sur
            // le destinataire (le contact reel), sinon sur l'expediteur.
            const avatarEmail = isSent
              ? thread.lastMessage.to_addresses?.[0]?.address || thread.lastMessage.from_address?.address || ""
              : thread.lastMessage.from_address?.address || "";

            return (
            <>
              {showReadSeparator && <ReadSectionSeparator label={t("mail.sectionRead")} />}
              {/* Wrapper stable pour l'animation de sortie : la classe est posee
                  ici (et pas sur SwipeableMailRow) pour ne pas ecraser le
                  translateX inline du swipe. */}
              <div className={cn(isRemoving && "animate-message-slide-out")}>
              <MessageContextMenu message={thread.lastMessage} threadMessages={thread.messages} onMarkAsRead={handleContextMarkAsRead} onOpenConversation={() => handleSelectThread(thread.id)}>
              <SwipeableMailRow
                readState={thread.unreadCount === 0}
                importance={threadImportance(thread.messages)}
                onSwipeLeft={() => {
                  if (thread.unreadCount > 0) {
                    markThreadAsRead(thread.id);
                    toast.success(t("message.markedRead"));
                  } else {
                    handleContextMarkAsRead(thread.lastMessage.id, false);
                    toast.success(t("message.markedUnread"));
                  }
                }}
                onSwipeLeftFull={deleteSwipeAllowed ? () => handleSwipeDelete(thread.lastMessage.id) : undefined}
                onSwipeRight={spamSwipeAllowed ? () => handleSwipeBlock(thread.lastMessage.from_address?.address) : undefined}
                onSwipeRightFull={spamSwipeAllowed ? () => handleSwipeSpam(thread.lastMessage.id) : undefined}
                onClick={() => handleSelectThread(thread.id, matchedMsg?.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelectThread(thread.id, matchedMsg?.id); } }}
                className={cn(
                  MAIL_ROW_CLASS,
                  rowPadding,
                  compactRowClass,
                  isSelected ? ROW_SELECTED_CLASS : isUnreadRow && ROW_UNREAD_CLASS,
                  isSpam && !isSelected && "opacity-50",
                  newThreadIds.has(thread.id) && "animate-message-slide-in"
                )}
                >
                {/* Logo de l'auteur ; un clic sur l'avatar coche la ligne (la
                    coche remplace le logo). Ligne groupee : ses deux
                    interlocuteurs principaux, dans le meme encombrement. */}
                {isSenderGroup ? (
                  <SenderAvatarPair
                    people={senderGroupAvatars(thread, myEmails)}
                    size={isCompact ? "sm" : "default"}
                    folderType={folderInfo?.type}
                    isSpam={isSpam}
                    isDraft={isDraft || hasDraftInThread}
                    isUnread={isUnreadRow}
                    checked={isChecked}
                    onClick={() => toggleChecked(msgId)}
                    className={isCompact ? "self-center" : "self-start"}
                  />
                ) : (
                  <SenderAvatar
                    name={displayName}
                    email={avatarEmail}
                    size={isCompact ? "sm" : "default"}
                    folderType={folderInfo?.type}
                    isSpam={isSpam}
                    isDraft={isDraft || hasDraftInThread}
                    isUnread={isUnreadRow}
                    checked={isChecked}
                    onClick={() => toggleChecked(msgId)}
                    className={isCompact ? "self-center" : "self-start"}
                  />
                )}
                {(() => {
                  const countBadge = thread.fullMessageCount > 1 && (
                    <ParticipantsPopover details={thread.participantDetails}>
                      <button
                        type="button"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex h-5 min-w-5 shrink-0 cursor-default items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-medium text-foreground"
                        aria-label={`${thread.fullMessageCount} ${thread.fullMessageCount > 1 ? t("thread.messages") : t("thread.message")}`}
                      >
                        {thread.fullMessageCount}
                      </button>
                    </ParticipantsPopover>
                  );
                  const starAndTracked = (
                    <>
                      <MailRowStarButton
                        starred={thread.isStarred}
                        selectedColored={false}
                        removeLabel={t("message.removeFavorite")}
                        onToggle={() => markThreadStarred(thread.lastMessage.id)}
                      />
                      <MailRowTrackedBadge
                        threadIds={[thread.id, ...thread.messages.map((m) => m.thread_id)]}
                        selectedColored={false}
                        label={t("tracking.tracked")}
                      />
                      <MailRowBriefBadge
                        threadIds={[thread.id, ...thread.messages.map((m) => m.thread_id)]}
                        selectedColored={false}
                        label={t("thread.briefTitle")}
                      />
                    </>
                  );
                  const meta = (
                    <div className={cn("flex shrink-0 items-center gap-1.5 pl-1", !isCompact && "ml-auto")}>
                      {thread.hasAttachments && (
                        <Paperclip className="size-3.5 text-muted-foreground" />
                      )}
                      <ReadStatusChecks messageId={thread.displayMessage.id} messageRfc={thread.displayMessage.message_id} isSent={isMineMessage(thread.displayMessage)} selectedColored={false} />
                      {awaitingSince ? (
                        <AwaitingReplyBadge since={awaitingSince} selectedColored={false} />
                      ) : (
                        <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                          {formatListDate(thread.displayMessage.date)}
                        </span>
                      )}
                    </div>
                  );
                  const searchMark = matchedMsg && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Search className="size-3.5 shrink-0 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>{t("search.matchInThread")}</TooltipContent>
                    </Tooltip>
                  );
                  const nameClass = cn(
                    "min-w-0 truncate text-[0.9375rem]",
                    isUnreadRow ? "font-semibold text-foreground" : "font-medium text-foreground",
                    isSpam && "text-muted-foreground"
                  );
                  const subject = (
                    <span
                      data-ref="message-row-subject"
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm",
                        isSpam ? "text-muted-foreground" : "text-foreground"
                      )}
                    >
                      {subjectDisplay}
                    </span>
                  );
                  const rowLabels = Array.from(
                    new Set(thread.messages.flatMap((m) => m.labels || []))
                  );
                  const unreadDot = isUnreadRow && <UnreadDot data-ref="message-row-unread-dot" />;

                  if (isCompact) {
                    // Une seule ligne : nom (colonne bornee), sujet, etiquette
                    // (ordinateur seulement), heure, point de non-lu.
                    return (
                      <div data-ref="message-row-compact" className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className={cn(nameClass, "w-[32%] max-w-48 shrink-0")}>{displayName}</span>
                        {countBadge}
                        {searchMark}
                        {subject}
                        {starAndTracked}
                        {rowLabels.length > 0 && (
                          <span className="hidden shrink-0 md:inline-flex">
                            <MessageLabels max={1} labelIds={rowLabels} />
                          </span>
                        )}
                        {meta}
                        {unreadDot}
                      </div>
                    );
                  }

                  return (
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      {/* Ligne 1 : expediteur (gras si non lu), compteur, heure */}
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className={nameClass}>{displayName}</span>
                        {countBadge}
                        {starAndTracked}
                        {meta}
                      </div>
                      {/* Ligne 2 : sujet + point de non-lu */}
                      <div className="flex min-w-0 items-center gap-2">
                        {searchMark}
                        {subject}
                        {unreadDot}
                      </div>
                      {/* Ligne 3 : apercu gris + etiquette */}
                      {(previewLines > 0 && previewMsg.snippet) || rowLabels.length > 0 ? (
                        <div className="flex min-w-0 items-end gap-2">
                          <span className={cn("min-w-0 flex-1 text-sm text-muted-foreground", snippetClamp)}>
                            {previewLines > 0 ? stripReplacementChars(previewMsg.snippet || "") : ""}
                          </span>
                          <MessageLabels max={1} labelIds={rowLabels} />
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
              </SwipeableMailRow>
            </MessageContextMenu>
              </div>
            </>
            );
          }}
        />
      )}
    </div>
  ) : (
    // Mode messages individuels (ancien comportement)
    <div data-ref="mail-list-block" className="flex h-full flex-col overflow-hidden">
      {/* Telephone : bandeau des echeances, recherche et filtres se replient
          quand on descend dans la liste (sauf pendant une selection). */}
      <CollapsibleTop forceVisible={checkedCount > 0} data-ref="mail-list-top">
        <SuggestionsBanner />
        {listHeader}
      </CollapsibleTop>
      {bulkBar}
      {bulkDeleteDialog}

      {loading ? (
        <div className="flex flex-1 flex-col gap-1 p-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <MessageSkeleton key={i} />
          ))}
        </div>
      ) : displayMessages.length === 0 ? (
        <div data-ref="mail-folder-empty" className="flex flex-1 flex-col items-center justify-center py-12 text-muted-foreground">
          <MailListEmptyState />
        </div>
      ) : (
        <VirtualMailList
          items={displayMessages}
          hasMoreBottom={messagesHasMoreBottom}
          hasMoreTop={messagesHasMoreTop}
          loadingMore={messagesLoadingMore}
          loadingDirection={messagesLoadingDirection}
          onLoadMoreBottom={messagesLoadMoreBottom}
          onLoadMoreTop={messagesLoadMoreTop}
          onRefresh={triggerSync}
          estimatedItemHeight={estimatedItemHeight}
          getItemKey={(msg) => msg.id}
          preserveScrollKey={selectedMessageId}
          bottomInset={undefined}
          renderItem={(msg, index) => {
            const showReadSeparator = index === firstReadMessageIndex;
            const isSelected = selectedMessageId === msg.id && !isMobile;
            // Ligne en cours de retrait (suppression/blocage) : animation slide-out.
            const isRemoving = removingMessageIds.has(msg.id);
            const isDrafts = folderSlug === "drafts";
            const isSent = folderSlug === "sent";
            const isMsgSpam = spamFolderIds.has(msg.folder);
            const msgUnread = !msg.is_read && !isMsgSpam;
            const isMsgDraft = !isDrafts && draftFolderIds.has(msg.folder);
            const hasMsgDraftInThread = !isDrafts && draftThreadIds.has(msg.thread_id || "");
            const isMsgChecked = checkedIds.has(msg.id);
            const msgFolderInfo = isAllMail ? folderTypeMap.get(msg.folder) : null;

            if (isDrafts) {
              const recipientDisplay = (msg.to_addresses ?? [])
                .map((r) => r.name || r.address)
                .filter(Boolean)
                .join(", ");
              return (
                <>
                  {showReadSeparator && <ReadSectionSeparator label={t("mail.sectionRead")} />}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectMessage(msg.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelectMessage(msg.id); } }}
                    className={cn(
                      MAIL_ROW_CLASS,
                      rowPadding,
                      compactRowClass,
                      isSelected && ROW_SELECTED_CLASS,
                      isRemoving && "animate-message-slide-out"
                    )}
                  >
                    {/* Brouillon : avatar du premier destinataire (meme colonne
                        que les autres lignes) ; un clic dessus coche la ligne. */}
                    <SenderAvatar
                      name={msg.to_addresses?.[0]?.name || msg.to_addresses?.[0]?.address || recipientDisplay}
                      email={msg.to_addresses?.[0]?.address || ""}
                      size={isCompact ? "sm" : "default"}
                      isDraft
                      isScheduled={!!msg.scheduled_at}
                      checked={isMsgChecked}
                      onClick={() => toggleChecked(msg.id)}
                      className="self-center"
                    />
                    <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[0.9375rem] font-medium">
                        {stripReplacementChars(msg.subject) || t("message.noSubject")}
                      </span>
                      {msg.scheduled_at ? (
                        <ScheduledSendCountdown
                          draftId={msg.id}
                          scheduledAt={msg.scheduled_at}
                        />
                      ) : (
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {formatRelativeDate(msg.date)}
                        </span>
                      )}
                    </div>
                    {recipientDisplay && (
                      <span className="truncate text-sm text-muted-foreground">
                        {stripReplacementChars(recipientDisplay)}
                      </span>
                    )}
                    </div>
                  </div>
                </>
              );
            }

            const displayName = isSent
              ? formatSentDisplay(msg.from_address, msg.to_addresses)
              : stripReplacementChars(msg.from_address?.name || msg.from_address?.address || "");
            // Favicon : ancre sur le destinataire en "Envoyes", sinon l'expediteur.
            const avatarEmail = isSent
              ? msg.to_addresses?.[0]?.address || msg.from_address?.address || ""
              : msg.from_address?.address || "";

            return (
            <>
              {showReadSeparator && <ReadSectionSeparator label={t("mail.sectionRead")} />}
              {/* Wrapper stable pour l'animation de sortie (cf mode conversation) */}
              <div className={cn(isRemoving && "animate-message-slide-out")}>
              <MessageContextMenu message={msg} onMarkAsRead={markAsRead} onOpenConversation={() => handleSelectMessage(msg.id)}>
              <SwipeableMailRow
                readState={msg.is_read}
                importance={msg.importance}
                onSwipeLeft={() => {
                  markAsRead(msg.id, !msg.is_read);
                  toast.success(t(msg.is_read ? "message.markedUnread" : "message.markedRead"));
                }}
                onSwipeLeftFull={deleteSwipeAllowed ? () => handleSwipeDelete(msg.id) : undefined}
                onSwipeRight={spamSwipeAllowed ? () => handleSwipeBlock(msg.from_address?.address) : undefined}
                onSwipeRightFull={spamSwipeAllowed ? () => handleSwipeSpam(msg.id) : undefined}
                onClick={() => handleSelectMessage(msg.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelectMessage(msg.id); } }}
                className={cn(
                  MAIL_ROW_CLASS,
                  rowPadding,
                  compactRowClass,
                  isSelected ? ROW_SELECTED_CLASS : msgUnread && ROW_UNREAD_CLASS,
                  isMsgSpam && !isSelected && "opacity-50"
                )}
              >
                {/* Logo de l'auteur ; un clic sur l'avatar coche la ligne. */}
                <SenderAvatar
                  name={displayName}
                  email={avatarEmail}
                  size={isCompact ? "sm" : "default"}
                  folderType={msgFolderInfo?.type}
                  isSpam={isMsgSpam}
                  isScheduled={!!msg.scheduled_at}
                  isDraft={isMsgDraft || hasMsgDraftInThread}
                  isUnread={msgUnread}
                  checked={isMsgChecked}
                  onClick={() => toggleChecked(msg.id)}
                  className={isCompact ? "self-center" : "self-start"}
                />
                {(() => {
                  const nameClass = cn(
                    "min-w-0 truncate text-[0.9375rem] text-foreground",
                    msgUnread ? "font-semibold" : "font-medium",
                    isMsgSpam && "text-muted-foreground"
                  );
                  const starAndTracked = (
                    <>
                      <MailRowStarButton
                        starred={msg.is_starred}
                        selectedColored={false}
                        removeLabel={t("message.removeFavorite")}
                        onToggle={() => markMsgStarred(msg.id)}
                      />
                      <MailRowTrackedBadge
                        threadIds={[msg.thread_id]}
                        selectedColored={false}
                        label={t("tracking.tracked")}
                      />
                      <MailRowBriefBadge
                        threadIds={[msg.thread_id]}
                        selectedColored={false}
                        label={t("thread.briefTitle")}
                      />
                    </>
                  );
                  const meta = (
                    <div className={cn("flex shrink-0 items-center gap-1.5 pl-1", !isCompact && "ml-auto")}>
                      {msg.has_attachments && (
                        <Paperclip className="size-3.5 text-muted-foreground" />
                      )}
                      <ReadStatusChecks messageId={msg.id} messageRfc={msg.message_id} isSent={isSent || isMineMessage(msg)} selectedColored={false} />
                      <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatListDate(msg.date)}
                      </span>
                    </div>
                  );
                  const subject = (
                    <span
                      data-ref="message-row-subject"
                      className={cn("min-w-0 flex-1 truncate text-sm", isMsgSpam ? "text-muted-foreground" : "text-foreground")}
                    >
                      {stripReplacementChars(msg.subject) || t("message.noSubject")}
                    </span>
                  );
                  const unreadDot = msgUnread && <UnreadDot data-ref="message-row-unread-dot" />;
                  const hasLabels = (msg.labels?.length ?? 0) > 0;

                  if (isCompact) {
                    return (
                      <div data-ref="message-row-compact" className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className={cn(nameClass, "w-[32%] max-w-48 shrink-0")}>{displayName}</span>
                        {subject}
                        {starAndTracked}
                        {hasLabels && (
                          <span className="hidden shrink-0 md:inline-flex">
                            <MessageLabels labelIds={msg.labels} max={1} />
                          </span>
                        )}
                        {meta}
                        {unreadDot}
                      </div>
                    );
                  }

                  return (
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className={nameClass}>{displayName}</span>
                        {starAndTracked}
                        {meta}
                      </div>
                      <div className="flex min-w-0 items-center gap-2">
                        {subject}
                        {unreadDot}
                      </div>
                      {(previewLines > 0 && msg.snippet) || hasLabels ? (
                        <div className="flex min-w-0 items-end gap-2">
                          <span className={cn("min-w-0 flex-1 text-sm text-muted-foreground", snippetClamp)}>
                            {previewLines > 0 ? stripReplacementChars(msg.snippet || "") : ""}
                          </span>
                          <MessageLabels labelIds={msg.labels} max={1} />
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
              </SwipeableMailRow>
            </MessageContextMenu>
              </div>
            </>
            );
          }}
        />
      )}
    </div>
  );

  // Mobile : la liste reste montee (donc garde sa position de scroll) et la
  // conversation s'ouvre dans le tiroir commun du telephone (MobileThreadDrawer :
  // poignee, arret sous la barre du haut, clavier iOS). La pilule "Rediger"
  // flotte en bas au centre, sous le tiroir (z-40 < z-50).
  if (isMobile) {
    return (
      <div data-ref="mail-folder-page" className="relative h-full">
        {listContent}
        {/* Barre du pied : « Rediger » en rond au centre (sous les tiroirs). */}
        <MobileFooterBar compose onCompose={() => openCompose("new")} />
        <MobileThreadDrawer
          open={!!selectedThreadId}
          onClose={closeThreadDrawer}
          threadId={selectedThreadId}
          threads={threads}
          loading={threadsLoading}
          getThread={getThreadWrapped}
          onContentClickCapture={flushMarkReadOnContentClick}
        />
      </div>
    );
  }

  // Un clic dans la conversation ouverte la passe en lu sans attendre le delai.
  const previewPanel = (
    <div className="flex h-full flex-col overflow-hidden" onClickCapture={flushMarkReadOnContentClick}>
      <ThreadView threads={threads} loading={threadsLoading} getThread={getThreadWrapped} />
    </div>
  );

  // Brouillons ou panneau de lecture desactive : liste uniquement
  if (readingPane === "off" || folderSlug === "drafts") {
    return (
      <div data-ref="mail-folder-page" className="h-full">
        {listContent}
      </div>
    );
  }

  // Desktop : panneau en bas
  if (readingPane === "bottom") {
    return (
      <ResizablePanelGroup data-ref="mail-folder-page" orientation="vertical" className="h-full" onLayoutChanged={handleMailLayout}>
        <ResizablePanel defaultSize={`${sizes.mailListSize}%`} minSize="20%">
          {listContent}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={`${100 - sizes.mailListSize}%`} minSize="20%">
          {previewPanel}
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  // Desktop : panneau a droite (defaut)
  return (
    <ResizablePanelGroup data-ref="mail-folder-page" orientation="horizontal" className="h-full" onLayoutChanged={handleMailLayout}>
      <ResizablePanel defaultSize={`${sizes.mailListSize}%`} minSize="20%">
        {listContent}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={`${100 - sizes.mailListSize}%`} minSize="30%">
        {previewPanel}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function ReadSectionSeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-[10px] pt-3 pb-1.5 md:px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
      <span className="h-px flex-1 bg-border" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function MessageSkeleton() {
  return (
    <div className="flex items-center gap-2.5 border-b px-3 py-2">
      {/* Favicon expediteur (meme gabarit que SenderAvatar : size-8 rounded-md) */}
      <Skeleton className="size-8 shrink-0 rounded-md" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-5 rounded-full" />
        </div>
        <Skeleton className="h-4 w-full max-w-64" />
      </div>
      <div className="flex shrink-0 items-center">
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
    </div>
  );
}
