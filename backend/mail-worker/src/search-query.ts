// Analyse d'une requete de recherche saisie par l'utilisateur et construction
// de l'expression FTS5 correspondante. Module PUR (aucune dependance) : teste
// dans search-query.test.ts.
//
// Regles de la barre de recherche :
//   - TOUS les mots saisis comptent (aucune liste de mots ignores : "contact",
//     "document", "projet" sont des recherches legitimes) ;
//   - chaque mot est un DEBUT de mot ("inovi" trouve "Labo") ;
//   - casse et accents ignores (tokenizer unicode61 remove_diacritics) ;
//   - une adresse ("noreply@labo-example.io") ou un mot compose ("rendez-vous")
//     devient une suite de mots consecutifs ;
//   - operateurs : from: to: subject: has:attachment is:unread is:read
//     is:starred after:DATE before:DATE ; une valeur inconnue ou une date
//     invalide est une ERREUR (POST /search/mail repond 400), jamais un filtre
//     ignore ni une comparaison de chaines fausse.

// --- BEGIN SHARED PARSER (copie IDENTIQUE dans frontend/src/lib/search-query.ts
// et backend/mail-worker/src/search-query.ts ; un test du frontend compare les
// deux blocs, et search-query.cases.json est joue des deux cotes) ---

/** Codes d'erreur d'une requete : jamais un filtre ignore en silence. */
export type SearchQueryErrorCode =
  | "emptyValue" // from: sans valeur
  | "unknownValue" // has:pdf, is:lu
  | "invalidDate" // after:2025-13-45, before:demain
  | "dateOrder" // after posterieur a before
  | "conflict"; // is:read et is:unread ensemble

export interface SearchQueryError {
  code: SearchQueryErrorCode;
  /** Le morceau de la requete en cause, tel que saisi. */
  token: string;
}

export interface ParsedSearchQuery {
  freeText: string;
  /** Plusieurs from: se cumulent (l'un OU l'autre expediteur). */
  from: string[];
  to: string[];
  /** Plusieurs subject: sont tous exiges. */
  subject: string[];
  hasAttachment: boolean;
  isUnread: boolean;
  isRead: boolean;
  isStarred: boolean;
  /** AAAA-MM-JJ valide, ou "". */
  after: string;
  before: string;
  errors: SearchQueryError[];
}

