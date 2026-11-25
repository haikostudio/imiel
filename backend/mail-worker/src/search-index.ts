import Database from "better-sqlite3";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PBMessage, PBEmailAddress } from "./pocketbase";
import { getPbDb, VECTOR_CACHE_DB_PATH } from "./sqlite-direct";
import { buildFtsMatch } from "./search-query";
import { legacyRenamed } from "./renamed-file";

// Index de recherche plein texte des mails, TENU PAR LE WORKER.
//
// Pourquoi pas dans data.db (ancien `messages_fts` + triggers) :
//   - sur le serveur, data.db est root:root et le worker tourne en `node` : il
//     ne peut pas y ecrire, donc ni le creer ni le reconstruire ;
//   - les triggers s'executaient DANS PocketBase, limites aux fonctions SQL
//     natives : impossible d'y retirer le balisage HTML. `html_body` etait donc
//     indexe BRUT ("width" ressortait 34 445 mails sur 38 726, dont 816 reels),
//     et chaque mise a jour d'un message (un simple passage a "lu") re-tokenisait
//     ~37 Ko de corps ;
//   - ni l'expediteur ni les destinataires n'etaient indexes.
//
// L'index vit dans une base SQLite que le worker possede (meme volume que le
// cache binaire des vecteurs) et se synchronise par DIFFERENCE D'IDENTIFIANTS
// avec data.db (lecture seule), comme syncEmbeddingsBin :
//   - nouveau mail  -> lecture de sa ligne, texte debalise en JS, insertion ;
//   - mail supprime -> retrait ;
//   - mail deplace  -> seule la fiche (dossier) change, le texte n'est pas relu ;
//   - brouillon     -> texte relu tant qu'il reste brouillon (il peut changer).
// La liste des identifiants cote source vient de l'index etroit
// idx_msg_list_keys (index-only, ~15 ms pour 38 700 mails) et un `PRAGMA
// data_version` inchange saute toute la comparaison.
//
// Colonnes : subject, sender (nom + adresse), recipients (to + cc + bcc), body
// (texte lisible : text_body, ou HTML debalise quand le texte brut est absent
// ou n'est qu'un moignon). Recherche par DEBUT de mot (prefix='2 3 4' rend les
// prefixes courts instantanes), casse et accents ignores.

const INDEX_DB_PATH =
  process.env.SEARCH_INDEX_PATH ||
  legacyRenamed(path.join(path.dirname(VECTOR_CACHE_DB_PATH), "imiel-search.db"));

// A incrementer quand le contenu indexe change de forme : l'index est alors
// vide et reconstruit en tache de fond.
const SCHEMA_VERSION = "1";
const BODY_MAX_CHARS = 200_000;
const READ_CHUNK = 20;
// Au-dela, on ne relit pas le texte des brouillons a chaque passe.
const DRAFT_RECHECK_MAX = 300;
const FRESH_MS = 5_000;

let indexDb: Database.Database | null = null;
let indexInitFailed = false;

interface DocEntry {
  rowid: number;
  folder: string;
  isDraft: number;
  date: string;
  account: string;
  sig: string;
}

