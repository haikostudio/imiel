import pb, { getCurrentUserId, type Message } from "@/lib/pocketbase";

/**
 * Client de l'endpoint SQL-direct /api/mail/list (pb_hooks/mail-list.pb.js).
 * Beaucoup plus rapide que pb.collection("messages").getList() qui applique
 * les access rules per-row sur toute la table.
 */

export interface MailListFilter {
  unread?: boolean;
  hasAttachments?: boolean;
  starred?: boolean;
  priority?: "all" | "low" | "normal" | "high";
  fromText?: string;
  bodyText?: string;
  /** Niveau du tri en trois niveaux (pastilles). */
  importance?: "important" | "secondary" | "low" | null;
}

export interface ImportanceCounts {
  important: number;
  secondary: number;
  low: number;
}

export interface MailListParams {
  page: number;
  perPage: number;
  accountId?: string | null;
  /** folder explicite (priorite sur folderIds/folderType) */
  folderId?: string;
  /** liste de folders (si > 1 ; sinon utiliser folderId) */
  folderIds?: string[];
  /** type standard : inbox/sent/drafts/trash/spam/archive */
  folderType?: string;
  /** vue virtuelle */
  view?: "starred" | "all_mail" | "unread";
  labelId?: string;
  /** exclure les messages portant au moins un label is_secondary=true */
  excludeSecondary?: boolean;
  isDraft?: boolean;
  filter?: MailListFilter;
  /** recherche libre multi-champs (sujet + from + to), via SQL direct */
  searchText?: string;
  /** "date" (default) ou "unread_date" */
  sort?: "date" | "unread_date";
  /**
   * Ajoute `thread_tails` a la reponse : dernier message de chaque fil de la
   * page, tous dossiers confondus (envoyes compris). Vue conversations.
   */
  withTails?: boolean;
  /** Ajoute `importance_counts` (non lus par niveau, meme contexte). */
  withImportanceCounts?: boolean;
}

export interface MailListResponse {
  items: Message[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  /** thread_id -> dernier message du fil (is_answered uni sur les copies) */
  thread_tails?: Record<string, Message> | null;
  /** Non lus par niveau dans le meme contexte (with_importance_counts). */
  importance_counts?: ImportanceCounts | null;
}

const CACHE_TTL_MS = 90_000;
const MAX_CACHE_ENTRIES = 160;

interface CacheEntry {
  expiresAt: number;
  response: MailListResponse;
}

const responseCache = new Map<string, CacheEntry>();
const pendingRequests = new Map<string, Promise<MailListResponse>>();

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(key);
  }
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    responseCache.delete(oldestKey);
  }
}

export function clearMailListPageCache() {
  responseCache.clear();
  pendingRequests.clear();
}

function buildMailListQuery(params: MailListParams): string {
  const qs = new URLSearchParams();
  qs.set("page", String(params.page));
  qs.set("per_page", String(params.perPage));

  if (params.accountId && params.accountId !== "all") {
    qs.set("account_id", params.accountId);
  }

  if (params.view === "starred" || params.view === "all_mail" || params.view === "unread") {
    qs.set("view", params.view);
  } else if (params.folderId) {
    qs.set("folder_id", params.folderId);
  } else if (params.folderIds && params.folderIds.length > 0) {
    if (params.folderIds.length === 1) {
      qs.set("folder_id", params.folderIds[0]);
    } else {
      qs.set("folder_ids", params.folderIds.join(","));
    }
  } else if (params.folderType) {
    qs.set("folder_type", params.folderType);
  }

  if (params.labelId) qs.set("label_id", params.labelId);
  if (params.excludeSecondary) qs.set("exclude_secondary", "true");

  if (params.isDraft === true) qs.set("is_draft", "true");
  if (params.isDraft === false) qs.set("is_draft", "false");

  const f = params.filter;
  if (f) {
    if (f.unread) qs.set("is_read", "false");
    if (f.starred) qs.set("is_starred", "true");
    if (f.hasAttachments) qs.set("has_attachments", "true");
    if (f.priority && f.priority !== "all") qs.set("priority", f.priority);
    if (f.fromText && f.fromText.trim()) qs.set("from_text", f.fromText.trim());
    if (f.bodyText && f.bodyText.trim()) qs.set("body_text", f.bodyText.trim());
    if (f.importance) qs.set("importance", f.importance);
  }

  if (params.searchText && params.searchText.trim()) {
    qs.set("search_text", params.searchText.trim());
  }

  if (params.sort) qs.set("sort", params.sort);
  if (params.withTails) qs.set("with_tails", "true");
  if (params.withImportanceCounts) qs.set("with_importance_counts", "true");

  return qs.toString();
}

function getCacheKey(query: string) {
  return `${getCurrentUserId() ?? "anonymous"}|${query}`;
}

export async function fetchMailListPage(params: MailListParams): Promise<MailListResponse> {
  pruneCache();
  const query = buildMailListQuery(params);
  const cacheKey = getCacheKey(query);
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.response;

  const pending = pendingRequests.get(cacheKey);
  if (pending) return pending;

  const request = pb
    .send<MailListResponse>(`/api/mail/list?${query}`, { method: "GET" })
    .then((response) => {
      responseCache.set(cacheKey, {
        response,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return response;
    })
    .finally(() => {
      pendingRequests.delete(cacheKey);
    });

  pendingRequests.set(cacheKey, request);
  return request;
}

/**
 * Non lus par niveau (pastilles Importants / Secondaires / Peu utiles) dans le
 * contexte de la liste, SANS cache (les compteurs doivent suivre la lecture).
 */
export async function fetchImportanceCounts(params: Omit<MailListParams, "page" | "perPage">): Promise<ImportanceCounts | null> {
  const query = buildMailListQuery({ ...params, page: 1, perPage: 1, withImportanceCounts: true });
  const res = await pb.send<MailListResponse>(`/api/mail/list?${query}`, { method: "GET" });
  return res.importance_counts ?? null;
}
