"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { messages, updateMessageFlags, updateMessageViaWorker, type Message } from "@/lib/pocketbase";
import { t as tStatic } from "@/lib/i18n";
import { useMailStore, REMOVAL_ANIM_MS } from "@/lib/stores/mail-store";
import { folderToCountKey } from "@/lib/hooks/useMessageActions";
import { sendAction } from "@/lib/ws-channel";
import { clearMailListPageCache, fetchMailListPage } from "@/lib/mail-list-api";
import { fetchMailSearchPage } from "@/lib/mail-search-api";
import { mergeMailListPage } from "@/lib/mail-list-merge";
import { bootMark } from "@/lib/boot-perf";

const PAGE_SIZE = 50;
const WINDOW_SIZE = 300;

const LIST_FIELDS =
  "id,account,folder,thread_id,message_id,in_reply_to,references," +
  "from_address,to_addresses,cc_addresses,subject,snippet,date," +
  "is_read,is_starred,is_answered,is_draft,is_sent,has_attachments," +
  "priority,uid,labels,spam_score,spam_action,importance";

// PocketBase 0.25 rejette les filtres > ~100 expressions. On hydrate donc une
// liste d'ids par lots courts (chacun AND-e a la contrainte structurelle du
// dossier/compte), puis on reordonne selon l'ordre d'origine des ids (le tri
// decide par la palette : recence ou pertinence). Cf useSearch (meme motif).
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
  // Reappliquer l'ordre d'origine et ecarter les ids qui ne matchent pas la
  // contrainte (autre dossier, filtre rapide) -> le total reflete le dossier.
  return ids.map((id) => byId.get(id)).filter((m): m is Message => !!m);
}

const sortByDateDesc = (a: Message, b: Message) =>
  new Date(b.date).getTime() - new Date(a.date).getTime();

const sortUnreadFirst = (a: Message, b: Message) => {
  const ar = a.is_read ? 1 : 0;
  const br = b.is_read ? 1 : 0;
  if (ar !== br) return ar - br;
  return sortByDateDesc(a, b);
};

export function shouldSortUnreadFirst(_folder: string) {
  // Tri non-lus-en-tete desactive : toutes les listes sont triees par date
  // decroissante. Les non-lus sont consultables via l'onglet dedie "Unread".
  return false;
}

export function getMessageComparator(folder: string) {
  return shouldSortUnreadFirst(folder) ? sortUnreadFirst : sortByDateDesc;
}

// Meme taille de page pour TOUS les dossiers. Avant, seuls inbox/all_mail
// prenaient 50 et les autres 20 : sur "Envoyes" (des milliers de mails), la
// premiere page ne remplissait presque pas l'ecran et chaque defilement
// n'ajoutait qu'une poignee de lignes. /api/mail/list est servi par un index
// couvrant (~50 ms pour 50 lignes), donc 50 partout est sans cout.
function getPageSize(_folder: string) {
  return PAGE_SIZE;
}

interface WindowState {
  startPage: number;
  endPage: number;
  totalPages: number;
  totalItems: number;
}

interface UseMessagesReturn {
  messages: Message[];
  totalItems: number;
  loading: boolean;
  loadingMore: boolean;
  loadingDirection: "top" | "bottom" | null;
  hasMoreBottom: boolean;
  hasMoreTop: boolean;
  newMessageIds: Set<string>;
  loadMoreBottom: () => Promise<void>;
  loadMoreTop: () => Promise<void>;
  markAsRead: (id: string, read?: boolean) => Promise<void>;
  markAsStarred: (id: string, starred?: boolean) => Promise<void>;
  moveToTrash: (id: string) => Promise<void>;
  archiveMessage: (id: string) => Promise<void>;
  moveToSpam: (id: string) => Promise<void>;
}

