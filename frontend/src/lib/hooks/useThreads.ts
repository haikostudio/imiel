"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import pbClient, { messages, retryUpdate, updateMessageFlags, type Message } from "@/lib/pocketbase";
import { t as tStatic } from "@/lib/i18n";
import { useMailStore, REMOVAL_ANIM_MS } from "@/lib/stores/mail-store";
import { folderToCountKey } from "@/lib/hooks/useMessageActions";
import { groupMessagesByThread, normalizeSubject } from "@/lib/utils/threading";
import { sendAction } from "@/lib/ws-channel";
import { clearMailListPageCache, fetchMailListPage } from "@/lib/mail-list-api";
import { fetchMailSearchPage } from "@/lib/mail-search-api";
import { mergeMailListPage } from "@/lib/mail-list-merge";

const PAGE_SIZE = 50;
const WINDOW_SIZE = 300;
const REBUILD_DEBOUNCE_MS = 100;

const LIST_FIELDS =
  "id,account,folder,thread_id,message_id,in_reply_to,references," +
  "from_address,to_addresses,cc_addresses,subject,snippet,date," +
  "is_read,is_starred,is_answered,is_draft,is_sent,has_attachments," +
  "priority,uid,labels,spam_score,spam_action,importance";

// PocketBase 0.25 rejette les filtres > ~100 expressions : on hydrate une liste
// d'ids par lots courts (chacun AND-e a la contrainte du dossier/compte), puis
// on reordonne selon l'ordre d'origine (tri decide par la palette).
const SEARCH_ID_CHUNK = 75;

async function hydrateMessagesByIds(
  ids: string[],
  structuralFilter: string
): Promise<Message[]> {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += SEARCH_ID_CHUNK) {
    chunks.push(ids.slice(i, i + SEARCH_ID_CHUNK));
  }
  const pages = await Promise.all(
    chunks.map((chunk) => {
      const idFilter = "(" + chunk.map((id) => `id = "${id}"`).join(" || ") + ")";
      const filter = structuralFilter ? `${idFilter} && ${structuralFilter}` : idFilter;
      return messages().getList<Message>(1, chunk.length, {
        filter,
        fields: LIST_FIELDS,
      });
    })
  );
  const byId = new Map<string, Message>();
  for (const page of pages) for (const m of page.items) byId.set(m.id, m);
  return ids.map((id) => byId.get(id)).filter((m): m is Message => !!m);
}

export interface ParticipantDetail {
  address: string;
  name: string;
  role: "interlocutor" | "cc";
}

export interface Thread {
  id: string;
  subject: string;
  messages: Message[];
  lastMessage: Message;
  participants: string[];
  participantNames: { name: string; address: string }[];
  participantDetails: ParticipantDetail[];
  unreadCount: number;
  hasAttachments: boolean;
  isStarred: boolean;
  fullMessageCount: number;
  /**
   * Dernier message REEL de la conversation, tous dossiers confondus (sa propre
   * reponse comprise, via `thread_tails` de /api/mail/list) : c'est ce que la
   * ligne affiche (extrait, date). `lastMessage` reste le dernier message DE LA
   * VUE et porte les actions (ouvrir, favori, bloquer l'expediteur...).
   */
  displayMessage: Message;
  /** Une copie du message affiche (autre compte lie) porte le flag "repondu" */
  displayAnswered: boolean;
}

interface WindowState {
  startPage: number;
  endPage: number;
  totalPages: number;
  totalItems: number;
}

interface UseThreadsReturn {
  threads: Thread[];
  totalItems: number;
  loading: boolean;
  loadingMore: boolean;
  loadingDirection: "top" | "bottom" | null;
  hasMoreBottom: boolean;
  hasMoreTop: boolean;
  newThreadIds: Set<string>;
  loadMoreBottom: () => Promise<void>;
  loadMoreTop: () => Promise<void>;
  getThread: (threadId: string) => Thread | undefined;
  markAsRead: (messageId: string, read?: boolean) => Promise<void>;
  markAsStarred: (messageId: string) => Promise<void>;
  moveToTrash: (messageId: string) => Promise<void>;
  archiveMessage: (messageId: string) => Promise<void>;
  moveToSpam: (messageId: string) => Promise<void>;
  /** Mise a jour optimiste locale du pageMap + rebuild threads (sans appel API) */
  updateMessageLocal: (messageId: string, changes: Partial<Message>) => void;
}

