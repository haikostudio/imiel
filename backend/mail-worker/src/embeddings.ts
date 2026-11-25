import { createHash } from "crypto";
import path from "path";
import type { FlagEmbedding } from "fastembed";
import {
  type PBMessage,
  type PBEmailAddress,
  findEmbeddingByMessage,
  createEmbedding,
  updateEmbedding,
  listAccountsForUser,
  listActiveUserIds,
  listUnembeddedMessageIds,
  countUnembeddedMessages,
  getMessage,
  listMessagesByIds,
  listMessagesByKeywords,
  listEmbeddingsForSearch,
  countRecords,
  getEarliestOrLatestMessageDate,
  getUserPauseFlags,
  invalidateUserPauseFlagsCache,
} from "./pocketbase";
import { searchKeywordsFTS5, searchKeywordsFTS5InWindow } from "./search-index";
import {
  loadEmbeddingsFromSQLite,
  loadEmbeddingsByMessageIdsFromSQLite,
  getCoverageStatsFromSqlite,
  isSqliteDirectAvailable,
} from "./sqlite-direct";

const MODEL_TAG = "all-MiniLM-L6-v2";
const MAX_CHARS = 1000;

// Retries pour les operations PB transientes pendant le backfill : un timeout
// reseau ou un 502 ne doit pas tuer toute l'indexation, on reessaye avec
// backoff. Au-dela, on saute l'element en cours et on continue.
const BACKFILL_MAX_RETRIES = 4;