// Miroir memoire de la table `doc` (id -> fiche) : evite de relire 38 000
// lignes a chaque comparaison.
let docs: Map<string, DocEntry> | null = null;
let lastDataVersion = -1;
let lastSyncAt = 0;
let syncPromise: Promise<void> | null = null;
const state = { ready: false, building: false, done: 0, total: 0 };

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function ensureIndexDb(): Database.Database | null {
  if (indexDb) return indexDb;
  if (indexInitFailed) return null;
  try {
    const db = new Database(INDEX_DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    const ver = db.prepare(`SELECT v FROM meta WHERE k = 'schema'`).get() as
      | { v: string }
      | undefined;
    if (!ver || ver.v !== SCHEMA_VERSION) {
      db.exec(`DROP TABLE IF EXISTS mail_fts; DROP TABLE IF EXISTS doc;`);
      db.prepare(`INSERT OR REPLACE INTO meta(k, v) VALUES ('schema', ?)`).run(
        SCHEMA_VERSION
      );
      db.prepare(`DELETE FROM meta WHERE k = 'built'`).run();
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc (
        rowid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        user TEXT NOT NULL,
        account TEXT NOT NULL,
        folder TEXT NOT NULL,
        is_draft INTEGER NOT NULL,
        date TEXT NOT NULL,
        sig TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_doc_user_date ON doc(user, date DESC, id DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(
        subject, sender, recipients, body,
        content='', contentless_delete=1,
        tokenize='unicode61 remove_diacritics 2',
        prefix='2 3 4'
      );
    `);
    state.ready = !!db.prepare(`SELECT v FROM meta WHERE k = 'built'`).get();
    indexDb = db;
    console.log(`[search-index] ${INDEX_DB_PATH} (pret=${state.ready})`);
    return db;
  } catch (err) {
    console.warn(
      `[search-index] indisponible (${(err as Error).message}) -> recherche par mots-cles desactivee`
    );
    indexInitFailed = true;
    return null;
  }
}

function loadDocs(db: Database.Database): Map<string, DocEntry> {
  if (docs) return docs;
  const map = new Map<string, DocEntry>();
  const rows = db
    .prepare(`SELECT rowid, id, folder, is_draft, date, account, sig FROM doc`)
    .raw()
    .all() as Array<[number, string, string, number, string, string, string]>;
  for (const r of rows) {
    map.set(r[1], {
      rowid: r[0],
      folder: r[2],
      isDraft: r[3],
      date: r[4],
      account: r[5],
      sig: r[6],
    });
  }
  docs = map;
  return map;
}

function safeJson<T>(s: string | null | undefined): T | null {
  if (!s || typeof s !== "string") return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function addrText(a: PBEmailAddress | null | undefined): string {
  if (!a) return "";
  return `${a.name || ""} ${a.address || ""}`.trim();
}

function addrListText(s: string | null): string {
  const list = safeJson<PBEmailAddress[]>(s);
  return Array.isArray(list) ? list.map(addrText).join(" ") : "";
}

// Entites HTML nommees courantes (lettres accentuees des langues de l'app,
// ponctuation). Les mails HTML francais ecrivent tres souvent "r&eacute;union" :
// sans decodage, le mot serait coupe en deux et introuvable.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ",
  ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", ntilde: "ñ",
  ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø", oelig: "œ",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", yuml: "ÿ", szlig: "ß",
  rsquo: "'", lsquo: "'", sbquo: "'", rdquo: '"', ldquo: '"', bdquo: '"',
  laquo: " ", raquo: " ", hellip: " ", ndash: " ", mdash: " ", middot: " ", bull: " ",
  euro: "€", copy: " ", reg: " ", trade: " ", deg: "°", shy: "", zwnj: "", zwj: "",
};

function decodeEntity(whole: string, body: string): string {
  if (body[0] === "#") {
    const code =
      body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return " ";
    // Espaces et caracteres invisibles (nbsp, zero-width, soft hyphen...).
    if (code === 160 || code === 173 || (code >= 0x2000 && code <= 0x200f) || code === 0xfeff) {
      return code === 173 || code >= 0x200b ? "" : " ";
    }
    try {
      return String.fromCodePoint(code);
    } catch {
      return " ";
    }
  }
  const lower = body.toLowerCase();
  const hit = NAMED_ENTITIES[lower];
  if (hit === undefined) return " ";
  // "&Eacute;" -> "É" : meme lettre, la casse est ignoree a la recherche.
  return hit;
}

/**
 * HTML -> texte lisible pour l'INDEX : styles, scripts, en-tete et balises
 * retires (aucun nom d'attribut ni de propriete CSS n'est indexe), entites
 * decodees.
 */
export function htmlToIndexText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, decodeEntity)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Texte lisible d'un mail. Le texte brut est prefere ; quand il manque (15 %
 * des mails) ou qu'il est nettement plus pauvre que le HTML ("Affichez ce
 * message dans votre navigateur"), c'est le HTML DEBALISE qui est indexe —
 * jamais le balisage lui-meme.
 */
export function readableBody(
  textBody: string | null,
  htmlBody: string | null,
  snippet: string | null
): string {
  const text = (textBody || "").trim();
  const fromHtml = htmlBody ? htmlToIndexText(htmlBody) : "";
  let body = text;
  if (!text || text.length < fromHtml.length * 0.6) body = fromHtml || text;
  if (!body) body = (snippet || "").trim();
  return body.length > BODY_MAX_CHARS ? body.slice(0, BODY_MAX_CHARS) : body;
}

interface SourceContentRow {
  id: string;
  subject: string | null;
  from_address: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  text_body: string | null;
  html_body: string | null;
  snippet: string | null;
}

function buildFields(r: SourceContentRow) {
  return {
    subject: r.subject || "",
    sender: addrText(safeJson<PBEmailAddress>(r.from_address)),
    recipients: [
      addrListText(r.to_addresses),
      addrListText(r.cc_addresses),
      addrListText(r.bcc_addresses),
    ]
      .join(" ")
      .trim(),
    body: readableBody(r.text_body, r.html_body, r.snippet),
  };
}

function sigOf(f: { subject: string; sender: string; recipients: string; body: string }): string {
  return createHash("sha1")
    .update(f.subject)
    .update("\u0000")
    .update(f.recipients)
    .update("\u0000")
    .update(f.body)
    .digest("hex");
}

type SourceKeyRow = [string, string, number, string, string]; // id, folder, is_draft, date, account

// Identifiants + dossier + date de TOUS les messages, sans lire une seule
// ligne de `messages` (corps inline) : index etroit, sinon index couvrant,
// sinon table (base de dev sans les migrations).
function readSourceKeys(pb: Database.Database): SourceKeyRow[] {
  const cols = `m.id, m.folder, m.is_draft, m.date, m.account`;
  for (const hint of [
    "INDEXED BY idx_msg_list_keys",
    "INDEXED BY idx_msg_list_cover",
    "",
  ]) {
    try {
      return pb
        .prepare(`SELECT ${cols} FROM messages m ${hint}`)
        .raw()
        .all() as SourceKeyRow[];
    } catch {
      // index absent : on essaie le suivant
    }
  }
  return [];
}

async function runSync(force: boolean): Promise<void> {
  const db = ensureIndexDb();
  const pb = getPbDb();
  if (!db || !pb) return;

  // Rien n'a ete ecrit dans data.db depuis la derniere passe : rien a comparer.
  const dataVersion = Number(pb.pragma("data_version", { simple: true }));
  if (!force && state.ready && dataVersion === lastDataVersion) {
    lastSyncAt = Date.now();
    return;
  }

  const t0 = Date.now();
  const map = loadDocs(db);
  const userByAccount = new Map<string, string>();
  for (const a of pb.prepare(`SELECT id, user FROM accounts`).all() as Array<{
    id: string;
    user: string;
  }>) {
    userByAccount.set(a.id, a.user);
  }

  const src = readSourceKeys(pb);
  const srcIds = new Set<string>();
  const toIndex: SourceKeyRow[] = [];
  const toMove: SourceKeyRow[] = [];
  const draftsToCheck: SourceKeyRow[] = [];
  for (const r of src) {
    if (!userByAccount.has(r[4])) continue;
    srcIds.add(r[0]);
    const d = map.get(r[0]);
    const isDraft = r[2] ? 1 : 0;
    if (!d) {
      toIndex.push(r);
    } else if (d.isDraft !== isDraft) {
      // Brouillon envoye (ou l'inverse) : le contenu final peut differer.
      toIndex.push(r);
    } else if (d.folder !== r[1] || d.date !== r[3] || d.account !== r[4]) {
      toMove.push(r);
    } else if (isDraft) {
      draftsToCheck.push(r);
    }
  }
  const toDelete: string[] = [];
  for (const id of map.keys()) if (!srcIds.has(id)) toDelete.push(id);

  // Les plus recents d'abord : pendant la premiere construction, les mails
  // recents deviennent trouvables en quelques secondes.
  toIndex.sort((a, b) => (a[3] < b[3] ? 1 : a[3] > b[3] ? -1 : 0));
  draftsToCheck.sort((a, b) => (a[3] < b[3] ? 1 : a[3] > b[3] ? -1 : 0));
  const drafts = draftsToCheck.slice(0, DRAFT_RECHECK_MAX);

  const delFts = db.prepare(`DELETE FROM mail_fts WHERE rowid = ?`);
  const delDoc = db.prepare(`DELETE FROM doc WHERE rowid = ?`);
  const insDoc = db.prepare(
    `INSERT INTO doc(id, user, account, folder, is_draft, date, sig) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const updDoc = db.prepare(
    `UPDATE doc SET user = ?, account = ?, folder = ?, is_draft = ?, date = ?, sig = ? WHERE rowid = ?`
  );
  const insFts = db.prepare(
    `INSERT INTO mail_fts(rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)`
  );

  let removed = 0;
  if (toDelete.length > 0) {
    db.transaction(() => {
      for (const id of toDelete) {
        const d = map.get(id);
        if (!d) continue;
        delFts.run(d.rowid);
        delDoc.run(d.rowid);
        map.delete(id);
        removed++;
      }
    })();
  }

  let moved = 0;
  if (toMove.length > 0) {
    db.transaction(() => {
      for (const r of toMove) {
        const d = map.get(r[0]);
        if (!d) continue;
        updDoc.run(userByAccount.get(r[4]), r[4], r[1], r[2] ? 1 : 0, r[3], d.sig, d.rowid);
        d.folder = r[1];
        d.date = r[3];
        d.account = r[4];
        moved++;
      }
    })();
  }

  const work = toIndex.concat(drafts);
  const firstBuild = !state.ready;
  if (work.length > 0) {
    state.building = firstBuild;
    state.done = map.size;
    state.total = map.size + toIndex.length;
  }
  let indexed = 0;
  for (let i = 0; i < work.length; i += READ_CHUNK) {
    // Les lectures better-sqlite3 sont synchrones : on rend la main entre
    // chaque lot pour ne pas geler IMAP / WebSocket / HTTP.
    await yieldLoop();
    const chunk = work.slice(i, i + READ_CHUNK);
    const byId = new Map(chunk.map((r) => [r[0], r]));
    const rows = pb
      .prepare(
        `SELECT id, subject, from_address, to_addresses, cc_addresses, bcc_addresses,
                text_body, html_body, snippet
         FROM messages WHERE id IN (${chunk.map(() => "?").join(",")})`
      )
      .all(...chunk.map((r) => r[0])) as SourceContentRow[];
    const prepared = rows.map((row) => {
      const fields = buildFields(row);
      return { row, fields, sig: sigOf(fields) };
    });
    db.transaction(() => {
      for (const p of prepared) {
        const key = byId.get(p.row.id);
        if (!key) continue;
        const isDraft = key[2] ? 1 : 0;
        const user = userByAccount.get(key[4]) as string;
        const existing = map.get(p.row.id);
        // La signature ne sert qu'aux brouillons (seuls a pouvoir changer).
        const sig = isDraft ? p.sig : "";
        if (existing) {
          if (existing.isDraft === isDraft && existing.sig === sig) continue;
          delFts.run(existing.rowid);
          updDoc.run(user, key[4], key[1], isDraft, key[3], sig, existing.rowid);
          insFts.run(
            existing.rowid,
            p.fields.subject,
            p.fields.sender,
            p.fields.recipients,
            p.fields.body
          );
          existing.folder = key[1];
          existing.isDraft = isDraft;
          existing.date = key[3];
          existing.account = key[4];
          existing.sig = sig;
        } else {
          const info = insDoc.run(p.row.id, user, key[4], key[1], isDraft, key[3], sig);
          const rowid = Number(info.lastInsertRowid);
          insFts.run(
            rowid,
            p.fields.subject,
            p.fields.sender,
            p.fields.recipients,
            p.fields.body
          );
          map.set(p.row.id, {
            rowid,
            folder: key[1],
            isDraft,
            date: key[3],
            account: key[4],
            sig,
          });
        }
        indexed++;
      }
    })();
    state.done = map.size;
  }

  if (firstBuild) {
    db.prepare(`INSERT OR REPLACE INTO meta(k, v) VALUES ('built', ?)`).run(
      new Date().toISOString()
    );
  }
  if (indexed > 500) {
    // Une grosse passe laisse un journal volumineux a cote de l'index.
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // confort, pas une condition
    }
  }
  state.ready = true;
  state.building = false;
  state.done = map.size;
  state.total = map.size;
  lastDataVersion = dataVersion;
  lastSyncAt = Date.now();
  if (indexed > 0 || removed > 0 || moved > 0 || firstBuild) {
    console.log(
      `[search-index] sync: +${indexed} -${removed} deplaces=${moved} total=${map.size} en ${
        Date.now() - t0
      }ms${firstBuild ? " (premiere construction)" : ""}`
    );
  }
}

/**
 * Aligne l'index sur data.db. Une seule passe a la fois : les appels
 * concurrents attendent la passe en cours.
 */
export function syncSearchIndex(force = false): Promise<void> {
  if (syncPromise) return syncPromise;
  syncPromise = runSync(force)
    .catch((err) => {
      console.warn(`[search-index] sync en echec: ${(err as Error).message}`);
    })
    .finally(() => {
      syncPromise = null;
    });
  return syncPromise;
}

/**
 * A appeler avant une recherche : rattrape les mails arrives depuis la
 * derniere passe (au plus toutes les 5 s). Pendant la PREMIERE construction on
 * n'attend pas : la recherche repond sur la partie deja indexee (les plus
 * recents d'abord) et `getSearchIndexState()` dit ou elle en est.
 */
export async function ensureSearchIndexFresh(): Promise<void> {
  if (!ensureIndexDb()) return;
  if (!state.ready) {
    void syncSearchIndex();
    return;
  }
  if (Date.now() - lastSyncAt < FRESH_MS) return;
  await syncSearchIndex();
}

export function getSearchIndexState(): {
  available: boolean;
  ready: boolean;
  done: number;
  total: number;
} {
  return {
    available: !!ensureIndexDb() && !!getPbDb(),
    ready: state.ready,
    done: state.done,
    total: state.total,
  };
}

/** Cle d'un message dans les index de liste de data.db. */
export interface SearchKey {
  id: string;
  folder: string;
  is_draft: number;
  date: string;
  account: string;
}

/**
 * Messages de l'utilisateur correspondant a une expression FTS5 (ou tous ses
 * messages si `match` est vide), tries par date decroissante ou par
 * pertinence (sujet et expediteur pesent plus que le corps).
 * Retourne null si l'index est indisponible.
 */
export function searchDocs(opts: {
  userId: string;
  accountId?: string;
  match: string;
  dateFrom?: string;
  dateTo?: string;
  isDraft?: boolean;
  orderBy?: "date" | "rank";
  limit?: number;
}): SearchKey[] | null {
  const db = ensureIndexDb();
  if (!db) return null;
  const where: string[] = ["d.user = @userId"];
  if (opts.accountId) where.push("d.account = @accountId");
  if (opts.dateFrom) where.push("d.date >= @dateFrom");
  if (opts.dateTo) where.push("d.date <= @dateTo");
  if (opts.isDraft !== undefined) where.push(`d.is_draft = ${opts.isDraft ? 1 : 0}`);
  const params = {
    userId: opts.userId,
    accountId: opts.accountId,
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
    q: opts.match,
    limit: opts.limit ?? 200_000,
  };
  try {
    const cols = `d.id AS id, d.folder AS folder, d.is_draft AS is_draft, d.date AS date, d.account AS account`;
    if (!opts.match) {
      return db
        .prepare(
          `SELECT ${cols} FROM doc d WHERE ${where.join(" AND ")}
           ORDER BY d.date DESC, d.id DESC LIMIT @limit`
        )
        .all(params) as SearchKey[];
    }
    const order =
      opts.orderBy === "rank"
        ? "bm25(mail_fts, 5.0, 4.0, 2.0, 1.0), d.date DESC"
        : "d.date DESC, d.id DESC";
    return db
      .prepare(
        `SELECT ${cols} FROM mail_fts
         JOIN doc d ON d.rowid = mail_fts.rowid
         WHERE mail_fts MATCH @q AND ${where.join(" AND ")}
         ORDER BY ${order} LIMIT @limit`
      )
      .all(params) as SearchKey[];
  } catch (err) {
    console.warn(`[search-index] requete en echec: ${(err as Error).message}`);
    return null;
  }
}

/** Cles d'un lot d'identifiants (ordre non garanti). */
export function getDocKeysByIds(userId: string, ids: string[]): SearchKey[] | null {
  const db = ensureIndexDb();
  if (!db) return null;
  const out: SearchKey[] = [];
  try {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = db
        .prepare(
          `SELECT id, folder, is_draft, date, account FROM doc
           WHERE id IN (${chunk.map(() => "?").join(",")}) AND user = ?`
        )
        .all(...chunk, userId) as SearchKey[];
      for (const r of rows) out.push(r);
    }
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recherche par mots-cles pour le chat IA (RAG) et le suivi d'affaires.
// Memes signatures que les anciennes fonctions de sqlite-direct.ts (qui
// lisaient `messages_fts` dans data.db) : mots ENTIERS, tous requis.
// ---------------------------------------------------------------------------

type MessageRow = {
  id: string;
  thread_id: string;
  subject: string;
  from_address: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  date: string;
  snippet: string;
  text_body?: string;
  html_body?: string;
};

function toPBMessage(r: MessageRow): PBMessage {
  return {
    id: r.id,
    thread_id: r.thread_id,
    subject: r.subject || "",
    from_address: safeJson<PBEmailAddress>(r.from_address) || { address: "", name: "" },
    to_addresses: safeJson<PBEmailAddress[]>(r.to_addresses) || [],
    cc_addresses: safeJson<PBEmailAddress[]>(r.cc_addresses) || [],
    date: r.date,
    snippet: r.snippet || "",
    text_body: r.text_body || "",
    html_body: r.html_body || "",
  } as PBMessage;
}

function loadMessages(keys: SearchKey[], lightweight: boolean): PBMessage[] {
  const pb = getPbDb();
  if (!pb || keys.length === 0) return [];
  const byId = new Map<string, MessageRow>();
  if (lightweight) {
    // Sans les corps : seek dans l'index couvrant, aucune ligne lue.
    let stmt: Database.Statement | null = null;
    try {
      stmt = pb.prepare(
        `SELECT id, thread_id, subject, from_address, to_addresses, cc_addresses, date, snippet
         FROM messages INDEXED BY idx_msg_list_cover
         WHERE folder = ? AND is_draft = ? AND date = ? AND id = ?`
      );
    } catch {
      stmt = null;
    }
    if (stmt) {
      for (const k of keys) {
        const r = stmt.get(k.folder, k.is_draft, k.date, k.id) as MessageRow | undefined;
        if (r) byId.set(r.id, r);
      }
    }
  }
  const missing = keys.filter((k) => !byId.has(k.id)).map((k) => k.id);
  const bodyCols = lightweight ? "" : ", text_body, html_body";
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    const rows = pb
      .prepare(
        `SELECT id, thread_id, subject, from_address, to_addresses, cc_addresses, date, snippet${bodyCols}
         FROM messages WHERE id IN (${chunk.map(() => "?").join(",")})`
      )
      .all(...chunk) as MessageRow[];
    for (const r of rows) byId.set(r.id, r);
  }
  const out: PBMessage[] = [];
  for (const k of keys) {
    const r = byId.get(k.id);
    if (r) out.push(toPBMessage(r));
  }
  return out;
}

export function searchKeywordsFTS5(opts: {
  userId: string;
  accountId?: string;
  terms: string[];
  limit: number;
  /** Sans text_body/html_body (les 2 gros champs). */
  lightweight?: boolean;
  /** "rank" (defaut) = pertinence ; "date" = plus recents d'abord. */
  orderBy?: "rank" | "date";
}): PBMessage[] | null {
  if (!getPbDb()) return null;
  if (opts.terms.length === 0) return [];
  const match = buildFtsMatch({ terms: opts.terms, prefix: false });
  if (!match) return [];
  const keys = searchDocs({
    userId: opts.userId,
    accountId: opts.accountId,
    match,
    orderBy: opts.orderBy === "date" ? "date" : "rank",
    limit: opts.limit,
  });
  if (!keys) return null;
  try {
    return loadMessages(keys, !!opts.lightweight);
  } catch (err) {
    console.warn(`[search-index] lecture des messages en echec: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Variante bornee dans le temps (hors brouillons). Sans terme, ramene tous
 * les mails de la fenetre (questions "tous les mails d'avril").
 */
export function searchKeywordsFTS5InWindow(opts: {
  userId: string;
  accountId?: string;
  terms: string[];
  dateFrom?: string;
  dateTo?: string;
  limit: number;
}): PBMessage[] | null {
  if (!getPbDb()) return null;
  const match = opts.terms.length > 0 ? buildFtsMatch({ terms: opts.terms, prefix: false }) : "";
  if (opts.terms.length > 0 && !match) return [];
  const keys = searchDocs({
    userId: opts.userId,
    accountId: opts.accountId,
    match,
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
    isDraft: false,
    orderBy: match ? "rank" : "date",
    limit: opts.limit,
  });
  if (!keys) return null;
  try {
    return loadMessages(keys, false);
  } catch (err) {
    console.warn(`[search-index] lecture des messages en echec: ${(err as Error).message}`);
    return null;
  }
}

process.on("SIGTERM", () => {
  indexDb?.close();
});
