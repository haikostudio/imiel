import { getCurrentUserId, type Message } from "@/lib/pocketbase";
import type { MailListFilter, MailListResponse } from "@/lib/mail-list-api";

/**
 * Client de la recherche de mails du worker (POST /worker/search/mail).
 * UN SEUL moteur pour la palette (Cmd+K) et pour la liste "Voir tout" :
 * debut de mot, expediteur et destinataires compris, pagination cote serveur
 * (aucun plafond), plus recents d'abord pour une requete simple.
 */

/** Perimetre de la liste : memes notions que MailListParams (/api/mail/list). */
export interface MailSearchScope {
  folderId?: string;
  folderIds?: string[];
  folderType?: string;
  view?: "starred" | "all_mail" | "unread";
  labelId?: string;
  excludeSecondary?: boolean;
  isDraft?: boolean;
  filter?: MailListFilter;
}

export interface MailSearchParams {
  /** Texte saisi tel quel, operateurs compris (from: is:unread after: ...). */
  query: string;
  page: number;
  perPage: number;
  accountId?: string | null;
  /** Absent = toute la boite, tous dossiers (palette). */
  scope?: MailSearchScope;
  signal?: AbortSignal;
}

export type MailSearchItem = Message & { folder_type?: string };

export interface MailSearchResponse extends MailListResponse {
  items: MailSearchItem[];
  /** Nombre de resultats par type de dossier (inbox, sent, spam...). */
  counts: Record<string, number>;
  mode: "keyword" | "semantic";
  /** Premiere construction de l'index apres une mise en ligne. */
  indexing: { ready: boolean; done: number; total: number };
}

function toWorkerScope(scope: MailSearchScope | undefined) {
  if (!scope) return undefined;
  const folderIds = scope.folderId ? [scope.folderId] : scope.folderIds;
  const f = scope.filter;
  return {
    view: scope.view,
    folderIds: scope.view ? undefined : folderIds,
    folderType: scope.folderType,
    labelId: scope.labelId,
    excludeSecondary: scope.excludeSecondary || undefined,
    isDraft: scope.isDraft,
    unread: f?.unread || undefined,
    starred: f?.starred || undefined,
    hasAttachments: f?.hasAttachments || undefined,
    priority: f?.priority && f.priority !== "all" ? f.priority : undefined,
    fromText: f?.fromText?.trim() || undefined,
    importance: f?.importance || undefined,
  };
}

/**
 * Leve une erreur si le worker est injoignable ou si son index est
 * indisponible : l'appelant retombe alors sur la recherche PocketBase.
 */
export async function fetchMailSearchPage(params: MailSearchParams): Promise<MailSearchResponse> {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("not authenticated");
  const res = await fetch("/worker/search/mail", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId,
      accountId: params.accountId && params.accountId !== "all" ? params.accountId : undefined,
      query: params.query,
      page: params.page,
      perPage: params.perPage,
      scope: toWorkerScope(params.scope),
    }),
    signal: params.signal,
  });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  return (await res.json()) as MailSearchResponse;
}