const HAS_VALUES = ["attachment"];
const IS_VALUES = ["unread", "read", "starred"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Date saisie -> AAAA-MM-JJ, ou null si elle n'existe pas. Formats acceptes :
 * AAAA-MM-JJ, AAAA/MM/JJ, JJ/MM/AAAA, JJ.MM.AAAA, JJ-MM-AAAA.
 */
export function normalizeSearchDate(input: string): string | null {
  const s = (input || "").trim();
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (match) {
    y = +match[1];
    m = +match[2];
    d = +match[3];
  } else {
    match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (!match) return null;
    d = +match[1];
    m = +match[2];
    y = +match[3];
  }
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > daysInMonth) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Retire les guillemets d'une valeur (from:"Paul Dupont"). */
function unquote(value: string): string {
  return value.replace(/"/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Analyse une requete de la barre de recherche. Operateurs (casse ignoree) :
 * from: to: subject: has:attachment is:unread is:read is:starred
 * after:DATE before:DATE. Un mot dont le prefixe n'est PAS un operateur
 * ("10:30", "Re:", une adresse web) reste du texte libre. Une valeur inconnue
 * ou une date invalide produit une ERREUR, jamais un filtre ignore.
 */
export function parseSearchQuery(query: string): ParsedSearchQuery {
  const out: ParsedSearchQuery = {
    freeText: "",
    from: [],
    to: [],
    subject: [],
    hasAttachment: false,
    isUnread: false,
    isRead: false,
    isStarred: false,
    after: "",
    before: "",
    errors: [],
  };
  const free: string[] = [];
  const tokens = (query || "").match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
  let afterToken = "";
  let beforeToken = "";
  for (const token of tokens) {
    const sep = token.indexOf(":");
    const key = sep > 0 ? token.slice(0, sep).toLowerCase() : "";
    const raw = sep > 0 ? token.slice(sep + 1) : "";
    const value = unquote(raw);
    const lower = value.toLowerCase();
    switch (key) {
      case "from":
      case "to":
      case "subject":
        if (!value) out.errors.push({ code: "emptyValue", token });
        else if (!out[key].some((v) => v.toLowerCase() === lower)) out[key].push(value);
        break;
      case "has":
        if (!value) out.errors.push({ code: "emptyValue", token });
        else if (!HAS_VALUES.includes(lower)) out.errors.push({ code: "unknownValue", token });
        else out.hasAttachment = true;
        break;
      case "is":
        if (!value) out.errors.push({ code: "emptyValue", token });
        else if (!IS_VALUES.includes(lower)) out.errors.push({ code: "unknownValue", token });
        else if (lower === "unread") out.isUnread = true;
        else if (lower === "read") out.isRead = true;
        else out.isStarred = true;
        break;
      case "after":
      case "before": {
        if (!value) {
          out.errors.push({ code: "emptyValue", token });
          break;
        }
        const date = normalizeSearchDate(value);
        if (!date) {
          out.errors.push({ code: "invalidDate", token });
        } else if (key === "after") {
          // Plusieurs bornes : la plus restrictive gagne.
          if (!out.after || date > out.after) {
            out.after = date;
            afterToken = token;
          }
        } else if (!out.before || date < out.before) {
          out.before = date;
          beforeToken = token;
        }
        break;
      }
      default:
        free.push(token);
    }
  }
  if (out.isRead && out.isUnread) out.errors.push({ code: "conflict", token: "is:read is:unread" });
  if (out.after && out.before && out.after > out.before) {
    out.errors.push({ code: "dateOrder", token: `${afterToken} ${beforeToken}` });
  }
  out.freeText = free.join(" ").trim();
  return out;
}

/** Une requete contient-elle de quoi chercher (texte ou filtre) ? */
export function hasSearchCriterion(p: ParsedSearchQuery): boolean {
  return !!(
    p.freeText.replace(/"/g, "").trim() ||
    p.from.length ||
    p.to.length ||
    p.subject.length ||
    p.hasAttachment ||
    p.isUnread ||
    p.isRead ||
    p.isStarred ||
    p.after ||
    p.before
  );
}

// --- END SHARED PARSER ---

const HAS_ALNUM = /[\p{L}\p{N}]/u;
const ALNUM_RUN = /[\p{L}\p{N}]+/gu;

/**
 * Decoupe un texte libre en termes de recherche : separes par des espaces,
 * guillemets retires, termes sans lettre ni chiffre ecartes. Un terme d'UN
 * seul caractere est ecarte (un debut de mot d'une lettre ramenerait toute la
 * boite) sauf s'il est seul.
 */
export function splitSearchTerms(text: string): string[] {
  const raw = (text || "")
    .replace(/"/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && HAS_ALNUM.test(t));
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of raw) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
  }
  const long = terms.filter((t) => (t.match(ALNUM_RUN) || []).join("").length >= 2);
  return (long.length > 0 ? long : terms).slice(0, 12);
}

/**
 * Un terme -> une phrase FTS5. Le terme est mis entre guillemets (FTS5 le
 * redecoupe avec SON tokenizer : "noreply@labo-example.io" devient la suite
 * noreply + labo + io), ce qui neutralise aussi tous les operateurs FTS5
 * (AND, OR, NOT, NEAR, -, :, ^, parentheses). `*` = le dernier mot est un debut.
 */
export function ftsPhrase(term: string, prefix: boolean): string {
  const clean = term.replace(/"/g, " ").trim();
  return `"${clean}"${prefix ? "*" : ""}`;
}

export type FtsColumn = "subject" | "sender" | "recipients" | "body";

/**
 * Expression FTS5 complete : tous les termes doivent etre presents (AND), les
 * operateurs from:/to:/subject: restreignent leurs termes a une colonne.
 * Plusieurs from: (ou to:) = l'un OU l'autre ; plusieurs subject: = tous.
 * Retourne "" quand il n'y a rien a chercher dans le texte.
 */
export function buildFtsMatch(opts: {
  terms: string[];
  from?: string | string[];
  to?: string | string[];
  subject?: string | string[];
  prefix?: boolean;
}): string {
  const prefix = opts.prefix !== false;
  const parts: string[] = [];
  for (const t of opts.terms) {
    if (HAS_ALNUM.test(t)) parts.push(ftsPhrase(t, prefix));
  }
  const list = (v: string | string[] | undefined): string[] =>
    (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
  const columnExpr = (col: FtsColumn, value: string): string =>
    splitSearchTerms(value)
      .map((t) => `${col} : ${ftsPhrase(t, prefix)}`)
      .join(" AND ");
  const anyOf = (col: FtsColumn, values: string[]) => {
    const alts = values.map((v) => columnExpr(col, v)).filter(Boolean);
    if (alts.length === 1) parts.push(alts[0]);
    else if (alts.length > 1) parts.push(`(${alts.map((a) => `(${a})`).join(" OR ")})`);
  };
  anyOf("sender", list(opts.from));
  anyOf("recipients", list(opts.to));
  for (const v of list(opts.subject)) {
    const e = columnExpr("subject", v);
    if (e) parts.push(e);
  }
  return parts.join(" AND ");
}

/**
 * Une requete "simple" (mot-cle, nom, adresse : <= 3 mots, pas de "?") attend
 * les mails les plus RECENTS d'abord ; une question en langage naturel passe
 * par le moteur de pertinence. Meme regle que isSimpleSearchQuery du frontend.
 */
export function isSimpleQuery(freeText: string): boolean {
  const t = (freeText || "").trim();
  if (!t) return true;
  if (t.includes("?")) return false;
  return t.split(/\s+/).length <= 3;
}