function isTransientError(err: unknown): boolean {
  const msg = (err as Error)?.message || "";
  return /aborted|timeout|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|502|503|504|deadline/i.test(
    msg
  );
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= BACKFILL_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === BACKFILL_MAX_RETRIES) throw err;
      const delay = Math.min(15_000, 1_000 * 2 ** (attempt - 1));
      console.warn(
        `[embeddings] ${label} transient error (attempt ${attempt}), retry in ${delay}ms:`,
        (err as Error).message
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Filet de securite ultime : meme si un fetch oublie un timeout ou que le
// modele d'embedding se bloque, on garantit que la boucle backfill ne reste
// jamais pendue plus de ITEM_HARD_DEADLINE_MS sur un mail. La requete sous-
// jacente est laissee a node (les AbortSignal cote pbFetch font le menage
// reseau), nous on continue avec le prochain item.
const ITEM_HARD_DEADLINE_MS = 90_000;

async function withDeadline<T>(
  label: string,
  ms: number,
  fn: () => Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} hard deadline ${ms}ms exceeded`)),
      ms
    );
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
// Nombre max de vecteurs charges en memoire et scores par requete. Au-dela,
// seuls les embeddings les plus recents sont consideres (recall plafonne).
// 75000 * 384 floats ~= 225 Mo transitoires par recherche : compromis
// couverture/memoire pour les boites tres volumineuses. Le cap a 25k coupait
// l'acces aux mails > 8 mois pour les comptes intensifs ("rien avant
// mi-avril" alors que la boite remonte a 1 an+). Quand la query contient une
// reference temporelle (dateWindow), on bypass le cap en chargeant uniquement
// les vecteurs des mails de la fenetre via SQLite direct.
const SEARCH_CAP = 75000;

let modelPromise: Promise<FlagEmbedding> | null = null;

// cacheDir par defaut de fastembed = "local_cache" RELATIF au cwd. En prod
// (Docker, cwd=/app, user=node) ce path n'est pas writable -> mkdirSync EACCES
// au demarrage, chaque embedDocument throw et le backfill rate TOUS les items
// (~3ms par fail). Cause confirmee par les logs prod "EACCES: permission
// denied, mkdir 'local_cache'". On accepte un override via env var pour
// pointer vers un path absolu writable (cf Dockerfile : /app/local_cache,
// chown node:node, modele pre-telecharge dans l'image).
const FASTEMBED_CACHE_DIR = process.env.FASTEMBED_CACHE_DIR || "local_cache";

function getModel(): Promise<FlagEmbedding> {
  if (!modelPromise) {
    // Import paresseux : fastembed -> require("onnxruntime-node") (binaire
    // natif). Le charger ici evite de crasher tout le worker au demarrage si
    // le binaire est absent (ex: musl/Alpine). L'erreur remonte alors via
    // l'endpoint/le state au lieu de tuer le process.
    // fastembed >= 1.14.5 a change DEUX choses pour AllMiniLML6V2 : pooling
    // CLS -> Mean, et dossier/tokenizer HF "Qdrant_all-MiniLM-L6-v2-onnx"
    // (troncature 256 au lieu de 512). Les ~43k vecteurs stockes dans
    // mail_embeddings ont ete calcules en CLS/512 : avec le defaut, les
    // requetes ne ressemblent plus aux mails indexes (cosinus 0.37-0.59 sur le
    // meme texte). On charge donc le modele EMBARQUE (local_cache/fast-all-
    // MiniLM-L6-v2, meme model.onnx) en mode CUSTOM + Pooling.CLS : vecteurs
    // identiques a 1.14.4 (cosinus 1.000000 mesure), aucun telechargement HF.
    // Changer ce reglage impose de re-embedder toute la base.
    modelPromise = import("fastembed").then(({ FlagEmbedding, EmbeddingModel, Pooling }) =>
      FlagEmbedding.init({
        model: EmbeddingModel.CUSTOM,
        modelAbsoluteDirPath: path.resolve(FASTEMBED_CACHE_DIR, "fast-all-MiniLM-L6-v2"),
        modelName: "model.onnx",
        pooling: Pooling.CLS,
        maxLength: 512,
      })
    );
    modelPromise.catch(() => {
      modelPromise = null;
    });
  }
  return modelPromise;
}

function toArray(v: ArrayLike<number>): number[] {
  return Array.from(v);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEmbedText(msg: Partial<PBMessage>): string {
  const from = msg.from_address
    ? `${msg.from_address.name || ""} ${msg.from_address.address || ""}`.trim()
    : "";
  const body =
    (msg.text_body && msg.text_body.trim()) ||
    (msg.html_body ? stripHtml(msg.html_body) : "") ||
    msg.snippet ||
    "";
  const text = `${msg.subject || ""}\n${from}\n${body}`.trim();
  return text.slice(0, MAX_CHARS);
}

function hashContent(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

// Serialise les appels au modele (CPU, instance unique).
let embedChain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = embedChain.then(fn, fn);
  embedChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// Timeout de securite sur l'inference modele : si fastembed/onnx se bloque
// (memoire, signal, etc.), on rejette pour que l'item soit skip plutot que
// de geler la chaine de serialisation pour tous les suivants.
const EMBED_TIMEOUT_MS = 30_000;

export function embedDocument(text: string): Promise<number[]> {
  return serialize(() =>
    withDeadline("embedDocument", EMBED_TIMEOUT_MS, async () => {
      const model = await getModel();
      const gen = model.embed([text || " "], 1);
      for await (const batch of gen) {
        if (batch.length > 0) return toArray(batch[0]);
      }
      return [];
    })
  );
}

// IMPORTANT : embedQuery DOIT avoir un withDeadline, sinon un queryEmbed
// pendu (model freeze, onnx hang, init bloquee) gele toute la chaine
// `serialize` : tous les embedDocument suivants attendent indefiniment,
// le backfill skip chaque item au hard deadline 90s sans jamais incrementer
// done. Cause confirmee du backfill bloque a (1/N) pendant des heures.
export function embedQuery(text: string): Promise<number[]> {
  return serialize(() =>
    withDeadline("embedQuery", EMBED_TIMEOUT_MS, async () => {
      const model = await getModel();
      return toArray(await model.queryEmbed(text || " "));
    })
  );
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Calcule et stocke (ou met a jour) l'embedding d'un message. */
export async function upsertMessageEmbedding(
  msg: Partial<PBMessage> & { id: string; account: string },
  userId: string
): Promise<void> {
  const text = buildEmbedText(msg);
  if (!text) return;
  const hash = hashContent(text);

  const existing = await findEmbeddingByMessage(msg.id);
  if (existing && existing.content_hash === hash) return;

  const vector = await embedDocument(text);
  if (vector.length === 0) return;

  if (existing) {
    await updateEmbedding(existing.id, {
      vector,
      model: MODEL_TAG,
      content_hash: hash,
    });
  } else {
    await createEmbedding({
      message: msg.id,
      account: msg.account,
      user: userId,
      vector,
      model: MODEL_TAG,
      content_hash: hash,
    });
  }
  pokeVecCache(userId, msg.account, msg.id, vector);
}

// --- File d'attente pour l'indexation incrementale (au fil des syncs) ---

interface QueueItem {
  msg: Partial<PBMessage> & { id: string; account: string };
  userId: string;
}

const queue: QueueItem[] = [];
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const item = queue.shift()!;
    try {
      await upsertMessageEmbedding(item.msg, item.userId);
    } catch (err) {
      console.error("[embeddings] enqueue index failed:", err);
    }
  }
  draining = false;
}

export function enqueueEmbedding(
  msg: Partial<PBMessage> & { id: string; account: string },
  userId: string
): void {
  queue.push({ msg, userId });
  void drain();
}

// --- Cache vecteurs en memoire (evite de retelecharger tous les embeddings
// depuis PocketBase a chaque recherche : c'etait la cause des timeouts) ---

interface VecRow {
  message: string;
  // Float32Array via SQLite direct (BLOB binaire), number[] via fallback PB API
  // ou pokeVecCache (vecteur fraichement embed). cosine accepte les deux.
  vector: Float32Array | number[];
}
interface VecCacheEntry {
  rows: VecRow[];
  loadedAt: number;
}

// TTL tres long : recharger 36k vecteurs depuis SQLite coute ~2-10s ET churn
// le page cache (sur une box RAM-tight, ca evince les pages de PocketBase ->
// la liste des conversations repasse a froid). pokeVecCache maintient le cache
// a jour EN PLACE a chaque mail indexe (pas de purge), donc on n'a pas besoin
// de recharger souvent : la seule staleness est sur suppressions/edits (impact
// mineur sur le ranking). 6h = on garde les vecteurs residents (recherche
// rapide) sans rechurner la memoire en boucle.
const VEC_TTL_MS = 6 * 60 * 60 * 1000;
const vecCache = new Map<string, VecCacheEntry>();

function vecKey(userId: string, accountId?: string): string {
  return `${userId}::${accountId || "*"}`;
}

async function loadVectorsCached(
  userId: string,
  accountId: string | undefined,
  cap: number,
  force = false
): Promise<VecRow[]> {
  const key = vecKey(userId, accountId);
  const hit = vecCache.get(key);
  if (!force && hit && Date.now() - hit.loadedAt < VEC_TTL_MS) return hit.rows;

  // Tente d'abord SQLite direct (<500ms pour 42k vecteurs). Si indispo
  // (fichier absent, init failed), fallback PB API HTTP (30s+, paginate).
  const t0 = Date.now();
  let rows: VecRow[] | null = await loadEmbeddingsFromSQLite(userId, accountId, cap);
  if (rows !== null) {
    console.log(
      `[embeddings] loadVectors SQLite direct: ${rows.length} en ${
        Date.now() - t0
      }ms`
    );
  } else {
    console.log("[embeddings] loadVectors fallback PB API HTTP...");
    rows = await listEmbeddingsForSearch(userId, accountId, cap);
    console.log(
      `[embeddings] loadVectors PB API: ${rows.length} en ${Date.now() - t0}ms`
    );
  }
  vecCache.set(key, { rows, loadedAt: Date.now() });
  return rows;
}

// Maintient le cache chaud quand un mail est (re)indexe au fil des syncs :
// pas de purge complete (qui forcerait un rechargement lourd), mise a jour
// en place. `sort: "-created"` cote PB => nouveau = en tete.
function pokeVecCache(
  userId: string,
  account: string,
  message: string,
  vector: number[]
): void {
  const prefix = `${userId}::`;
  for (const [k, entry] of vecCache.entries()) {
    if (!k.startsWith(prefix)) continue;
    const scope = k.slice(prefix.length);
    if (scope !== "*" && scope !== account) continue;
    const idx = entry.rows.findIndex((r) => r.message === message);
    if (idx >= 0) entry.rows[idx].vector = vector;
    else entry.rows.unshift({ message, vector });
  }
}

// --- Recherche semantique ---

export async function searchEmbeddings(opts: {
  userId: string;
  accountId?: string;
  query: string;
  limit: number;
}): Promise<{ message: string; score: number }[]> {
  const qVec = await embedQuery(opts.query.slice(0, MAX_CHARS));
  const candidates = await loadVectorsCached(
    opts.userId,
    opts.accountId,
    SEARCH_CAP
  );
  const scored = candidates.map((c) => ({
    message: c.message,
    score: cosine(qVec, c.vector),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(Math.max(opts.limit, 1), 25));
}

export interface RagHit {
  id: string;
  thread_id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  body: string;
  score: number;
}

function fmtAddr(a?: PBEmailAddress): string {
  if (!a) return "";
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function msgToHit(m: PBMessage, score: number): RagHit {
  const raw =
    (m.text_body && m.text_body.trim()) ||
    (m.html_body ? stripHtml(m.html_body) : "") ||
    m.snippet ||
    "";
  return {
    id: m.id,
    thread_id: m.thread_id,
    subject: m.subject || "(sans sujet)",
    from: fmtAddr(m.from_address),
    date: m.date,
    snippet: m.snippet || "",
    body: raw.length > 1800 ? raw.slice(0, 1800) + "..." : raw,
    score: Number(score.toFixed(3)),
  };
}

// Recherche semantique + contenu des messages : renvoie directement les
// extraits prets a injecter dans le prompt (un seul appel LLM cote route).
export async function searchEmbeddingContext(opts: {
  userId: string;
  accountId?: string;
  query: string;
  limit: number;
  /** UI search bar : on saute l'hydratation des records (id+score suffisent). */
  lightweight?: boolean;
}): Promise<RagHit[]> {
  const hits = await searchEmbeddings(opts);
  if (hits.length === 0) return [];
  if (opts.lightweight) {
    return hits
      .map((h) => ({
        id: h.message,
        thread_id: "",
        subject: "",
        from: "",
        date: "",
        snippet: "",
        body: "",
        score: Number(h.score.toFixed(3)),
      }))
      .sort((a, b) => b.score - a.score);
  }
  const scoreById = new Map(hits.map((h) => [h.message, h.score]));
  const msgs = await listMessagesByIds(hits.map((h) => h.message));
  return msgs
    .map((m) => msgToHit(m, scoreById.get(m.id) ?? 0))
    .sort((a, b) => b.score - a.score);
}

// Stopwords FR/EN/DE/IT pour extraire les termes signifiants d'une question
// conversationnelle. Couvre aussi les mots "meta" generiques qui polluent la
// recherche LIKE (projet/dossier/affaire/sujet) : ils matchent tellement de
// mails que le keyword filter perd toute precision si on les garde.
const KW_STOPWORDS = new Set([
  // FR
  "tu", "me", "moi", "te", "se", "le", "la", "les", "un", "une", "des", "du",
  "de", "et", "ou", "mais", "donc", "car", "ni", "que", "qui", "quoi", "dont",
  "ce", "ces", "cette", "mon", "ton", "son", "ma", "ta", "sa", "nos", "vos",
  "ses", "leur", "leurs", "pour", "par", "avec", "sans", "sur", "sous", "dans",
  "chez", "vers", "entre", "depuis", "pendant", "avant", "apres", "comme",
  "concernant", "tous", "toutes", "tout", "toute", "etre", "avoir", "faire",
  "peux", "peut", "puis", "veux", "veut", "voudrais", "voulez", "fais",
  "fait", "vais", "vas", "va", "suis", "est", "sont", "ete", "soit", "ait",
  "ai", "as", "aux", "ils", "elles", "nous", "vous", "lui", "elle", "il",
  "resume", "resumer", "resumes", "resumez", "resumant", "echange", "echanges",
  "email", "emails", "mail", "mails", "message", "messages", "boite",
  "discussion", "discussions", "envoi", "envoie", "envoyer", "trouve",
  "trouver", "cherche", "chercher", "recherche", "rechercher", "moi",
  "donne", "donner", "donnez", "afficher", "affiche", "liste", "voir",
  "peux-tu", "merci", "stp", "svp",
  // FR meta (mots trop generiques pour un LIKE)
  "projet", "projets", "dossier", "dossiers", "affaire", "affaires",
  "sujet", "sujets", "programme", "programmes", "info", "infos",
  "client", "clients", "fournisseur", "fournisseurs", "demande", "demandes",
  "reunion", "reunions", "rendez-vous", "doc", "document", "documents",
  "fichier", "fichiers", "piece", "pieces", "attache", "attachee",
  "nouveau", "nouvelle", "ancien", "ancienne", "derniere", "dernier",
  "premiere", "premier", "recent", "recente", "important", "importante",
  "personne", "personnes", "contact", "contacts",
  // EN
  "the", "a", "an", "and", "or", "but", "if", "then", "for", "to", "of",
  "in", "on", "at", "by", "with", "from", "as", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "can", "may", "might", "must", "this", "that",
  "these", "those", "my", "your", "his", "her", "its", "our", "their", "me",
  "him", "us", "them", "you", "we", "they", "he", "she", "it", "i",
  "summarize", "summary", "find", "search", "show", "list", "give", "tell",
  "please", "thanks", "thank", "email", "emails", "mail", "mails",
  "message", "messages", "inbox", "about", "regarding", "concerning",
  "project", "projects", "case", "cases", "file", "files", "info", "infos",
  "client", "clients", "vendor", "vendors", "meeting", "meetings",
  "doc", "document", "documents", "thread", "threads", "conversation",
  "conversations", "new", "old", "last", "first", "recent", "important",
  // DE
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "und",
  "oder", "aber", "ich", "du", "er", "sie", "es", "wir", "ihr", "von",
  "zu", "in", "auf", "an", "mit", "fur", "uber", "bei", "ist", "sind",
  // IT
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "e", "o", "ma",
  "se", "di", "da", "in", "con", "su", "per", "tra", "fra", "io", "tu",
  "lui", "lei", "noi", "voi", "loro", "che", "del", "dei", "delle",
]);

// Cache PB API par term/limit/window. Sans ce cache, chaque requete chat
// repaye 7-20s par terme sur la PB distante (LIKE sur 42k mails). TTL 60s
// pour balance fraicheur/perf (nouveaux mails apparaissent rapidement).
const kwCache = new Map<
  string,
  { results: PBMessage[]; loadedAt: number }
>();

// Marqueurs de specificite : un terme est "rare" s'il contient un chiffre, est
// capitalise (nom propre probable) ou est long. Sert a prioriser quand on
// doit tronquer la liste.
function termSpecificity(t: string): number {
  let s = 0;
  if (/\d/.test(t)) s += 3;
  if (/^[A-Z]/.test(t)) s += 2;
  if (t.length >= 7) s += 1;
  return s;
}

// Extrait les termes "signifiants" pour une recherche LIKE : mots de
// 3+ caracteres absents du stopword set, dedupliques, tries par specificite
// decroissante (noms propres / refs avec chiffres / mots longs d'abord) pour
// que la limite de 8 garde les termes les plus discriminants.
export function extractKeywords(query: string): string[] {
  const seen = new Set<string>();
  const all: string[] = [];
  for (const raw of query.split(/[^\p{L}\p{N}_-]+/u)) {
    if (raw.length < 3) continue;
    const lower = raw.toLowerCase();
    if (KW_STOPWORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    all.push(raw);
  }
  all.sort((a, b) => termSpecificity(b) - termSpecificity(a));
  return all.slice(0, 8);
}

// Mode de recherche :
// - "focused" (defaut) : top-N par pertinence, date DESC en tiebreaker.
//   Bon pour les questions ciblees ("quel est le dernier mail de X ?").
// - "wide" : echantillonnage chronologique pour couvrir l'arc complet d'un
//   sujet (resumes, analyses, vues d'ensemble). Pool keyword elargi,
//   tiebreaker = repartition uniforme dans le temps au lieu de date DESC.
//   Sinon "resume le projet Atelier sur 8 mois" ne ramene que les 15 mails
//   les plus recents et le LLM rate l'historique.
export type SearchMode = "focused" | "wide";

// Echantillonne `n` elements uniformement sur un tableau deja trie (typ.
// date ASC) : garde toujours le premier et le dernier, repartit le reste
// par pas constant. Si arr.length <= n, retourne tout.
function uniformSample<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  if (arr.length <= n) return [...arr];
  if (n === 1) return [arr[arr.length - 1]];
  const result: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * step);
    if (!seen.has(idx)) {
      seen.add(idx);
      result.push(arr[idx]);
    }
  }
  return result;
}

// Fenetre temporelle pour cibler la recherche RAG sur une periode precise
// (parsee depuis la question utilisateur cote frontend).
export interface DateWindow {
  from: string; // ISO YYYY-MM-DD inclus
  to: string;   // ISO YYYY-MM-DD inclus
  label?: string; // libelle humain ("avril 2025", "il y a 8 mois")
}

// Recherche keyword multi-terme : UNE requete par terme, puis fusion avec
// scoring proportionnel au nombre de termes matches dans chaque message.
// Avantage vs un seul filter `(t1 OR t2 OR ...)` trie par date : un terme
// generique present dans des newsletters recentes ne noie plus les vrais
// matches sur le terme specifique ("atelier60", "asso") qui sont plus
// anciens. Score = matched_terms / total_terms (1.0 = match parfait).
async function searchKeywordContext(opts: {
  userId: string;
  accountId?: string;
  query: string;
  limit: number;
  mode?: SearchMode;
  dateWindow?: DateWindow;
  /** UI search bar : ne ramene pas text_body/html_body (cf searchKeywordsFTS5). */
  lightweight?: boolean;
}): Promise<RagHit[]> {
  const mode: SearchMode = opts.mode || "focused";
  let terms = extractKeywords(opts.query);
  if (terms.length === 0) {
    console.log(`[chat-rag] keyword: no terms extracted from "${opts.query}"`);
    return [];
  }
  // En mode fallback PB API (SQLite direct indispo : dev local pointe sur PB
  // distante), chaque terme = 1 requete HTTP LIKE de 5-7s. Empiriquement, PB
  // SQLite serialise les LIKEs en interne : 3 termes en parallele = 25s, pas
  // 7s. Cap a 1 SEUL terme (le plus specifique) en fallback PB pour passer
  // de 25s a ~7s. On perd un peu de scoring multi-terme mais le ranking par
  // pertinence du terme top suffit largement (Atelier > commence/relatives).
  // En FTS5 (prod) on garde les 8 termes (instantane).
  if (!isSqliteDirectAvailable() && terms.length > 1) {
    console.log(
      `[chat-rag] PB API fallback : cap keyword 8->1 (kept: ${terms[0]} ; dropped: ${terms
        .slice(1)
        .join(", ")})`
    );
    terms = terms.slice(0, 1);
  }
  console.log(
    `[chat-rag] keyword terms=${JSON.stringify(terms)} mode=${mode} (from "${opts.query}")`
  );

  // Sur-fetch par terme. En wide mode, on tire un pool beaucoup plus large
  // (jusqu'a 200 par terme) pour avoir une vraie chronologie avant
  // l'echantillonnage. En focused, 20 suffisent.
  const perTermLimit =
    mode === "wide"
      ? Math.max(opts.limit * 8, 200)
      : Math.max(opts.limit, 20);

  // Cache PB API par (userId, term, limit) TTL 60s : evite de repayer le
  // LIKE de 7s sur des requetes successives sur le meme terme. Cache memoire
  // sans expiration LRU : meme question -> instantane. TTL court car on veut
  // que les nouveaux mails apparaissent dans la recherche.
  const KW_CACHE_TTL_MS = 60_000;
  const cacheKey = `${opts.userId}::${opts.accountId || "*"}::${perTermLimit}::${
    opts.dateWindow ? `${opts.dateWindow.from}..${opts.dateWindow.to}` : "all"
  }`;

  // Tente d'abord FTS5 SQLite direct (<100ms par terme). Si une dateWindow
  // est fournie, on cible la fenetre SQL (clauses date >=, <=) pour bypass
  // le cap 75k vecteurs et retrouver les mails anciens. Fallback PB API HTTP
  // si SQLite indispo (init failed) ou si la query FTS plante.
  //
  // IMPORTANT : Promise.allSettled, PAS Promise.all. Si un terme generique
  // ("quand", "ont") timeout sur PB API, on perd l'integralite des hits y
  // compris sur le terme specifique ("Atelier"). allSettled garde les
  // resultats partiels, on continue avec ce qu'on a.
  const perTermSettled = await Promise.allSettled(
    terms.map(async (t) => {
      const t0 = Date.now();
      const fts = opts.dateWindow
        ? searchKeywordsFTS5InWindow({
            userId: opts.userId,
            accountId: opts.accountId,
            terms: [t],
            dateFrom: opts.dateWindow.from,
            dateTo: opts.dateWindow.to + "T23:59:59.999Z",
            limit: perTermLimit,
          })
        : searchKeywordsFTS5({
            userId: opts.userId,
            accountId: opts.accountId,
            terms: [t],
            limit: perTermLimit,
            lightweight: opts.lightweight,
          });
      if (fts !== null) {
        console.log(
          `[chat-rag] keyword FTS5 term="${t}"${
            opts.dateWindow ? ` window=${opts.dateWindow.from}..${opts.dateWindow.to}` : ""
          } -> ${fts.length} hits (${Date.now() - t0}ms)`
        );
        return fts;
      }
      // Fallback PB API : check cache d'abord (60s TTL) pour eviter le LIKE
      // a 7-20s sur la PB distante en dev local.
      const fullKey = `${cacheKey}::${t.toLowerCase()}`;
      const cached = kwCache.get(fullKey);
      if (cached && Date.now() - cached.loadedAt < KW_CACHE_TTL_MS) {
        console.log(
          `[chat-rag] keyword PB-API CACHE HIT term="${t}" -> ${cached.results.length} hits (${
            Date.now() - t0
          }ms)`
        );
        return cached.results;
      }
      const list = await listMessagesByKeywords({
        userId: opts.userId,
        accountId: opts.accountId,
        terms: [t],
        limit: perTermLimit,
      });
      kwCache.set(fullKey, { results: list, loadedAt: Date.now() });
      console.log(
        `[chat-rag] keyword PB-API fallback term="${t}" -> ${
          list.length
        } hits (${Date.now() - t0}ms) [cached for 60s]`
      );
      return list;
    })
  );

  // Unwrap des resultats : on garde les fulfilled, on log les rejected pour
  // visibilite (sans bloquer la suite).
  const perTerm: PBMessage[][] = perTermSettled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.warn(
      `[chat-rag] keyword term="${terms[i]}" REJECTED:`,
      (r.reason as Error)?.message || r.reason
    );
    return [];
  });

  // Fusion : chaque message accumule la liste des termes qui le matchent.
  // Verification cote serveur sur subject + text_body + html_body strip +
  // snippet + adresses : DOIT couvrir TOUS les champs interroges cote PB,
  // sinon un email HTML-only matche par PB (html_body) serait rejete ici.
  // Si la verif blob echoue malgre un retour PB, on credite quand meme le
  // terme qui a ramene ce message (fallback "trust PB") : evite le faux
  // negatif sur les accents, caracteres speciaux, ou edge case JSON.
  const lowerTerms = terms.map((t) => t.toLowerCase());
  type Entry = { m: PBMessage; matched: Set<string> };
  const byId = new Map<string, Entry>();
  const addrBlob = (a?: PBEmailAddress | null): string =>
    a ? `${a.address || ""} ${a.name || ""}` : "";
  const addrListBlob = (list?: PBEmailAddress[] | null): string =>
    (list || []).map(addrBlob).join(" ");
  for (let i = 0; i < perTerm.length; i++) {
    const list = perTerm[i];
    const termForList = lowerTerms[i];
    for (const m of list) {
      const blob = [
        m.subject || "",
        m.text_body || "",
        m.html_body ? stripHtml(m.html_body) : "",
        m.snippet || "",
        addrBlob(m.from_address),
        addrListBlob(m.to_addresses),
        addrListBlob(m.cc_addresses),
      ]
        .join(" ")
        .toLowerCase();
      const existing = byId.get(m.id);
      const matched = existing ? existing.matched : new Set<string>();
      let foundAny = false;
      for (const lt of lowerTerms) {
        if (blob.includes(lt)) {
          matched.add(lt);
          foundAny = true;
        }
      }
      // Fallback : si le blob ne trouve rien mais PB a retourne ce message
      // pour le terme courant, on credite quand meme ce terme (PB a vu une
      // raison de matcher : adresse JSON, html non-strippe, etc.).
      if (!foundAny) matched.add(termForList);
      byId.set(m.id, { m, matched });
    }
  }

  const scored = Array.from(byId.values()).map(({ m, matched }) => ({
    m,
    score: matched.size / terms.length,
    matched: Array.from(matched),
  }));

  if (mode === "wide") {
    // Wide : on isole la classe top-score (tous les mails matchant le max de
    // termes), on echantillonne uniformement dans le temps pour couvrir l'arc
    // complet, puis on complete avec les meilleurs scores restants. Le caller
    // (searchHybridContext) refera un slice final apres fusion semantique,
    // donc on renvoie ici un pool dimensionne genereusement (limit * 2).
    const targetPool = opts.limit * 2;
    scored.sort((a, b) => b.score - a.score);
    const maxScore = scored.length > 0 ? scored[0].score : 0;
    const topClass = scored.filter((s) => s.score >= maxScore - 0.0001);
    const rest = scored.filter((s) => s.score < maxScore - 0.0001);

    const topQuota = Math.min(
      topClass.length,
      Math.max(1, Math.ceil(targetPool * 0.8))
    );
    const topByDateAsc = [...topClass].sort(
      (a, b) => new Date(a.m.date).getTime() - new Date(b.m.date).getTime()
    );
    const sampledTop = uniformSample(topByDateAsc, topQuota);
    const restQuota = Math.max(0, targetPool - sampledTop.length);
    const fillRest = rest.slice(0, restQuota);
    const out = [...sampledTop, ...fillRest];

    console.log(
      `[chat-rag] keyword WIDE fusion: ${scored.length} candidates, topClass=${topClass.length} sampled=${sampledTop.length} + fill=${fillRest.length} (span: ${
        sampledTop[0]?.m.date ?? "-"
      } -> ${sampledTop[sampledTop.length - 1]?.m.date ?? "-"})`
    );
    return out.map(({ m, score }) => msgToHit(m, Number(score.toFixed(3))));
  }

  // Focused : Score DESC, puis date DESC. Garantit que les messages matchant
  // TOUS les termes remontent en tete meme s'ils sont plus anciens.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.m.date).getTime() - new Date(a.m.date).getTime();
  });

  const top = scored.slice(0, opts.limit);
  console.log(
    `[chat-rag] keyword fusion: ${scored.length} unique candidates, top ${top.length}, scores=${top
      .slice(0, 5)
      .map((s) => `${s.score.toFixed(2)}[${s.matched.join("+")}]`)
      .join(",")}`
  );
  return top.map(({ m, score }) => msgToHit(m, Number(score.toFixed(3))));
}

// Path date-anchored : quand la query contient une reference temporelle
// (dateWindow fournie), on cible la fenetre SQL pour ramener TOUS les mails
// de la periode meme s'ils sont hors top-75k vecteurs. Cette branche evite
// le piege "rien avant mi-avril" pour les boites volumineuses.
async function searchHybridInDateWindow(opts: {
  userId: string;
  accountId?: string;
  query: string;
  limit: number;
  mode: SearchMode;
  dateWindow: DateWindow;
}): Promise<RagHit[]> {
  const t0 = Date.now();
  // 1. Keyword FTS5 sur la fenetre — large pool car la fenetre est etroite
  const keywordHits = await searchKeywordContext({
    ...opts,
    limit: Math.max(opts.limit * 3, 60),
  }).catch((err) => {
    console.warn(
      "[chat-rag] dated-keyword failed:",
      (err as Error).message
    );
    return [] as RagHit[];
  });

  // 2. Si moins de mails que demande, on ramene aussi le contenu temporel
  //    pur (sans filtrage keyword) pour donner une vue complete de la fenetre.
  let extraTemporal: PBMessage[] = [];
  if (keywordHits.length < opts.limit) {
    const rawWindow = searchKeywordsFTS5InWindow({
      userId: opts.userId,
      accountId: opts.accountId,
      terms: [], // pas de filtre keyword : tous les mails de la fenetre
      dateFrom: opts.dateWindow.from,
      dateTo: opts.dateWindow.to + "T23:59:59.999Z",
      limit: opts.limit * 2,
    });
    if (rawWindow) extraTemporal = rawWindow;
  }
  const extraHits = extraTemporal.map((m) => msgToHit(m, 0.5));

  // 3. Branche semantique ciblee : on score le query vector contre UNIQUEMENT
  //    les vecteurs des mails de la fenetre (pas les 75k globaux). Tres
  //    rapide (~50ms pour 500 vecteurs).
  let semanticHits: RagHit[] = [];
  if (isSqliteDirectAvailable() && (keywordHits.length > 0 || extraHits.length > 0)) {
    try {
      const candidateIds = [
        ...new Set([
          ...keywordHits.map((h) => h.id),
          ...extraHits.map((h) => h.id),
        ]),
      ];
      const vectors = loadEmbeddingsByMessageIdsFromSQLite(candidateIds);
      if (vectors && vectors.length > 0) {
        const qVec = await embedQuery(opts.query.slice(0, MAX_CHARS));
        const scored = vectors
          .map((v) => ({
            message: v.message,
            score: cosine(qVec, v.vector),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, opts.limit * 2);
        const scoreById = new Map(scored.map((s) => [s.message, s.score]));
        const msgs = await listMessagesByIds(scored.map((s) => s.message));
        semanticHits = msgs.map((m) => msgToHit(m, scoreById.get(m.id) ?? 0));
      }
    } catch (err) {
      console.warn(
        "[chat-rag] dated-semantic failed:",
        (err as Error).message
      );
    }
  }

  // 4. Fusion : keyword > semantic > temporel pur (par score). Dedup par id.
  const byId = new Map<string, RagHit>();
  for (const h of extraHits) byId.set(h.id, h);
  for (const h of semanticHits) {
    const existing = byId.get(h.id);
    if (!existing || h.score > existing.score) byId.set(h.id, h);
  }
  for (const h of keywordHits) {
    const existing = byId.get(h.id);
    if (!existing || h.score > existing.score) byId.set(h.id, h);
  }
  const fused = Array.from(byId.values());

  let merged: RagHit[];
  if (opts.mode === "wide") {
    // Echantillonnage chronologique sur la fenetre pour voir l'arc complet
    const byDateAsc = [...fused].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    const sampled = uniformSample(byDateAsc, opts.limit);
    merged = sampled.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  } else {
    merged = fused.sort((a, b) => b.score - a.score).slice(0, opts.limit);
  }
  console.log(
    `[chat-rag] DATED window=${opts.dateWindow.from}..${opts.dateWindow.to} kw=${keywordHits.length} sem=${semanticHits.length} extra=${extraHits.length} -> ${merged.length} in ${Date.now() - t0}ms`
  );
  return merged;
}

// Recherche hybride : semantique + keyword en parallele. Le keyword est
// prioritaire (noms propres, refs, numeros) et son score reflete la qualite
// du match (proportion termes matches). Le semantique complete avec les
// paraphrases conceptuelles. Dedup par id : on garde la version au score le
// plus haut (les hits keyword ecrasent les semantiques quand match parfait).
//
// Quand `dateWindow` est fourni, bascule sur le path date-anchored qui ramene
// les mails de la fenetre meme s'ils sont hors top-75k.
export async function searchHybridContext(opts: {
  userId: string;
  accountId?: string;
  query: string;
  limit: number;
  mode?: SearchMode;
  dateWindow?: DateWindow;
  /** UI search bar (/search/hybrid) : id+score uniquement, pas d'hydratation
   *  des corps (text_body/html_body). Le chat (/embeddings/context) laisse
   *  false pour garder le contenu dans le contexte LLM. */
  lightweight?: boolean;
}): Promise<RagHit[]> {
  const mode: SearchMode = opts.mode || "focused";
  const t0 = Date.now();
  console.log(
    `[chat-rag] >>> hybrid search user=${opts.userId} account=${
      opts.accountId ?? "*"
    } limit=${opts.limit} mode=${mode}${
      opts.dateWindow ? ` window=${opts.dateWindow.from}..${opts.dateWindow.to}` : ""
    } query="${opts.query}"`
  );
  if (opts.dateWindow) {
    return searchHybridInDateWindow({ ...opts, mode, dateWindow: opts.dateWindow });
  }
  // Sur-fetch chaque branche pour avoir une bonne diversite avant fusion.
  // En wide mode, on tire un pool ~3x plus large pour avoir de quoi
  // echantillonner chronologiquement apres fusion.
  const halfish =
    mode === "wide" ? Math.max(opts.limit * 3, 60) : Math.max(opts.limit, 12);
  // La branche semantique charge ~42k vecteurs en memoire pour le cosinus.
  // Viable en SQLite direct (<500ms) mais pas via PB API HTTP (160 MB JSON,
  // plusieurs minutes). Quand SQLite direct est indispo (dev local pointe sur
  // PB prod), on skip et on tourne en keyword-only : la recherche reste utile
  // (FTS PB sur subject/text/html/snippet) sans bloquer la requete.
  const semanticEnabled = isSqliteDirectAvailable();
  if (!semanticEnabled) {
    console.log(
      "[chat-rag] semantic skipped (sqlite-direct unavailable) -> keyword-only"
    );
  }
  const [semantic, keyword] = await Promise.all([
    semanticEnabled
      ? searchEmbeddingContext({ ...opts, limit: halfish }).catch((err) => {
          console.warn("[chat-rag] semantic failed:", (err as Error).message);
          return [] as RagHit[];
        })
      : Promise.resolve([] as RagHit[]),
    searchKeywordContext({ ...opts, limit: halfish, mode }).catch((err) => {
      console.warn("[chat-rag] keyword failed:", (err as Error).message);
      return [] as RagHit[];
    }),
  ]);
  console.log(
    `[chat-rag] semantic=${semantic.length} keyword=${keyword.length}`
  );

  const byId = new Map<string, RagHit>();
  for (const h of keyword) byId.set(h.id, h);
  for (const h of semantic) {
    const existing = byId.get(h.id);
    if (!existing) byId.set(h.id, h);
    else if (h.score > existing.score) byId.set(h.id, h);
  }
  const fused = Array.from(byId.values());

  let merged: RagHit[];
  if (mode === "wide") {
    // Wide : on garde la classe top-score, on l'echantillonne uniformement
    // dans le temps (oldest -> newest) pour donner au LLM une vue d'ensemble
    // de l'arc complet du sujet, puis on complete avec les scores inferieurs
    // (sources sementiques complementaires).
    fused.sort((a, b) => b.score - a.score);
    const maxScore = fused[0]?.score ?? 0;
    const topClass = fused.filter((h) => h.score >= maxScore - 0.0001);
    const rest = fused.filter((h) => h.score < maxScore - 0.0001);
    const topQuota = Math.min(
      topClass.length,
      Math.max(1, Math.ceil(opts.limit * 0.8))
    );
    const topByDateAsc = [...topClass].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    const sampledTop = uniformSample(topByDateAsc, topQuota);
    const restQuota = Math.max(0, opts.limit - sampledTop.length);
    const fillRest = rest.slice(0, restQuota);
    // Tri final par date DESC pour aider le LLM a raisonner chronologiquement
    // (presentation : du plus recent au plus ancien). Le score est preserve
    // dans le RagHit pour debug.
    merged = [...sampledTop, ...fillRest].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    console.log(
      `[chat-rag] WIDE sampling: fused=${fused.length} topClass=${topClass.length} sampled=${sampledTop.length} fill=${fillRest.length} span=${
        sampledTop[0]?.date ?? "-"
      } -> ${sampledTop[sampledTop.length - 1]?.date ?? "-"}`
    );
  } else {
    merged = fused
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit);
  }
  console.log(
    `[chat-rag] <<< hybrid merged=${merged.length} in ${Date.now() - t0}ms top=${merged
      .slice(0, 5)
      .map((h) => `${h.score}:${h.subject.slice(0, 30)}`)
      .join(" | ")}`
  );
  return merged;
}

// --- Backfill des emails existants ---

interface BackfillState {
  running: boolean;
  paused: boolean;
  total: number;
  done: number;
  error: string | null;
  // Ring buffer des derniers evenements du backfill, expose via /status.
  // Permet au frontend de voir cote DevTools ce que fait le worker, sans
  // acces SSH/logs prod. Cap a 200 entries (~30 KB max).
  events: string[];
}

const EVENTS_MAX = 200;

const backfillStates = new Map<string, BackfillState>();

function newState(): BackfillState {
  return {
    running: false,
    paused: false,
    total: 0,
    done: 0,
    error: null,
    events: [],
  };
}

function pushEvent(state: BackfillState, msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  state.events.push(line);
  if (state.events.length > EVENTS_MAX) {
    state.events.splice(0, state.events.length - EVENTS_MAX);
  }
  console.log(`[embeddings] ${msg}`);
}

export function getBackfillStatus(userId: string): BackfillState {
  return backfillStates.get(userId) || newState();
}

/** Demande l'arret cooperatif du backfill en cours (gardera le progres). */
export function pauseBackfill(userId: string): BackfillState {
  const state = backfillStates.get(userId);
  if (state && state.running) state.paused = true;
  return getBackfillStatus(userId);
}

export async function getEmbeddingStats(
  userId: string
): Promise<{ totalMessages: number; embedded: number }> {
  // SQLite direct : un seul COUNT indexe par table (<20ms), au lieu d'un
  // COUNT(*) HTTP par compte sur la PB. Le filtre `account=X && is_draft=false`
  // ne tombe sur aucun index couvrant cote PB API : chaque COUNT scanne ~43k
  // lignes (~6-7s), * N comptes en serie = 30s+. C'etait le vrai goulot de la
  // barre de recherche (/search/hybrid attendait ces stats en Promise.all avec
  // la recherche qui, elle, prend ~2s). getCoverageStatsFromSqlite renvoie deja
  // exactement totalMessages (non-draft) + indexedMessages.
  const fast = getCoverageStatsFromSqlite(userId);
  if (fast) {
    return { totalMessages: fast.totalMessages, embedded: fast.indexedMessages };
  }

  // Fallback PB API (dev local pointe sur PB distante : SQLite direct indispo).
  const accounts = await listAccountsForUser(userId);
  let totalMessages = 0;
  for (const acc of accounts) {
    totalMessages += await countRecords(
      "messages",
      `account="${acc.id}" && is_draft=false`
    );
  }
  const embedded = await countRecords("mail_embeddings", `user="${userId}"`);
  return { totalMessages, embedded };
}

/** Lance (en arriere-plan) l'indexation des emails non encore indexes. */
export function startBackfill(userId: string): BackfillState {
  const current = backfillStates.get(userId);
  if (current && current.running) return current;
  // Force le rechargement du flag pause user (le frontend vient peut-etre
  // de le remettre a false pour "Reprendre").
  invalidateUserPauseFlagsCache(userId);

  const state: BackfillState = {
    ...newState(),
    running: true,
  };
  backfillStates.set(userId, state);

  void (async () => {
    try {
      pushEvent(state, `backfill start user=${userId}`);
      // Denominateur = nombre de mails NON-indexes (le seul travail reel),
      // calcule cote SQL via LEFT JOIN. state.done++ pour chaque mail
      // effectivement traite : progression toujours visible.
      try {
        const t0 = Date.now();
        state.total = await withRetry("countUnembeddedMessages", () =>
          countUnembeddedMessages(userId)
        );
        pushEvent(state, `count unembedded=${state.total} (${Date.now() - t0}ms)`);
      } catch (err) {
        pushEvent(state, `count FAILED: ${(err as Error).message}`);
        console.error("[embeddings] backfill count failed:", err);
      }

      let cursor: string | null = null;
      const perPage = 500;
      let consecutivePageFailures = 0;
      let pageCount = 0;
      while (true) {
        let ids: string[];
        let lastDate: string | null;
        let hasMore: boolean;
        const pageT0 = Date.now();
        try {
          const res = await withRetry("listUnembeddedMessageIds", () =>
            listUnembeddedMessageIds(userId, null, cursor, perPage)
          );
          ids = res.ids;
          lastDate = res.lastDate;
          hasMore = res.hasMore;
          consecutivePageFailures = 0;
          state.error = null;
        } catch (err) {
          pushEvent(
            state,
            `page cursor=${cursor ?? "<start>"} FAILED after retries: ${(err as Error).message}`
          );
          state.error = (err as Error).message || "page fetch failed";
          consecutivePageFailures++;
          if (consecutivePageFailures >= 3) break;
          break;
        }

        pageCount++;
        pushEvent(
          state,
          `page=${pageCount} cursor=${cursor ?? "<start>"} -> ids=${ids.length} lastDate=${lastDate ?? "null"} hasMore=${hasMore} (${Date.now() - pageT0}ms) done=${state.done}/${state.total}`
        );

        if (ids.length === 0) {
          pushEvent(state, `page=${pageCount} ids empty -> BREAK loop`);
          break;
        }

        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          // Check de pause cooperative (flag user en DB, cache 3s).
          const flags = await getUserPauseFlags(userId);
          if (state.paused || flags.ai_embeddings_paused) {
            state.paused = true;
            pushEvent(state, `paused at ${state.done}/${state.total} (id=${id})`);
            return;
          }
          const itemT0 = Date.now();
          try {
            await withDeadline(
              `backfill item ${id}`,
              ITEM_HARD_DEADLINE_MS,
              () =>
                withRetry("backfill item", async () => {
                  const m = await getMessage(id);
                  if (m.is_draft) return;
                  await upsertMessageEmbedding(
                    {
                      id: m.id,
                      account: m.account,
                      subject: m.subject,
                      text_body: m.text_body,
                      html_body: m.html_body,
                      from_address: m.from_address,
                    },
                    userId
                  );
                })
            );
            state.done++;
            state.error = null;
            const ms = Date.now() - itemT0;
            if (ms > 5_000 || state.done <= 5 || state.done % 25 === 0) {
              pushEvent(
                state,
                `item ok id=${id} (${ms}ms) -> done=${state.done}/${state.total}`
              );
            }
          } catch (err) {
            // Item perdu mais loop continue. Le LEFT JOIN reprendra l'item
            // au prochain run du backfill (e.id IS NULL).
            pushEvent(
              state,
              `item FAILED id=${id} (${Date.now() - itemT0}ms): ${(err as Error).message}`
            );
          }
        }

        if (!hasMore || !lastDate) {
          pushEvent(
            state,
            `page=${pageCount} hasMore=${hasMore} lastDate=${lastDate ?? "null"} -> BREAK loop (done=${state.done}/${state.total})`
          );
          break;
        }
        cursor = lastDate;
      }
      pushEvent(
        state,
        `backfill done user=${userId} processed=${state.done}/${state.total} pages=${pageCount}`
      );
    } catch (err) {
      state.error = (err as Error).message || "backfill failed";
      pushEvent(state, `backfill CRASHED: ${state.error}`);
      console.error("[embeddings] backfill failed:", err);
    } finally {
      state.running = false;
    }
  })();

  return state;
}

// --- Couverture temporelle (pour le system prompt du chat IA) ---
//
// Pourquoi : sans connaitre les bornes reelles de la boite, le LLM hallucine
// une limite ("je n'ai rien avant mi-avril") qui frustre l'utilisateur quand
// la boite remonte en realite a 1 an+. Cette fonction renvoie les bornes
// exactes + le total indexe ; on les injecte dans le system prompt.

export interface CoverageStats {
  earliestDate: string | null;
  latestDate: string | null;
  totalMessages: number;
  indexedMessages: number;
}

const COVERAGE_TTL_MS = 5 * 60 * 1000;
const coverageCache = new Map<string, { stats: CoverageStats; loadedAt: number }>();

export async function getCoverage(userId: string): Promise<CoverageStats> {
  const hit = coverageCache.get(userId);
  if (hit && Date.now() - hit.loadedAt < COVERAGE_TTL_MS) return hit.stats;
  let stats: CoverageStats;
  // SQLite direct quasi-instantane (<20ms meme sur 50k mails)
  const fast = getCoverageStatsFromSqlite(userId);
  if (fast) {
    stats = fast;
  } else {
    // Fallback PB API : 2 requetes paginees (sort+date ASC + DESC, perPage=1)
    // + count total + count embeddings. Permet d'avoir les bornes meme en
    // dev local pointe sur PB distante (sans SQLite direct).
    stats = await coverageFromPbApi(userId);
  }
  coverageCache.set(userId, { stats, loadedAt: Date.now() });
  return stats;
}

async function coverageFromPbApi(userId: string): Promise<CoverageStats> {
  try {
    const [earliest, latest, total, embedded] = await Promise.all([
      getEarliestOrLatestMessageDate(userId, "asc").catch(() => null),
      getEarliestOrLatestMessageDate(userId, "desc").catch(() => null),
      countRecords(
        "messages",
        `account.user="${userId}" && is_draft=false`
      ).catch(() => 0),
      countRecords("mail_embeddings", `user="${userId}"`).catch(() => 0),
    ]);
    return {
      earliestDate: earliest,
      latestDate: latest,
      totalMessages: total,
      indexedMessages: embedded,
    };
  } catch {
    return {
      earliestDate: null,
      latestDate: null,
      totalMessages: 0,
      indexedMessages: 0,
    };
  }
}

/**
 * Pre-chauffe le cache des vecteurs pour un user (appele au login ou a
 * l'ouverture du panneau chat) pour que la 1ere requete soit deja chaude.
 * Idempotent : si le cache est deja chaud, ne fait rien.
 */
export async function warmCache(userId: string, force = false): Promise<{ cached: number }> {
  const rows = await loadVectorsCached(userId, undefined, SEARCH_CAP, force);
  return { cached: rows.length };
}

// Pre-charge (et rafraichit, force=true) le cache vecteurs de TOUS les users
// actifs. Appele au boot + toutes les 20 min : sans ca, la 1ere recherche apres
// un redemarrage du worker (ou apres expiration du TTL) paie ~6s de chargement
// des 36k vecteurs depuis SQLite. Le warm-on-mount frontend ne suffit pas (il
// peut ne pas se declencher, ou l'utilisateur cherche pendant le chargement).
export async function warmVectorCacheForAllUsers(): Promise<void> {
  let users: string[] = [];
  try {
    users = await listActiveUserIds();
  } catch (err) {
    console.warn(
      "[embeddings] warm-all listActiveUserIds failed:",
      (err as Error).message
    );
    return;
  }
  for (const userId of users) {
    try {
      const t0 = Date.now();
      // NON force : no-op si le cache est deja chaud (TTL 6h) -> on ne rechurn
      // pas la memoire toutes les N minutes. Recharge seulement apres expiration
      // du TTL (toutes les ~6h). pokeVecCache assure la fraicheur entre-temps.
      const rows = await loadVectorsCached(userId, undefined, SEARCH_CAP, false);
      console.log(
        `[embeddings] warm-all user=${userId} -> ${rows.length} vecteurs (${
          Date.now() - t0
        }ms)`
      );
    } catch (err) {
      console.warn(
        `[embeddings] warm-all user=${userId} failed:`,
        (err as Error).message
      );
    }
  }
}

// --- Top-up automatique ---
//
// Pourquoi : `enqueueEmbedding` est appele apres chaque createMessage, mais
// si le worker redemarre pendant que la queue est non vide, ou si
// upsertMessageEmbedding throw (modele timeout, HTML toxique, transient PB
// error), l'item est perdu et le mail ne sera plus jamais indexe sans
// intervention manuelle. Resultat constate en prod : 9 mails recents
// (Google security alerts, OpenRouter newsletter) sans embedding.
//
// Solution : un scan periodique de tous les users actifs, qui relance le
// backfill (idempotent : no-op si deja running) des qu'il existe au moins
// un mail non indexe. startBackfill couvre les pages en LEFT JOIN SQL donc
// rattrape sans relire tous les mails deja indexes.

const TOPUP_MIN_UNEMBEDDED = 1; // declenche des qu'il manque ne serait-ce qu'un mail

/**
 * Pour chaque utilisateur ayant un compte actif, compte les mails non
 * indexes et lance `startBackfill` si besoin. Idempotent : un appel
 * pendant qu'un backfill tourne ne fait rien. Sur erreur d'un user, on
 * continue avec les suivants (le rattrapage n'est pas critique).
 */
export async function topUpEmbeddingsForAllUsers(): Promise<void> {
  const t0 = Date.now();
  let users: string[] = [];
  try {
    users = await listActiveUserIds();
  } catch (err) {
    console.error(
      "[embeddings] auto-topup listActiveUserIds failed:",
      (err as Error).message
    );
    return;
  }
  console.log(`[embeddings] auto-topup scanning ${users.length} active users`);
  let triggered = 0;
  for (const userId of users) {
    try {
      const current = backfillStates.get(userId);
      if (current?.running) continue; // deja en cours, ne pas relancer
      const count = await countUnembeddedMessages(userId);
      if (count >= TOPUP_MIN_UNEMBEDDED) {
        console.log(
          `[embeddings] auto-topup user=${userId} unembedded=${count} -> startBackfill`
        );
        startBackfill(userId);
        triggered++;
      }
    } catch (err) {
      console.error(
        `[embeddings] auto-topup user=${userId} failed:`,
        (err as Error).message
      );
    }
  }
  console.log(
    `[embeddings] auto-topup done in ${Date.now() - t0}ms triggered=${triggered}/${users.length}`
  );
}
