import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { PBMessage, PBEmailAddress } from "./pocketbase";
import { legacyRenamed } from "./renamed-file";

// Acces direct au fichier SQLite de PocketBase (data.db) depuis le worker.
//
// Pourquoi : la recherche keyword via l'API PocketBase HTTP prenait 25s sur
// 42k mails (LIKE sur 7 colonnes dont JSON, sans index full-text). En lisant
// directement la DB en SQL + index FTS5, on passe a <100ms.
//
// Compatibilite multi-process : PocketBase utilise SQLite en mode WAL, qui
// supporte plusieurs processes sans corruption tant que tous utilisent WAL.
// better-sqlite3 detecte le mode existant. Le worker ne fait que LIRE data.db
// (sur le serveur il n'a meme pas le droit d'y ecrire) : l'index de recherche
// plein texte vit dans SA base (search-index.ts), plus dans data.db.

const DB_PATH = (() => {
  if (process.env.PB_DATA_PATH) {
    return path.join(process.env.PB_DATA_PATH, "data.db");
  }
  // En dev local, le worker est dans backend/mail-worker, pb_data est dans
  // backend/. On remonte de deux crans depuis src/.
  return path.resolve(__dirname, "..", "..", "pb_data", "data.db");
})();

// SQLite direct ne doit etre actif QUE si la PB pointee tourne en local
// (memes donnees). Si POCKETBASE_URL est distante (prod), lire le data.db
// local renvoie un snapshot fige sans rapport avec la PB que l'UI affiche
// -> on force le fallback PB API. Override possible via PB_DATA_PATH explicite.
function isLocalPbUrl(): boolean {
  const url = process.env.POCKETBASE_URL || "";
  return (
    !url ||
    url.includes("127.0.0.1") ||
    url.includes("localhost") ||
    url.includes("://pb:") || // service docker interne
    url.includes("://pocketbase:")
  );
}

const SQLITE_DIRECT_ENABLED =
  !!process.env.PB_DATA_PATH || isLocalPbUrl();

let dbInstance: Database.Database | null = null;
let initFailed = false;

if (!SQLITE_DIRECT_ENABLED) {
  console.log(
    `[sqlite-direct] desactive (POCKETBASE_URL=${process.env.POCKETBASE_URL} non-local, PB_DATA_PATH absent) -> fallback PB API`
  );
  initFailed = true;
}

/**
 * Indique si SQLite direct est utilisable (DB locale presente + PB locale).
 * Quand false, l'appelant doit eviter les operations couteuses qui ne sont
 * viables QUE en SQLite direct (ex: charger 42k vecteurs pour cosinus en
 * memoire = 160 MB JSON via HTTP, ingerable depuis une PB distante).
 */
export function isSqliteDirectAvailable(): boolean {
  if (!SQLITE_DIRECT_ENABLED) return false;
  return ensureDb() !== null;
}

/**
 * Initialise (idempotent) la connexion SQLite a data.db.
 * Retourne null si le fichier n'existe pas (cas dev sans rapatriement, ou
 * config prod incomplete) : les fonctions de recherche tomberont alors en
 * fallback PB API.
 */
function ensureDb(): Database.Database | null {
  if (dbInstance) return dbInstance;
  if (initFailed) return null;
  try {
    if (!fs.existsSync(DB_PATH)) {
      console.warn(
        `[sqlite-direct] ${DB_PATH} introuvable, fallback PB API actif`
      );
      initFailed = true;
      return null;
    }
    const db = new Database(DB_PATH, { fileMustExist: true });
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");

    dbInstance = db;
    console.log(`[sqlite-direct] connecte ${DB_PATH}`);
    return db;
  } catch (err) {
    console.error(
      `[sqlite-direct] init failed (${(err as Error).message}), fallback PB API`
    );
    initFailed = true;
    return null;
  }
}

/**
 * Connexion a data.db pour les modules qui lisent en SQL direct
 * (search-index.ts, mail-search.ts). null si indisponible.
 */
export function getPbDb(): Database.Database | null {
  return ensureDb();
}

