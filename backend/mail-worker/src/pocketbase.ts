// Node 20+ has native fetch, FormData, Blob
import { serviceDisabled } from "./local-mode";
import {
  listExistingUidsFromSqlite,
  listExistingMessageIdsFromSqlite,
  listUidsAmongFromSqlite,
  messageIdExistsFromSqlite,
  listMessageCopiesForUserFromSqlite,
} from "./sqlite-direct";
import {
  isLaterCopyOnOtherAccount,
  messageIdVariants,
  type MessageCopy,
} from "./notify-dedup";

// Read at call time (not module load) to avoid import hoisting issues with dotenv
function getPocketBaseUrl(): string {
  return process.env.POCKETBASE_URL || "http://127.0.0.1:8090";
}

let adminToken: string | null = null;
let tokenExpiry = 0;

async function getAdminToken(): Promise<string> {
  if (adminToken && Date.now() < tokenExpiry) {
    return adminToken;
  }

  const email = process.env.PB_ADMIN_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL;
  const password = process.env.PB_ADMIN_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are required"
    );
  }

  const res = await fetch(`${getPocketBaseUrl()}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PocketBase admin auth failed: ${res.status} - ${body}`);
  }

  const data = (await res.json()) as { token: string };
  adminToken = data.token;
  // Refresh 5 minutes before expiry (PB tokens last ~1 hour)
  tokenExpiry = Date.now() + 55 * 60 * 1000;

  return adminToken;
}

