import type Database from "better-sqlite3";
import { getPbDb } from "./sqlite-direct";
import {
  ensureSearchIndexFresh,
  getDocKeysByIds,
  getSearchIndexState,
  searchDocs,
  type SearchKey,
} from "./search-index";
import {
  buildFtsMatch,
  isSimpleQuery,
  parseSearchQuery,
  splitSearchTerms,
  type SearchQueryError,
} from "./search-query";
import { searchHybridContext } from "./embeddings";

// Recherche de mails pour l'interface : UN SEUL moteur pour la palette (Cmd+K)
// et pour la liste "Voir tout", pagine cote serveur, sans plafond.
//
//   1. requete simple (mot-cle, nom, adresse) -> index plein texte du worker
//      (search-index.ts), debut de mot, plus recents d'abord ;
//      aucun resultat -> on tente le moteur semantique avant de dire "rien" ;
//   2. question en langage naturel -> moteur hybride (pertinence) ;
//   3. le perimetre (dossier, vue, label, filtres rapides, expediteurs bloques)
//      est applique sur l'etat ACTUEL des messages, lu dans les index de liste
//      de data.db (jamais une ligne de `messages`) ;
//   4. seules les lignes de la page demandee sont chargees.

export interface MailSearchScope {
  view?: "starred" | "all_mail" | "unread";
  folderIds?: string[];
  folderType?: string;
  labelId?: string;
  isDraft?: boolean;
  excludeSecondary?: boolean;
  unread?: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
  priority?: string;
  fromText?: string;
  /** Niveau du tri en trois niveaux (pastilles). */
  importance?: string;
}

export interface MailSearchRequest {
  userId: string;
  accountId?: string;
  query: string;
  page?: number;
  perPage?: number;
  /** "auto" (defaut) : date pour une requete simple, pertinence pour une question. */
  sort?: "auto" | "date" | "relevance";
  scope?: MailSearchScope;
}

export interface MailSearchItem {
  id: string;
  account: string;
  folder: string;
  folder_type: string;
  thread_id: string;
  message_id: string;
  in_reply_to: string;
  references: string[];
  from_address: { name?: string; address: string };
  to_addresses: { name?: string; address: string }[];
  cc_addresses: { name?: string; address: string }[];
  subject: string;
  snippet: string;
  date: string;
  is_read: boolean;
  is_starred: boolean;
  is_answered: boolean;
  is_draft: boolean;
  is_sent: boolean;
  has_attachments: boolean;
  priority: string;
  uid: number;
  labels: string[];
  spam_score: number;
  spam_action: string;
  scheduled_at: string;
  importance: string;
}