// ---------------------------------------------------------------------------
// Cache binaire des embeddings (DB SQLite separee, propriete du worker)
// ---------------------------------------------------------------------------
//
// PocketBase stocke `mail_embeddings.vector` en JSON texte (~8 Ko/vecteur).
// Charger 43k vecteurs pour le cosinus = lire 351 Mo de TEXTE depuis SQLite
// (~21s mesures) + heap a 497 Mo (number[] boxe). Le JSON.parse lui-meme n'est
// que 3.5s : le vrai cout est la LECTURE du texte.
//
// On maintient un miroir Float32 BLOB (384*4 = 1536 octets/vecteur) : 66 Mo au
// lieu de 351 Mo a lire (~4s), heap a 66 Mo. IMPORTANT : le worker tourne en
// `node` (uid 1000) et la data.db de PB est root:root read-only pour lui (c'est
// pourquoi tout le SQLite-direct ne fait que LIRE). On ne peut donc PAS ecrire
// ce miroir dans la data.db de PB ;
// il vit dans une DB separee que le worker possede (chemin writable, /tmp par
// defaut). Si cette DB de cache est indispo (path non writable), on retombe
// proprement sur la lecture JSON directe -> aucune regression.
//
// Le cache se synchronise paresseusement a la lecture par DIFF D'IDs entre la
// source (data.db, lecture seule) et le cache : on ne lit la source que pour
// les ids manquants (pas tout le JSON a chaque fois). Persistant tant que le
// conteneur vit ; reconstruit une fois (en tache de fond via warm) apres un
// recreate de conteneur.

const CACHE_DB_PATH = legacyRenamed(process.env.EMBEDDINGS_CACHE_PATH || "/tmp/imiel-vectors.db");
// L'index de recherche (search-index.ts) vit dans le meme dossier inscriptible.
export const VECTOR_CACHE_DB_PATH = CACHE_DB_PATH;

let cacheDbInstance: Database.Database | null = null;
let cacheInitFailed = false;