async function pbFetch(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    formData?: FormData;
    params?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<unknown> {
  const token = await getAdminToken();
  const { method = "GET", body, formData, params, timeoutMs } = options;

  let url = `${getPocketBaseUrl()}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let fetchBody: string | FormData | undefined;
  if (formData) {
    fetchBody = formData;
  } else if (body) {
    headers["Content-Type"] = "application/json";
    fetchBody = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers,
    body: fetchBody,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PocketBase ${method} ${path} failed: ${res.status} - ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

// --- Contacts ---

export interface PBContact {
  id: string;
  user: string;
  name: string;
  email: string;
  last_contact_date: string;
  message_count: number;
  // Numero de telephone.
  phone?: string;
  // Societe (migration 062).
  company?: string;
  created: string;
  updated: string;
}

// --- Accounts ---

export interface PBAccount {
  id: string;
  user: string;
  /** Boite iMiel Cloud : relevee par le serveur de transfert, jamais ici. */
  cloud_managed?: boolean;
  label: string;
  email: string;
  display_name: string;
  protocol: "imap" | "pop3";
  imap_host: string;
  imap_port: number;
  imap_security: "none" | "ssl" | "starttls";
  imap_username: string;
  imap_password: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: "none" | "ssl" | "starttls";
  smtp_username: string;
  smtp_password: string;
  check_interval: number;
  signature: string;
  sync_status: string;
  sync_error: string;
  last_synced_at: string;
  is_active: boolean;
  auth_type: "password" | "oauth2";
  oauth_provider: string;
  oauth_refresh_token: string;
  oauth_access_token: string;
  oauth_token_expiry: string;
  created: string;
  updated: string;
}

export async function createAccount(
  data: Partial<PBAccount>
): Promise<PBAccount> {
  return (await pbFetch("/api/collections/accounts/records", {
    method: "POST",
    body: data,
  })) as PBAccount;
}

export async function getAccount(accountId: string): Promise<PBAccount> {
  return (await pbFetch(`/api/collections/accounts/records/${accountId}`)) as PBAccount;
}

export async function updateAccount(
  accountId: string,
  data: Partial<PBAccount>
): Promise<PBAccount> {
  return (await pbFetch(`/api/collections/accounts/records/${accountId}`, {
    method: "PATCH",
    body: data,
  })) as PBAccount;
}

export async function findAccountByEmail(
  userId: string,
  email: string
): Promise<PBAccount | null> {
  const result = (await pbFetch("/api/collections/accounts/records", {
    params: {
      filter: `user="${userId}" && email="${email}"`,
      perPage: "1",
    },
  })) as { items: PBAccount[] };
  return result.items.length > 0 ? result.items[0] : null;
}

export async function listAccountsDueForSync(): Promise<PBAccount[]> {
  const result = (await pbFetch("/api/collections/accounts/records", {
    params: {
      // Boites iMiel Cloud : relevees par le serveur de transfert, jamais ici.
      filter: "is_active=true && cloud_managed!=true",
      perPage: "200",
      sort: "last_synced_at",
    },
  })) as { items: PBAccount[] };
  return result.items;
}

// --- Folders ---

export interface PBFolder {
  id: string;
  account: string;
  name: string;
  path: string;
  type: string;
  delimiter: string;
  unread_count: number;
  total_count: number;
  last_uid: number;
  uid_validity?: number;
  created: string;
  updated: string;
}

export async function listFolders(accountId: string): Promise<PBFolder[]> {
  const result = (await pbFetch("/api/collections/folders/records", {
    params: {
      filter: `account="${accountId}"`,
      perPage: "200",
    },
  })) as { items: PBFolder[] };
  return result.items;
}

export async function upsertFolder(
  accountId: string,
  data: {
    name: string;
    path: string;
    type?: string;
    delimiter?: string;
    unread_count?: number;
    total_count?: number;
    last_uid?: number;
  }
): Promise<PBFolder> {
  // Check if folder exists
  const existing = (await pbFetch("/api/collections/folders/records", {
    params: {
      filter: `account="${accountId}" && path="${data.path}"`,
      perPage: "1",
    },
  })) as { items: PBFolder[] };

  if (existing.items.length > 0) {
    return (await pbFetch(
      `/api/collections/folders/records/${existing.items[0].id}`,
      { method: "PATCH", body: data }
    )) as PBFolder;
  }

  return (await pbFetch("/api/collections/folders/records", {
    method: "POST",
    body: { account: accountId, ...data },
  })) as PBFolder;
}

export async function updateFolder(
  folderId: string,
  data: Partial<PBFolder>
): Promise<PBFolder> {
  return (await pbFetch(`/api/collections/folders/records/${folderId}`, {
    method: "PATCH",
    body: data,
  })) as PBFolder;
}

// --- Messages ---

export interface PBEmailAddress {
  name?: string;
  address: string;
}

export interface PBMessage {
  id: string;
  account: string;
  folder: string;
  message_id: string;
  thread_id: string;
  subject: string;
  from_address: PBEmailAddress;
  to_addresses: PBEmailAddress[];
  cc_addresses: PBEmailAddress[];
  bcc_addresses: PBEmailAddress[];
  date: string;
  snippet: string;
  text_body: string;
  html_body: string;
  is_read: boolean;
  is_starred: boolean;
  is_draft: boolean;
  is_sent: boolean;
  is_answered: boolean;
  has_attachments: boolean;
  priority: string;
  labels: string[];
  /** Niveau d'importance (migration 075) : "" = pas encore classe. */
  importance?: "important" | "secondary" | "low" | "";
  importance_source?: "ai" | "rule" | "user" | "heuristic" | "";
  uid: number;
  references: string[];
  in_reply_to: string;
  draft_reply_to: string;
  auto_saved_at: string;
  attachments: string[];
  raw_headers: string;
  spam_score: number;
  spam_action: string;
  created: string;
  updated: string;
}

export async function createMessage(
  data: Partial<PBMessage>
): Promise<PBMessage> {
  try {
    return (await pbFetch("/api/collections/messages/records", {
      method: "POST",
      body: data,
    })) as PBMessage;
  } catch (err) {
    // Course inter-sync : l'index UNIQUE (folder, uid) interdit deux
    // enregistrements pour le meme mail IMAP. Quand deux syncs du meme compte
    // se chevauchent (IMAP IDLE + safety poll + sync manuelle), la perdante
    // prend une violation de contrainte. On la resout en renvoyant la ligne
    // gagnante au lieu de planter : l'insert "a reussi" du point de vue appel.
    if (data.folder && typeof data.uid === "number" && data.uid > 0) {
      const existing = await findMessageByFolderUid(
        data.folder,
        data.uid
      ).catch(() => null);
      if (existing) return existing;
    }
    throw err;
  }
}

// Recherche un message par (folder, uid) : clef d'unicite IMAP (cf index
// UNIQUE idx_msg_folder_uid_unique). Utilise pour resoudre les courses d'insert.
export async function findMessageByFolderUid(
  folderId: string,
  uid: number
): Promise<PBMessage | null> {
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `folder="${folderId}" && uid=${uid}`,
      perPage: "1",
    },
  })) as { items: PBMessage[] };
  return result.items[0] || null;
}

export async function getMessage(messageId: string): Promise<PBMessage> {
  return (await pbFetch(`/api/collections/messages/records/${messageId}`, {
    timeoutMs: 30000,
  })) as PBMessage;
}

export async function updateMessage(
  messageId: string,
  data: Partial<PBMessage>
): Promise<PBMessage> {
  return (await pbFetch(`/api/collections/messages/records/${messageId}`, {
    method: "PATCH",
    body: data,
  })) as PBMessage;
}

// Partial PATCH peut echouer en 400 si PB revalide un champ stale du record
// (relation supprimee, JSON hors limite, etc.). On retombe alors sur un merge
// du record complet, comme pour les endpoints message-flags/message-update.
export async function updateMessageSafe(
  messageId: string,
  updates: Partial<PBMessage>
): Promise<PBMessage> {
  try {
    return await updateMessage(messageId, updates);
  } catch (err) {
    const record = await getMessage(messageId);
    const merged: Record<string, unknown> = { ...record, ...updates };
    delete merged.id;
    delete merged.created;
    delete merged.updated;
    delete merged.collectionId;
    delete merged.collectionName;
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(
      `updateMessageSafe: partial PATCH failed for ${messageId}, falling back to full merge: ${errMsg}`
    );
    return await updateMessage(messageId, merged as Partial<PBMessage>);
  }
}

export async function findMessageByMessageId(
  accountId: string,
  messageId: string,
  folderId?: string
): Promise<PBMessage | null> {
  let filter = `account="${accountId}" && message_id="${messageId}"`;
  if (folderId) {
    filter += ` && folder="${folderId}"`;
  }
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter,
      perPage: "1",
    },
  })) as { items: PBMessage[] };
  return result.items[0] || null;
}

export async function getLastUidForFolder(
  folderId: string
): Promise<number> {
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `folder="${folderId}"`,
      sort: "-uid",
      perPage: "1",
      fields: "uid",
    },
  })) as { items: { uid: number }[] };
  return result.items[0]?.uid || 0;
}

export async function listExistingMessageIds(
  accountId: string,
  folderId: string
): Promise<Set<string>> {
  // Voie rapide : lecture SQLite directe (1 requete indexee) au lieu de
  // paginer en offset l'API PB (~68 requetes / ~10 min sur l'inbox Gmail).
  const fast = listExistingMessageIdsFromSqlite(accountId, folderId);
  if (fast) return fast;

  const ids = new Set<string>();
  let page = 1;
  const perPage = 500;

  while (true) {
    const result = (await pbFetch("/api/collections/messages/records", {
      params: {
        filter: `account="${accountId}" && folder="${folderId}"`,
        fields: "message_id",
        page: String(page),
        perPage: String(perPage),
      },
    })) as { items: { message_id: string }[]; totalPages: number };

    for (const item of result.items) {
      if (item.message_id) ids.add(item.message_id);
    }

    if (page >= result.totalPages) break;
    page++;
  }

  return ids;
}

/**
 * UIDs already stored for a folder. UID is unique and stable per IMAP
 * mailbox, so this is a reliable dedup key even for messages that have
 * no Message-ID header.
 */
export async function listExistingUidsForFolder(
  folderId: string
): Promise<Set<number>> {
  // Voie rapide : lecture SQLite directe (1 requete indexee) au lieu de
  // paginer en offset l'API PB (cf listExistingMessageIds).
  const fast = listExistingUidsFromSqlite(folderId);
  if (fast) return fast;

  const uids = new Set<number>();
  let page = 1;
  const perPage = 500;

  while (true) {
    const result = (await pbFetch("/api/collections/messages/records", {
      params: {
        filter: `folder="${folderId}"`,
        fields: "uid",
        page: String(page),
        perPage: String(perPage),
      },
    })) as { items: { uid: number }[]; totalPages: number };

    for (const item of result.items) {
      if (item.uid > 0) uids.add(item.uid);
    }

    if (page >= result.totalPages) break;
    page++;
  }

  return uids;
}

/**
 * UIDs deja stockes PARMI les candidats donnes (hot path live, peu de
 * candidats). Point queries indexees ; fallback = listing complet du dossier
 * (semantique identique, juste plus lent).
 */
export async function listExistingUidsAmong(
  folderId: string,
  candidates: number[]
): Promise<Set<number>> {
  if (candidates.length === 0) return new Set();
  const fast = listUidsAmongFromSqlite(folderId, candidates);
  if (fast) return fast;
  return listExistingUidsForFolder(folderId);
}

/**
 * Existence d'un message par (account, message_id) : dedup du hot path live
 * sans precharger tous les message-ids. Fast path SQLite (idx_msg_mid),
 * fallback filtre PB. En cas d'echec des deux -> false (on retombe alors sur
 * l'index UNIQUE (folder, uid) qui empeche le vrai doublon par dossier).
 */
export async function messageIdExists(
  accountId: string,
  messageId: string
): Promise<boolean> {
  const fast = messageIdExistsFromSqlite(accountId, messageId);
  if (fast !== null) return fast;
  try {
    const escaped = messageId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const result = (await pbFetch("/api/collections/messages/records", {
      params: {
        filter: `account="${accountId}" && message_id="${escaped}"`,
        perPage: "1",
        fields: "id",
      },
      timeoutMs: 10000,
    })) as { totalItems?: number };
    return (result.totalItems || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Vrai si le message `recordId` (Message-ID `messageIdHeader`) est une copie
 * TARDIVE d'un mail deja enregistre sur un AUTRE compte du meme utilisateur
 * (regle "la plus ancienne notifie", cf notify-dedup.ts). Toute erreur ->
 * false : dans le doute on notifie (mieux vaut un doublon qu'un mail manque).
 */
export async function isLaterCopyOfMailOnOtherAccount(
  userId: string,
  recordId: string,
  messageIdHeader: string | undefined
): Promise<boolean> {
  const variants = messageIdVariants(messageIdHeader);
  if (variants.length === 0) return false;
  try {
    let copies: MessageCopy[] | null = listMessageCopiesForUserFromSqlite(userId, variants);
    if (copies === null) {
      const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const midFilter = variants.map((v) => `message_id="${esc(v)}"`).join(" || ");
      const result = (await pbFetch("/api/collections/messages/records", {
        params: {
          filter: `(${midFilter}) && account.user="${userId}"`,
          perPage: "50",
          skipTotal: "true",
          fields: "id,account,created",
        },
        timeoutMs: 10000,
      })) as { items?: MessageCopy[] };
      copies = result.items || [];
    }
    return isLaterCopyOnOtherAccount(recordId, copies);
  } catch (err) {
    console.warn(`[notify] copy check failed for ${recordId}: ${(err as Error).message}`);
    return false;
  }
}

export async function findSpamFolder(
  accountId: string
): Promise<PBFolder | null> {
  const result = (await pbFetch("/api/collections/folders/records", {
    params: {
      filter: `account="${accountId}" && type="spam"`,
      perPage: "1",
    },
  })) as { items: PBFolder[] };
  return result.items[0] || null;
}

export async function deleteFolder(folderId: string): Promise<void> {
  await pbFetch(`/api/collections/folders/records/${folderId}`, {
    method: "DELETE",
  });
}

export async function deleteMessage(messageId: string): Promise<void> {
  await pbFetch(`/api/collections/messages/records/${messageId}`, {
    method: "DELETE",
  });
}

export async function listMessageIdsByFolder(
  folderId: string
): Promise<{ id: string; message_id: string }[]> {
  const messages: { id: string; message_id: string }[] = [];
  let page = 1;
  const perPage = 500;

  while (true) {
    const result = (await pbFetch("/api/collections/messages/records", {
      params: {
        filter: `folder="${folderId}"`,
        fields: "id,message_id",
        page: String(page),
        perPage: String(perPage),
      },
    })) as { items: { id: string; message_id: string }[]; totalPages: number };

    messages.push(...result.items);
    if (page >= result.totalPages) break;
    page++;
  }

  return messages;
}

export async function listMessages(
  folderId: string,
  page: number,
  perPage: number,
  fields: string = "id,uid,subject"
): Promise<PBMessage[]> {
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `folder="${folderId}"`,
      sort: "-date",
      page: String(page),
      perPage: String(perPage),
      fields,
    },
  })) as { items: PBMessage[] };
  return result.items;
}

/** Charge plusieurs messages par id en une requete (contexte RAG). */
export async function listMessagesByIds(
  ids: string[]
): Promise<PBMessage[]> {
  if (ids.length === 0) return [];
  const filter = ids.map((id) => `id="${id}"`).join(" || ");
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter,
      perPage: String(ids.length),
      fields:
        "id,thread_id,subject,from_address,to_addresses,date,snippet,text_body,html_body",
    },
    timeoutMs: 30000,
  })) as { items: PBMessage[] };
  return result.items;
}

/**
 * Recherche keyword (LIKE) sur subject/text_body + adresses (from/to/cc),
 * restreinte aux comptes de l'utilisateur via `account.user`. Complement
 * essentiel a la recherche semantique pour les noms propres, references,
 * numeros, et pour faire le lien sujet <-> contact (email "asso" matche
 * "admin@association-example.org"). Les termes sont OR'es entre eux : la
 * fusion / scoring par nombre de termes matches est faite cote appelant.
 *
 * Pourquoi inclure les addresses (champs JSON) :
 * - PB stocke from_address/to_addresses en JSON, mais le `~` text match
 *   matche la representation serialisee : `subject ~ "asso"` ne matche
 *   PAS l'adresse, alors que `from_address ~ "asso"` matche le JSON
 *   {"address":"...asso.ch","name":"..."}.
 * - Sans ca, on rate les emails entrants ou un correspondant lie au projet
 *   ecrit sans jamais mentionner le mot-cle dans le corps (ex: facture,
 *   accuse de reception).
 */
export async function listMessagesByKeywords(opts: {
  userId: string;
  accountId?: string;
  terms: string[];
  limit: number;
}): Promise<PBMessage[]> {
  if (opts.terms.length === 0) return [];
  const parts: string[] = [`account.user="${opts.userId}"`];
  if (opts.accountId) parts.push(`account="${opts.accountId}"`);
  // IMPORTANT : on cherche aussi dans html_body et snippet. Beaucoup d'emails
  // (newsletters, factures, transactionnels) sont HTML-only : leur text_body
  // est vide et le terme ("atelier60", "asso"...) n'existe QUE dans le HTML.
  // Sans ces deux champs, on rate la majorite des emails commerciaux. C'etait
  // la cause du "aucun email trouve" en prod malgre des matches evidents.
  // IMPORTANT perfs : on a teste les LIKE par colonne sur une boite reelle
  // (42k mails, 173 hits sur "Atelier60") :
  //   - subject + text_body + snippet           ~1.1s
  //   - + html_body                              ~5.3s
  //   - + JSON columns (from/to/cc_addresses)    ~7.1s
  // Les JSON columns (PocketBase stocke les addresses en JSON serialise) sont
  // lentes ET capturent quasi rien que les autres champs n'attrapent deja
  // (l'email apparait dans le body du mail dans 99% des cas). On les vire
  // pour passer sous la barre des 2s. html_body est garde car indispensable
  // pour les newsletters HTML-only.
  // Avant ce fix : 15s timeout systematique en prod -> "keyword failed:
  // operation aborted due to timeout" -> seul le semantic remontait, qui
  // ramenait des mails non pertinents (Nudient pour une recherche
  // "Atelier60"). Cause confirmee par les logs worker.
  const termClauses = opts.terms
    .map((t) => {
      const safe = t.replace(/"/g, '\\"');
      return [
        `subject ~ "${safe}"`,
        `text_body ~ "${safe}"`,
        `html_body ~ "${safe}"`,
        `snippet ~ "${safe}"`,
      ].join(" || ");
    })
    .join(" || ");
  parts.push(`(${termClauses})`);
  const filter = parts.join(" && ");
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter,
      sort: "-date",
      perPage: String(opts.limit),
      fields:
        "id,thread_id,subject,from_address,to_addresses,cc_addresses,date,snippet,text_body,html_body",
    },
    // Marge confortable au-dessus de la mesure SQL (~5.3s avec html_body sur
    // 42k mails). Si la boite double, on reste sous la limite.
    timeoutMs: 30000,
  })) as { items: PBMessage[] };
  return result.items;
}

// --- Mail Embeddings (memoire semantique pour l'assistant IA) ---

export interface PBMailEmbedding {
  id: string;
  message: string;
  account: string;
  user: string;
  vector: number[];
  model: string;
  content_hash: string;
  created: string;
  updated: string;
}

// Timeouts critiques pour le hot path du backfill : sans `timeoutMs`, fetch()
// peut rester pendu pour toujours si PB freeze (socket undici sature par les
// SSE, latence reseau, etc.), figeant la boucle d'indexation a un mail donne
// sans erreur visible. Avec timeout + retry cote backfill, on saute l'item
// problematique et on continue.
export async function findEmbeddingByMessage(
  messageId: string
): Promise<PBMailEmbedding | null> {
  const result = (await pbFetch("/api/collections/mail_embeddings/records", {
    params: { filter: `message="${messageId}"`, perPage: "1" },
    timeoutMs: 20000,
  })) as { items: PBMailEmbedding[] };
  return result.items[0] || null;
}

export async function createEmbedding(
  data: Partial<PBMailEmbedding>
): Promise<PBMailEmbedding> {
  return (await pbFetch("/api/collections/mail_embeddings/records", {
    method: "POST",
    body: data,
    timeoutMs: 30000,
  })) as PBMailEmbedding;
}

export async function updateEmbedding(
  id: string,
  data: Partial<PBMailEmbedding>
): Promise<PBMailEmbedding> {
  return (await pbFetch(`/api/collections/mail_embeddings/records/${id}`, {
    method: "PATCH",
    body: data,
    timeoutMs: 30000,
  })) as PBMailEmbedding;
}

/**
 * Recupere la 1re date de message d'un user dans un sens donne (ASC pour le
 * plus ancien, DESC pour le plus recent). Sert au fallback coverage quand
 * SQLite direct n'est pas disponible (worker dev pointe sur PB distante).
 */
export async function getEarliestOrLatestMessageDate(
  userId: string,
  direction: "asc" | "desc"
): Promise<string | null> {
  const sort = direction === "asc" ? "date" : "-date";
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `account.user="${userId}" && is_draft=false`,
      sort,
      perPage: "1",
      fields: "date",
    },
    timeoutMs: 15000,
  })) as { items: Array<{ date: string }> };
  return result.items[0]?.date || null;
}

export async function countRecords(
  collection: string,
  filter: string
): Promise<number> {
  const result = (await pbFetch(`/api/collections/${collection}/records`, {
    params: { filter, perPage: "1", fields: "id" },
  })) as { totalItems: number };
  return result.totalItems;
}

export async function listAccountsForUser(
  userId: string
): Promise<PBAccount[]> {
  const result = (await pbFetch("/api/collections/accounts/records", {
    params: { filter: `user="${userId}"`, perPage: "200" },
  })) as { items: PBAccount[] };
  return result.items;
}

/**
 * Retourne la liste dedupliquee des userId ayant au moins un compte actif.
 * Utilise par le top-up automatique des embeddings (rattrape les mails que
 * l'indexation incrementale a manques : worker redemarre, exception, etc.).
 */
export async function listActiveUserIds(): Promise<string[]> {
  const result = (await pbFetch("/api/collections/accounts/records", {
    params: {
      filter: `is_active=true`,
      perPage: "500",
      fields: "user",
    },
    timeoutMs: 20000,
  })) as { items: { user: string }[] };
  return Array.from(new Set(result.items.map((a) => a.user).filter(Boolean)));
}

export async function listInboxFolderIds(accountId: string): Promise<string[]> {
  const result = (await pbFetch("/api/collections/folders/records", {
    params: {
      filter: `account="${accountId}" && type="inbox"`,
      perPage: "10",
      fields: "id",
    },
  })) as { items: { id: string }[] };
  return result.items.map((f) => f.id);
}

export interface PBMessageForCategorize {
  id: string;
  subject: string;
  snippet: string;
  text_body: string;
  from_address: PBEmailAddress;
  thread_id?: string;
}

/** Page de messages d'un inbox folder sans labels, depuis `sinceIso`. */
export async function listUncategorizedMessages(
  folderId: string,
  sinceIso: string,
  page: number,
  perPage: number
): Promise<{ items: PBMessageForCategorize[]; totalPages: number; totalItems: number }> {
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `folder="${folderId}" && date >= "${sinceIso}" && is_draft=false && labels:length=0`,
      page: String(page),
      perPage: String(perPage),
      fields: "id,subject,snippet,text_body,from_address,thread_id",
      sort: "-date",
    },
  })) as { items: PBMessageForCategorize[]; totalPages: number; totalItems: number };
  return result;
}

// --- Cerveau (memoire centrale) --------------------------------------------

export interface PBMessageForCerveau {
  id: string;
  subject: string;
  snippet: string;
  text_body: string;
  html_body: string;
  from_address: PBEmailAddress;
  to_addresses: PBEmailAddress[];
  cc_addresses: PBEmailAddress[];
  date: string;
  account: string;
  folder: string;
  thread_id?: string;
  has_attachments: boolean;
  is_sent: boolean;
  labels: string[];
  expand?: { labels?: { name: string }[] };
}

/** Page de messages d'un compte (labels expandus pour leur nom), tri -date.
 * `sinceIso` borne la fenetre (ex: 90 derniers jours) si fourni. */
export async function listMessagesForCerveau(
  accountId: string,
  page: number,
  perPage: number,
  sinceIso?: string
): Promise<{ items: PBMessageForCerveau[]; totalPages: number; totalItems: number }> {
  const since = sinceIso ? ` && date >= "${sinceIso}"` : "";
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      // Dossiers reels uniquement (pas spam/trash/drafts) : le filtre fin
      // "vrai echange" (expediteur trusted, pas de label secondaire) est
      // applique cote backfill par message.
      filter: `account="${accountId}" && is_draft=false && (folder.type="inbox" || folder.type="sent" || folder.type="archive")${since}`,
      page: String(page),
      perPage: String(perPage),
      fields:
        "id,subject,snippet,text_body,html_body,from_address,to_addresses,cc_addresses,date,account,folder,thread_id,has_attachments,is_sent,labels,expand.labels.name",
      expand: "labels",
      sort: "-date",
    },
    timeoutMs: 30000,
  })) as { items: PBMessageForCerveau[]; totalPages: number; totalItems: number };
  return result;
}

/** Compte les mails candidats a l'agregation Cerveau (dossiers reels). */
export async function countRealFolderMessages(
  accountId: string,
  sinceIso?: string
): Promise<number> {
  const since = sinceIso ? ` && date >= "${sinceIso}"` : "";
  return countRecords(
    "messages",
    `account="${accountId}" && is_draft=false && (folder.type="inbox" || folder.type="sent" || folder.type="archive")${since}`
  );
}

/** Recharge un lot de messages par id (rendu Cerveau, labels expandus). */
export async function listMessagesForCerveauByIds(
  ids: string[]
): Promise<PBMessageForCerveau[]> {
  if (ids.length === 0) return [];
  const filter = "(" + ids.map((id) => `id="${id}"`).join(" || ") + ")";
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter,
      perPage: String(ids.length),
      fields:
        "id,subject,snippet,text_body,html_body,from_address,to_addresses,cc_addresses,date,account,folder,thread_id,has_attachments,is_sent,labels,expand.labels.name",
      expand: "labels",
    },
    timeoutMs: 30000,
  })) as { items: PBMessageForCerveau[] };
  return result.items;
}

export interface PBThreadBrief {
  id: string;
  thread_id: string;
  content: string;
  message_count: number;
  updated: string;
}

/** Page de notes IA de discussion d'un utilisateur (tri -updated). */
export async function listThreadBriefs(
  userId: string,
  page: number,
  perPage: number
): Promise<{ items: PBThreadBrief[]; totalPages: number; totalItems: number }> {
  const result = (await pbFetch("/api/collections/thread_briefs/records", {
    params: {
      filter: `user="${userId}"`,
      page: String(page),
      perPage: String(perPage),
      fields: "id,thread_id,content,message_count,updated",
      sort: "-updated",
    },
  })) as { items: PBThreadBrief[]; totalPages: number; totalItems: number };
  return result;
}

/** Note IA d'une discussion d'un utilisateur (null si absente). */
export async function getThreadBrief(
  userId: string,
  threadId: string
): Promise<PBThreadBrief | null> {
  const safe = threadId.replace(/"/g, '\\"');
  const result = (await pbFetch("/api/collections/thread_briefs/records", {
    params: {
      filter: `user="${userId}" && thread_id="${safe}"`,
      perPage: "1",
      fields: "id,thread_id,content,message_count,updated",
    },
  })) as { items: PBThreadBrief[] };
  return result.items[0] || null;
}

// --- Newsletters (flux RSS de syntheses IA) --------------------------------

export interface PBNewsletterPost {
  id: string;
  user: string;
  message: string;
  account: string;
  source_name: string;
  source_address: string;
  original_subject: string;
  title: string;
  summary: string;
  language: string;
  message_date: string;
  thread_id: string;
  status: string;
  is_read: boolean;
  matched_alerts?: { id: string; name: string }[];
  /** Etiquettes de sujet (migration 069). */
  tags?: string[] | null;
  /** Synthese deja etiquetee (le rattrapage ne repasse pas dessus). */
  tags_done?: boolean;
  created: string;
  updated: string;
}

/**
 * Page de newsletter_posts selon un filtre PocketBase (champs reduits si
 * `fields` est donne). Sert aux etiquettes, statistiques et au resume hebdo.
 */
export async function listNewsletterPostsPage(opts: {
  filter: string;
  page?: number;
  perPage?: number;
  fields?: string;
  sort?: string;
}): Promise<{ items: PBNewsletterPost[]; totalPages: number }> {
  const params: Record<string, string> = {
    filter: opts.filter,
    page: String(opts.page || 1),
    perPage: String(opts.perPage || 200),
    sort: opts.sort || "-message_date",
  };
  if (opts.fields) params.fields = opts.fields;
  return (await pbFetch("/api/collections/newsletter_posts/records", { params })) as {
    items: PBNewsletterPost[];
    totalPages: number;
  };
}

/** Toutes les pages d'un filtre (borne a `maxPages`). */
export async function listAllNewsletterPosts(
  filter: string,
  fields?: string,
  maxPages = 50
): Promise<PBNewsletterPost[]> {
  const out: PBNewsletterPost[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await listNewsletterPostsPage({ filter, page, perPage: 500, fields });
    out.push(...res.items);
    if (page >= res.totalPages || res.items.length === 0) break;
  }
  return out;
}

/** Sujets d'alerte newsletter d'un utilisateur (alert_topics). */
export async function listAlertTopics(
  userId: string
): Promise<{ id: string; name: string; description: string }[]> {
  const result = (await pbFetch("/api/collections/alert_topics/records", {
    params: { filter: `user="${userId}"`, perPage: "100", sort: "created", fields: "id,name,description" },
  })) as { items: { id: string; name: string; description: string }[] };
  return result.items.filter((t) => (t.name || "").trim());
}

export async function findNewsletterPostByMessage(
  messageId: string
): Promise<PBNewsletterPost | null> {
  const result = (await pbFetch("/api/collections/newsletter_posts/records", {
    params: { filter: `message="${messageId}"`, perPage: "1" },
  })) as { items: PBNewsletterPost[] };
  return result.items[0] || null;
}

export async function createNewsletterPost(
  data: Partial<PBNewsletterPost>
): Promise<PBNewsletterPost> {
  return (await pbFetch("/api/collections/newsletter_posts/records", {
    method: "POST",
    body: data,
  })) as PBNewsletterPost;
}

/**
 * Syntheses terminees depuis `sinceIso` (format espace PB) dont le titre est
 * encore le sujet d'origine : cible du rattrapage des titres traduits.
 */
export async function listNewsletterPostsWithOriginalTitle(
  sinceIso: string,
  page: number,
  perPage = 100
): Promise<{ items: PBNewsletterPost[]; totalPages: number }> {
  const result = (await pbFetch("/api/collections/newsletter_posts/records", {
    params: {
      filter: `status="done" && message_date >= "${sinceIso}" && (title = original_subject || title = "")`,
      sort: "-message_date",
      page: String(page),
      perPage: String(perPage),
      fields: "id,user,original_subject,title,summary,language,message_date",
    },
  })) as { items: PBNewsletterPost[]; totalPages: number };
  return { items: result.items, totalPages: result.totalPages || 1 };
}

export async function updateNewsletterPost(
  id: string,
  data: Partial<PBNewsletterPost>
): Promise<void> {
  await pbFetch(`/api/collections/newsletter_posts/records/${id}`, {
    method: "PATCH",
    body: data,
  });
}

export interface PBNewsletterSource {
  id: string;
  user: string;
  email: string;
  name: string;
}

/** Sources newsletter designees par un utilisateur. */
export async function listNewsletterSources(
  userId: string
): Promise<PBNewsletterSource[]> {
  const result = (await pbFetch("/api/collections/newsletter_sources/records", {
    params: { filter: `user="${userId}"`, perPage: "500", fields: "id,user,email,name" },
  })) as { items: PBNewsletterSource[] };
  return result.items;
}

/** Supprime tous les posts du flux d'un utilisateur (reset). Retourne le nombre supprime. */
export async function purgeNewsletterPosts(userId: string): Promise<number> {
  let deleted = 0;
  // Boucle page=1 : chaque suppression retire l'item du filtre.
  while (true) {
    const res = (await pbFetch("/api/collections/newsletter_posts/records", {
      params: { filter: `user="${userId}"`, perPage: "200", fields: "id" },
    })) as { items: { id: string }[] };
    if (res.items.length === 0) break;
    for (const it of res.items) {
      try {
        await pbFetch(`/api/collections/newsletter_posts/records/${it.id}`, {
          method: "DELETE",
        });
        deleted++;
      } catch (err) {
        console.warn("[newsletter] purge delete failed:", (err as Error).message);
      }
    }
  }
  return deleted;
}

export interface PBMessageForNewsletter {
  id: string;
  subject: string;
  snippet: string;
  text_body: string;
  html_body: string;
  from_address: PBEmailAddress;
  thread_id?: string;
  raw_headers?: string;
  date: string;
  account: string;
  labels: string[];
  expand?: { labels?: { name: string }[] };
}

/** Page de messages inbox depuis `sinceIso` (labels expandus pour la detection). */
export async function listInboxMessagesForNewsletter(
  folderId: string,
  sinceIso: string,
  page: number,
  perPage: number
): Promise<{ items: PBMessageForNewsletter[]; totalPages: number; totalItems: number }> {
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `folder="${folderId}" && date >= "${sinceIso}" && is_draft=false`,
      page: String(page),
      perPage: String(perPage),
      fields:
        "id,subject,snippet,text_body,html_body,from_address,thread_id,raw_headers,date,account,labels,expand.labels.name",
      expand: "labels",
      sort: "-date",
    },
  })) as { items: PBMessageForNewsletter[]; totalPages: number; totalItems: number };
  return result;
}

/** Mails inbox d'un expediteur donne depuis `sinceIso` (filtre JSON from_address.address). */
export async function listInboxMessagesFromSender(
  folderId: string,
  senderEmail: string,
  sinceIso: string,
  page: number,
  perPage: number
): Promise<{ items: PBMessageForNewsletter[]; totalPages: number; totalItems: number }> {
  const safe = senderEmail.replace(/"/g, '\\"');
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `folder="${folderId}" && from_address.address = "${safe}" && date >= "${sinceIso}" && is_draft=false`,
      page: String(page),
      perPage: String(perPage),
      fields:
        "id,subject,snippet,text_body,html_body,from_address,thread_id,raw_headers,date,account,labels,expand.labels.name",
      expand: "labels",
      sort: "-date",
    },
  })) as { items: PBMessageForNewsletter[]; totalPages: number; totalItems: number };
  return result;
}

/**
 * Ids des messages non-indexes d'un user, par keyset pagination (curseur sur
 * `date`). Utilise l'endpoint dedie /api/mail/embeddings/unembedded qui fait
 * un LEFT JOIN cote SQL : on recupere directement les mails restant a indexer
 * sans avoir a charger la liste des deja-indexes en memoire ni a paginer en
 * silence dans la zone deja faite (cause de l'UI qui paraissait figee).
 *
 * Le worker s'authentifie en superuser (Bearer admin token), c'est lui qui
 * passe `user_id` ; cote PB le SQL est filtre sur `a.user = userId`.
 */
export async function listUnembeddedMessageIds(
  userId: string,
  accountId: string | null,
  cursor: string | null,
  limit: number
): Promise<{ ids: string[]; lastDate: string | null; hasMore: boolean }> {
  const params: Record<string, string> = {
    user_id: userId,
    limit: String(limit),
  };
  if (accountId) params.account_id = accountId;
  if (cursor) params.before = cursor;
  const result = (await pbFetch("/api/mail/embeddings/unembedded", {
    params,
    timeoutMs: 60000,
  })) as { ids: string[]; lastDate: string | null; hasMore: boolean };
  return result;
}

/** Nombre de mails non-indexes pour un user (denominateur du backfill). */
export async function countUnembeddedMessages(userId: string): Promise<number> {
  const result = (await pbFetch("/api/mail/embeddings/unembedded-count", {
    params: { user_id: userId },
    timeoutMs: 60000,
  })) as { count: number };
  return result.count || 0;
}

/** Charge les vecteurs candidats pour une recherche (cap, plus recents d'abord). */
export async function listEmbeddingsForSearch(
  userId: string,
  accountId: string | undefined,
  cap: number
): Promise<{ message: string; vector: number[] }[]> {
  const out: { message: string; vector: number[] }[] = [];
  let filter = `user="${userId}"`;
  if (accountId) filter += ` && account="${accountId}"`;
  let page = 1;
  const perPage = 500;
  while (out.length < cap) {
    const result = (await pbFetch("/api/collections/mail_embeddings/records", {
      params: {
        filter,
        fields: "message,vector",
        sort: "-created",
        page: String(page),
        perPage: String(perPage),
      },
    })) as {
      items: { message: string; vector: number[] }[];
      totalPages: number;
    };
    for (const it of result.items) out.push(it);
    if (page >= result.totalPages) break;
    page++;
  }
  return out.slice(0, cap);
}

// --- Attachments ---

export interface PBAttachment {
  id: string;
  message: string;
  filename: string;
  content_type: string;
  size: number;
  file: string;
  content_id: string;
  is_inline: boolean;
  created: string;
  updated: string;
}

export async function createAttachment(
  messageId: string,
  attachment: {
    filename: string;
    contentType: string;
    size: number;
    content: Buffer;
    contentId?: string;
    isInline?: boolean;
  }
): Promise<PBAttachment> {
  const formData = new FormData();
  formData.append("message", messageId);
  formData.append("filename", attachment.filename);
  formData.append("content_type", attachment.contentType);
  formData.append("size", String(attachment.size));
  formData.append("content_id", attachment.contentId || "");
  formData.append("is_inline", String(attachment.isInline || false));

  const blob = new Blob([attachment.content], {
    type: attachment.contentType,
  });
  formData.append("file", blob, attachment.filename);

  return (await pbFetch("/api/collections/attachments/records", {
    method: "POST",
    formData,
  })) as PBAttachment;
}

export async function getAttachmentsForMessage(
  messageId: string
): Promise<PBAttachment[]> {
  try {
    const result = (await pbFetch("/api/collections/attachments/records", {
      params: {
        filter: `message="${messageId}"`,
        perPage: "100",
      },
    })) as { items: PBAttachment[] };
    return result.items;
  } catch {
    // Collection may not exist yet — return empty array
    return [];
  }
}

export async function getAttachment(attachmentId: string): Promise<PBAttachment> {
  return (await pbFetch(`/api/collections/attachments/records/${attachmentId}`)) as PBAttachment;
}

// --- Suivi (tracking) ---

export interface PBTrackingItem {
  id: string;
  user: string;
  account: string;
  type: string;
  title: string;
  status: "active" | "waiting" | "done" | "cancelled";
  closure_suggested: boolean;
  status_label: string;
  // Synthese d'identite de l'affaire (registre central) : sert au rattachement
  // des nouveaux mails par comparaison de CONTEXTE (cf migration 047).
  context_summary?: string;
  fields: Record<string, string>;
  image_attachment: string;
  merchant: string;
  sender_domain: string;
  thread_id: string;
  thread_ids: string[];
  // QR codes trouves dans les PJ des fils ({ scanned: string[], qr: [...] }),
  // structure typee dans tracking-assets.ts
  assets?: unknown;
  first_message: string;
  last_message_id: string;
  last_message_date: string;
  event_count: number;
  pinned: boolean;
  archived: boolean;
  is_read: boolean;
  created: string;
  updated: string;
}

/** Fiches de suivi OUVERTES candidates au rapprochement d'un nouveau mail :
 * meme thread (lien fort), meme domaine expediteur, ou recentes (cross-domaine
 * pour le cas transporteur != marchand). Dedupe + cap. */
export async function listOpenTrackingCandidates(
  userId: string,
  opts: { threadId?: string; senderDomain?: string; cap?: number }
): Promise<PBTrackingItem[]> {
  const cap = opts.cap ?? 15;
  const safeUser = userId.replace(/"/g, '\\"');
  const open = `(status="active" || status="waiting")`;
  const byId = new Map<string, PBTrackingItem>();

  async function run(filter: string, perPage: number) {
    try {
      const result = (await pbFetch("/api/collections/tracking_items/records", {
        params: {
          filter,
          perPage: String(perPage),
          sort: "-last_message_date",
        },
      })) as { items: PBTrackingItem[] };
      for (const it of result.items) if (!byId.has(it.id)) byId.set(it.id, it);
    } catch {
      /* collection absente : ignore */
    }
  }

  if (opts.threadId) {
    const safe = opts.threadId.replace(/"/g, '\\"');
    await run(`user="${safeUser}" && archived=false && thread_id="${safe}"`, 5);
  }
  if (opts.senderDomain) {
    const safe = opts.senderDomain.replace(/"/g, '\\"');
    await run(`user="${safeUser}" && archived=false && ${open} && sender_domain="${safe}"`, 10);
  }
  // perPage doit HONORER le cap : un appelant qui demande cap=60 (matching par
  // numero/marchand) doit scanner TOUTES les fiches ouvertes, pas seulement 8.
  await run(`user="${safeUser}" && archived=false && ${open}`, Math.min(Math.max(cap, 8), 200));

  return Array.from(byId.values()).slice(0, cap);
}

/** Fiches de suivi (non archivees) rattachees a un thread (champ thread_id OU
 * liste thread_ids), pour un user. */
export async function findTrackingItemsByThread(
  userId: string,
  threadId: string
): Promise<PBTrackingItem[]> {
  if (!threadId) return [];
  const safeUser = userId.replace(/"/g, '\\"');
  const safeThread = threadId.replace(/"/g, '\\"');
  try {
    const result = (await pbFetch("/api/collections/tracking_items/records", {
      params: {
        filter: `user="${safeUser}" && archived=false && (thread_id="${safeThread}" || thread_ids~"${safeThread}")`,
        perPage: "50",
      },
    })) as { items: PBTrackingItem[] };
    return result.items;
  } catch {
    return [];
  }
}

/** Premiere fiche rattachee a un thread (archivee ou non) ou null. */
export async function findAnyTrackingItemByThread(
  userId: string,
  threadId: string
): Promise<PBTrackingItem | null> {
  if (!threadId) return null;
  const safeUser = userId.replace(/"/g, '\\"');
  const safeThread = threadId.replace(/"/g, '\\"');
  try {
    const result = (await pbFetch("/api/collections/tracking_items/records", {
      params: {
        filter: `user="${safeUser}" && (thread_id="${safeThread}" || thread_ids~"${safeThread}")`,
        perPage: "1",
        sort: "-created",
      },
    })) as { items: PBTrackingItem[] };
    return result.items[0] || null;
  } catch {
    return null;
  }
}

/** Nombre d'evenements de timeline d'une fiche. */
export async function countTrackingEvents(itemId: string): Promise<number> {
  try {
    const result = (await pbFetch("/api/collections/tracking_events/records", {
      params: { filter: `item="${itemId}"`, perPage: "1", fields: "id" },
    })) as { totalItems: number };
    return result.totalItems || 0;
  } catch {
    return 0;
  }
}

/** Une fiche de suivi par son id (ou null). */
export async function getTrackingItem(id: string): Promise<PBTrackingItem | null> {
  try {
    return (await pbFetch(
      `/api/collections/tracking_items/records/${id}`
    )) as PBTrackingItem;
  } catch {
    return null;
  }
}

/** Nombre de fiches de suivi OUVERTES (non archivees) d'un user. */
export async function countOpenTrackingItems(userId: string): Promise<number> {
  const safeUser = userId.replace(/"/g, '\\"');
  try {
    const result = (await pbFetch("/api/collections/tracking_items/records", {
      params: {
        filter: `user="${safeUser}" && archived=false`,
        perPage: "1",
        fields: "id",
      },
    })) as { totalItems: number };
    return result.totalItems || 0;
  } catch {
    return 0;
  }
}

/** Fiches OUVERTES d'un user avec leurs fils (pour la deduplication : deux
 * fiches qui partagent un fil sont la MEME affaire). */
export async function listOpenTrackingItemsForDedup(
  userId: string
): Promise<
  Array<{ id: string; event_count: number; thread_id: string; thread_ids: string[] }>
> {
  const safeUser = userId.replace(/"/g, '\\"');
  const out: Array<{
    id: string;
    event_count: number;
    thread_id: string;
    thread_ids: string[];
  }> = [];
  let page = 1;
  while (true) {
    let res: {
      items: Array<{
        id: string;
        event_count: number;
        thread_id: string;
        thread_ids: string[];
      }>;
      totalPages: number;
    };
    try {
      res = (await pbFetch("/api/collections/tracking_items/records", {
        params: {
          filter: `user="${safeUser}" && archived=false`,
          page: String(page),
          perPage: "200",
          fields: "id,event_count,thread_id,thread_ids",
          sort: "created",
        },
      })) as typeof res;
    } catch {
      break;
    }
    for (const it of res.items) {
      out.push({
        id: it.id,
        event_count: it.event_count || 0,
        thread_id: it.thread_id || "",
        thread_ids: Array.isArray(it.thread_ids) ? it.thread_ids : [],
      });
    }
    if (res.items.length === 0 || page >= res.totalPages) break;
    page++;
  }
  return out;
}

/** Fiche compacte pour le contexte du chat IA (GET /tracking/context). */
export interface TrackingChatFiche {
  id: string;
  title: string;
  type: string;
  status: string;
  status_label: string;
  merchant: string;
  closure_suggested: boolean;
  fields: Record<string, unknown>;
  thread_id: string;
  last_message_date: string;
  events: Array<{ date: string; label: string; detail: string }>;
}

/**
 * Fiches de suivi d'un user (non archivees, ouvertes ET cloturees) avec leurs
 * derniers evenements de timeline. Sert au chat IA : donnees STRUCTUREES et
 * fiables sur les achats/commandes/livraisons en cours, la ou le RAG email
 * peut rater les bons mails (mots ambigus comme "bureau"). Volume borne :
 * 40 fiches max, 4 evenements max par fiche.
 */
export async function listTrackingContextForChat(
  userId: string
): Promise<TrackingChatFiche[]> {
  const safeUser = userId.replace(/"/g, '\\"');
  const itemsRes = (await pbFetch("/api/collections/tracking_items/records", {
    params: {
      filter: `user="${safeUser}" && archived=false`,
      perPage: "40",
      sort: "-last_message_date",
      fields:
        "id,title,type,status,status_label,merchant,fields,thread_id,last_message_date,closure_suggested",
    },
  })) as {
    items: Array<{
      id: string;
      title?: string;
      type?: string;
      status?: string;
      status_label?: string;
      merchant?: string;
      fields?: Record<string, unknown>;
      thread_id?: string;
      last_message_date?: string;
      closure_suggested?: boolean;
    }>;
  };

  const fiches: TrackingChatFiche[] = (itemsRes.items || []).map((it) => ({
    id: it.id,
    title: it.title || "",
    type: it.type || "",
    status: it.status || "active",
    status_label: it.status_label || "",
    merchant: it.merchant || "",
    closure_suggested: !!it.closure_suggested,
    fields:
      it.fields && typeof it.fields === "object"
        ? (it.fields as Record<string, unknown>)
        : {},
    thread_id: it.thread_id || "",
    last_message_date: it.last_message_date || "",
    events: [],
  }));
  if (fiches.length === 0) return fiches;

  // Derniers evenements de timeline, une seule requete pour tout le monde,
  // regroupes par fiche (cap 4 par fiche).
  try {
    const evRes = (await pbFetch("/api/collections/tracking_events/records", {
      params: {
        filter: `user="${safeUser}"`,
        perPage: "200",
        sort: "-date",
        fields: "item,date,label,detail",
      },
    })) as {
      items: Array<{ item: string; date?: string; label?: string; detail?: string }>;
    };
    const byItem = new Map<string, TrackingChatFiche>();
    for (const f of fiches) byItem.set(f.id, f);
    for (const ev of evRes.items || []) {
      const fiche = byItem.get(ev.item);
      if (!fiche || fiche.events.length >= 4) continue;
      fiche.events.push({
        date: ev.date || "",
        label: ev.label || "",
        detail: (ev.detail || "").slice(0, 200),
      });
    }
  } catch {
    // best effort : les fiches sans timeline restent utiles
  }
  return fiches;
}

/** Tous les ids des fiches OUVERTES d'un user (pour une reconstruction de masse :
 * on collecte les ids AVANT de modifier les fiches, car la reconstruction change
 * `last_message_date` et decalerait une pagination triee). */
export async function listAllTrackingItemIds(userId: string): Promise<string[]> {
  const safeUser = userId.replace(/"/g, '\\"');
  const ids: string[] = [];
  let page = 1;
  while (true) {
    let res: { items: { id: string }[]; totalPages: number };
    try {
      res = (await pbFetch("/api/collections/tracking_items/records", {
        params: {
          filter: `user="${safeUser}" && archived=false`,
          page: String(page),
          perPage: "200",
          fields: "id",
          sort: "created",
        },
      })) as { items: { id: string }[]; totalPages: number };
    } catch {
      break;
    }
    for (const it of res.items) ids.push(it.id);
    if (res.items.length === 0 || page >= res.totalPages) break;
    page++;
  }
  return ids;
}

/** Supprime les evenements AUTO (issus de mails, message != "") d'une fiche,
 * en PRESERVANT les evenements manuels (status_change, sans message). Sert a
 * reconstruire une timeline deterministe sans perdre les changements de statut
 * saisis par l'utilisateur. */
export async function deleteTrackingEventsForItem(itemId: string): Promise<number> {
  const safe = itemId.replace(/"/g, '\\"');
  let deleted = 0;
  while (true) {
    let res: { items: { id: string }[] };
    try {
      res = (await pbFetch("/api/collections/tracking_events/records", {
        params: {
          filter: `item="${safe}" && message!=""`,
          perPage: "200",
          fields: "id",
        },
      })) as { items: { id: string }[] };
    } catch {
      break;
    }
    if (res.items.length === 0) break;
    for (const ev of res.items) {
      try {
        await pbFetch(`/api/collections/tracking_events/records/${ev.id}`, {
          method: "DELETE",
        });
        deleted++;
      } catch {
        /* best effort */
      }
    }
  }
  return deleted;
}

/** Messages ETOILES de l'inbox d'un dossier depuis `sinceIso` (recents). */
export async function listStarredInboxSince(
  folderId: string,
  sinceIso: string,
  page: number,
  perPage: number
): Promise<{ items: { id: string; thread_id: string; account: string; date: string }[]; totalPages: number }> {
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `folder="${folderId}" && is_starred=true && is_draft=false && date >= "${sinceIso}"`,
      page: String(page),
      perPage: String(perPage),
      fields: "id,thread_id,account,date",
      sort: "-date",
    },
  })) as { items: { id: string; thread_id: string; account: string; date: string }[]; totalPages: number };
  return result;
}

/** Page de messages ETOILES d'un compte (id + thread pour dedup conversation). */
export async function listStarredMessages(
  accountId: string,
  page: number,
  perPage: number
): Promise<{ items: { id: string; thread_id: string; account: string }[]; totalPages: number }> {
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `account="${accountId}" && is_starred=true && is_draft=false`,
      page: String(page),
      perPage: String(perPage),
      fields: "id,thread_id,account",
      sort: "-date",
    },
  })) as { items: { id: string; thread_id: string; account: string }[]; totalPages: number };
  return result;
}

export interface PBMessageForThread {
  id: string;
  subject: string;
  snippet: string;
  text_body: string;
  html_body: string;
  from_address: PBEmailAddress;
  to_addresses?: PBEmailAddress[];
  is_sent: boolean;
  has_attachments: boolean;
  date: string;
  account: string;
}

/** Tous les messages d'une conversation (thread), du plus ANCIEN au plus recent. */
export async function listMessagesByThread(
  threadId: string,
  limit = 50
): Promise<PBMessageForThread[]> {
  if (!threadId) return [];
  const safe = threadId.replace(/"/g, '\\"');
  try {
    const result = (await pbFetch("/api/collections/messages/records", {
      params: {
        filter: `thread_id="${safe}" && is_draft=false`,
        perPage: String(limit),
        sort: "date",
        fields:
          "id,subject,snippet,text_body,html_body,from_address,to_addresses,is_sent,has_attachments,date,account",
      },
    })) as { items: PBMessageForThread[] };
    return result.items;
  } catch {
    return [];
  }
}

export async function createTrackingItem(
  data: Partial<PBTrackingItem>
): Promise<PBTrackingItem> {
  return (await pbFetch("/api/collections/tracking_items/records", {
    method: "POST",
    body: data,
  })) as PBTrackingItem;
}

export async function updateTrackingItem(
  id: string,
  data: Partial<PBTrackingItem>
): Promise<PBTrackingItem> {
  return (await pbFetch(`/api/collections/tracking_items/records/${id}`, {
    method: "PATCH",
    body: data,
  })) as PBTrackingItem;
}

export async function createTrackingEvent(data: {
  user: string;
  item: string;
  message?: string;
  date: string;
  kind: "created" | "update" | "status_change" | "manual";
  author?: string;
  label?: string;
  detail?: string;
  changed_fields?: Record<string, unknown>;
}): Promise<void> {
  await pbFetch("/api/collections/tracking_events/records", {
    method: "POST",
    body: data,
  });
}

/** Cree OU met a jour (en place) l'evenement (item, message). Permet de
 * RAFRAICHIR le label/detail/date d'une etape existante (ex: nouvelle synthese
 * plus ludique) SANS supprimer puis recreer -> aucune perte si l'appel suivant
 * echoue. Si pas de `message` (evenement manuel), cree simplement. */
export async function upsertTrackingEvent(data: {
  user: string;
  item: string;
  message?: string;
  date: string;
  kind: "created" | "update" | "status_change" | "manual";
  author?: string;
  label?: string;
  detail?: string;
  changed_fields?: Record<string, unknown>;
}): Promise<void> {
  if (data.message) {
    const safeItem = data.item.replace(/"/g, '\\"');
    const safeMsg = data.message.replace(/"/g, '\\"');
    try {
      const res = (await pbFetch("/api/collections/tracking_events/records", {
        params: {
          filter: `item="${safeItem}" && message="${safeMsg}"`,
          perPage: "1",
          fields: "id",
        },
      })) as { items: { id: string }[] };
      if (res.items[0]) {
        await pbFetch(
          `/api/collections/tracking_events/records/${res.items[0].id}`,
          {
            method: "PATCH",
            body: {
              date: data.date,
              kind: data.kind,
              author: data.author ?? "",
              label: data.label ?? "",
              detail: data.detail ?? "",
            },
          }
        );
        return;
      }
    } catch {
      /* pas trouve / erreur lecture -> on cree */
    }
  }
  await pbFetch("/api/collections/tracking_events/records", {
    method: "POST",
    body: data,
  });
}

/** Vide les fiches de suivi d'un user (cascade supprime aussi les events). */
export async function purgeTrackingItems(userId: string): Promise<number> {
  let deleted = 0;
  const safeUser = userId.replace(/"/g, '\\"');
  while (true) {
    const res = (await pbFetch("/api/collections/tracking_items/records", {
      params: { filter: `user="${safeUser}"`, perPage: "200", fields: "id" },
    })) as { items: { id: string }[] };
    if (res.items.length === 0) break;
    for (const it of res.items) {
      await pbFetch(`/api/collections/tracking_items/records/${it.id}`, {
        method: "DELETE",
      });
      deleted++;
    }
  }
  return deleted;
}

/** Page de messages inbox depuis `sinceIso`, du PLUS ANCIEN au plus recent
 * (sort ASC) : indispensable pour que la timeline de suivi se construise dans
 * l'ordre chronologique au backfill (contrairement aux newsletters). */
export async function listInboxMessagesForTrackingAsc(
  folderId: string,
  sinceIso: string,
  page: number,
  perPage: number
): Promise<{ items: PBMessageForNewsletter[]; totalPages: number; totalItems: number }> {
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `folder="${folderId}" && date >= "${sinceIso}" && is_draft=false`,
      page: String(page),
      perPage: String(perPage),
      fields:
        "id,subject,snippet,text_body,html_body,from_address,thread_id,raw_headers,date,account,labels,expand.labels.name",
      expand: "labels",
      sort: "date",
    },
  })) as { items: PBMessageForNewsletter[]; totalPages: number; totalItems: number };
  return result;
}

/** URL de base PocketBase (utilisee pour construire les URLs de fichiers). */
export function getPbBaseUrl(): string {
  return getPocketBaseUrl();
}

/** Jeton de fichier court (protege l'acces aux fichiers des collections privees). */
export async function getFileToken(): Promise<string> {
  const data = (await pbFetch("/api/files/token", { method: "POST" })) as {
    token: string;
  };
  return data.token;
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
  await pbFetch(`/api/collections/attachments/records/${attachmentId}`, {
    method: "DELETE",
  });
}

/**
 * List messages with has_attachments=true but no records in the attachments collection.
 * Returns messages grouped by folder path for batch IMAP fetching.
 */
export async function listMessagesWithMissingAttachments(
  accountId: string
): Promise<PBMessage[]> {
  // Get all messages with has_attachments=true for this account
  const allPages: PBMessage[] = [];
  let page = 1;
  const perPage = 200;
  while (true) {
    const result = (await pbFetch("/api/collections/messages/records", {
      params: {
        filter: `account="${accountId}" && has_attachments=true`,
        sort: "-date",
        page: String(page),
        perPage: String(perPage),
        fields: "id,uid,subject,folder,account",
      },
    })) as { items: PBMessage[]; totalPages: number };
    allPages.push(...result.items);
    if (page >= result.totalPages) break;
    page++;
  }

  if (allPages.length === 0) return [];

  // Get all message IDs that have attachment records (batch filter to avoid URL too long)
  const messageIdsWithAtt = new Set<string>();
  const BATCH_SIZE = 50;
  for (let i = 0; i < allPages.length; i += BATCH_SIZE) {
    const batch = allPages.slice(i, i + BATCH_SIZE);
    const filter = batch.map((m) => `message="${m.id}"`).join(" || ");
    let page2 = 1;
    while (true) {
      const result = (await pbFetch("/api/collections/attachments/records", {
        params: {
          filter,
          page: String(page2),
          perPage: "500",
          fields: "message",
        },
      })) as { items: { message: string }[]; totalPages: number };
      for (const item of result.items) {
        messageIdsWithAtt.add(item.message);
      }
      if (page2 >= result.totalPages) break;
      page2++;
    }
  }

  return allPages.filter((m) => !messageIdsWithAtt.has(m.id));
}

export function getFileUrl(
  collectionId: string,
  recordId: string,
  filename: string
): string {
  return `${getPocketBaseUrl()}/api/files/${collectionId}/${recordId}/${filename}`;
}

// --- User helpers ---

interface PBUserPartial {
  id: string;
  openrouter_api_key?: string;
  cerveau_api_key?: string;
  sync_paused?: boolean;
  ai_embeddings_paused?: boolean;
  ai_categorize_paused?: boolean;
  cerveau_paused?: boolean;
  tracking_paused?: boolean;
  notifications_enabled?: boolean;
}

// Cache court du flag notifications_enabled : une rafale de nouveaux mails
// declenche plusieurs notifications quasi simultanees pour le meme user ; on
// evite de marteler PocketBase. TTL aligne sur getUserPauseFlags.
const notifEnabledCache = new Map<string, { value: boolean; expiresAt: number }>();
const NOTIF_ENABLED_TTL_MS = 3_000;

/**
 * Lit users.notifications_enabled (defaut true si absent). Sert a respecter la
 * preference de l'utilisateur cote worker : depuis que la notification push est
 * pilotee par le worker (et non plus le hook PB), c'est le seul endroit qui
 * verifie ce flag.
 */
export async function getUserNotificationsEnabled(userId: string): Promise<boolean> {
  const cached = notifEnabledCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  try {
    const rec = (await pbFetch(`/api/collections/users/records/${userId}`, {
      params: { fields: "id,notifications_enabled" },
    })) as PBUserPartial;
    const value = rec?.notifications_enabled !== false;
    notifEnabledCache.set(userId, { value, expiresAt: Date.now() + NOTIF_ENABLED_TTL_MS });
    return value;
  } catch {
    // En cas d'erreur reseau, on penche cote "notifier" (mieux vaut une notif
    // de trop qu'un vrai mail rate).
    return true;
  }
}

// Cache court de la liste blocked_senders : meme logique que notifEnabledCache,
// une rafale de mails interroge le meme user en boucle.
const blockedSendersCache = new Map<string, { value: string[]; expiresAt: number }>();
const BLOCKED_SENDERS_TTL_MS = 3_000;

/**
 * Lit users.blocked_senders (JSON array d'adresses, en minuscules). Sert a
 * intercepter au sync les mails d'un expediteur bloque (route corbeille + pas
 * de notif), pas seulement a les masquer de la liste.
 */
export async function getUserBlockedSenders(userId: string): Promise<string[]> {
  const cached = blockedSendersCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  try {
    const rec = (await pbFetch(`/api/collections/users/records/${userId}`, {
      params: { fields: "id,blocked_senders" },
    })) as PBUserPartial & { blocked_senders?: unknown };
    const raw = Array.isArray(rec?.blocked_senders) ? rec.blocked_senders : [];
    const value = raw
      .map((a) => ("" + a).toLowerCase().trim())
      .filter((a) => a.length > 0);
    blockedSendersCache.set(userId, { value, expiresAt: Date.now() + BLOCKED_SENDERS_TTL_MS });
    return value;
  } catch {
    // En cas d'erreur reseau, on penche cote "ne pas bloquer" (mieux vaut un
    // mail de trop dans l'inbox qu'un vrai mail perdu en corbeille).
    return [];
  }
}

/** Recupere la cle OpenRouter d'un utilisateur (vide si non configuree). */
export async function getUserOpenRouterKey(userId: string): Promise<string> {
  try {
    const rec = (await pbFetch(
      `/api/collections/users/records/${userId}`,
      { params: { fields: "id,openrouter_api_key" } }
    )) as PBUserPartial;
    return (rec?.openrouter_api_key || "").trim();
  } catch {
    return "";
  }
}

/** Recupere la cle API Cerveau d'un utilisateur (vide si non configuree). */
export async function getUserCerveauKey(userId: string): Promise<string> {
  // Integration Cerveau propre a l'instance de l'editeur : eteinte quand
  // CERVEAU_API_URL=off (app d'ordinateur, version pour tous).
  if (serviceDisabled(process.env.CERVEAU_API_URL)) return "";
  try {
    const rec = (await pbFetch(
      `/api/collections/users/records/${userId}`,
      { params: { fields: "id,cerveau_api_key" } }
    )) as PBUserPartial;
    return (rec?.cerveau_api_key || "").trim();
  } catch {
    return "";
  }
}

/** Langue UI d'un utilisateur (fr par defaut). Sert a traduire les syntheses. */
export async function getUserLanguage(userId: string): Promise<string> {
  try {
    const rec = (await pbFetch(`/api/collections/users/records/${userId}`, {
      params: { fields: "id,language" },
    })) as { language?: string };
    return (rec?.language || "fr").trim() || "fr";
  } catch {
    return "fr";
  }
}

export interface UserPauseFlags {
  sync_paused: boolean;
  ai_embeddings_paused: boolean;
  ai_categorize_paused: boolean;
  cerveau_paused: boolean;
  tracking_paused: boolean;
}

/**
 * Lit les flags pause d'un user. Cache court (3s) pour eviter de marteler
 * PocketBase dans les boucles de backfill.
 */
const pauseFlagsCache = new Map<string, { value: UserPauseFlags; expiresAt: number }>();
const PAUSE_FLAGS_TTL_MS = 3_000;

/** Force le rechargement des flags pause au prochain appel (utilise par les
 * endpoints pause/resume pour que la boucle voie l'etat frais). */
export function invalidateUserPauseFlagsCache(userId: string): void {
  pauseFlagsCache.delete(userId);
}

export async function getUserPauseFlags(userId: string): Promise<UserPauseFlags> {
  const cached = pauseFlagsCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  try {
    const rec = (await pbFetch(
      `/api/collections/users/records/${userId}`,
      { params: { fields: "id,sync_paused,ai_embeddings_paused,ai_categorize_paused,cerveau_paused,tracking_paused" } }
    )) as PBUserPartial;
    const value: UserPauseFlags = {
      sync_paused: !!rec?.sync_paused,
      ai_embeddings_paused: !!rec?.ai_embeddings_paused,
      ai_categorize_paused: !!rec?.ai_categorize_paused,
      cerveau_paused: !!rec?.cerveau_paused,
      tracking_paused: !!rec?.tracking_paused,
    };
    pauseFlagsCache.set(userId, { value, expiresAt: Date.now() + PAUSE_FLAGS_TTL_MS });
    return value;
  } catch {
    return {
      sync_paused: false,
      ai_embeddings_paused: false,
      ai_categorize_paused: false,
      cerveau_paused: false,
      tracking_paused: false,
    };
  }
}

// --- Push Tokens ---

export interface PBPushToken {
  id: string;
  user: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  /** "web" (defaut) | "apns" (application iPhone, migration 077). */
  platform?: string;
  device_key?: string;
  created: string;
  updated: string;
}

export async function listPushTokensForUser(
  userId: string
): Promise<PBPushToken[]> {
  const result = (await pbFetch("/api/collections/push_tokens/records", {
    params: {
      // is_active=true : ne jamais pousser vers un token desactive (unregister)
      // ni vers un ancien endpoint remplace lors d'un re-abonnement.
      filter: `user="${userId}" && is_active=true`,
      perPage: "50",
    },
  })) as { items: PBPushToken[] };
  return result.items;
}

export async function deletePushToken(tokenId: string): Promise<void> {
  await pbFetch(`/api/collections/push_tokens/records/${tokenId}`, {
    method: "DELETE",
  });
}

// --- Calendar (Agenda) ---

export interface PBCalendarGroup {
  id: string;
  user: string;
  name: string;
  color: string;
  account: string;
  google_calendar_id: string;
  sync_token: string;
  is_visible: boolean;
  /** Agenda des rendez-vous lus dans les mails (un seul par user, migration 078). */
  is_default?: boolean;
  /** Agenda principal Google (jamais supprimable). */
  is_primary?: boolean;
  /** Role Google (owner|writer|reader|freeBusyReader), vide pour un agenda local. */
  access_role?: string;
  created: string;
  updated: string;
}

export interface PBCalendarAttendee {
  name?: string;
  email: string;
  status?: string;
}

export interface PBCalendarEvent {
  id: string;
  user: string;
  group: string;
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  all_day: boolean;
  source: "local" | "google" | "email";
  google_event_id: string;
  google_calendar_id: string;
  etag: string;
  ics_uid: string;
  attendees: PBCalendarAttendee[];
  status: "confirmed" | "tentative" | "cancelled";
  /** Offsets (minutes avant `start`) auxquels notifier. Vide => defauts worker. */
  reminders: number[];
  /** Offsets deja notifies (anti-doublon entre passages du cron de rappels). */
  reminders_sent: number[];
  /** Invitation (migration 076) : vide = pas une invitation. */
  invitation_status?: "needs_action" | "accepted" | "declined" | "tentative" | "";
  organizer_email?: string;
  organizer_name?: string;
  attendee_email?: string;
  account?: string;
  message?: string;
  ics_sequence?: number;
  ics_recurrence_id?: string;
  /** Meme valeur sur les copies d'un evenement range dans plusieurs agendas (078). */
  copy_key?: string;
  /** Copie Google creee par nous (reponse d'invitation en iMIP, jamais PATCH). */
  google_pushed?: boolean;
  /** Ne jamais pousser chez Google (Google l'ajoute lui-meme : invitation Gmail). */
  no_push?: boolean;
  created: string;
  updated: string;
}

/** Event a venir avec l'utilisateur expanse (langue + flag notifications). */
export type PBCalendarEventWithUser = PBCalendarEvent & {
  expand?: {
    user?: { id: string; language?: string; notifications_enabled?: boolean };
  };
};

export async function listCalendarGroupsForUser(
  userId: string
): Promise<PBCalendarGroup[]> {
  const result = (await pbFetch("/api/collections/calendar_groups/records", {
    params: { filter: `user="${userId}"`, perPage: "200" },
  })) as { items: PBCalendarGroup[] };
  return result.items;
}

export async function findCalendarGroupByGoogleId(
  userId: string,
  accountId: string,
  googleCalendarId: string
): Promise<PBCalendarGroup | null> {
  const safe = googleCalendarId.replace(/"/g, '\\"');
  const result = (await pbFetch("/api/collections/calendar_groups/records", {
    params: {
      filter: `user="${userId}" && account="${accountId}" && google_calendar_id="${safe}"`,
      perPage: "1",
    },
  })) as { items: PBCalendarGroup[] };
  return result.items[0] || null;
}

export async function getCalendarGroup(groupId: string): Promise<PBCalendarGroup> {
  return (await pbFetch(
    `/api/collections/calendar_groups/records/${groupId}`
  )) as PBCalendarGroup;
}

export async function createCalendarGroup(
  data: Partial<PBCalendarGroup>
): Promise<PBCalendarGroup> {
  return (await pbFetch("/api/collections/calendar_groups/records", {
    method: "POST",
    body: data,
  })) as PBCalendarGroup;
}

export async function updateCalendarGroup(
  groupId: string,
  data: Partial<PBCalendarGroup>
): Promise<PBCalendarGroup> {
  return (await pbFetch(`/api/collections/calendar_groups/records/${groupId}`, {
    method: "PATCH",
    body: data,
  })) as PBCalendarGroup;
}

/**
 * Groupe par defaut "Invitations" pour les events recus par email (.ics).
 * Cree paresseusement si absent.
 */
export async function ensureEmailGroup(userId: string): Promise<PBCalendarGroup> {
  const result = (await pbFetch("/api/collections/calendar_groups/records", {
    params: {
      filter: `user="${userId}" && name="Invitations"`,
      perPage: "1",
    },
  })) as { items: PBCalendarGroup[] };
  if (result.items[0]) return result.items[0];
  return await createCalendarGroup({
    user: userId,
    name: "Invitations",
    color: "#6366f1",
    is_visible: true,
  });
}

/**
 * Groupe par defaut "Suivi" pour les echeances/livraisons/rendez-vous extraits
 * des fiches de suivi (source=local). Cree paresseusement si absent. Couleur
 * ambre, en echo au theme du Suivi.
 */
export async function ensureTrackingGroup(userId: string): Promise<PBCalendarGroup> {
  const result = (await pbFetch("/api/collections/calendar_groups/records", {
    params: {
      filter: `user="${userId}" && name="Suivi"`,
      perPage: "1",
    },
  })) as { items: PBCalendarGroup[] };
  if (result.items[0]) return result.items[0];
  return await createCalendarGroup({
    user: userId,
    name: "Suivi",
    color: "#f59e0b",
    is_visible: true,
  });
}

/**
 * Supprime tous les events d'agenda generes par une fiche de suivi (cle
 * `ics_uid` prefixee `tracking:<itemId>:`). Best effort : appele quand la fiche
 * est archivee (etoile retiree).
 */
export async function deleteTrackingCalendarEventsForItem(
  userId: string,
  itemId: string
): Promise<number> {
  const result = (await pbFetch("/api/collections/calendar_events/records", {
    params: {
      filter: `user="${userId}" && ics_uid ~ "tracking:${itemId}:"`,
      perPage: "200",
    },
  })) as { items: PBCalendarEvent[] };
  let n = 0;
  for (const ev of result.items) {
    try {
      await deleteCalendarEvent(ev.id);
      n++;
    } catch {
      /* best effort */
    }
  }
  return n;
}

/**
 * Liste (lecture seule) les events d'agenda generes par une fiche de suivi
 * (cle `ics_uid` prefixee `tracking:<itemId>:`), TOUTES dates confondues. Sert a
 * verifier qu'une echeance du MEME type est DEJA a l'agenda pour cette fiche
 * (ex: l'autre borne d'une fenetre de livraison), independamment du jour.
 */
export async function listTrackingCalendarEventsForItem(
  userId: string,
  itemId: string
): Promise<PBCalendarEvent[]> {
  const result = (await pbFetch("/api/collections/calendar_events/records", {
    params: {
      filter: `user="${userId}" && status != "cancelled" && ics_uid ~ "tracking:${itemId}:"`,
      perPage: "200",
    },
  })) as { items: PBCalendarEvent[] };
  return result.items;
}

export async function findCalendarEventByGoogleId(
  userId: string,
  googleEventId: string,
  googleCalendarId?: string
): Promise<PBCalendarEvent | null> {
  const safe = googleEventId.replace(/"/g, '\\"');
  // Une meme invitation/import peut porter le MEME id Google dans deux agendas
  // (copies liees) : on cherche dans l'agenda tire, sans exclure les anciennes
  // lignes sans google_calendar_id.
  const cal = googleCalendarId
    ? ` && (google_calendar_id="${googleCalendarId.replace(/"/g, '\\"')}" || google_calendar_id="")`
    : "";
  const result = (await pbFetch("/api/collections/calendar_events/records", {
    params: {
      filter: `user="${userId}" && google_event_id="${safe}"${cal}`,
      perPage: "1",
    },
  })) as { items: PBCalendarEvent[] };
  return result.items[0] || null;
}