export interface MailSearchResponse {
  items: MailSearchItem[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  /** Nombre de resultats par type de dossier (inbox, sent, spam...). */
  counts: Record<string, number>;
  /** Moteur qui a repondu. */
  mode: "keyword" | "semantic";
  /** Etat de l'index plein texte (premiere construction apres une mise en ligne). */
  indexing: { ready: boolean; done: number; total: number };
}

const SEMANTIC_LIMIT = 200;
// Repli "aucun mot ne correspond" : le moteur semantique rend TOUJOURS ses
// plus proches voisins, meme pour une faute de frappe. On ne garde que les
// resultats franchement proches, en petit nombre, plutot qu'un bruit de 200.
const FALLBACK_MIN_SCORE = 0.45;
const FALLBACK_LIMIT = 50;
const CACHE_TTL_MS = 20_000;
const CACHE_MAX = 24;

interface CachedResult {
  at: number;
  keys: SearchKey[];
  counts: Record<string, number>;
  mode: "keyword" | "semantic";
}
const resultCache = new Map<string, CachedResult>();

interface FlagRow {
  is_read: number;
  is_starred: number;
  is_sent: number;
  has_attachments: number;
  priority: string;
  labels: string | null;
  from_address: string | null;
  importance: string | null;
}

type RawItemRow = {
  id: string;
  account: string;
  folder: string;
  thread_id: string;
  message_id: string;
  in_reply_to: string;
  refs: string | null;
  from_address: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  subject: string;
  snippet: string;
  date: string;
  is_read: number;
  is_starred: number;
  is_answered: number;
  is_draft: number;
  is_sent: number;
  has_attachments: number;
  priority: string;
  uid: number;
  labels: string | null;
  spam_score: number;
  spam_action: string;
  scheduled_at: string;
  importance: string | null;
};

const ITEM_COLS = `id, account, folder, thread_id, message_id, in_reply_to,
  "references" AS refs, from_address, to_addresses, cc_addresses, subject,
  snippet, date, is_read, is_starred, is_answered, is_draft, is_sent,
  has_attachments, priority, uid, labels, spam_score, spam_action, scheduled_at, importance`;
const FLAG_COLS = `is_read, is_starred, is_sent, has_attachments, priority, labels, from_address, importance`;
const KEY_WHERE = `folder = ? AND is_draft = ? AND date = ? AND id = ?`;

// Requete servie par un index de liste ; si l'index n'existe pas (base de dev
// sans les migrations), repli par identifiant.
// Base sans la migration 075 (dev, tests) : la colonne `importance` n'existe
// pas encore -> on la lit comme vide au lieu de casser toute la recherche.
const importanceColCache = new WeakMap<Database.Database, boolean>();
function withImportanceCol(pb: Database.Database, cols: string): string {
  let has = importanceColCache.get(pb);
  if (has === undefined) {
    try {
      has = (pb.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).some(
        (c) => c.name === "importance"
      );
    } catch {
      has = false;
    }
    importanceColCache.set(pb, has);
  }
  return has ? cols : cols.replace(/,\s*importance\b/, ", '' AS importance");
}

function prepareKeyed(
  pb: Database.Database,
  colsIn: string,
  indexes: string[]
): { stmt: Database.Statement; byKey: boolean } {
  const cols = withImportanceCol(pb, colsIn);
  for (const idx of indexes) {
    try {
      return {
        stmt: pb.prepare(`SELECT ${cols} FROM messages INDEXED BY ${idx} WHERE ${KEY_WHERE}`),
        byKey: true,
      };
    } catch {
      // index absent
    }
  }
  return { stmt: pb.prepare(`SELECT ${cols} FROM messages WHERE id = ?`), byKey: false };
}

function safeJson<T>(s: string | null | undefined, dflt: T): T {
  if (!s || typeof s !== "string") return dflt;
  try {
    return JSON.parse(s) as T;
  } catch {
    return dflt;
  }
}

function likeCI(haystack: string | null, needle: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(needle);
}

/**
 * Requete mal formee (valeur inconnue, date invalide, bornes inversees) :
 * POST /search/mail repond 400 avec la liste des erreurs au lieu de chercher.
 */
export class InvalidSearchQueryError extends Error {
  constructor(public readonly errors: SearchQueryError[]) {
    super(`invalid search query: ${errors.map((e) => `${e.code}(${e.token})`).join(", ")}`);
    this.name = "InvalidSearchQueryError";
  }
}

export async function runMailSearch(req: MailSearchRequest): Promise<MailSearchResponse | null> {
  // Verification AVANT toute lecture : une requete fausse ne cherche rien.
  const checked = parseSearchQuery((req.query || "").trim());
  if (checked.errors.length > 0) throw new InvalidSearchQueryError(checked.errors);

  const pb = getPbDb();
  if (!pb || !getSearchIndexState().available) return null;

  const page = Math.max(Number(req.page) || 1, 1);
  const perPage = Math.min(Math.max(Number(req.perPage) || 50, 1), 200);
  const scope = req.scope || {};
  const accountId = req.accountId && req.accountId !== "all" ? req.accountId : undefined;
  const query = (req.query || "").trim();

  await ensureSearchIndexFresh();
  const indexing = getSearchIndexState();
  const indexingOut = { ready: indexing.ready, done: indexing.done, total: indexing.total };

  const cacheKey = JSON.stringify([req.userId, accountId || "", query, req.sort || "auto", scope]);
  let cached = resultCache.get(cacheKey);
  if (cached && (Date.now() - cached.at > CACHE_TTL_MS || !indexing.ready)) cached = undefined;

  // Dossiers de l'utilisateur (ownership) et leur type.
  const folderRows = pb
    .prepare(
      `SELECT f.id AS id, f.type AS type, f.account AS account FROM folders f
       JOIN accounts a ON f.account = a.id WHERE a.user = ?`
    )
    .all(req.userId) as Array<{ id: string; type: string; account: string }>;
  const folderType = new Map(folderRows.map((f) => [f.id, f.type]));

  if (!cached) {
    const parsed = parseSearchQuery(query);
    const terms = splitSearchTerms(parsed.freeText);
    const hasOperators = !!(parsed.from.length || parsed.to.length || parsed.subject.length);
    const dateFrom = parsed.after || undefined;
    const dateTo = parsed.before ? `${parsed.before} 23:59:59.999Z` : undefined;
    const simple =
      req.sort === "date" || (req.sort !== "relevance" && isSimpleQuery(parsed.freeText));
    const hasAnyCriterion =
      terms.length > 0 ||
      hasOperators ||
      !!dateFrom ||
      !!dateTo ||
      parsed.hasAttachment ||
      parsed.isUnread ||
      parsed.isRead ||
      parsed.isStarred;

    let keys: SearchKey[] = [];
    let mode: "keyword" | "semantic" = "keyword";

    const semantic = async (fallback: boolean): Promise<SearchKey[]> => {
      let hits = await searchHybridContext({
        userId: req.userId,
        accountId,
        query: parsed.freeText,
        limit: fallback ? FALLBACK_LIMIT : SEMANTIC_LIMIT,
        lightweight: true,
      });
      if (fallback) hits = hits.filter((h) => h.score >= FALLBACK_MIN_SCORE);
      const ids = hits.map((h) => h.id);
      const found = getDocKeysByIds(req.userId, ids) || [];
      const byId = new Map(found.map((k) => [k.id, k]));
      let ordered = ids.map((id) => byId.get(id)).filter((k): k is SearchKey => !!k);
      // Les operateurs (from:, to:, subject:, dates) restent des conditions
      // strictes, meme en mode pertinence.
      if (hasOperators || dateFrom || dateTo) {
        const allowed = searchDocs({
          userId: req.userId,
          accountId,
          match: buildFtsMatch({
            terms: [],
            from: parsed.from,
            to: parsed.to,
            subject: parsed.subject,
          }),
          dateFrom,
          dateTo,
        });
        const allowedIds = new Set((allowed || []).map((k) => k.id));
        ordered = ordered.filter((k) => allowedIds.has(k.id));
      }
      return ordered;
    };

    if (hasAnyCriterion) {
      if (simple) {
        const match = buildFtsMatch({
          terms,
          from: parsed.from,
          to: parsed.to,
          subject: parsed.subject,
        });
        const found = searchDocs({
          userId: req.userId,
          accountId,
          match,
          dateFrom,
          dateTo,
          orderBy: "date",
        });
        if (found === null) return null;
        keys = found;
        // Aucun mot ne correspond : on tente le sens avant de dire "rien".
        if (keys.length === 0 && terms.length > 0) {
          try {
            keys = await semantic(true);
            if (keys.length > 0) mode = "semantic";
          } catch (err) {
            console.warn(`[mail-search] repli semantique en echec: ${(err as Error).message}`);
          }
        }
      } else {
        mode = "semantic";
        try {
          keys = await semantic(false);
        } catch (err) {
          console.warn(`[mail-search] moteur hybride en echec: ${(err as Error).message}`);
          keys = [];
        }
        if (keys.length === 0) {
          // Question sans reponse semantique : mots-cles par pertinence.
          const found = searchDocs({
            userId: req.userId,
            accountId,
            match: buildFtsMatch({
              terms,
              from: parsed.from,
              to: parsed.to,
              subject: parsed.subject,
            }),
            dateFrom,
            dateTo,
            orderBy: "rank",
            limit: SEMANTIC_LIMIT,
          });
          if (found && found.length > 0) {
            keys = found;
            mode = "keyword";
          }
        }
      }
    }

    // --- Perimetre : memes regles que GET /api/mail/list (mail-list.pb.js) ---
    const hasFolderConstraint = !!(
      (scope.folderIds && scope.folderIds.length > 0) ||
      scope.folderType
    );
    const wanted =
      !scope.view && scope.folderIds && scope.folderIds.length > 0
        ? new Set(scope.folderIds)
        : null;
    const hasScope = !!(scope.view || hasFolderConstraint || scope.labelId);
    const allowedFolders = new Set<string>();
    for (const f of folderRows) {
      if (accountId && f.account !== accountId) continue;
      let keep: boolean;
      if (!hasScope) keep = true; // palette : tous les dossiers, ranges par type
      else if (scope.view === "all_mail") keep = f.type !== "trash";
      else if (scope.view === "unread")
        keep = f.type !== "spam" && f.type !== "trash" && f.type !== "drafts";
      else if (scope.view === "starred") keep = hasFolderConstraint ? true : f.type !== "spam";
      else if (wanted) keep = wanted.has(f.id);
      else if (scope.folderType) keep = f.type === scope.folderType;
      else keep = f.type !== "spam";
      if (keep) allowedFolders.add(f.id);
    }

    const needUnread = scope.view === "unread" || !!scope.unread || parsed.isUnread;
    const needStarred = scope.view === "starred" || !!scope.starred || parsed.isStarred;
    const needAttach = !!scope.hasAttachments || parsed.hasAttachment;
    const needRead = parsed.isRead;
    const needNotSent = scope.view === "all_mail";
    const priority =
      scope.priority === "low" || scope.priority === "normal" || scope.priority === "high"
        ? scope.priority
        : "";
    const fromText = (scope.fromText || "").trim().toLowerCase();
    const importance =
      scope.importance === "important" || scope.importance === "secondary" || scope.importance === "low"
        ? scope.importance
        : "";
    const labelNeedle = scope.labelId ? `"${scope.labelId}"` : "";

    const secondary: string[] = [];
    if (scope.excludeSecondary) {
      for (const r of pb
        .prepare(`SELECT id FROM labels WHERE user = ? AND is_secondary = TRUE`)
        .all(req.userId) as Array<{ id: string }>) {
        secondary.push(`"${r.id}"`);
      }
    }
    // Un expediteur bloque n'apparait dans aucune vue, recherche comprise.
    let blocked: string[] = [];
    const userRow = pb.prepare(`SELECT blocked_senders FROM users WHERE id = ?`).get(req.userId) as
      | { blocked_senders: string | null }
      | undefined;
    if (userRow) {
      blocked = safeJson<unknown[]>(userRow.blocked_senders, [])
        .map((b) => String(b).toLowerCase().trim())
        .filter(Boolean);
    }

    const needFlags =
      needUnread ||
      needRead ||
      needStarred ||
      needAttach ||
      needNotSent ||
      !!priority ||
      !!importance ||
      !!fromText ||
      !!labelNeedle ||
      secondary.length > 0 ||
      blocked.length > 0;
    const flags = needFlags
      ? prepareKeyed(pb, FLAG_COLS, ["idx_msg_list_keys", "idx_msg_list_cover"])
      : null;

    const kept: SearchKey[] = [];
    const counts: Record<string, number> = {};
    for (const k of keys) {
      if (!allowedFolders.has(k.folder)) continue;
      if (scope.isDraft !== undefined && !!k.is_draft !== scope.isDraft) continue;
      // Palette : meme regle que les listes (un brouillon ne se voit que dans
      // Brouillons, et Brouillons ne montre que des brouillons), sinon le
      // nombre annonce par dossier ne serait pas celui de "Voir tout".
      if (!hasScope && (folderType.get(k.folder) === "drafts") !== !!k.is_draft) continue;
      if (flags) {
        const f = (
          flags.byKey ? flags.stmt.get(k.folder, k.is_draft, k.date, k.id) : flags.stmt.get(k.id)
        ) as FlagRow | undefined;
        // Fiche d'index plus a jour (mail deplace ou supprime a l'instant) :
        // la prochaine passe de synchronisation la corrige.
        if (!f) continue;
        if (needUnread && f.is_read) continue;
        if (needRead && !f.is_read) continue;
        if (needStarred && !f.is_starred) continue;
        if (needAttach && !f.has_attachments) continue;
        if (needNotSent && f.is_sent) continue;
        if (priority && f.priority !== priority) continue;
        if (importance && f.importance !== importance) continue;
        if (labelNeedle && !(f.labels || "").includes(labelNeedle)) continue;
        if (secondary.length > 0 && secondary.some((s) => (f.labels || "").includes(s))) continue;
        if (fromText && !likeCI(f.from_address, fromText)) continue;
        if (blocked.length > 0 && f.from_address) {
          const from = f.from_address.toLowerCase();
          if (blocked.some((b) => from.includes(b))) continue;
        }
      }
      kept.push(k);
      const type = folderType.get(k.folder) || "custom";
      counts[type] = (counts[type] || 0) + 1;
    }

    cached = { at: Date.now(), keys: kept, counts, mode };
    if (indexing.ready) {
      resultCache.set(cacheKey, cached);
      while (resultCache.size > CACHE_MAX) {
        const oldest = resultCache.keys().next().value as string | undefined;
        if (!oldest) break;
        resultCache.delete(oldest);
      }
    }
  }

  const total = cached.keys.length;
  const pageKeys = cached.keys.slice((page - 1) * perPage, page * perPage);
  const itemStmt = prepareKeyed(pb, ITEM_COLS, ["idx_msg_list_cover"]);
  const items: MailSearchItem[] = [];
  for (const k of pageKeys) {
    const r = (
      itemStmt.byKey
        ? itemStmt.stmt.get(k.folder, k.is_draft, k.date, k.id)
        : itemStmt.stmt.get(k.id)
    ) as RawItemRow | undefined;
    if (!r) continue;
    items.push({
      id: r.id,
      account: r.account,
      folder: r.folder || "",
      folder_type: folderType.get(r.folder) || "",
      thread_id: r.thread_id || "",
      message_id: r.message_id || "",
      in_reply_to: r.in_reply_to || "",
      references: safeJson<string[]>(r.refs, []),
      from_address: safeJson(r.from_address, { address: "", name: "" }),
      to_addresses: safeJson(r.to_addresses, []),
      cc_addresses: safeJson(r.cc_addresses, []),
      subject: r.subject || "",
      snippet: r.snippet || "",
      date: r.date || "",
      is_read: !!r.is_read,
      is_starred: !!r.is_starred,
      is_answered: !!r.is_answered,
      is_draft: !!r.is_draft,
      is_sent: !!r.is_sent,
      has_attachments: !!r.has_attachments,
      priority: r.priority || "normal",
      uid: Number(r.uid) || 0,
      labels: safeJson<string[]>(r.labels, []),
      spam_score: Number(r.spam_score) || 0,
      spam_action: r.spam_action || "",
      scheduled_at: r.scheduled_at || "",
      importance: r.importance || "",
    });
  }

  return {
    items,
    page,
    perPage,
    totalItems: total,
    totalPages: Math.ceil(total / perPage),
    counts: cached.counts,
    mode: cached.mode,
    indexing: indexingOut,
  };
}