/** Dedupliquer les messages par message_id normalise (Gmail dossiers multiples, double sync) */
export function deduplicateMessages(msgs: Message[]): Message[] {
  const seen = new Set<string>();
  return msgs.filter((m) => {
    const rawId = (m.message_id || "").replace(/^<|>$/g, "").toLowerCase().trim();
    const key = rawId || `${m.from_address?.address || ""}|${m.date}|${m.subject || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildThread(threadMessages: Message[], groupKey?: string): Thread {
  const sorted = deduplicateMessages(
    [...threadMessages].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    )
  );
  const last = sorted[sorted.length - 1];

  const participantMap = new Map<string, { address: string; name: string }>();
  const fromMap = new Map<string, { name: string; address: string }>();
  const interlocutorAddrs = new Set<string>(); // from + to
  for (const msg of sorted) {
    if (msg.from_address?.address) {
      const addr = msg.from_address.address;
      const key = addr.toLowerCase();
      interlocutorAddrs.add(key);
      if (!participantMap.has(key) || (msg.from_address.name && msg.from_address.name !== addr)) {
        participantMap.set(key, { address: addr, name: msg.from_address.name || addr });
      }
      if (!fromMap.has(key)) {
        fromMap.set(key, {
          name: msg.from_address.name || addr,
          address: addr,
        });
      }
    }
    for (const to of msg.to_addresses ?? []) {
      if (to.address) {
        const key = to.address.toLowerCase();
        interlocutorAddrs.add(key);
        if (!participantMap.has(key) || (to.name && to.name !== to.address)) {
          participantMap.set(key, { address: to.address, name: to.name || to.address });
        }
      }
    }
    for (const cc of msg.cc_addresses ?? []) {
      if (cc.address) {
        const key = cc.address.toLowerCase();
        if (!participantMap.has(key) || (cc.name && cc.name !== cc.address)) {
          participantMap.set(key, { address: cc.address, name: cc.name || cc.address });
        }
      }
    }
  }

  // Un mail recu sur deux comptes lies existe en double : seule une copie
  // porte parfois le flag \Answered -> union sur les copies du dernier message.
  const lastMid = normalizeMessageId(last.message_id);
  const displayAnswered = threadMessages.some(
    (m) => m.is_answered && (m.id === last.id || (!!lastMid && normalizeMessageId(m.message_id) === lastMid))
  );

  // Construire les details des participants avec leur role
  const participantDetails: ParticipantDetail[] = [];
  for (const [key, { address, name }] of participantMap) {
    participantDetails.push({
      address,
      name,
      role: interlocutorAddrs.has(key) ? "interlocutor" : "cc",
    });
  }

  return {
    id: groupKey || last.thread_id || last.message_id || last.id,
    subject: normalizeSubject(last.subject ?? ""),
    messages: sorted,
    lastMessage: last,
    participants: Array.from(participantMap.keys()),
    participantNames: Array.from(fromMap.values()),
    participantDetails,
    unreadCount: sorted.filter((m) => !m.is_read).length,
    hasAttachments: sorted.some((m) => m.has_attachments),
    isStarred: sorted.some((m) => m.is_starred),
    fullMessageCount: sorted.length,
    displayMessage: last,
    displayAnswered,
  };
}

function normalizeMessageId(mid: string | undefined | null): string {
  return (mid || "").replace(/^<|>$/g, "").toLowerCase().trim();
}

function dateMs(m: Message): number {
  const t = new Date(m.date).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Applique le DERNIER message de chaque fil (tous dossiers, envoyes compris)
 * aux conversations construites depuis les messages de la vue : la ligne
 * affiche la derniere reponse, comme Gmail. Tri par date de ce dernier message.
 * `tails` : thread_id -> dernier message (reponse /api/mail/list with_tails).
 */
export function applyThreadTails(threads: Thread[], tails: Map<string, Message>): Thread[] {
  if (tails.size > 0) {
    for (const thread of threads) {
      let tail: Message | undefined;
      const seen = new Set<string>();
      for (const m of thread.messages) {
        const tid = m.thread_id;
        if (!tid || seen.has(tid)) continue;
        seen.add(tid);
        const cand = tails.get(tid);
        if (cand && (!tail || dateMs(cand) > dateMs(tail))) tail = cand;
      }
      if (!tail) continue;
      const display = thread.displayMessage;
      const sameMessage =
        tail.id === display.id ||
        (!!tail.message_id && normalizeMessageId(tail.message_id) === normalizeMessageId(display.message_id));
      if (sameMessage) {
        if (tail.is_answered) thread.displayAnswered = true;
        continue;
      }
      if (dateMs(tail) <= dateMs(display)) continue;
      thread.displayMessage = tail;
      thread.displayAnswered = !!tail.is_answered;
      const addr = tail.from_address?.address;
      if (addr && !thread.participantNames.some((p) => p.address.toLowerCase() === addr.toLowerCase())) {
        thread.participantNames = [
          ...thread.participantNames,
          { name: tail.from_address.name || addr, address: addr },
        ];
      }
    }
  }
  return threads.sort((a, b) => dateMs(b.displayMessage) - dateMs(a.displayMessage));
}

/** Integre les `thread_tails` d'une reponse de liste ; true si quelque chose a change. */
function mergeTails(target: Map<string, Message>, incoming: Record<string, Message> | null | undefined): boolean {
  if (!incoming) return false;
  let changed = false;
  for (const [tid, msg] of Object.entries(incoming)) {
    const prev = target.get(tid);
    if (
      !prev ||
      prev.id !== msg.id ||
      prev.is_answered !== msg.is_answered ||
      prev.is_read !== msg.is_read ||
      prev.snippet !== msg.snippet
    ) {
      target.set(tid, msg);
      changed = true;
    }
  }
  return changed;
}

export function buildThreadsFromMessages(
  allMessages: Message[],
  opts?: { unreadFirst?: boolean }
): Thread[] {
  const groups = groupMessagesByThread(allMessages);
  const threads = Object.entries(groups).map(([key, msgs]) => buildThread(msgs, key));
  if (opts?.unreadFirst) {
    return threads.sort((a, b) => {
      const au = a.unreadCount > 0 ? 0 : 1;
      const bu = b.unreadCount > 0 ? 0 : 1;
      if (au !== bu) return au - bu;
      return (
        new Date(b.lastMessage.date).getTime() -
        new Date(a.lastMessage.date).getTime()
      );
    });
  }
  return threads.sort(
    (a, b) =>
      new Date(b.lastMessage.date).getTime() -
      new Date(a.lastMessage.date).getTime()
  );
}

// Meme taille de page pour TOUS les dossiers (cf. useMessages). En mode
// conversation, une page de messages donne encore MOINS de lignes (regroupement
// par fil) : avec 20, "Envoyes" n'affichait qu'une quinzaine de conversations.
function getPageSize(_folder: string) {
  return PAGE_SIZE;
}

/** Recuperer tous les messages des pages dans la fenetre */
function getWindowedMessages(
  pageMap: Map<number, Message[]>,
  win: WindowState
): Message[] {
  const all: Message[] = [];
  for (let p = win.startPage; p <= win.endPage; p++) {
    const pageItems = pageMap.get(p);
    if (pageItems) all.push(...pageItems);
  }
  return all;
}

function preserveThreadOrder(nextThreads: Thread[], previousOrder: string[]): Thread[] {
  if (previousOrder.length === 0) return nextThreads;
  const order = new Map(previousOrder.map((id, index) => [id, index]));
  return nextThreads
    .map((thread, index) => ({ thread, index }))
    .sort((a, b) => {
      const ai = order.get(a.thread.id);
      const bi = order.get(b.thread.id);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ thread }) => thread);
}

/** Compter le total des messages dans la fenetre */
function countWindowedMessages(
  pageMap: Map<number, Message[]>,
  win: WindowState
): number {
  let count = 0;
  for (let p = win.startPage; p <= win.endPage; p++) {
    count += pageMap.get(p)?.length ?? 0;
  }
  return count;
}

/** Trimmer les pages du haut pour rester sous WINDOW_SIZE */
function trimTop(pageMap: Map<number, Message[]>, win: WindowState): void {
  while (countWindowedMessages(pageMap, win) > WINDOW_SIZE && win.startPage < win.endPage) {
    pageMap.delete(win.startPage);
    win.startPage++;
  }
}

/** Trimmer les pages du bas pour rester sous WINDOW_SIZE */
function trimBottom(pageMap: Map<number, Message[]>, win: WindowState): void {
  while (countWindowedMessages(pageMap, win) > WINDOW_SIZE && win.endPage > win.startPage) {
    pageMap.delete(win.endPage);
    win.endPage--;
  }
}

export function useThreads(options?: { enabled?: boolean; searchQuery?: string; searchFilter?: string; searchText?: string; searchIds?: string[]; searchAdvFilter?: string }): UseThreadsReturn {
  const enabled = options?.enabled ?? true;
  const searchFilter = options?.searchFilter;
  const searchText = options?.searchText;
  // Recherche servie par le worker (meme moteur que la palette, pagination
  // cote serveur, sans plafond). searchText / searchFilter ne servent plus que
  // de repli si le worker est injoignable.
  const searchQuery = options?.searchQuery;
  // Recherche par liste d'ids (resultats hybrides) : hydratation par lots
  // pagines de l'INTEGRALITE des ids, sans plafond (cf useMessages).
  const searchIds = options?.searchIds;
  const searchAdvFilter = options?.searchAdvFilter;
  const searchIdsKey = searchIds ? searchIds.join(",") : "";
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDirection, setLoadingDirection] = useState<"top" | "bottom" | null>(null);
  const [newThreadIds, setNewThreadIds] = useState<Set<string>>(new Set());
  const newThreadTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pageMapRef = useRef<Map<number, Message[]>>(new Map());
  // Cache de l'hydratation complete du mode recherche-par-ids.
  const searchHydrationRef = useRef<{ key: string; messages: Message[] } | null>(null);
  const windowRef = useRef<WindowState>({ startPage: 1, endPage: 1, totalPages: 1, totalItems: 0 });
  const loadingMoreRef = useRef(false);
  const threadsLengthRef = useRef(0);
  const threadsOrderRef = useRef<string[]>([]);
  const lastFetchKeyRef = useRef("");
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchPageRef = useRef<(page: number) => Promise<{ items: Message[]; totalPages: number; totalItems: number; thread_tails?: Record<string, Message> | null }>>(null!);
  // thread_id -> dernier message du fil tous dossiers confondus (cf applyThreadTails)
  const tailsRef = useRef<Map<string, Message>>(new Map());
  const crossFolderCountsRef = useRef<Map<string, number>>(new Map());
  const lastFetchTimestampRef = useRef<string>("");
  const prevNewMsgSignalRef = useRef(0);
  // Requete (dossier/compte/filtres) du dernier chargement reussi : distingue
  // un CHANGEMENT de liste (skeletons legitimes) d'un simple RAFRAICHISSEMENT
  // de la meme liste (fusion en place, aucun vidage). Cf useMessages.
  const lastQueryKeyRef = useRef("");

  /** Marquer des conversations comme "nouvelles" (animation slide-in ~600ms). */
  const markThreadsAsNew = useCallback((threadIds: string[]) => {
    if (threadIds.length === 0) return;
    setNewThreadIds((prev) => {
      const next = new Set(prev);
      for (const id of threadIds) next.add(id);
      return next;
    });
    for (const id of threadIds) {
      const existingTimer = newThreadTimersRef.current.get(id);
      if (existingTimer) clearTimeout(existingTimer);
      newThreadTimersRef.current.set(
        id,
        setTimeout(() => {
          setNewThreadIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          newThreadTimersRef.current.delete(id);
        }, 600)
      );
    }
  }, []);

  const rebuildThreads = (msgs: Message[]): Thread[] => {
    // Tri non-lus-en-tete desactive : threads tries par date decroissante.
    const threads = buildThreadsFromMessages(msgs, { unreadFirst: false });
    const counts = crossFolderCountsRef.current;
    for (const thread of threads) {
      // Sommer les counts cross-folder de tous les thread_id (threads fusionnes)
      const uniqueTids = [...new Set(thread.messages.map(m => m.thread_id).filter(Boolean))];
      let totalCount = 0;
      let hasCount = false;
      for (const tid of uniqueTids) {
        if (tid && counts.has(tid)) {
          totalCount += counts.get(tid)!;
          hasCount = true;
        }
      }
      if (hasCount) {
        thread.fullMessageCount = totalCount;
      }
    }
    return applyThreadTails(threads, tailsRef.current);
  };

  /** Fetch real cross-folder message counts for all threads and store in ref */
  const fetchCrossFolderCounts = async (threadList: Thread[]): Promise<boolean> => {
    // Collecter tous les thread_id uniques de tous les messages (threads fusionnes)
    const threadIds = [...new Set(
      threadList
        .flatMap(t => t.messages.map(m => m.thread_id))
        .filter((id): id is string => !!id && !crossFolderCountsRef.current.has(id))
    )];

    if (threadIds.length === 0) return false;

    try {
      // SQL-direct (bypass des access rules per-row) : un COUNT(DISTINCT message
      // normalise) par thread_id. Remplace les anciens getFullList par lots de 30
      // sur l'API record (0,3-0,6 s/lot) qui ralentissaient chaque ouverture de
      // dossier (Envoyes/Spam...). Batching pour borner la longueur d'URL.
      const BATCH_SIZE = 200;
      const counts: Record<string, number> = {};

      for (let i = 0; i < threadIds.length; i += BATCH_SIZE) {
        const batch = threadIds.slice(i, i + BATCH_SIZE);
        const res = await pbClient.send<{ counts: Record<string, number> }>(
          `/api/mail/thread-counts?thread_ids=${encodeURIComponent(batch.join(","))}`,
          { method: "GET" }
        );
        Object.assign(counts, res.counts || {});
      }

      let changed = false;
      for (const tid of threadIds) {
        // Un thread sans message correspondant (rare) compte 0 -> ignorer.
        const size = counts[tid] ?? 0;
        if (size > 0 && crossFolderCountsRef.current.get(tid) !== size) {
          crossFolderCountsRef.current.set(tid, size);
          changed = true;
        }
      }

      return changed;
    } catch {
      return false;
    }
  };

  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const activeFolderIds = useMailStore((s) => s.activeFolderIds);
  const activeFolder = useMailStore((s) => s.activeFolder);
  const activeLabelId = useMailStore((s) => s.activeLabelId);
  const refreshKey = useMailStore((s) => s.messagesRefreshKey);
  const newMessagesSignal = useMailStore((s) => s.newMessagesSignal);
  const localMessageUpdate = useMailStore((s) => s.localMessageUpdate);
  const localMessageRemoval = useMailStore((s) => s.localMessageRemoval);
  const localSenderRemoval = useMailStore((s) => s.localSenderRemoval);
  const listFilter = useMailStore((s) => s.listFilter);
  const listFilterKey = JSON.stringify(listFilter);
  const pageSize = getPageSize(activeFolder);

  // Cle stable pour les deps d'effets (evite les re-runs sur nouvelle reference de tableau)
  const folderKey = activeFolderIds.join(",");

  const filterReady =
    // Les vues virtuelles (starred/all_mail) n'ont pas besoin de folder ids,
    // mais on attend que le compte actif soit resolu : sinon, au reload, on
    // tire une requete globale (tous comptes, sans filtre account) qui ne peut
    // pas utiliser l'index composite (account, ...) -> scan complet + tri en
    // memoire sur des dizaines de milliers de mails. On attend activeAccountId
    // (specifique ou "all" explicite) comme inbox attend ses folders.
    ((activeFolder === "starred" || activeFolder === "all_mail" || activeFolder === "unread") && activeAccountId !== null) ||
    (activeFolder === "label" && !!activeLabelId) ||
    activeFolderIds.length > 0;

  const hasMoreBottom = windowRef.current.endPage < windowRef.current.totalPages;
  const hasMoreTop = windowRef.current.startPage > 1;

  const buildFilter = useCallback(() => {
    const parts: string[] = [];
    if (activeFolder === "starred") {
      parts.push("is_starred = true");
    } else if (activeFolder === "all_mail") {
      parts.push("is_sent = false");
    } else if (activeFolder === "unread") {
      parts.push("is_read = false");
    } else if (activeFolder === "label" && activeLabelId) {
      parts.push(`labels.id ?= "${activeLabelId}"`);
      parts.push("is_sent = false");
    } else if (activeFolderIds.length === 1) {
      parts.push(`folder = "${activeFolderIds[0]}"`);
    } else if (activeFolderIds.length > 1) {
      const folderFilter = activeFolderIds
        .map((id) => `folder = "${id}"`)
        .join(" || ");
      parts.push(`(${folderFilter})`);
    }
    if (activeAccountId && activeAccountId !== "all") {
      parts.push(`account = "${activeAccountId}"`);
    }
    if (searchFilter) {
      parts.push(searchFilter);
    }
    if (searchText && searchText.trim()) {
      const escaped = searchText.trim().replace(/"/g, '\\"');
      parts.push(`(subject ~ "${escaped}" || from_address ~ "${escaped}" || to_addresses ~ "${escaped}")`);
    }
    if (listFilter.unread) parts.push("is_read = false");
    if (listFilter.hasAttachments) parts.push("has_attachments = true");
    if (listFilter.starred) parts.push("is_starred = true");
    if (listFilter.priority !== "all") parts.push(`priority = "${listFilter.priority}"`);
    if (listFilter.importance) parts.push(`importance = "${listFilter.importance}"`);
    if (listFilter.fromText.trim()) {
      const escaped = listFilter.fromText.trim().replace(/"/g, '\\"');
      parts.push(`(from_address.address ~ "${escaped}" || from_address.name ~ "${escaped}")`);
    }
    if (listFilter.bodyText.trim()) {
      const escaped = listFilter.bodyText.trim().replace(/"/g, '\\"');
      parts.push(`(subject ~ "${escaped}" || text_body ~ "${escaped}")`);
    }
    // Filtrer brouillons : inclure seulement les vrais brouillons dans la vue brouillons
    if (activeFolder === "drafts") {
      parts.push("is_draft = true");
    } else {
      parts.push("is_draft = false");
    }
    return parts.join(" && ");
  }, [activeAccountId, activeFolderIds, activeFolder, activeLabelId, searchFilter, searchText, listFilter]);

  const fetchPagePbFallback = useCallback(
    async (page: number) => {
      const filter = buildFilter();
      return messages().getList<Message>(page, pageSize, {
        filter,
        sort: "-date",
        fields: LIST_FIELDS,
      });
    },
    [buildFilter, pageSize]
  );

  // Recherche par liste d'ids : hydratation complete UNE fois (bornee au
  // dossier/compte + operateurs avances), puis pagination memoire. Plus de
  // plafond a 75 ; total annonce exact pour le dossier.
  const fetchSearchIdsPage = useCallback(
    async (page: number) => {
      const ids = searchIds ?? [];
      const structural = searchAdvFilter ? `${buildFilter()} && ${searchAdvFilter}` : buildFilter();
      const cacheKey = `${ids.join(",")}|${structural}`;
      let cached = searchHydrationRef.current;
      if (!cached || cached.key !== cacheKey) {
        const hydrated = await hydrateMessagesByIds(ids, structural);
        cached = { key: cacheKey, messages: hydrated };
        searchHydrationRef.current = cached;
      }
      const all = cached.messages;
      const total = all.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const start = (page - 1) * pageSize;
      return { items: all.slice(start, start + pageSize), totalPages, totalItems: total };
    },
    [searchIds, searchAdvFilter, buildFilter, pageSize]
  );

  const fetchPage = useCallback(
    async (page: number) => {
      if (searchQuery) {
        try {
          return await fetchMailSearchPage({
            query: searchQuery,
            page,
            perPage: pageSize,
            accountId: activeAccountId,
            scope: {
              view:
                activeFolder === "starred" ? "starred" :
                activeFolder === "all_mail" ? "all_mail" :
                activeFolder === "unread" ? "unread" : undefined,
              labelId: activeFolder === "label" ? (activeLabelId ?? undefined) : undefined,
              folderIds: activeFolder !== "label" ? activeFolderIds : undefined,
              excludeSecondary: activeFolder === "inbox",
              isDraft: activeFolder === "drafts" ? true : (activeFolder === "label" ? undefined : false),
              filter: {
                unread: listFilter.unread,
                starred: listFilter.starred,
                hasAttachments: listFilter.hasAttachments,
                priority: listFilter.priority,
                fromText: listFilter.fromText,
                importance: listFilter.importance,
              },
            },
          });
        } catch (err) {
          console.warn("[useThreads] /worker/search/mail failed, fallback", err);
        }
      }
      if (searchIds) {
        return fetchSearchIdsPage(page);
      }
      if (searchFilter) {
        return fetchPagePbFallback(page);
      }

      const view =
        activeFolder === "starred" ? "starred" :
        activeFolder === "all_mail" ? "all_mail" :
        activeFolder === "unread" ? "unread" : undefined;

      try {
        return await fetchMailListPage({
          page,
          perPage: pageSize,
          accountId: activeAccountId,
          view,
          labelId: activeFolder === "label" ? (activeLabelId ?? undefined) : undefined,
          folderIds: !view && activeFolder !== "label" ? activeFolderIds : undefined,
          // Inbox = uniquement les mails "importants" : on exclut les labels secondaires.
          excludeSecondary: activeFolder === "inbox",
          isDraft: activeFolder === "drafts" ? true : (activeFolder === "label" ? undefined : false),
          searchText,
          filter: {
            unread: listFilter.unread,
            starred: listFilter.starred,
            hasAttachments: listFilter.hasAttachments,
            priority: listFilter.priority,
            fromText: listFilter.fromText,
            bodyText: listFilter.bodyText,
            importance: listFilter.importance,
          },
          sort: "date",
          // Dernier message de chaque fil (envoyes compris) : la ligne montre
          // sa propre reponse. Inutile pour les brouillons.
          withTails: activeFolder !== "drafts",
        });
      } catch (err) {
        console.warn("[useThreads] /api/mail/list failed, fallback to PB API", err);
        return fetchPagePbFallback(page);
      }
    },
    [activeAccountId, activeFolderIds, activeFolder, activeLabelId, listFilter, pageSize, searchQuery, searchFilter, searchText, searchIds, fetchSearchIdsPage, fetchPagePbFallback]
  );
  fetchPageRef.current = fetchPage;
  const buildFilterRef = useRef(buildFilter);
  buildFilterRef.current = buildFilter;

  // Chargement initial
  useEffect(() => {
    let cancelled = false;

    if (!enabled || !filterReady) {
      pageMapRef.current = new Map();
      windowRef.current = { startPage: 1, endPage: 1, totalPages: 1, totalItems: 0 };
      // Reset fetchKey pour forcer un re-fetch quand filterReady redevient true
      // (evite les listes vides apres HMR ou changement de compte temporaire)
      lastFetchKeyRef.current = "";
      // Garder loading=true si le compte n'est pas encore initialise (evite le flash "Aucun message")
      if (activeAccountId !== null) {
        setThreads((prev) => (prev.length === 0 ? prev : []));
        setLoading(false);
      }
      return;
    }

    if (refreshKey > 0) {
      clearMailListPageCache();
    }

    // Eviter les fetches en double pour un filtre deja charge.
    // Ne pas marquer la cle au lancement : en dev/StrictMode, le cleanup peut
    // annuler la premiere reponse avant qu'un second effet identique ne parte.
    // queryKey = identite de la LISTE (sans refreshKey) : elle inclut searchIdsKey
    // car un jeu d'ids de recherche different ("Voir tout") est une autre liste.
    const queryKey = `${activeAccountId}|${folderKey}|${activeFolder}|${activeLabelId ?? ""}|${searchFilter ?? ""}|${searchText ?? ""}|${searchQuery ?? ""}|${searchIdsKey}|${listFilterKey}`;
    const fetchKey = `${queryKey}|${refreshKey}`;
    if (fetchKey === lastFetchKeyRef.current) return;

    // RAFRAICHISSEMENT DE LA MEME LISTE : refetch de la page 1 en tache de
    // fond + diff sur les conversations concernees, sans repasser par l'etat
    // vide (skeletons). Cf useMessages, meme mecanique.
    const softRefresh =
      lastQueryKeyRef.current === queryKey &&
      windowRef.current.startPage === 1 &&
      (pageMapRef.current.get(1)?.length ?? 0) > 0;

    lastFetchKeyRef.current = "";
    if (!softRefresh) {
      setLoading(true);
      pageMapRef.current = new Map();
      windowRef.current = { startPage: 1, endPage: 1, totalPages: 1, totalItems: 0 };
      crossFolderCountsRef.current = new Map();
      tailsRef.current = new Map();
      setNewThreadIds(new Set());
      for (const timer of newThreadTimersRef.current.values()) clearTimeout(timer);
      newThreadTimersRef.current.clear();
    }

    fetchPageRef.current!(1)
      .then((result) => {
        if (cancelled) return;

        if (softRefresh) {
          const pageMap = pageMapRef.current;
          const win = windowRef.current;
          const page1 = pageMap.get(1) ?? [];
          // Ne pas dupliquer un message deja charge dans une page suivante.
          const skipIds = new Set<string>();
          for (let p = 2; p <= win.endPage; p++) {
            for (const m of pageMap.get(p) ?? []) skipIds.add(m.id);
          }
          const merged = mergeMailListPage(page1, result.items, {
            complete: result.items.length < pageSize,
            comparator: (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
            skipIds,
          });
          const tailsChanged = mergeTails(tailsRef.current, result.thread_tails);
          windowRef.current = { ...win, totalPages: result.totalPages, totalItems: result.totalItems };
          lastFetchTimestampRef.current = new Date().toISOString();
          lastQueryKeyRef.current = queryKey;
          lastFetchKeyRef.current = fetchKey;
          if (merged.items !== page1) {
            pageMap.set(1, merged.items);
            const built = rebuildThreads(getWindowedMessages(pageMap, windowRef.current));
            setThreads(built);
            const freshById = new Map(result.items.map((m) => [m.id, m]));
            markThreadsAsNew(
              merged.addedIds.map((id) => {
                const msg = freshById.get(id)!;
                return msg.thread_id || msg.message_id || msg.id;
              })
            );
            fetchCrossFolderCounts(built).then((changed) => {
              if (cancelled || !changed) return;
              setThreads(rebuildThreads(getWindowedMessages(pageMapRef.current, windowRef.current)));
            });
          } else if (tailsChanged) {
            // Seul le dernier message d'un fil a change (ex. reponse envoyee :
            // elle vit dans "Envoyes", pas dans cette vue) -> maj en place.
            setThreads(rebuildThreads(getWindowedMessages(pageMap, windowRef.current)));
          }
          return;
        }

        mergeTails(tailsRef.current, result.thread_tails);
        pageMapRef.current.set(1, result.items);
        windowRef.current = { startPage: 1, endPage: 1, totalPages: result.totalPages, totalItems: result.totalItems };
        const built = rebuildThreads(result.items);
        setThreads(built);
        lastFetchKeyRef.current = fetchKey;
        setLoading(false);
        lastFetchTimestampRef.current = new Date().toISOString();
        lastQueryKeyRef.current = queryKey;

        // Fetch real cross-folder counts then update
        fetchCrossFolderCounts(built).then((changed) => {
          if (cancelled || !changed) return;
          setThreads(rebuildThreads(getWindowedMessages(pageMapRef.current, windowRef.current)));
        });
      })
      .catch(() => {
        if (cancelled) return;
        // Sur un rafraichissement, garder la liste affichee : un echec reseau
        // ne doit pas vider ce que l'utilisateur voit.
        if (softRefresh) {
          lastFetchKeyRef.current = fetchKey;
          return;
        }
        pageMapRef.current = new Map();
        setThreads([]);
        lastFetchKeyRef.current = fetchKey;
        setLoading(false);
      });

    // Real-time updates are handled by the WebSocket channel (ws-channel.ts)
    // which dispatches to the Zustand store signals that this hook already reacts to:
    // - signalNewMessages → triggers incremental fetch effect below
    // - localMessageUpdate → triggers the local update effect below
    // - localMessageRemoval → triggers the local removal effect below

    return () => {
      cancelled = true;
      // Si React relance l'effet avec les memes deps apres ce cleanup, la
      // requete courante sera ignoree par `cancelled`; il faut donc permettre
      // au prochain passage de refaire le fetch au lieu de rester en loading.
      if (lastFetchKeyRef.current === fetchKey) {
        lastFetchKeyRef.current = "";
      }
      if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
      for (const timer of newThreadTimersRef.current.values()) clearTimeout(timer);
      newThreadTimersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, activeAccountId, folderKey, activeFolder, activeLabelId, filterReady, refreshKey, searchFilter, searchText, searchQuery, searchIdsKey, listFilterKey]);

  // Fetch incremental : ajouter les nouveaux messages sans recharger toute la liste
  useEffect(() => {
    if (newMessagesSignal <= prevNewMsgSignalRef.current) return;
    // PIEGE : ne consommer le signal QU'UNE fois les gardes passees, sinon un
    // event "nouveau mail" arrivant pendant un chargement est perdu pour
    // toujours (cf useMessages, meme mecanique).
    if (!enabled || !filterReady || loading || !lastFetchTimestampRef.current) return;
    prevNewMsgSignalRef.current = newMessagesSignal;

    let cancelled = false;

    // Re-fetch page 1 via the exact same query/sort/filter as the list (hot
    // path /api/mail/list) and merge any unknown ids. We deliberately do NOT
    // filter by `date > lastFetch`: `date` is the email's Date header, not the
    // ingest time, so a mail that arrives now but was *sent* before this
    // session loaded (delivery latency, bulk senders with lagging Date
    // headers) would be silently excluded and never show up live.
    //
    // CRITIQUE : purger le cache client de /api/mail/list AVANT le refetch.
    // fetchMailListPage garde chaque page 90s en cache : sans purge, ce
    // refetch renvoyait la page 1 PERIMEE (sans le nouveau mail) -> la
    // conversation n'apparaissait JAMAIS en live si la liste avait ete
    // chargee il y a moins de 90s (le cas quasi systematique).
    clearMailListPageCache();
    fetchPageRef.current!(1).then((result) => {
      if (cancelled || result.items.length === 0) return;

      const win = windowRef.current;
      const pageMap = pageMapRef.current;

      // Ne pas injecter si on n'est pas en haut de la liste
      if (win.startPage > 1) return;

      // Fusion differentielle sur la page 1 : ajout des nouveaux, maj en place
      // des lignes modifiees (lu/favori/labels), retrait de ce qui a disparu.
      const page1 = pageMap.get(1) ?? [];
      const skipIds = new Set<string>();
      for (let p = 2; p <= win.endPage; p++) {
        for (const m of pageMap.get(p) ?? []) skipIds.add(m.id);
      }
      const merged = mergeMailListPage(page1, result.items, {
        complete: result.items.length < pageSize,
        comparator: (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        skipIds,
      });
      // Server truth for the total (page 1 reflects the real count).
      win.totalItems = result.totalItems;
      const tailsChanged = mergeTails(tailsRef.current, result.thread_tails);
      if (merged.items === page1) {
        // Reponse envoyee : absente de la vue (dossier Envoyes) mais c'est le
        // nouveau dernier message du fil -> la ligne se met a jour sur place.
        if (tailsChanged) setThreads(rebuildThreads(getWindowedMessages(pageMap, win)));
        return;
      }

      pageMap.set(1, merged.items);
      trimBottom(pageMap, win);

      // Rebuild threads
      const built = rebuildThreads(getWindowedMessages(pageMap, win));
      setThreads(built);

      // Animation slide-in pour les nouveaux threads
      const freshById = new Map(result.items.map((m) => [m.id, m]));
      markThreadsAsNew(
        merged.addedIds.map((id) => {
          const msg = freshById.get(id)!;
          return msg.thread_id || msg.message_id || msg.id;
        })
      );

      // Fetch cross-folder counts pour les nouveaux threads
      fetchCrossFolderCounts(built);
    }).catch(() => {});

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newMessagesSignal, enabled, filterReady, loading]);

  // Polling fallback removed — real-time updates via WebSocket channel (ws-channel.ts)

  // Appliquer les mises a jour locales depuis useMessageActions
  useEffect(() => {
    if (!localMessageUpdate) return;
    const { id, changes } = localMessageUpdate;
    const win = windowRef.current;
    const pageMap = pageMapRef.current;

    let found = false;
    for (let p = win.startPage; p <= win.endPage; p++) {
      const page = pageMap.get(p);
      if (!page) continue;
      const idx = page.findIndex((m) => m.id === id);
      if (idx !== -1) {
        const updated = { ...page[idx], ...changes };

        // Verifier si le message correspond toujours au filtre actif
        const stillMatches = (() => {
          if (activeFolder === "starred") return updated.is_starred;
          if (activeFolder === "all_mail") return !updated.is_sent;
          if (activeFolderIds.length > 0) return activeFolderIds.includes(updated.folder);
          return true;
        })();

        if (!stillMatches) {
          page.splice(idx, 1);
        } else {
          page[idx] = updated;
        }
        found = true;
        break;
      }
    }

    if (found) {
      const rebuilt = rebuildThreads(getWindowedMessages(pageMap, win));
      const readOnlyUpdate = Object.keys(changes).every((key) => key === "is_read");
      setThreads(readOnlyUpdate ? preserveThreadOrder(rebuilt, threadsOrderRef.current) : rebuilt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localMessageUpdate]);

  // Retrait optimiste immediat de message(s) (depuis useMessageActions)
  useEffect(() => {
    if (!localMessageRemoval) return;
    const { ids } = localMessageRemoval;
    const idSet = new Set(ids);
    const win = windowRef.current;
    const pageMap = pageMapRef.current;

    let found = false;
    for (let p = win.startPage; p <= win.endPage; p++) {
      const page = pageMap.get(p);
      if (!page) continue;
      for (let i = page.length - 1; i >= 0; i--) {
        if (idSet.has(page[i].id)) {
          page.splice(i, 1);
          found = true;
        }
      }
    }

    if (found) {
      setThreads(rebuildThreads(getWindowedMessages(pageMap, win)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localMessageRemoval]);

  // Retrait de tous les messages d'un expediteur bloque : marquer les lignes
  // pour l'animation slide-out puis purger apres l'animation (le serveur les
  // filtrera ensuite via blocked_senders).
  useEffect(() => {
    if (!localSenderRemoval) return;
    const { email } = localSenderRemoval;
    const win = windowRef.current;
    const pageMap = pageMapRef.current;

    const ids: string[] = [];
    for (let p = win.startPage; p <= win.endPage; p++) {
      const page = pageMap.get(p);
      if (!page) continue;
      for (const msg of page) {
        if ((msg.from_address?.address || "").toLowerCase().trim() === email) {
          ids.push(msg.id);
        }
      }
    }
    if (ids.length === 0) return;

    const idSet = new Set(ids);
    useMailStore.getState().markMessagesRemoving(ids);
    setTimeout(() => {
      const w = windowRef.current;
      const pm = pageMapRef.current;
      let found = false;
      for (let p = w.startPage; p <= w.endPage; p++) {
        const page = pm.get(p);
        if (!page) continue;
        for (let i = page.length - 1; i >= 0; i--) {
          if (idSet.has(page[i].id)) {
            page.splice(i, 1);
            found = true;
          }
        }
      }
      if (found) {
        setThreads(rebuildThreads(getWindowedMessages(pm, w)));
      }
      useMailStore.getState().unmarkMessagesRemoving(ids);
    }, REMOVAL_ANIM_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localSenderRemoval]);

  // Synchroniser le ref avec la longueur actuelle des threads
  threadsLengthRef.current = threads.length;
  threadsOrderRef.current = threads.map((thread) => thread.id);

  // Charger plus de pages vers le bas (jusqu'a obtenir de nouveaux threads)
  const loadMoreBottom = useCallback(async () => {
    const win = windowRef.current;
    if (win.endPage >= win.totalPages || loading || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadingDirection("bottom");

    const threadCountBefore = threadsLengthRef.current;

    try {
      let page = win.endPage;
      let more = true;
      let pagesLoaded = 0;
      let applied = false;

      while (more && pagesLoaded < 3) {
        page++;
        pagesLoaded++;

        const result = await fetchPageRef.current!(page);

        mergeTails(tailsRef.current, result.thread_tails);
        pageMapRef.current.set(page, result.items);
        windowRef.current = { ...windowRef.current, endPage: page, totalPages: result.totalPages, totalItems: result.totalItems };
        more = result.totalPages > page;

        // Trimmer les pages du haut si necessaire
        trimTop(pageMapRef.current, windowRef.current);

        const newThreads = rebuildThreads(
          getWindowedMessages(pageMapRef.current, windowRef.current)
        );

        if (newThreads.length > threadCountBefore || !more) {
          setThreads(newThreads);
          applied = true;
          // Fetch counts for new threads
          fetchCrossFolderCounts(newThreads).then((changed) => {
            if (changed) {
              setThreads(rebuildThreads(getWindowedMessages(pageMapRef.current, windowRef.current)));
            }
          });
          break;
        }
      }

      // PIEGE : si les 3 pages chargees n'ont produit AUCUNE nouvelle
      // conversation (tous les messages se rattachent a des fils deja
      // affiches), on sortait de la boucle sans jamais appeler setThreads.
      // La liste restait identique -> plus rien a faire defiler -> aucun
      // nouvel event de scroll -> pagination bloquee definitivement.
      if (!applied) {
        const finalThreads = rebuildThreads(
          getWindowedMessages(pageMapRef.current, windowRef.current)
        );
        setThreads(finalThreads);
        fetchCrossFolderCounts(finalThreads).then((changed) => {
          if (changed) {
            setThreads(rebuildThreads(getWindowedMessages(pageMapRef.current, windowRef.current)));
          }
        });
      }
    } catch {
      // Erreur de chargement — garder l'etat actuel
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setLoadingDirection(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const loadMoreTop = useCallback(async () => {
    const win = windowRef.current;
    if (win.startPage <= 1 || loading || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadingDirection("top");

    try {
      const prevPage = win.startPage - 1;
      const result = await fetchPageRef.current!(prevPage);

      mergeTails(tailsRef.current, result.thread_tails);
      pageMapRef.current.set(prevPage, result.items);
      windowRef.current = { ...windowRef.current, startPage: prevPage, totalPages: result.totalPages, totalItems: result.totalItems };

      // Trimmer les pages du bas si necessaire
      trimBottom(pageMapRef.current, windowRef.current);

      setThreads(
        rebuildThreads(getWindowedMessages(pageMapRef.current, windowRef.current))
      );
    } catch {
      // Erreur de chargement — garder l'etat actuel
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setLoadingDirection(null);
    }
  }, [loading]);

  const getThread = useCallback(
    (threadId: string) => {
      return threads.find((t) => t.id === threadId);
    },
    [threads]
  );

  const markAsRead = useCallback(
    async (messageId: string, read = true) => {
      const win = windowRef.current;
      const pageMap = pageMapRef.current;

      // Optimistic update : mettre a jour le pageMap + rebuild threads
      for (let p = win.startPage; p <= win.endPage; p++) {
        const page = pageMap.get(p);
        if (!page) continue;
        const idx = page.findIndex((m) => m.id === messageId);
        if (idx !== -1) {
          page[idx] = { ...page[idx], is_read: read };
          break;
        }
      }
      const rebuilt = rebuildThreads(getWindowedMessages(pageMap, win));
      setThreads(preserveThreadOrder(rebuilt, threadsOrderRef.current));

      // Broadcast to other tabs/windows
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
    },
    []
  );

  const markAsStarred = useCallback(
    async (messageId: string) => {
      // Trouver le message dans le pageMap
      let foundMsg: Message | undefined;
      const win = windowRef.current;
      const pageMap = pageMapRef.current;
      for (let p = win.startPage; p <= win.endPage; p++) {
        const page = pageMap.get(p);
        if (!page) continue;
        foundMsg = page.find((m) => m.id === messageId);
        if (foundMsg) break;
      }
      const newVal = !(foundMsg?.is_starred ?? false);
      toast.success(tStatic(newVal ? "message.starred" : "message.unstarred"));

      // Optimistic update : mettre a jour le pageMap + rebuild threads
      // Verifier si le message matche encore le filtre actif
      const af = useMailStore.getState().activeFolder;
      const afIds = useMailStore.getState().activeFolderIds;
      let removedMsg: Message | undefined;

      for (let p = win.startPage; p <= win.endPage; p++) {
        const page = pageMap.get(p);
        if (!page) continue;
        const idx = page.findIndex((m) => m.id === messageId);
        if (idx !== -1) {
          const updated = { ...page[idx], is_starred: newVal };
          const stillMatches =
            af === "starred" ? updated.is_starred :
            af === "all_mail" ? !updated.is_sent :
            afIds.length > 0 ? afIds.includes(updated.folder) :
            true;
          if (!stillMatches) {
            removedMsg = page[idx];
            page.splice(idx, 1);
          } else {
            page[idx] = updated;
          }
          break;
        }
      }
      setThreads(rebuildThreads(getWindowedMessages(pageMap, win)));
      useMailStore.getState().adjustSidebarCount("starred", newVal ? 1 : -1);

      // Broadcast to other tabs/windows
      sendAction({ action: "message-update", id: messageId, changes: { is_starred: newVal } });
      sendAction({ action: "sidebar-adjust", key: "starred", delta: newVal ? 1 : -1 });

      try {
        await updateMessageFlags(messageId, { is_starred: newVal });
        useMailStore.getState().invalidateFolders();
        sendAction({ action: "invalidate-folders" });
      } catch {
        useMailStore.getState().adjustSidebarCount("starred", newVal ? -1 : 1);
        // Revert on error
        if (removedMsg) {
          // Re-inserer le message supprime
          const firstPage = pageMap.get(win.startPage);
          if (firstPage) {
            firstPage.push({ ...removedMsg });
            firstPage.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          }
        } else {
          for (let p = win.startPage; p <= win.endPage; p++) {
            const page = pageMap.get(p);
            if (!page) continue;
            const idx = page.findIndex((m) => m.id === messageId);
            if (idx !== -1) {
              page[idx] = { ...page[idx], is_starred: !newVal };
              break;
            }
          }
        }
        setThreads(rebuildThreads(getWindowedMessages(pageMap, win)));
      }
    },
    []
  );

  const moveMessage = useCallback(
    async (messageId: string, folderType: string) => {
      const win = windowRef.current;
      const pageMap = pageMapRef.current;

      // Optimistic: retirer le message du pageMap
      let removedMsg: Message | undefined;
      for (let p = win.startPage; p <= win.endPage; p++) {
        const page = pageMap.get(p);
        if (!page) continue;
        const idx = page.findIndex((m) => m.id === messageId);
        if (idx !== -1) {
          removedMsg = page[idx];
          page.splice(idx, 1);
          break;
        }
      }
      setThreads(rebuildThreads(getWindowedMessages(pageMap, win)));

      // Broadcast to other tabs/windows
      sendAction({ action: "message-removal", id: messageId });

      const { activeFolder, adjustSidebarCount } = useMailStore.getState();
      const sourceKey = activeFolder !== "all_mail" ? folderToCountKey(activeFolder) : null;
      const destKey = folderToCountKey(folderType);
      if (sourceKey) {
        adjustSidebarCount(sourceKey, -1);
        sendAction({ action: "sidebar-adjust", key: sourceKey, delta: -1 });
      }
      if (destKey) {
        adjustSidebarCount(destKey, 1);
        sendAction({ action: "sidebar-adjust", key: destKey, delta: 1 });
      }
      if (activeFolder === "inbox" && removedMsg && !removedMsg.is_read) {
        adjustSidebarCount("inboxUnread", -1);
        sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: -1 });
      }

      const msg = removedMsg || await messages().getOne<Message>(messageId).catch(() => null);
      if (!msg) return;

      try {
        const { default: pb } = await import("@/lib/pocketbase");
        const targetFolder = await pb
          .collection<import("@/lib/pocketbase").Folder>("folders")
          .getFirstListItem(`account = "${msg.account}" && type = "${folderType}"`);
        await retryUpdate(messages(), messageId, { folder: targetFolder.id });
        useMailStore.getState().invalidateFolders();
        sendAction({ action: "invalidate-folders" });
      } catch {
        if (sourceKey) {
          adjustSidebarCount(sourceKey, 1);
          sendAction({ action: "sidebar-adjust", key: sourceKey, delta: 1 });
        }
        if (destKey) {
          adjustSidebarCount(destKey, -1);
          sendAction({ action: "sidebar-adjust", key: destKey, delta: -1 });
        }
        if (activeFolder === "inbox" && removedMsg && !removedMsg.is_read) {
          adjustSidebarCount("inboxUnread", 1);
          sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: 1 });
        }
        // Rollback
        if (removedMsg) {
          const firstPage = pageMap.get(win.startPage);
          if (firstPage) {
            firstPage.push(removedMsg);
            firstPage.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          }
          setThreads(rebuildThreads(getWindowedMessages(pageMap, win)));
        }
      }
    },
    []
  );

  const moveToTrash = useCallback(
    (messageId: string) => moveMessage(messageId, "trash"),
    [moveMessage]
  );

  const archiveMessage = useCallback(
    (messageId: string) => moveMessage(messageId, "archive"),
    [moveMessage]
  );

  const moveToSpam = useCallback(
    (messageId: string) => moveMessage(messageId, "spam"),
    [moveMessage]
  );

  const updateMessageLocal = useCallback(
    (messageId: string, changes: Partial<Message>) => {
      const win = windowRef.current;
      const pageMap = pageMapRef.current;
      let found = false;
      for (let p = win.startPage; p <= win.endPage; p++) {
        const page = pageMap.get(p);
        if (!page) continue;
        const idx = page.findIndex((m) => m.id === messageId);
        if (idx !== -1) {
          page[idx] = { ...page[idx], ...changes };
          found = true;
          break;
        }
      }
      if (found) {
        const rebuilt = rebuildThreads(getWindowedMessages(pageMap, win));
        setThreads(preserveThreadOrder(rebuilt, threadsOrderRef.current));
      }
    },
    []
  );

  // Filtre optimiste cote client : sur la boite de reception, on cache les
  // threads dont tous les messages portent au moins un label "secondaire".
  // Le store Zustand garantit un re-render immediat de tous les hooks de liste.
  const secondaryLabelIdsList = useMailStore((s) => s.secondaryLabelIds);
  const visibleThreads = (() => {
    if (activeFolder !== "inbox") return threads;
    if (secondaryLabelIdsList.length === 0) return threads;
    const secondaryIds = new Set(secondaryLabelIdsList);
    return threads.filter((t) => {
      for (const m of t.messages) {
        const ls = m.labels;
        if (!ls || ls.length === 0) return true;
        let hasSecondary = false;
        for (const id of ls) {
          if (secondaryIds.has(id)) { hasSecondary = true; break; }
        }
        if (!hasSecondary) return true;
      }
      return false;
    });
  })();

  return {
    threads: visibleThreads,
    totalItems: windowRef.current.totalItems,
    loading,
    loadingMore,
    loadingDirection,
    hasMoreBottom,
    hasMoreTop,
    newThreadIds,
    loadMoreBottom,
    loadMoreTop,
    getThread,
    markAsRead,
    markAsStarred,
    moveToTrash,
    archiveMessage,
    moveToSpam,
    updateMessageLocal,
  };
}