function ensureCacheDb(): Database.Database | null {
  if (cacheDbInstance) return cacheDbInstance;
  if (cacheInitFailed) return null;
  try {
    const db = new Database(CACHE_DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `CREATE TABLE IF NOT EXISTS mail_embeddings_bin (
         message TEXT PRIMARY KEY,
         user TEXT,
         account TEXT,
         created TEXT,
         vec BLOB
       )`
    ).run();
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_meb_user_created
         ON mail_embeddings_bin(user, created DESC)`
    ).run();
    cacheDbInstance = db;
    console.log(`[sqlite-direct] cache binaire embeddings: ${CACHE_DB_PATH}`);
    return db;
  } catch (err) {
    console.warn(
      `[sqlite-direct] cache binaire indispo (${(err as Error).message}) -> lecture JSON directe`
    );
    cacheInitFailed = true;
    return null;
  }
}

// number[] -> Buffer (BLOB) en Float32 little-endian (endianness plateforme ;
// ecriture et lecture par le meme worker donc coherentes).
function packVec(v: number[]): Buffer {
  const f = Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

// Buffer (BLOB) -> Float32Array. `slice` recopie les octets dans un ArrayBuffer
// propre et 4-aligne (un Buffer node peut etre un view non aligne sur un pool
// partage), indispensable pour construire la Float32Array sans erreur.
function unpackVec(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

// Cede la main a l'event loop (les requetes better-sqlite3 sont SYNCHRONES :
// sans ces yields, un chargement de 36k vecteurs gelait le worker ~16s au
// boot — IMAP, WS et HTTP compris).
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// Aligne le cache binaire sur la source pour un user, par diff d'ids (les deux
// connexions sont independantes : pas d'ATTACH cross-DB). On ne lit le JSON de
// la source QUE pour les ids absents du cache. No-op a chaud (rien ne manque).
// Async : yield entre chaque chunk pour ne pas geler l'event loop pendant la
// reconstruction (~12s apres un recreate de conteneur si le cache est vide).
async function syncEmbeddingsBin(
  src: Database.Database,
  cache: Database.Database,
  userId: string,
  accountId: string | undefined
): Promise<void> {
  const accountClause = accountId ? `AND account = @accountId` : "";

  // Ids cote source (data.db) et cote cache : colonnes minuscules, rapide.
  const srcIds = (
    src
      .prepare(
        `SELECT message FROM mail_embeddings WHERE user = @userId ${accountClause}`
      )
      .all({ userId, accountId }) as Array<{ message: string }>
  ).map((r) => r.message);
  const cacheIdSet = new Set(
    (
      cache
        .prepare(
          `SELECT message FROM mail_embeddings_bin WHERE user = @userId ${accountClause}`
        )
        .all({ userId, accountId }) as Array<{ message: string }>
    ).map((r) => r.message)
  );

  // 1. Inserts manquants : on lit les vecteurs JSON UNIQUEMENT pour ces ids.
  const missingIds = srcIds.filter((id) => !cacheIdSet.has(id));
  if (missingIds.length > 0) {
    const t0 = Date.now();
    const ins = cache.prepare(
      `INSERT OR REPLACE INTO mail_embeddings_bin(message, user, account, created, vec)
       VALUES (@message, @user, @account, @created, @vec)`
    );
    let inserted = 0;
    const CHUNK = 500;
    for (let i = 0; i < missingIds.length; i += CHUNK) {
      await yieldLoop();
      const chunk = missingIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = src
        .prepare(
          `SELECT message, vector, user, account, created
           FROM mail_embeddings WHERE message IN (${placeholders})`
        )
        .all(...chunk) as Array<{
        message: string;
        vector: string;
        user: string;
        account: string;
        created: string;
      }>;
      const tx = cache.transaction((rs: typeof rows) => {
        for (const r of rs) {
          const v = safeJsonParse<number[]>(r.vector);
          if (Array.isArray(v) && v.length > 0) {
            ins.run({
              message: r.message,
              user: r.user,
              account: r.account,
              created: r.created,
              vec: packVec(v),
            });
            inserted++;
          }
        }
      });
      tx(rows);
    }
    console.log(
      `[sqlite-direct] cache binaire sync: +${inserted} vecteurs en ${
        Date.now() - t0
      }ms`
    );
  }

  // 2. Orphelins : ids du cache absents de la source (mails supprimes ->
  //    cascade PB a retire la ligne JSON mais pas la ligne miroir).
  const srcIdSet = new Set(srcIds);
  const orphanIds = [...cacheIdSet].filter((id) => !srcIdSet.has(id));
  if (orphanIds.length > 0) {
    const del = cache.prepare(
      `DELETE FROM mail_embeddings_bin WHERE message = ?`
    );
    const tx = cache.transaction((ids: string[]) => {
      for (const id of ids) del.run(id);
    });
    tx(orphanIds);
    console.log(
      `[sqlite-direct] cache binaire cleanup: -${orphanIds.length} orphelins`
    );
  }
}

/**
 * Metadonnees de liste pour la barre de recherche UI (palette Cmd+K).
 * Contient tout ce que la palette affiche (expediteur, sujet, extrait, date,
 * type de dossier pour le groupement) SANS les corps : le frontend n'a plus
 * besoin de rehydrater les records via l'API PB (3 requetes paralleles de
 * 1.5-3.7s sur 200 ids -> 0).
 */
export interface SearchMetaRow {
  id: string;
  thread_id: string;
  message_id: string;
  subject: string;
  from_address: PBEmailAddress | null;
  to_addresses: PBEmailAddress[];
  date: string;
  snippet: string;
  has_attachments: boolean;
  is_read: boolean;
  folder: string;
  folder_type: string;
}

const SEARCH_META_COLS = `
  m.id, m.thread_id, m.message_id, m.subject, m.from_address, m.to_addresses,
  m.date, m.snippet, m.has_attachments, m.is_read, m.folder,
  COALESCE(f.type, '') AS folder_type
`;

type SearchMetaRawRow = {
  id: string;
  thread_id: string;
  message_id: string;
  subject: string;
  from_address: string | null;
  to_addresses: string | null;
  date: string;
  snippet: string;
  has_attachments: number | boolean;
  is_read: number | boolean;
  folder: string;
  folder_type: string;
};

function mapSearchMetaRow(r: SearchMetaRawRow): SearchMetaRow {
  return {
    id: r.id,
    thread_id: r.thread_id || "",
    message_id: r.message_id || "",
    subject: r.subject || "",
    from_address: safeJsonParse<PBEmailAddress>(r.from_address),
    to_addresses: safeJsonParse<PBEmailAddress[]>(r.to_addresses) || [],
    date: r.date,
    snippet: r.snippet || "",
    has_attachments: !!r.has_attachments,
    is_read: !!r.is_read,
    folder: r.folder,
    folder_type: r.folder_type || "",
  };
}

/**
 * Metadonnees de liste pour un lot d'ids (resultats du moteur hybride par
 * pertinence). L'ordre de sortie n'est PAS garanti : l'appelant reapplique
 * le rang des ids. Retourne null si SQLite direct indisponible.
 */
export function getSearchMetaByIds(
  userId: string,
  ids: string[]
): SearchMetaRow[] | null {
  const db = ensureDb();
  if (!db) return null;
  if (ids.length === 0) return [];

  try {
    const out: SearchMetaRow[] = [];
    // Lots de 500 : tres en-dessous de la limite de variables SQLite (32k),
    // et un seul batch en pratique (limit hybride = 200).
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = db.prepare(`
        SELECT ${SEARCH_META_COLS}
        FROM messages m
        JOIN accounts a ON a.id = m.account
        LEFT JOIN folders f ON f.id = m.folder
        WHERE m.id IN (${placeholders})
          AND a.user = ?
      `);
      const rows = stmt.all(...chunk, userId) as SearchMetaRawRow[];
      for (const r of rows) out.push(mapSearchMetaRow(r));
    }
    return out;
  } catch (err) {
    console.warn(
      `[sqlite-direct] meta-by-ids query failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Charge les embeddings d'un user directement depuis SQLite. PocketBase
 * stocke `vector` en JSON serialise (texte), on parse cote worker.
 *
 * Gain : 42k vecteurs en <500ms vs 30s+ via PB API REST.
 * Retourne null si init failed -> fallback PB API.
 */
export async function loadEmbeddingsFromSQLite(
  userId: string,
  accountId: string | undefined,
  cap: number
): Promise<{ message: string; vector: Float32Array }[] | null> {
  const db = ensureDb();
  if (!db) return null;

  // Chemin rapide : cache binaire Float32 (~4s, 66 Mo) si la DB de cache est
  // disponible. Sinon, lecture JSON directe (~21s, 351 Mo) -> comportement
  // historique, aucune regression. Iteration chunkee avec yields : les appels
  // better-sqlite3 sont synchrones et gelaient l'event loop du worker.
  const cache = ensureCacheDb();
  if (cache) {
    try {
      await syncEmbeddingsBin(db, cache, userId, accountId);
      const accountClause = accountId ? `AND account = @accountId` : "";
      const out: { message: string; vector: Float32Array }[] = [];
      let sinceYield = 0;
      for (const row of cache
        .prepare(
          `SELECT message, vec FROM mail_embeddings_bin
           WHERE user = @userId ${accountClause}
           ORDER BY created DESC LIMIT @cap`
        )
        .iterate({ userId, accountId, cap })) {
        const r = row as { message: string; vec: Buffer };
        if (r.vec && r.vec.length >= 4) {
          out.push({ message: r.message, vector: unpackVec(r.vec) });
        }
        if (++sinceYield >= 4000) {
          sinceYield = 0;
          await yieldLoop();
        }
      }
      return out;
    } catch (err) {
      // Le cache a echoue : on ne casse pas la recherche, on tombe sur le JSON.
      console.warn(
        `[sqlite-direct] cache binaire KO (${(err as Error).message}) -> lecture JSON`
      );
    }
  }

  try {
    const accountClause = accountId ? `AND account = @accountId` : "";
    const stmt = db.prepare(`
      SELECT message, vector
      FROM mail_embeddings
      WHERE user = @userId
        ${accountClause}
      ORDER BY created DESC
      LIMIT @cap
    `);

    const out: { message: string; vector: Float32Array }[] = [];
    let sinceYield = 0;
    for (const row of stmt.iterate({ userId, accountId, cap })) {
      const r = row as { message: string; vector: string };
      const v = safeJsonParse<number[]>(r.vector);
      if (Array.isArray(v) && v.length > 0) {
        out.push({ message: r.message, vector: Float32Array.from(v) });
      }
      if (++sinceYield >= 500) {
        sinceYield = 0;
        await yieldLoop();
      }
    }
    return out;
  } catch (err) {
    console.warn(
      `[sqlite-direct] loadEmbeddings failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Bornes de couverture des mails indexes d'un utilisateur. Permet au LLM de
 * connaitre la fenetre reelle de sa boite (eviter "rien avant mi-avril" quand
 * il y a des mails de 8 mois). Retourne null si SQLite indispo.
 *
 * Tres rapide (<20ms typique meme sur 50k mails) car la table messages a un
 * index sur `date`.
 */
export function getCoverageStatsFromSqlite(userId: string): {
  earliestDate: string | null;
  latestDate: string | null;
  totalMessages: number;
  indexedMessages: number;
} | null {
  const db = ensureDb();
  if (!db) return null;
  try {
    const bounds = db
      .prepare(
        `SELECT MIN(m.date) AS earliest, MAX(m.date) AS latest, COUNT(*) AS total
         FROM messages m
         JOIN accounts a ON a.id = m.account
         WHERE a.user = ? AND m.is_draft = 0`
      )
      .get(userId) as { earliest: string | null; latest: string | null; total: number };
    const indexed = db
      .prepare(`SELECT COUNT(*) AS c FROM mail_embeddings WHERE user = ?`)
      .get(userId) as { c: number };
    return {
      earliestDate: bounds.earliest,
      latestDate: bounds.latest,
      totalMessages: bounds.total,
      indexedMessages: indexed.c,
    };
  } catch (err) {
    console.warn(
      `[sqlite-direct] getCoverageStats failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * UIDs deja stockes pour un dossier, en UNE seule lecture SQLite indexee.
 * Remplace la pagination HTTP en offset de `listExistingUidsForFolder` (~68
 * requetes / ~10 min sur l'inbox Gmail de 33k mails, qui bloquait le lock de
 * sync). Retourne null si la DB directe est indisponible -> l'appelant retombe
 * sur l'API PB (semantique identique).
 */
export function listExistingUidsFromSqlite(folderId: string): Set<number> | null {
  const db = ensureDb();
  if (!db) return null;
  try {
    const rows = db
      .prepare(`SELECT uid FROM messages WHERE folder = ? AND uid > 0`)
      .all(folderId) as { uid: number }[];
    const uids = new Set<number>();
    for (const r of rows) uids.add(r.uid);
    return uids;
  } catch (err) {
    console.warn(
      `[sqlite-direct] listExistingUids failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Message-IDs deja stockes pour un (compte, dossier), en UNE seule lecture
 * SQLite indexee (cf `listExistingUidsFromSqlite`). Remplace la pagination HTTP
 * en offset de `listExistingMessageIds`. Retourne null si indispo -> fallback PB.
 */
export function listExistingMessageIdsFromSqlite(
  accountId: string,
  folderId: string
): Set<string> | null {
  const db = ensureDb();
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        `SELECT message_id FROM messages WHERE account = ? AND folder = ? AND message_id != ''`
      )
      .all(accountId, folderId) as { message_id: string }[];
    const ids = new Set<string>();
    for (const r of rows) if (r.message_id) ids.add(r.message_id);
    return ids;
  } catch (err) {
    console.warn(
      `[sqlite-direct] listExistingMessageIds failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * UIDs deja stockes PARMI une petite liste de candidats (sync incrementale
 * live : 1-quelques mails). Requete point sur l'index UNIQUE (folder, uid)
 * au lieu de materialiser les ~33k uids du dossier : le listing complet
 * (index non couvrant -> row fetches dans la table 2.3 Go) gelait l'event
 * loop ~25 s a froid A CHAQUE sync. Retourne null si indispo -> fallback.
 */
export function listUidsAmongFromSqlite(
  folderId: string,
  uids: number[]
): Set<number> | null {
  const db = ensureDb();
  if (!db) return null;
  try {
    const placeholders = uids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT uid FROM messages WHERE folder = ? AND uid IN (${placeholders})`
      )
      .all(folderId, ...uids) as { uid: number }[];
    const found = new Set<number>();
    for (const r of rows) found.add(r.uid);
    return found;
  } catch (err) {
    console.warn(
      `[sqlite-direct] listUidsAmong failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Existence d'un message par (account, message_id) en requete point indexee
 * (idx_msg_mid). Sert au dedup du hot path live sans precharger les ~33k
 * message-ids du compte. Retourne null si indispo -> fallback PB.
 */
export function messageIdExistsFromSqlite(
  accountId: string,
  messageId: string
): boolean | null {
  const db = ensureDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS x FROM messages WHERE message_id = ? AND account = ? LIMIT 1`
      )
      .get(messageId, accountId) as { x: number } | undefined;
    return !!row;
  } catch (err) {
    console.warn(
      `[sqlite-direct] messageIdExists failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Toutes les copies d'un Message-ID chez un utilisateur (tous ses comptes),
 * pour l'anti double notification (notify-dedup.ts). `variants` = egalites
 * exactes -> index idx_msg_mid. Retourne null si indispo -> fallback PB.
 */
export function listMessageCopiesForUserFromSqlite(
  userId: string,
  variants: string[]
): { id: string; account: string; created: string }[] | null {
  if (variants.length === 0) return [];
  const db = ensureDb();
  if (!db) return null;
  try {
    const placeholders = variants.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT m.id AS id, m.account AS account, m.created AS created
           FROM messages m JOIN accounts a ON a.id = m.account
          WHERE m.message_id IN (${placeholders}) AND a.user = ?
          LIMIT 50`
      )
      .all(...variants, userId) as { id: string; account: string; created: string }[];
  } catch (err) {
    console.warn(
      `[sqlite-direct] listMessageCopiesForUser failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Garde-fou WAL : si data.db-wal depasse le seuil, tente un checkpoint
 * TRUNCATE (best effort, busy_timeout 5s -> inoffensif si PB ecrit).
 *
 * Pourquoi : sous churn continu (lectures+ecritures qui se chevauchent en
 * permanence), les checkpoints passifs de SQLite ne trouvent jamais de
 * fenetre pour tronquer et le WAL grossit sans limite (constate en prod le
 * 2026-07-06 : WAL de 1 Go accumule depuis 2 jours -> TOUTES les requetes
 * PB fusionnaient ce Go -> timeouts 8-20s en cascade). Appele toutes les
 * heures depuis index.ts.
 */
const WAL_CHECKPOINT_THRESHOLD_BYTES = 256 * 1024 * 1024;

export function checkpointWalIfBloated(): void {
  const db = ensureDb();
  if (!db) return;
  try {
    const walPath = DB_PATH + "-wal";
    if (!fs.existsSync(walPath)) return;
    const size = fs.statSync(walPath).size;
    if (size < WAL_CHECKPOINT_THRESHOLD_BYTES) return;
    console.warn(
      `[sqlite-direct] WAL bloated (${Math.round(size / 1024 / 1024)} MB), attempting checkpoint(TRUNCATE)`
    );
    const res = db.pragma("wal_checkpoint(TRUNCATE)") as {
      busy: number;
      log: number;
      checkpointed: number;
    }[];
    const after = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    console.warn(
      `[sqlite-direct] WAL checkpoint result busy=${res[0]?.busy} log=${res[0]?.log} checkpointed=${res[0]?.checkpointed}, WAL now ${Math.round(after / 1024 / 1024)} MB`
    );
  } catch (err) {
    console.warn(
      `[sqlite-direct] WAL checkpoint failed: ${(err as Error).message}`
    );
  }
}

/**
 * Compteurs de confiance expediteur (sender-trust), en SQL direct.
 * Remplace 3 COUNT via l'API PB HTTP (filtres `~` = LIKE non indexes, parses
 * par PB, 1.4-11s chacun en prod -> depassaient le timeout 8s et bloquaient
 * chaque nouveau mail ~16-24s AVANT son insertion). En direct : ~0.1-0.8s
 * les trois, et zero charge sur PB. Retourne null si indispo -> fallback PB.
 */
export function getSenderTrustCountsFromSqlite(
  userId: string,
  email: string
): {
  sentToCount: number;
  receivedInboxCount: number;
  contactMessageCount: number;
} | null {
  const db = ensureDb();
  if (!db) return null;
  try {
    const like = `%${email}%`;
    const sent = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM messages m
           JOIN accounts a ON a.id = m.account
          WHERE a.user = ? AND m.is_sent = 1
            AND (m.to_addresses LIKE ? OR m.cc_addresses LIKE ?)`
      )
      .get(userId, like, like) as { c: number };
    const received = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM messages m
           JOIN accounts a ON a.id = m.account
           LEFT JOIN folders f ON f.id = m.folder
          WHERE a.user = ? AND m.from_address LIKE ?
            AND COALESCE(f.type, '') != 'spam'`
      )
      .get(userId, like) as { c: number };
    const contact = db
      .prepare(
        `SELECT message_count AS c FROM contacts WHERE user = ? AND email = ? LIMIT 1`
      )
      .get(userId, email) as { c: number } | undefined;
    return {
      sentToCount: sent.c,
      receivedInboxCount: received.c,
      contactMessageCount: contact?.c || 0,
    };
  } catch (err) {
    console.warn(
      `[sqlite-direct] senderTrustCounts failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Nombre de mails recus (non-spam) d'un DOMAINE pour un user (sender-trust,
 * approximation "domaine connu"). Retourne null si indispo -> fallback PB.
 */
export function countDomainInboxFromSqlite(
  userId: string,
  domain: string
): number | null {
  const db = ensureDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM messages m
           JOIN accounts a ON a.id = m.account
           LEFT JOIN folders f ON f.id = m.folder
          WHERE a.user = ? AND m.from_address LIKE ?
            AND COALESCE(f.type, '') != 'spam'`
      )
      .get(userId, `%@${domain}%`) as { c: number };
    return row.c;
  } catch (err) {
    console.warn(
      `[sqlite-direct] countDomainInbox failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Liste les mails RECENTS d'un MEME expediteur (par domaine) dans une fenetre
 * temporelle. Sert au suivi (tracking) : rattacher un mail FRERE du meme
 * marchand (RDV/activation/expedition), dans un fil SEPARE, qui ne repete NI le
 * numero de commande NI un token produit distinctif -> introuvable par FTS5.
 * Lightweight (pas de corps) ; l'IA confirme ensuite qu'il concerne bien la
 * fiche (llmConfirmBelongs). `since`/`until` en format PocketBase espace
 * (`YYYY-MM-DD HH:MM:SS.sssZ`), pas ISO 'T' (comparaison de chaines SQLite).
 */
export function listRecentMessagesBySenderDomain(opts: {
  userId: string;
  accountId?: string;
  domain: string;
  since: string;
  until: string;
  limit: number;
}): PBMessage[] | null {
  const db = ensureDb();
  if (!db) return null;
  if (!opts.domain) return [];
  const accountClause = opts.accountId ? `AND m.account = @accountId` : "";
  try {
    const rows = db
      .prepare(
        `SELECT m.id, m.thread_id, m.subject, m.from_address, m.date, m.snippet
         FROM messages m
         JOIN accounts a ON a.id = m.account
         WHERE a.user = @userId
           ${accountClause}
           AND m.from_address LIKE @like
           AND m.date >= @since
           AND m.date <= @until
         ORDER BY m.date DESC
         LIMIT @limit`
      )
      .all({
        userId: opts.userId,
        accountId: opts.accountId,
        like: `%${opts.domain}%`,
        since: opts.since,
        until: opts.until,
        limit: opts.limit,
      }) as Array<{
      id: string;
      thread_id: string;
      subject: string;
      from_address: string | null;
      date: string;
      snippet: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      thread_id: r.thread_id,
      subject: r.subject || "",
      from_address: safeJsonParse<PBEmailAddress>(r.from_address) || {
        address: "",
        name: "",
      },
      to_addresses: [] as PBEmailAddress[],
      cc_addresses: [] as PBEmailAddress[],
      date: r.date,
      snippet: r.snippet || "",
      text_body: "",
      html_body: "",
    })) as PBMessage[];
  } catch (err) {
    console.warn(
      `[sqlite-direct] listRecentMessagesBySenderDomain failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Mails echanges avec UN correspondant precis (adresse exacte en expediteur OU
 * en destinataire), dans une fenetre de dates. Sert au suivi : retrouver les
 * echanges PRECEDENTS avec la meme personne (fil separe, sans numero commun).
 * Lecture seule, bornee par `limit`. null si la base n'est pas lisible.
 */
export function listMessagesWithCounterpart(opts: {
  userId: string;
  accountId?: string;
  address: string;
  since: string;
  until: string;
  limit: number;
}): PBMessage[] | null {
  const db = ensureDb();
  if (!db) return null;
  const address = (opts.address || "").trim().toLowerCase();
  if (!address || !address.includes("@")) return [];
  const accountClause = opts.accountId ? `AND m.account = @accountId` : "";
  try {
    const rows = db
      .prepare(
        `SELECT m.id, m.thread_id, m.subject, m.from_address, m.date, m.snippet
         FROM messages m
         JOIN accounts a ON a.id = m.account
         WHERE a.user = @userId
           ${accountClause}
           AND m.is_draft = 0
           AND (m.from_address LIKE @like OR m.to_addresses LIKE @like OR m.cc_addresses LIKE @like)
           AND m.date >= @since
           AND m.date <= @until
         ORDER BY m.date DESC
         LIMIT @limit`
      )
      .all({
        userId: opts.userId,
        accountId: opts.accountId,
        like: `%"${address}"%`,
        since: opts.since,
        until: opts.until,
        limit: opts.limit,
      }) as Array<{
      id: string;
      thread_id: string;
      subject: string;
      from_address: string | null;
      date: string;
      snippet: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      thread_id: r.thread_id,
      subject: r.subject || "",
      from_address: safeJsonParse<PBEmailAddress>(r.from_address) || {
        address: "",
        name: "",
      },
      to_addresses: [] as PBEmailAddress[],
      cc_addresses: [] as PBEmailAddress[],
      date: r.date,
      snippet: r.snippet || "",
      text_body: "",
      html_body: "",
    })) as PBMessage[];
  } catch (err) {
    console.warn(`[sqlite-direct] listMessagesWithCounterpart failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Charge les embeddings d'un sous-ensemble de message IDs. Sert au pipeline
 * date-anchored : on a deja une shortlist FTS5 (les mails de la fenetre),
 * on ne charge que leurs vecteurs pour le scoring cosinus, au lieu des 25k
 * vecteurs globaux. Coupe drastiquement la latence sur les fenetres etroites.
 */
export function loadEmbeddingsByMessageIdsFromSQLite(
  messageIds: string[]
): { message: string; vector: number[] }[] | null {
  const db = ensureDb();
  if (!db) return null;
  if (messageIds.length === 0) return [];
  try {
    // SQLite limite a 999 placeholders ; on chunk par 500 pour rester safe
    const out: { message: string; vector: number[] }[] = [];
    const CHUNK = 500;
    for (let i = 0; i < messageIds.length; i += CHUNK) {
      const chunk = messageIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT message, vector FROM mail_embeddings WHERE message IN (${placeholders})`
        )
        .all(...chunk) as Array<{ message: string; vector: string }>;
      for (const r of rows) {
        const v = safeJsonParse<number[]>(r.vector);
        if (Array.isArray(v) && v.length > 0) {
          out.push({ message: r.message, vector: v });
        }
      }
    }
    return out;
  } catch (err) {
    console.warn(
      `[sqlite-direct] loadEmbeddingsByMessageIds failed: ${(err as Error).message}`
    );
    return null;
  }
}

function safeJsonParse<T>(s: string | null | undefined): T | null {
  if (!s || typeof s !== "string") return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

process.on("SIGTERM", () => {
  dbInstance?.close();
  cacheDbInstance?.close();
});
process.on("SIGINT", () => {
  dbInstance?.close();
  cacheDbInstance?.close();
  process.exit(0);
});