export function useMessages(options?: { enabled?: boolean; searchQuery?: string; searchFilter?: string; searchText?: string; searchIds?: string[]; searchAdvFilter?: string }): UseMessagesReturn {
  const enabled = options?.enabled ?? true;
  const searchFilter = options?.searchFilter;
  const searchText = options?.searchText;
  // Recherche servie par le worker (meme moteur que la palette, pagination
  // cote serveur, sans plafond). searchText / searchFilter ne servent plus que
  // de repli si le worker est injoignable.
  const searchQuery = options?.searchQuery;
  // Recherche par liste d'ids (resultats hybrides) : on hydrate l'INTEGRALITE
  // des ids par lots pagines (une page = un filtre PB court et valide), sans
  // plafond. searchAdvFilter = operateurs avances AND-es a chaque lot.
  const searchIds = options?.searchIds;
  const searchAdvFilter = options?.searchAdvFilter;
  const searchIdsKey = searchIds ? searchIds.join(",") : "";
  const [items, setItems] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDirection, setLoadingDirection] = useState<"top" | "bottom" | null>(null);
  const [totalItemsState, setTotalItemsState] = useState(0);
  const windowRef = useRef<WindowState>({ startPage: 1, endPage: 1, totalPages: 1, totalItems: 0 });
  const loadingMoreRef = useRef(false);
  const lastFetchKeyRef = useRef("");
  // Cache de l'hydratation complete du mode recherche-par-ids (evite de
  // re-hydrater a chaque page ; recalcule quand ids/dossier changent).
  const searchHydrationRef = useRef<{ key: string; messages: Message[] } | null>(null);

  const fetchPageRef = useRef<(page: number) => ReturnType<typeof fetchPage>>(null!);
  const [newMessageIds, setNewMessageIds] = useState<Set<string>>(new Set());
  const newIdTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const initialFetchDoneRef = useRef(false);
  const knownIdsRef = useRef<Set<string>>(new Set());
  // Liste affichee (lue dans les effets sans les mettre dans les deps).
  const itemsRef = useRef<Message[]>([]);
  // Requete (dossier/compte/filtres) du dernier chargement reussi : sert a
  // distinguer un CHANGEMENT de liste (skeletons legitimes) d'un simple
  // RAFRAICHISSEMENT de la meme liste (fusion en place, aucun vidage).
  const lastQueryKeyRef = useRef("");
  // Messages inseres localement (brouillon fraichement cree) : le serveur peut
  // ne pas encore les renvoyer, ne jamais les retirer lors d'une fusion.
  const localInsertIdsRef = useRef<Set<string>>(new Set());

  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const activeFolderIds = useMailStore((s) => s.activeFolderIds);
  const activeFolder = useMailStore((s) => s.activeFolder);
  const activeLabelId = useMailStore((s) => s.activeLabelId);
  const refreshKey = useMailStore((s) => s.messagesRefreshKey);
  const newMessagesSignal = useMailStore((s) => s.newMessagesSignal);
  const localMessageUpdate = useMailStore((s) => s.localMessageUpdate);
  const localMessageInsert = useMailStore((s) => s.localMessageInsert);
  const localMessageRemoval = useMailStore((s) => s.localMessageRemoval);
  const localSenderRemoval = useMailStore((s) => s.localSenderRemoval);
  const listFilter = useMailStore((s) => s.listFilter);
  const listFilterKey = JSON.stringify(listFilter);
  const lastFetchTimestampRef = useRef<string>("");
  const prevNewMsgSignalRef = useRef(0);
  const buildFilterRef = useRef<() => string>(null!);

  const folderKey = activeFolderIds.join(",");
  const pageSize = getPageSize(activeFolder);

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

  // Filter PB (utilise pour l'incremental fetch via PB realtime / since)
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
      const sort = shouldSortUnreadFirst(activeFolder) ? "is_read,-date" : "-date";
      return messages().getList<Message>(page, pageSize, {
        filter,
        sort,
        fields: LIST_FIELDS,
      });
    },
    [buildFilter, activeFolder, pageSize]
  );

  // Recherche par liste d'ids : on hydrate UNE fois l'integralite des ids (par
  // lots courts), bornes au dossier/compte courant + operateurs avances, puis on
  // pagine en memoire. Plus de plafond a 75 : les 140 resultats defilent jusqu'au
  // dernier et le total annonce reflete exactement le dossier.
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
      return {
        page,
        perPage: pageSize,
        totalItems: total,
        totalPages,
        items: all.slice(start, start + pageSize),
      };
    },
    [searchIds, searchAdvFilter, buildFilter, pageSize]
  );

  // Hot path : /api/mail/list (SQL direct, ~50-200ms sur 37k mails).
  // Pour la recherche (searchFilter, syntaxe PB), fallback sur l'API record PB.
  // Si /api/mail/list echoue, fallback aussi pour ne pas casser l'UI.
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
          console.warn("[useMessages] /worker/search/mail failed, fallback", err);
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
          sort: shouldSortUnreadFirst(activeFolder) ? "unread_date" : "date",
        });
      } catch (err) {
        console.warn("[useMessages] /api/mail/list failed, fallback to PB API", err);
        return fetchPagePbFallback(page);
      }
    },
    [activeAccountId, activeFolderIds, activeFolder, activeLabelId, listFilter, pageSize, searchQuery, searchFilter, searchText, searchIds, fetchSearchIdsPage, fetchPagePbFallback]
  );
  fetchPageRef.current = fetchPage;
  buildFilterRef.current = buildFilter;
  itemsRef.current = items;

  // Marquer des lignes comme "nouvelles" (animation slide-in ~600ms).
  const markIdsAsNew = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setNewMessageIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    for (const id of ids) {
      knownIdsRef.current.add(id);
      const existingTimer = newIdTimersRef.current.get(id);
      if (existingTimer) clearTimeout(existingTimer);
      newIdTimersRef.current.set(
        id,
        setTimeout(() => {
          setNewMessageIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          newIdTimersRef.current.delete(id);
        }, 600)
      );
    }
  }, []);

  // Chargement initial
  useEffect(() => {
    let cancelled = false;

    if (!enabled || !filterReady) {
      // Reset fetchKey pour forcer un re-fetch quand filterReady redevient true
      lastFetchKeyRef.current = "";
      // Garder loading=true si le compte n'est pas encore initialise (evite le flash "Aucun message")
      if (activeAccountId !== null) {
        setItems((prev) => (prev.length === 0 ? prev : []));
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

    // RAFRAICHISSEMENT DE LA MEME LISTE (seul refreshKey a bouge : retour au
    // premier plan, envoi d'un mail, undo, reglage...) : on NE repasse PAS par
    // l'etat vide (skeletons). On refetch la page 1 en tache de fond et on
    // applique un diff sur les lignes concernees. Un vrai changement de liste
    // (dossier, compte, filtre, recherche) garde les skeletons.
    const softRefresh =
      initialFetchDoneRef.current &&
      lastQueryKeyRef.current === queryKey &&
      windowRef.current.startPage === 1 &&
      itemsRef.current.length > 0;

    lastFetchKeyRef.current = "";
    if (!softRefresh) {
      setLoading(true);
      windowRef.current = { startPage: 1, endPage: 1, totalPages: 1, totalItems: 0 };
      setTotalItemsState(0);
      initialFetchDoneRef.current = false;
      knownIdsRef.current.clear();
      localInsertIdsRef.current.clear();
      setNewMessageIds(new Set());
      for (const timer of newIdTimersRef.current.values()) clearTimeout(timer);
      newIdTimersRef.current.clear();
    }

    bootMark("messages:fetch-start", { folder: activeFolder, account: activeAccountId });
    const tFetch = performance.now();
    fetchPageRef.current!(1)
      .then((result) => {
        bootMark("messages:fetch-done", {
          dur_ms: Math.round(performance.now() - tFetch),
          page_count: result.items.length,
          total: result.totalItems,
        });
        if (cancelled) return;

        if (softRefresh) {
          const merged = mergeMailListPage(itemsRef.current, result.items, {
            complete: result.items.length < pageSize,
            comparator: getMessageComparator(activeFolder),
            protectedIds: localInsertIdsRef.current,
          });
          if (merged.items !== itemsRef.current) {
            setItems(merged.items);
            markIdsAsNew(merged.addedIds);
          }
          for (const msg of result.items) knownIdsRef.current.add(msg.id);
          windowRef.current = {
            ...windowRef.current,
            totalPages: result.totalPages,
            totalItems: result.totalItems,
          };
          setTotalItemsState(result.totalItems);
          lastFetchTimestampRef.current = new Date().toISOString();
          lastQueryKeyRef.current = queryKey;
          return;
        }

        setItems(result.items);
        knownIdsRef.current = new Set(result.items.map((m) => m.id));
        initialFetchDoneRef.current = true;
        lastFetchTimestampRef.current = new Date().toISOString();
        lastQueryKeyRef.current = queryKey;
        windowRef.current = {
          startPage: 1,
          endPage: 1,
          totalPages: result.totalPages,
          totalItems: result.totalItems,
        };
        setTotalItemsState(result.totalItems);
      })
      .catch(() => {
        bootMark("messages:fetch-error", { dur_ms: Math.round(performance.now() - tFetch) });
        // Sur un rafraichissement, garder la liste affichee : un echec reseau
        // ne doit pas vider ce que l'utilisateur voit.
        if (!cancelled && !softRefresh) {
          setItems([]);
          setTotalItemsState(0);
        }
      })
      .finally(() => {
        if (!cancelled) {
          lastFetchKeyRef.current = fetchKey;
          setLoading(false);
        }
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, activeAccountId, folderKey, activeFolder, activeLabelId, filterReady, refreshKey, searchFilter, searchText, searchQuery, searchIdsKey, listFilterKey]);

  // Fetch incremental : ajouter les nouveaux messages sans recharger toute la liste
  useEffect(() => {
    if (newMessagesSignal <= prevNewMsgSignalRef.current) return;
    // PIEGE : ne consommer le signal QU'UNE fois les gardes passees. Avant,
    // il etait marque traite AVANT le check `loading` : un event "nouveau
    // mail" arrivant pendant un chargement de liste etait perdu pour toujours
    // (le mail n'apparaissait qu'apres un refresh manuel). En laissant le
    // signal en attente, l'effet se rejoue quand `loading` repasse a false
    // (deps) et le fetch incremental rattrape le mail (dedup par id).
    if (!enabled || !filterReady || loading || !lastFetchTimestampRef.current) return;
    prevNewMsgSignalRef.current = newMessagesSignal;

    let cancelled = false;
    const af = useMailStore.getState().activeFolder;

    // Re-fetch page 1 via the exact same query/sort/filter as the list (hot
    // path /api/mail/list) and merge any unknown ids. We deliberately do NOT
    // filter by `date > lastFetch`: `date` is the email's Date header, not the
    // ingest time, so a mail that arrives now but was *sent* before this
    // session loaded (delivery latency, bulk senders with lagging Date
    // headers) would be silently excluded and never show up live.
    //
    // CRITIQUE : purger le cache client de /api/mail/list AVANT le refetch.
    // fetchMailListPage garde chaque page 90s en cache : sans purge, ce
    // refetch renvoyait la page 1 PERIMEE (sans le nouveau mail) -> dedup ->
    // rien a inserer -> le mail ne s'affichait JAMAIS en live si la liste
    // avait ete chargee il y a moins de 90s (le cas quasi systematique).
    clearMailListPageCache();
    fetchPageRef.current!(1).then((result) => {
      if (cancelled || result.items.length === 0) return;
      if (windowRef.current.startPage > 1) return;

      // Fusion differentielle : ajout des nouveaux, maj en place des lignes
      // modifiees, retrait de ce qui a disparu. Aucun redessin complet.
      const merged = mergeMailListPage(itemsRef.current, result.items, {
        complete: result.items.length < pageSize,
        comparator: getMessageComparator(af),
        protectedIds: localInsertIdsRef.current,
      });
      // Server truth for the total (page 1 reflects the real count).
      windowRef.current.totalItems = result.totalItems;
      setTotalItemsState(result.totalItems);
      if (merged.items === itemsRef.current) return;

      setItems(
        merged.items.length > WINDOW_SIZE ? merged.items.slice(0, WINDOW_SIZE) : merged.items
      );
      markIdsAsNew(merged.addedIds);
    }).catch(() => {});

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newMessagesSignal, enabled, filterReady, loading]);

  // Polling fallback removed — real-time updates via WebSocket channel (ws-channel.ts)

  // Cleanup des timers d'animation
  useEffect(() => {
    return () => {
      for (const timer of newIdTimersRef.current.values()) clearTimeout(timer);
    };
  }, []);

  // Appliquer les mises a jour locales depuis useMessageActions
  useEffect(() => {
    if (!localMessageUpdate) return;
    const { id, changes } = localMessageUpdate;

    setItems((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;

      const updated = { ...prev[idx], ...changes };

      // Verifier si le message correspond toujours au filtre actif
      const stillMatches = (() => {
        if (activeFolder !== "drafts" && updated.is_draft) return false;
        if (activeFolder === "starred") return updated.is_starred;
        if (activeFolder === "all_mail") return !updated.is_sent;
        if (activeFolderIds.length > 0) return activeFolderIds.includes(updated.folder);
        return true;
      })();

      if (!stillMatches) {
        return prev.filter((m) => m.id !== id);
      }

      const result = prev.map((m) => (m.id === id ? { ...m, ...changes } : m));
      // Re-trier si la date a change (brouillons mis a jour)
      if (changes.date) {
        result.sort(getMessageComparator(activeFolder));
      }
      return result;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localMessageUpdate]);

  // Insertion locale d'un nouveau message (brouillon cree)
  useEffect(() => {
    if (!localMessageInsert) return;
    const { message } = localMessageInsert;

    // Verifier que le message correspond au filtre actif
    const matches = (() => {
      if (activeFolder === "drafts") return message.is_draft !== false;
      if (activeFolder === "starred") return !!message.is_starred;
      if (activeFolder === "all_mail") return !message.is_sent;
      if (activeFolderIds.length > 0 && message.folder) return activeFolderIds.includes(message.folder);
      return false;
    })();

    if (!matches) return;

    if (message.id) localInsertIdsRef.current.add(message.id);
    setItems((prev) => {
      // Eviter les doublons
      if (prev.some((m) => m.id === message.id)) return prev;
      const updated = [message as Message, ...prev];
      updated.sort(getMessageComparator(activeFolder));
      return updated;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localMessageInsert]);

  // Retrait optimiste immediat de message(s) (depuis useMessageActions)
  useEffect(() => {
    if (!localMessageRemoval) return;
    const { ids } = localMessageRemoval;
    const idSet = new Set(ids);
    for (const id of ids) localInsertIdsRef.current.delete(id);
    setItems((prev) => prev.filter((m) => !idSet.has(m.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localMessageRemoval]);

  // Retrait de tous les messages d'un expediteur bloque : marquer les lignes
  // pour l'animation slide-out puis purger apres l'animation (le serveur les
  // filtrera ensuite via blocked_senders).
  useEffect(() => {
    if (!localSenderRemoval) return;
    const { email } = localSenderRemoval;
    const ids = items
      .filter((m) => (m.from_address?.address || "").toLowerCase().trim() === email)
      .map((m) => m.id);
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    useMailStore.getState().markMessagesRemoving(ids);
    setTimeout(() => {
      setItems((prev) => prev.filter((m) => !idSet.has(m.id)));
      useMailStore.getState().unmarkMessagesRemoving(ids);
    }, REMOVAL_ANIM_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localSenderRemoval]);

  const loadMoreBottom = useCallback(async () => {
    const win = windowRef.current;
    if (win.endPage >= win.totalPages || loading || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadingDirection("bottom");

    try {
      const nextPage = win.endPage + 1;
      const result = await fetchPageRef.current!(nextPage);

      windowRef.current = {
        ...windowRef.current,
        endPage: nextPage,
        totalPages: result.totalPages,
        totalItems: result.totalItems,
      };
      setTotalItemsState(result.totalItems);

      setItems((prev) => {
        let updated = [...prev, ...result.items];
        // Trimmer les items du haut si on depasse WINDOW_SIZE
        if (updated.length > WINDOW_SIZE) {
          updated = updated.slice(pageSize);
          windowRef.current = {
            ...windowRef.current,
            startPage: windowRef.current.startPage + 1,
          };
        }
        return updated;
      });
    } catch {
      // Erreur de chargement — garder l'etat actuel
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setLoadingDirection(null);
    }
  }, [loading, pageSize]);

  const loadMoreTop = useCallback(async () => {
    const win = windowRef.current;
    if (win.startPage <= 1 || loading || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadingDirection("top");

    try {
      const prevPage = win.startPage - 1;
      const result = await fetchPageRef.current!(prevPage);

      windowRef.current = {
        ...windowRef.current,
        startPage: prevPage,
        totalPages: result.totalPages,
        totalItems: result.totalItems,
      };
      setTotalItemsState(result.totalItems);

      setItems((prev) => {
        let updated = [...result.items, ...prev];
        // Trimmer les items du bas si on depasse WINDOW_SIZE
        if (updated.length > WINDOW_SIZE) {
          updated = updated.slice(0, updated.length - pageSize);
          windowRef.current = {
            ...windowRef.current,
            endPage: windowRef.current.endPage - 1,
          };
        }
        return updated;
      });
    } catch {
      // Erreur de chargement — garder l'etat actuel
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setLoadingDirection(null);
    }
  }, [loading, pageSize]);

  const markAsRead = useCallback(async (id: string, read = true) => {
    setItems((prev) => prev.map((m) => m.id === id ? { ...m, is_read: read } : m));
    const { activeFolder } = useMailStore.getState();
    if (activeFolder === "inbox") {
      useMailStore.getState().adjustSidebarCount("inboxUnread", read ? -1 : 1);
    }
    try {
      await updateMessageFlags(id, { is_read: read });
      useMailStore.getState().invalidateFolders();
    } catch {
      setItems((prev) => prev.map((m) => m.id === id ? { ...m, is_read: !read } : m));
      if (activeFolder === "inbox") {
        useMailStore.getState().adjustSidebarCount("inboxUnread", read ? 1 : -1);
      }
    }
  }, []);

  const markAsStarred = useCallback(
    async (id: string, starred?: boolean) => {
      const msg = items.find((m) => m.id === id);
      const newVal = starred ?? !(msg?.is_starred ?? false);
      toast.success(tStatic(newVal ? "message.starred" : "message.unstarred"));
      const af = useMailStore.getState().activeFolder;
      const afIds = useMailStore.getState().activeFolderIds;

      setItems((prev) => {
        const updated = prev.map((m) => m.id === id ? { ...m, is_starred: newVal } : m);
        // Retirer si ne matche plus le filtre actif
        return updated.filter((m) => {
          if (m.id !== id) return true;
          if (af !== "drafts" && m.is_draft) return false;
          if (af === "starred") return m.is_starred;
          if (af === "all_mail") return !m.is_sent;
          if (afIds.length > 0) return afIds.includes(m.folder);
          return true;
        });
      });
      useMailStore.getState().adjustSidebarCount("starred", newVal ? 1 : -1);
      try {
        await updateMessageFlags(id, { is_starred: newVal });
        useMailStore.getState().invalidateFolders();
      } catch {
        useMailStore.getState().adjustSidebarCount("starred", newVal ? -1 : 1);
        setItems((prev) => {
          // Si le message a ete retire, le re-inserer
          if (!prev.find((m) => m.id === id) && msg) {
            const restored = [...prev, { ...msg, is_starred: !newVal }];
            restored.sort(getMessageComparator(useMailStore.getState().activeFolder));
            return restored;
          }
          return prev.map((m) => m.id === id ? { ...m, is_starred: !newVal } : m);
        });
      }
    },
    [items]
  );

  const moveToTrash = useCallback(async (id: string) => {
    let removedMsg: Message | undefined;
    setItems((prev) => {
      removedMsg = prev.find((m) => m.id === id);
      if (removedMsg) {
        windowRef.current.totalItems = Math.max(0, windowRef.current.totalItems - 1);
        setTotalItemsState(windowRef.current.totalItems);
      }
      return prev.filter((m) => m.id !== id);
    });
    sendAction({ action: "message-removal", id });

    const { activeFolder, adjustSidebarCount } = useMailStore.getState();
    const sourceKey = activeFolder !== "all_mail" ? folderToCountKey(activeFolder) : null;
    if (sourceKey) {
      adjustSidebarCount(sourceKey, -1);
      sendAction({ action: "sidebar-adjust", key: sourceKey, delta: -1 });
    }
    adjustSidebarCount("trash", 1);
    sendAction({ action: "sidebar-adjust", key: "trash", delta: 1 });
    if (activeFolder === "inbox" && removedMsg && !removedMsg.is_read) {
      adjustSidebarCount("inboxUnread", -1);
      sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: -1 });
    }

    const msg = removedMsg || await messages().getOne<Message>(id).catch(() => null);
    if (!msg) return;

    try {
      const { default: pb } = await import("@/lib/pocketbase");
      const trashFolder = await pb
        .collection<import("@/lib/pocketbase").Folder>("folders")
        .getFirstListItem(`account = "${msg.account}" && type = "trash"`);

      await updateMessageViaWorker(id, { folder: trashFolder.id });
    } catch {
      if (sourceKey) {
        adjustSidebarCount(sourceKey, 1);
        sendAction({ action: "sidebar-adjust", key: sourceKey, delta: 1 });
      }
      adjustSidebarCount("trash", -1);
      sendAction({ action: "sidebar-adjust", key: "trash", delta: -1 });
      if (activeFolder === "inbox" && removedMsg && !removedMsg.is_read) {
        adjustSidebarCount("inboxUnread", 1);
        sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: 1 });
      }
      if (removedMsg) {
        setItems((prev) => {
          const updated = [...prev, removedMsg!];
          updated.sort(getMessageComparator(useMailStore.getState().activeFolder));
          return updated;
        });
      }
    }
  }, []);

  const archiveMessage = useCallback(async (id: string) => {
    let removedMsg: Message | undefined;
    setItems((prev) => {
      removedMsg = prev.find((m) => m.id === id);
      if (removedMsg) {
        windowRef.current.totalItems = Math.max(0, windowRef.current.totalItems - 1);
        setTotalItemsState(windowRef.current.totalItems);
      }
      return prev.filter((m) => m.id !== id);
    });
    sendAction({ action: "message-removal", id });

    const { activeFolder, adjustSidebarCount } = useMailStore.getState();
    const sourceKey = activeFolder !== "all_mail" ? folderToCountKey(activeFolder) : null;
    if (sourceKey) {
      adjustSidebarCount(sourceKey, -1);
      sendAction({ action: "sidebar-adjust", key: sourceKey, delta: -1 });
    }
    if (activeFolder === "inbox" && removedMsg && !removedMsg.is_read) {
      adjustSidebarCount("inboxUnread", -1);
      sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: -1 });
    }

    const msg = removedMsg || await messages().getOne<Message>(id).catch(() => null);
    if (!msg) return;

    try {
      const { default: pb } = await import("@/lib/pocketbase");
      const archiveFolder = await pb
        .collection<import("@/lib/pocketbase").Folder>("folders")
        .getFirstListItem(`account = "${msg.account}" && type = "archive"`);

      await updateMessageViaWorker(id, { folder: archiveFolder.id });
    } catch {
      if (sourceKey) {
        adjustSidebarCount(sourceKey, 1);
        sendAction({ action: "sidebar-adjust", key: sourceKey, delta: 1 });
      }
      if (activeFolder === "inbox" && removedMsg && !removedMsg.is_read) {
        adjustSidebarCount("inboxUnread", 1);
        sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: 1 });
      }
      if (removedMsg) {
        setItems((prev) => {
          const updated = [...prev, removedMsg!];
          updated.sort(getMessageComparator(useMailStore.getState().activeFolder));
          return updated;
        });
      }
    }
  }, []);

  const moveToSpam = useCallback(async (id: string) => {
    let removedMsg: Message | undefined;
    setItems((prev) => {
      removedMsg = prev.find((m) => m.id === id);
      if (removedMsg) {
        windowRef.current.totalItems = Math.max(0, windowRef.current.totalItems - 1);
        setTotalItemsState(windowRef.current.totalItems);
      }
      return prev.filter((m) => m.id !== id);
    });
    sendAction({ action: "message-removal", id });

    const { activeFolder, adjustSidebarCount } = useMailStore.getState();
    const sourceKey = activeFolder !== "all_mail" ? folderToCountKey(activeFolder) : null;
    if (sourceKey) {
      adjustSidebarCount(sourceKey, -1);
      sendAction({ action: "sidebar-adjust", key: sourceKey, delta: -1 });
    }
    adjustSidebarCount("spam", 1);
    sendAction({ action: "sidebar-adjust", key: "spam", delta: 1 });
    if (activeFolder === "inbox" && removedMsg && !removedMsg.is_read) {
      adjustSidebarCount("inboxUnread", -1);
      sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: -1 });
    }

    const msg = removedMsg || await messages().getOne<Message>(id).catch(() => null);
    if (!msg) return;

    try {
      const { default: pb } = await import("@/lib/pocketbase");
      const spamFolder = await pb
        .collection<import("@/lib/pocketbase").Folder>("folders")
        .getFirstListItem(`account = "${msg.account}" && type = "spam"`);

      await updateMessageViaWorker(id, { folder: spamFolder.id });
    } catch {
      if (sourceKey) {
        adjustSidebarCount(sourceKey, 1);
        sendAction({ action: "sidebar-adjust", key: sourceKey, delta: 1 });
      }
      adjustSidebarCount("spam", -1);
      sendAction({ action: "sidebar-adjust", key: "spam", delta: -1 });
      if (activeFolder === "inbox" && removedMsg && !removedMsg.is_read) {
        adjustSidebarCount("inboxUnread", 1);
        sendAction({ action: "sidebar-adjust", key: "inboxUnread", delta: 1 });
      }
      if (removedMsg) {
        setItems((prev) => {
          const updated = [...prev, removedMsg!];
          updated.sort(getMessageComparator(useMailStore.getState().activeFolder));
          return updated;
        });
      }
    }
  }, []);

  // Quand toutes les pages sont chargees, items.length est la source de verite.
  // Quand il y a pagination, utiliser totalItemsState du serveur.
  const allPagesLoaded = windowRef.current.startPage === 1 && windowRef.current.endPage >= windowRef.current.totalPages;
  const displayTotalItems = allPagesLoaded ? items.length : totalItemsState;

  // Filtre optimiste cote client : sur la boite de reception, on cache les
  // messages portant au moins un label secondaire. La liste secondaryLabelIds
  // est miroir dans le store Zustand → re-render immediat sur toggle.
  const secondaryLabelIdsList = useMailStore((s) => s.secondaryLabelIds);
  const visibleItems = (() => {
    if (activeFolder !== "inbox") return items;
    if (secondaryLabelIdsList.length === 0) return items;
    const secondaryIds = new Set(secondaryLabelIdsList);
    return items.filter((m) => {
      const labels = m.labels;
      if (!labels || labels.length === 0) return true;
      for (const id of labels) {
        if (secondaryIds.has(id)) return false;
      }
      return true;
    });
  })();

  return {
    messages: visibleItems,
    totalItems: allPagesLoaded ? visibleItems.length : displayTotalItems,
    loading,
    loadingMore,
    loadingDirection,
    hasMoreBottom,
    hasMoreTop,
    newMessageIds,
    loadMoreBottom,
    loadMoreTop,
    markAsRead,
    markAsStarred,
    moveToTrash,
    archiveMessage,
    moveToSpam,
  };
}