export async function findCalendarEventByIcsUid(
  userId: string,
  icsUid: string
): Promise<PBCalendarEvent | null> {
  const safe = icsUid.replace(/"/g, '\\"');
  const result = (await pbFetch("/api/collections/calendar_events/records", {
    params: {
      filter: `user="${userId}" && ics_uid="${safe}"`,
      perPage: "1",
    },
  })) as { items: PBCalendarEvent[] };
  return result.items[0] || null;
}

/** Evenement lu dans un mail (meme UID) PAS ENCORE relie a Google. */
export async function findUnlinkedCalendarEventByIcsUid(
  userId: string,
  icsUid: string
): Promise<PBCalendarEvent | null> {
  const safe = icsUid.replace(/"/g, '\\"');
  const result = (await pbFetch("/api/collections/calendar_events/records", {
    params: {
      filter: `user="${userId}" && ics_uid="${safe}" && google_event_id=""`,
      perPage: "1",
    },
  })) as { items: PBCalendarEvent[] };
  return result.items[0] || null;
}

/** Toutes les copies d'un evenement range dans plusieurs agendas. */
export async function listCalendarEventsByCopyKey(
  userId: string,
  copyKey: string
): Promise<PBCalendarEvent[]> {
  if (!copyKey) return [];
  const result = (await pbFetch("/api/collections/calendar_events/records", {
    params: {
      filter: `user="${userId}" && copy_key="${copyKey.replace(/"/g, "")}"`,
      perPage: "50",
    },
  })) as { items: PBCalendarEvent[] };
  return result.items;
}

/**
 * Evenements d'un agenda pas encore envoyes chez Google (rattrapage) : sans
 * google_event_id, non annules, et que Google n'ajoute pas lui-meme (no_push).
 */
export async function listUnpushedCalendarEvents(groupId: string): Promise<PBCalendarEvent[]> {
  const out: PBCalendarEvent[] = [];
  for (let page = 1; page < 50; page++) {
    const result = (await pbFetch("/api/collections/calendar_events/records", {
      params: {
        filter: `group="${groupId}" && google_event_id="" && no_push=false && status!="cancelled"`,
        sort: "start",
        perPage: "200",
        page: String(page),
      },
    })) as { items: PBCalendarEvent[]; totalPages: number };
    out.push(...result.items);
    if (page >= (result.totalPages || 1)) break;
  }
  return out;
}

export async function countCalendarEventsInGroup(groupId: string): Promise<number> {
  const result = (await pbFetch("/api/collections/calendar_events/records", {
    params: { filter: `group="${groupId}"`, perPage: "1", fields: "id" },
  })) as { totalItems: number };
  return result.totalItems || 0;
}

export async function deleteCalendarGroup(groupId: string): Promise<void> {
  await pbFetch(`/api/collections/calendar_groups/records/${groupId}`, { method: "DELETE" });
}

/**
 * Agenda ou vont les rendez-vous lus dans les mails : celui marque par defaut,
 * sinon l'agenda principal Google (marque au passage), sinon "Invitations"
 * (utilisateur sans Google : comportement local d'origine).
 */
export async function getDefaultCalendarGroup(userId: string): Promise<PBCalendarGroup> {
  const groups = await listCalendarGroupsForUser(userId);
  const def = groups.find((g) => g.is_default);
  if (def) return def;
  const primary = groups
    .filter((g) => g.is_primary && g.google_calendar_id)
    .sort((a, b) => (a.created < b.created ? -1 : 1))[0];
  if (primary) {
    return await updateCalendarGroup(primary.id, { is_default: true }).catch(() => primary);
  }
  return await ensureEmailGroup(userId);
}

export async function getCalendarEvent(eventId: string): Promise<PBCalendarEvent> {
  return (await pbFetch(
    `/api/collections/calendar_events/records/${eventId}`
  )) as PBCalendarEvent;
}

export async function createCalendarEvent(
  data: Partial<PBCalendarEvent>
): Promise<PBCalendarEvent> {
  return (await pbFetch("/api/collections/calendar_events/records", {
    method: "POST",
    body: data,
  })) as PBCalendarEvent;
}

export async function updateCalendarEvent(
  eventId: string,
  data: Partial<PBCalendarEvent>
): Promise<PBCalendarEvent> {
  return (await pbFetch(`/api/collections/calendar_events/records/${eventId}`, {
    method: "PATCH",
    body: data,
  })) as PBCalendarEvent;
}

/**
 * Liste les events dont le debut tombe dans [now, now + horizonDays] et qui ne
 * sont pas annules, pour le cron de rappels. L'utilisateur est expanse afin de
 * lire sa langue et son flag notifications_enabled sans requete supplementaire.
 * Trie par debut croissant ; horizon 8 jours (couvre des rappels jusqu'a ~1
 * semaine en plus du defaut max de 9h).
 */
export async function listUpcomingEventsForReminders(
  now: Date,
  horizonDays = 8
): Promise<PBCalendarEventWithUser[]> {
  const fromIso = now.toISOString();
  const toIso = new Date(now.getTime() + horizonDays * 86400_000).toISOString();
  const out: PBCalendarEventWithUser[] = [];
  let page = 1;
  // Pagination defensive (peu d'events en pratique sur cette fenetre).
  for (;;) {
    const result = (await pbFetch("/api/collections/calendar_events/records", {
      params: {
        filter: `start >= "${fromIso}" && start <= "${toIso}" && status != "cancelled"`,
        sort: "start",
        expand: "user",
        perPage: "500",
        page: String(page),
      },
    })) as { items: PBCalendarEventWithUser[]; totalPages: number };
    out.push(...result.items);
    if (page >= (result.totalPages || 1)) break;
    page++;
  }
  return out;
}

/**
 * Events non annules d'un user dont le DEBUT tombe dans [fromIso, toIso].
 * Sert a verifier qu'une echeance n'est pas DEJA a l'agenda (Google/ICS/manuel)
 * avant de la proposer en suivi.
 */
export async function listCalendarEventsInRange(
  userId: string,
  fromIso: string,
  toIso: string
): Promise<PBCalendarEvent[]> {
  const result = (await pbFetch("/api/collections/calendar_events/records", {
    params: {
      filter: `user="${userId}" && status != "cancelled" && start >= "${fromIso}" && start <= "${toIso}"`,
      sort: "start",
      perPage: "200",
    },
  })) as { items: PBCalendarEvent[] };
  return result.items;
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  await pbFetch(`/api/collections/calendar_events/records/${eventId}`, {
    method: "DELETE",
  });
}

// --- Propositions d'echeances (calendar_suggestions) -------------------------

export interface PBCalendarSuggestion {
  id: string;
  user: string;
  item: string;
  dedup_key: string;
  kind: string;
  label: string;
  title: string;
  fiche_title: string;
  start: string;
  end: string;
  all_day: boolean;
  status: "pending" | "accepted" | "refused";
  event: string;
  created: string;
  updated: string;
}

export async function findSuggestionByDedupKey(
  userId: string,
  dedupKey: string
): Promise<PBCalendarSuggestion | null> {
  const safe = dedupKey.replace(/"/g, '\\"');
  const result = (await pbFetch("/api/collections/calendar_suggestions/records", {
    params: { filter: `user="${userId}" && dedup_key="${safe}"`, perPage: "1" },
  })) as { items: PBCalendarSuggestion[] };
  return result.items[0] || null;
}

export async function getSuggestion(id: string): Promise<PBCalendarSuggestion> {
  return (await pbFetch(
    `/api/collections/calendar_suggestions/records/${id}`
  )) as PBCalendarSuggestion;
}

export async function createSuggestion(
  data: Partial<PBCalendarSuggestion>
): Promise<PBCalendarSuggestion> {
  return (await pbFetch("/api/collections/calendar_suggestions/records", {
    method: "POST",
    body: data,
  })) as PBCalendarSuggestion;
}

export async function updateSuggestion(
  id: string,
  data: Partial<PBCalendarSuggestion>
): Promise<PBCalendarSuggestion> {
  return (await pbFetch(`/api/collections/calendar_suggestions/records/${id}`, {
    method: "PATCH",
    body: data,
  })) as PBCalendarSuggestion;
}

/** Toutes les propositions EN ATTENTE d'un user (pour pruning vs agenda). */
export async function listPendingSuggestionsForUser(
  userId: string
): Promise<PBCalendarSuggestion[]> {
  const result = (await pbFetch("/api/collections/calendar_suggestions/records", {
    params: { filter: `user="${userId}" && status="pending"`, sort: "start", perPage: "200" },
  })) as { items: PBCalendarSuggestion[] };
  return result.items;
}

export async function deleteSuggestion(id: string): Promise<void> {
  await pbFetch(`/api/collections/calendar_suggestions/records/${id}`, {
    method: "DELETE",
  });
}

export async function countPendingSuggestions(userId: string): Promise<number> {
  const result = (await pbFetch("/api/collections/calendar_suggestions/records", {
    params: { filter: `user="${userId}" && status="pending"`, perPage: "1", fields: "id" },
  })) as { totalItems: number };
  return result.totalItems;
}

/** Supprime les propositions encore EN ATTENTE d'une fiche (etoile retiree). On
 * laisse les accepted/refused (historique + dedup des refus). */
export async function deletePendingSuggestionsForItem(itemId: string): Promise<void> {
  const result = (await pbFetch("/api/collections/calendar_suggestions/records", {
    params: { filter: `item="${itemId}" && status="pending"`, perPage: "200" },
  })) as { items: PBCalendarSuggestion[] };
  for (const s of result.items) {
    try {
      await pbFetch(`/api/collections/calendar_suggestions/records/${s.id}`, {
        method: "DELETE",
      });
    } catch {
      /* best effort */
    }
  }
}

// --- Activities (journal d'activite / centre de notifications) -------------

export interface PBActivity {
  id: string;
  user: string;
  account: string;
  type:
    | "new_email"
    | "mail_sent"
    | "newsletter"
    | "tracking_new"
    | "tracking_status"
    | "calendar_reminder"
    | "calendar_suggestion";
  title: string;
  body: string;
  icon: string;
  url: string;
  source_collection: string;
  source_id: string;
  thread_id: string;
  metadata: Record<string, unknown>;
  is_read: boolean;
  event_date: string;
  created: string;
  updated: string;
}

/**
 * Cree une entree de journal d'activite. BEST EFFORT : si la collection
 * `activities` n'existe pas encore (migration pas passee) ou en cas de course,
 * on avale l'erreur et on renvoie null -> le flux appelant (sync, envoi...)
 * n'est jamais interrompu par le journal.
 */
export async function createActivity(
  data: Partial<PBActivity>
): Promise<PBActivity | null> {
  try {
    return (await pbFetch("/api/collections/activities/records", {
      method: "POST",
      body: data,
      timeoutMs: 15000,
    })) as PBActivity;
  } catch (err) {
    console.warn("[activity] create failed:", (err as Error).message);
    return null;
  }
}

/**
 * Purge les entrees du journal plus vieilles que `days` jours (retention : le
 * feed n'affiche que 30 jours). Filtre en format espace (piege PB : les
 * datetimes se comparent en chaines "YYYY-MM-DD HH:MM:SS.sssZ"). Best effort.
 */
export async function pruneActivitiesOlderThan(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ");
  let deleted = 0;
  while (true) {
    let res: { items: { id: string }[] };
    try {
      res = (await pbFetch("/api/collections/activities/records", {
        params: {
          filter: `event_date < "${cutoff}"`,
          perPage: "200",
          fields: "id",
          sort: "event_date",
        },
        timeoutMs: 20000,
      })) as { items: { id: string }[] };
    } catch {
      break;
    }
    if (res.items.length === 0) break;
    for (const it of res.items) {
      try {
        await pbFetch(`/api/collections/activities/records/${it.id}`, {
          method: "DELETE",
        });
        deleted++;
      } catch {
        /* best effort */
      }
    }
    if (res.items.length < 200) break;
  }
  return deleted;
}

// --- Read receipts (suivi de lecture des mails envoyes) ---

export interface PBReadReceipt {
  id: string;
  user: string;
  account: string;
  message: string;
  /** "received" = scan de la messagerie du destinataire a l'arrivee (preuve
   * de reception, migration 072), jamais compte comme une vue. */
  kind: "sent" | "opened" | "received";
  date: string;
  user_agent: string;
  ip: string;
  client: string;
  /** Adresse du destinataire (ouvertures par personne) ; vide pour "sent". */
  recipient: string;
  created: string;
  updated: string;
}

/**
 * Ecrit un evenement de suivi de lecture. BEST EFFORT : si la collection
 * n'existe pas encore (migration pas passee), on avale l'erreur -> l'envoi
 * SMTP / le pixel ne sont jamais interrompus par le suivi.
 */
export async function createReadReceipt(
  data: Partial<PBReadReceipt>
): Promise<PBReadReceipt | null> {
  try {
    return (await pbFetch("/api/collections/read_receipts/records", {
      method: "POST",
      body: data,
      timeoutMs: 15000,
    })) as PBReadReceipt;
  } catch (err) {
    console.warn("[read-receipts] create failed:", (err as Error).message);
    return null;
  }
}

function quotePbFilter(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Le message a-t-il deja son evenement "received" (pour ce destinataire) ?
 * Un seul "received" par (message, destinataire) : les scanners chargent le
 * pixel plusieurs fois. */
export async function hasReceivedReceipt(
  messageId: string,
  recipient?: string
): Promise<boolean> {
  try {
    let filter = `message = ${quotePbFilter(messageId)} && kind = "received"`;
    const email = (recipient || "").trim().toLowerCase();
    filter += ` && recipient = ${quotePbFilter(email)}`;
    const res = (await pbFetch("/api/collections/read_receipts/records", {
      params: { filter, perPage: "1", skipTotal: "1" },
      timeoutMs: 10000,
    })) as { items: PBReadReceipt[] };
    return res.items.length > 0;
  } catch {
    // Dans le doute (PB indisponible) : ne rien ecrire plutot qu'un doublon.
    return true;
  }
}

/** Dernier evenement "opened" d'un message (debounce des hits pixel). */
export async function getLastOpenReceipt(
  messageId: string,
  recipient?: string
): Promise<PBReadReceipt | null> {
  try {
    let filter = `message = ${quotePbFilter(messageId)} && kind = "opened"`;
    const email = (recipient || "").trim().toLowerCase();
    if (email) {
      filter += ` && recipient = ${quotePbFilter(email)}`;
    }
    const res = (await pbFetch("/api/collections/read_receipts/records", {
      params: {
        filter,
        sort: "-date",
        perPage: "1",
      },
      timeoutMs: 10000,
    })) as { items: PBReadReceipt[] };
    return res.items[0] || null;
  } catch {
    return null;
  }
}

/** Carnet de contacts d'un utilisateur (propositions d'associations projet). */
export async function listContactsForUser(
  userId: string,
  limit = 500
): Promise<PBContact[]> {
  const res = (await pbFetch("/api/collections/contacts/records", {
    params: {
      filter: `user = "${userId}"`,
      sort: "-message_count",
      perPage: String(limit),
    },
  })) as { items: PBContact[] };
  return res.items;
}

/** Adresses des comptes de l'utilisateur (a exclure des propositions). */
export async function listUserAccountEmails(userId: string): Promise<string[]> {
  const accounts = await listAccountsForUser(userId);
  return accounts.map((a) => (a.email || "").toLowerCase()).filter(Boolean);
}

// --- Cles d'API (onglet Connectivite, connecteur MCP en ligne) ---

export interface PBApiKey {
  id: string;
  user: string;
  name: string;
  scope: "read" | "full";
  prefix: string;
  last_used: string;
  inactive_notified_at: string;
  created: string;
}

/** Cle active dont l'empreinte vaut `hash` (null si inconnue / supprimee). */
export async function findApiKeyByHash(hash: string): Promise<PBApiKey | null> {
  const res = (await pbFetch("/api/collections/api_keys/records", {
    params: { filter: `key_hash = "${hash.replace(/[^a-f0-9]/g, "")}"`, perPage: "1", skipTotal: "1" },
  })) as { items: PBApiKey[] };
  return res.items[0] || null;
}

export async function createApiKeyRecord(data: {
  user: string;
  name: string;
  scope: "read" | "full";
  key_hash: string;
  prefix: string;
}): Promise<PBApiKey> {
  return (await pbFetch("/api/collections/api_keys/records", {
    method: "POST",
    body: data,
  })) as PBApiKey;
}

export async function updateApiKeyRecord(
  id: string,
  data: Partial<Pick<PBApiKey, "last_used" | "inactive_notified_at">>
): Promise<void> {
  await pbFetch(`/api/collections/api_keys/records/${id}`, { method: "PATCH", body: data });
}

/** Toutes les cles (tous utilisateurs) : sert au controle d'inactivite. */
export async function listAllApiKeys(): Promise<PBApiKey[]> {
  const out: PBApiKey[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = (await pbFetch("/api/collections/api_keys/records", {
      params: { perPage: "200", page: String(page), skipTotal: "1", sort: "created" },
    })) as { items: PBApiKey[] };
    out.push(...res.items);
    if (res.items.length < 200) break;
  }
  return out;
}

/**
 * Jeton UTILISATEUR de courte duree, fabrique par le superuser du worker
 * (PocketBase 0.23+ : POST /api/collections/users/impersonate/{id}). Sert au
 * connecteur MCP en ligne : les outils appellent l'API headless avec les
 * droits de l'utilisateur, jamais ceux du superuser.
 */
export async function impersonateUser(userId: string, durationSec: number): Promise<string> {
  const data = (await pbFetch(`/api/collections/users/impersonate/${encodeURIComponent(userId)}`, {
    method: "POST",
    body: { duration: durationSec },
  })) as { token: string };
  return data.token;
}

/**
 * Identifie l'utilisateur porteur d'un jeton PocketBase (Authorization du
 * frontend). null si le jeton est invalide ou expire.
 */
export async function userIdFromAuthToken(token: string): Promise<string | null> {
  const bare = token.replace(/^Bearer\s+/i, "").trim();
  if (!bare) return null;
  const res = await fetch(`${getPocketBaseUrl()}/api/collections/users/auth-refresh`, {
    method: "POST",
    headers: { Authorization: bare },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { record?: { id?: string } };
  return data.record?.id || null;
}

/** URL de PocketBase vue du worker (le connecteur MCP y appelle l'API headless). */
export function pocketBaseUrl(): string {
  return getPocketBaseUrl();
}

// --- Resume du lundi (newsletter-digest.ts) ---

export async function getUserDigestInfo(
  userId: string
): Promise<{ newsletter_digest_week: string; default_account: string }> {
  const rec = (await pbFetch(`/api/collections/users/records/${userId}`, {
    params: { fields: "id,newsletter_digest_week,default_account" },
  })) as { newsletter_digest_week?: string; default_account?: string };
  return {
    newsletter_digest_week: rec?.newsletter_digest_week || "",
    default_account: rec?.default_account || "",
  };
}

export async function setUserDigestWeek(userId: string, week: string): Promise<void> {
  await pbFetch(`/api/collections/users/records/${userId}`, {
    method: "PATCH",
    body: { newsletter_digest_week: week },
  });
}

// --- Recapitulatif du matin (daily-digest.ts, migration 074) ---

export async function getUserDailyDigestInfo(
  userId: string
): Promise<{ disabled: boolean; day: string; default_account: string }> {
  const rec = (await pbFetch(`/api/collections/users/records/${userId}`, {
    params: { fields: "id,daily_digest_disabled,daily_digest_day,default_account" },
  })) as { daily_digest_disabled?: boolean; daily_digest_day?: string; default_account?: string };
  return {
    disabled: rec?.daily_digest_disabled === true,
    day: rec?.daily_digest_day || "",
    default_account: rec?.default_account || "",
  };
}

export async function setUserDailyDigestDay(userId: string, day: string): Promise<void> {
  await pbFetch(`/api/collections/users/records/${userId}`, {
    method: "PATCH",
    body: { daily_digest_day: day },
  });
}

/** Mail de boite de reception tel que lu par le recapitulatif du matin. */
export interface PBDigestMessage {
  id: string;
  account: string;
  folder: string;
  message_id: string;
  thread_id: string;
  subject: string;
  snippet: string;
  from_address: PBEmailAddress;
  date: string;
  is_read: boolean;
  labels: string[];
  /** Niveau du tri en trois niveaux (migration 075). */
  importance?: string;
}

/**
 * Mails des dossiers `folderIds` dates dans [lo, hi[ (bornes ISO), plus recents
 * d'abord, au plus `limit`. Brouillons exclus.
 */
export async function listDigestMessages(
  folderIds: string[],
  lo: string,
  hi: string,
  limit = 300
): Promise<PBDigestMessage[]> {
  if (!folderIds.length) return [];
  const fmt = (iso: string) => iso.replace("T", " ");
  const folders = folderIds.map((id) => `folder="${id}"`).join(" || ");
  const result = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `(${folders}) && is_draft=false && date >= "${fmt(lo)}" && date < "${fmt(hi)}"`,
      sort: "-date",
      perPage: String(Math.min(limit, 500)),
      skipTotal: "1",
      fields: "id,account,folder,message_id,thread_id,subject,snippet,from_address,date,is_read,labels,importance",
    },
    timeoutMs: 30000,
  })) as { items: PBDigestMessage[] };
  return result.items;
}

/** Libelles d'un utilisateur : id -> nom. */
export async function listUserLabelNames(userId: string): Promise<Map<string, string>> {
  const result = (await pbFetch("/api/collections/labels/records", {
    params: { filter: `user="${userId}"`, perPage: "500", fields: "id,name" },
  })) as { items: { id: string; name: string }[] };
  return new Map(result.items.map((l) => [l.id, l.name]));
}

/** Fiches de suivi non archivees d'un utilisateur (toutes, ouvertes ou non). */
export async function listTrackingItemsForDigest(userId: string): Promise<PBTrackingItem[]> {
  const result = (await pbFetch("/api/collections/tracking_items/records", {
    params: {
      filter: `user="${userId}" && archived=false`,
      sort: "-last_message_date",
      perPage: "200",
      fields: "id,user,title,status,status_label,merchant,thread_id,thread_ids,last_message_date,archived",
    },
  })) as { items: PBTrackingItem[] };
  return result.items;
}

/** Evenements de timeline d'un utilisateur dates dans [lo, hi[ (bornes ISO). */
export async function listTrackingEventsBetween(
  userId: string,
  lo: string,
  hi: string
): Promise<{ id: string; item: string; date: string; label: string; detail: string; message: string }[]> {
  const fmt = (iso: string) => iso.replace("T", " ");
  const result = (await pbFetch("/api/collections/tracking_events/records", {
    params: {
      filter: `user="${userId}" && date >= "${fmt(lo)}" && date < "${fmt(hi)}"`,
      sort: "-date",
      perPage: "200",
      fields: "id,item,date,label,detail,message",
    },
  })) as { items: { id: string; item: string; date: string; label: string; detail: string; message: string }[] };
  return result.items;
}

// --- Memoire des contacts (contact-memory.ts) ---

export interface PBContactMemory {
  id: string;
  user: string;
  /** "me" = fiche de l'utilisateur ; sinon l'adresse principale de la personne. */
  key: string;
  name: string;
  addresses: string[] | null;
  role: string;
  organization: string;
  relation: string;
  facts: string[] | null;
  related: { name: string; address: string; role: string }[] | null;
  user_notes: string;
  locked: string[] | null;
  dismissed: string[] | null;
  last_message_date: string;
  analyzed_count: number;
  model: string;
  built_at: string;
  updated: string;
}

function pbQuote(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Fiches dont la cle ou une des adresses vaut l'une de `keys` (adresses ou "me"). */
export async function findContactMemories(
  userId: string,
  keys: string[]
): Promise<PBContactMemory[]> {
  const list = Array.from(new Set(keys.map((k) => k.trim().toLowerCase()).filter(Boolean))).slice(0, 40);
  if (list.length === 0) return [];
  const clauses = list.map((k) => {
    const q = pbQuote(k);
    return k === "me" ? `key = "me"` : `key = "${q}" || addresses ~ "\\"${q}\\""`;
  });
  const res = (await pbFetch("/api/collections/contact_memories/records", {
    params: {
      filter: `user = "${pbQuote(userId)}" && (${clauses.join(" || ")})`,
      perPage: "60",
      skipTotal: "1",
    },
    timeoutMs: 8000,
  })) as { items: PBContactMemory[] };
  return res.items;
}

export async function createContactMemory(
  data: Partial<PBContactMemory> & { user: string; key: string }
): Promise<PBContactMemory> {
  return (await pbFetch("/api/collections/contact_memories/records", {
    method: "POST",
    body: data,
    timeoutMs: 8000,
  })) as PBContactMemory;
}

export async function updateContactMemory(
  id: string,
  data: Partial<PBContactMemory>
): Promise<PBContactMemory> {
  return (await pbFetch(`/api/collections/contact_memories/records/${id}`, {
    method: "PATCH",
    body: data,
    timeoutMs: 8000,
  })) as PBContactMemory;
}

export interface PBMessageForMemory {
  id: string;
  message_id: string;
  thread_id: string;
  subject: string;
  date: string;
  from_address: PBEmailAddress | null;
  to_addresses: PBEmailAddress[] | null;
  cc_addresses: PBEmailAddress[] | null;
  is_sent: boolean;
  is_draft: boolean;
  text_body: string;
  html_body: string;
}

/**
 * Repli quand la lecture SQLite directe est inactive (PB distante) : mails
 * de/vers ces adresses par l'API. Borne par `timeoutMs` : un LIKE sur les
 * destinataires de ~40k mails peut depasser 20 s, on prefere alors rendre vide.
 */
export async function listMessagesForAddressesApi(
  userId: string,
  addresses: string[],
  limit: number,
  timeoutMs: number
): Promise<PBMessageForMemory[]> {
  const clauses = addresses.slice(0, 5).map((a) => {
    const q = pbQuote(a);
    return `from_address.address = "${q}" || to_addresses ~ "${q}" || cc_addresses ~ "${q}"`;
  });
  if (clauses.length === 0) return [];
  const res = (await pbFetch("/api/collections/messages/records", {
    params: {
      filter: `account.user = "${pbQuote(userId)}" && is_draft = false && (${clauses.join(" || ")})`,
      sort: "-date",
      perPage: String(limit),
      skipTotal: "1",
      fields:
        "id,message_id,thread_id,subject,date,from_address,to_addresses,cc_addresses,is_sent,is_draft,text_body:excerpt(4000),html_body:excerpt(4000)",
    },
    timeoutMs,
  })) as { items: PBMessageForMemory[] };
  return res.items;
}


// --- Niveau d'importance (tri en trois niveaux, migration 075) ---

export interface ImportanceContext {
  rules: { match_type: "email" | "domain"; match_value: string; importance: "important" | "secondary" | "low" }[];
  examples: { from: string; subject: string; importance: "important" | "secondary" | "low" }[];
  notify: string;
}
const importanceCtxCache = new Map<string, { value: ImportanceContext; expiresAt: number }>();
const IMPORTANCE_CTX_TTL_MS = 30_000;

/** Regles expediteur + corrections recentes + reglage des notifications (cache 30 s). */
export async function getImportanceContext(userId: string): Promise<ImportanceContext> {
  const cached = importanceCtxCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const value: ImportanceContext = { rules: [], examples: [], notify: "" };
  try {
    const rules = (await pbFetch(`/api/collections/importance_rules/records`, {
      params: { filter: `user = "${userId}"`, perPage: "500", fields: "match_type,match_value,importance" },
      timeoutMs: 5000,
    })) as { items?: ImportanceContext["rules"] };
    value.rules = (rules.items || []).map((r) => ({
      ...r,
      match_value: String(r.match_value || "").toLowerCase(),
    }));
  } catch {
    /* collection absente (migration pas encore passee) : aucune regle */
  }
  try {
    const u = (await pbFetch(`/api/collections/users/records/${userId}`, {
      params: { fields: "id,notify_importance,importance_examples" },
      timeoutMs: 5000,
    })) as { notify_importance?: string; importance_examples?: unknown };
    value.notify = u.notify_importance || "";
    if (Array.isArray(u.importance_examples)) {
      value.examples = (u.importance_examples as ImportanceContext["examples"]).slice(0, 10);
    }
  } catch {
    /* defaut : aucun exemple, notifications importants + secondaires */
  }
  importanceCtxCache.set(userId, { value, expiresAt: Date.now() + IMPORTANCE_CTX_TTL_MS });
  return value;
}

export function invalidateImportanceContext(userId: string): void {
  importanceCtxCache.delete(userId);
}

/** Page de messages INBOX d'un utilisateur a (re)classer depuis `sinceIso`. */
export async function listInboxMessagesForImportance(
  folderId: string,
  sinceIso: string,
  page: number,
  perPage = 100
): Promise<{ items: { id: string; subject: string; snippet: string; text_body: string; from_address: { name?: string; address: string } | null; importance?: string; importance_source?: string; labels: string[]; thread_id: string }[]; totalPages: number }> {
  const res = (await pbFetch(`/api/collections/messages/records`, {
    params: {
      page: String(page),
      perPage: String(perPage),
      sort: "-date",
      filter: `folder="${folderId}" && date >= "${sinceIso.replace("T", " ")}" && is_draft=false`,
      fields: "id,subject,snippet,text_body,from_address,importance,importance_source,labels,thread_id",
      skipTotal: "false",
    },
    timeoutMs: 30_000,
  })) as { items: never[]; totalPages: number };
  return res;
}


/**
 * Evenements non annules qui CHEVAUCHENT [startIso, endIso[ (conflit d'horaire
 * d'une invitation). Bornes au format espace : PocketBase compare les dates
 * comme des chaines (un "T" exclurait des lignes sans erreur).
 */
export async function listOverlappingCalendarEvents(
  userId: string,
  startIso: string,
  endIso: string,
  excludeId?: string
): Promise<PBCalendarEvent[]> {
  const a = new Date(startIso).toISOString().replace("T", " ");
  const b = new Date(endIso).toISOString().replace("T", " ");
  const result = (await pbFetch("/api/collections/calendar_events/records", {
    params: {
      filter:
        `user="${userId}" && status != "cancelled" && all_day = false && start < "${b}" && end > "${a}"` +
        (excludeId ? ` && id != "${excludeId}"` : ""),
      sort: "start",
      perPage: "5",
      fields: "id,title,start,end,invitation_status,ics_uid",
    },
  })) as { items: PBCalendarEvent[] };
  return result.items;
}
export const pbAdminFetch = pbFetch;


/** Jeton APNs de l'application iPhone, lie a sa cle d'appareil (migration 077). */
export async function upsertApnsToken(
  userId: string,
  deviceKeyId: string,
  endpoint: string,
  deviceName: string
): Promise<void> {
  const existing = (await pbFetch("/api/collections/push_tokens/records", {
    params: { filter: `endpoint="${endpoint.replace(/"/g, "")}"`, perPage: "1" },
  })) as { items: PBPushToken[] };
  const body = {
    user: userId,
    endpoint,
    p256dh: "-",
    auth_key: "-",
    device_name: deviceName.slice(0, 200),
    is_active: true,
    platform: "apns",
    device_key: deviceKeyId,
  };
  if (existing.items[0]) {
    await pbFetch(`/api/collections/push_tokens/records/${existing.items[0].id}`, { method: "PATCH", body });
  } else {
    await pbFetch("/api/collections/push_tokens/records", { method: "POST", body });
  }
  // Un seul jeton vivant par cle d'appareil (le jeton APNs change parfois).
  const others = (await pbFetch("/api/collections/push_tokens/records", {
    params: { filter: `device_key="${deviceKeyId}" && endpoint != "${endpoint.replace(/"/g, "")}"`, perPage: "20" },
  })) as { items: PBPushToken[] };
  for (const t of others.items) {
    await pbFetch(`/api/collections/push_tokens/records/${t.id}`, { method: "DELETE" }).catch(() => {});
  }
}
