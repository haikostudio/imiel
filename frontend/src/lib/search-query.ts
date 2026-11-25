// Analyse de la requete de recherche cote ecran. Le bloc "SHARED PARSER" est
// une copie IDENTIQUE de backend/mail-worker/src/search-query.ts (sous-projets
// separes, pas de paquet commun) : __tests__/search-query.test.ts verifie que
// les deux blocs sont identiques et joue le meme jeu de cas que le worker.
// Le reste du fichier (pastilles, repli PocketBase) est propre a l'ecran.

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

// ------------------------------------------------------------------ Pastilles

/** Filtres poses par les pastilles de la recherche (etat structure). */
export interface SearchChips {
  unread: boolean;
  starred: boolean;
  attachment: boolean;
  /** Adresse (ou nom) de l'expediteur, null = tous. */
  from: string | null;
  /** AAAA-MM-JJ ou "" (bornes incluses). */
  after: string;
  before: string;
}

export const EMPTY_CHIPS: SearchChips = {
  unread: false,
  starred: false,
  attachment: false,
  from: null,
  after: "",
  before: "",
};

export function hasActiveChips(c: SearchChips): boolean {
  return c.unread || c.starred || c.attachment || !!c.from || !!c.after || !!c.before;
}

function quoteValue(v: string): string {
  const clean = v.replace(/"/g, "").trim();
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

/** Pastilles -> operateurs texte : UN SEUL chemin vers le worker. */
export function chipsToQuery(c: SearchChips): string {
  const parts: string[] = [];
  if (c.unread) parts.push("is:unread");
  if (c.starred) parts.push("is:starred");
  if (c.attachment) parts.push("has:attachment");
  if (c.from && c.from.trim()) parts.push(`from:${quoteValue(c.from)}`);
  if (c.after) parts.push(`after:${c.after}`);
  if (c.before) parts.push(`before:${c.before}`);
  return parts.join(" ");
}

/** Requete complete envoyee au moteur : pastilles puis texte saisi. */
export function composeSearchQuery(chips: SearchChips, text: string): string {
  return [chipsToQuery(chips), text.trim()].filter(Boolean).join(" ");
}

/**
 * Requete texte (recherche recente, ancien format compris) -> pastilles + texte
 * restant. Seuls les operateurs representables par une pastille en sortent ;
 * le reste (to:, subject:, texte libre, operateurs en erreur) reste tel quel.
 */
export function splitChipsFromQuery(query: string): { chips: SearchChips; text: string } {
  const chips: SearchChips = { ...EMPTY_CHIPS };
  const rest: string[] = [];
  const tokens = (query || "").match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
  for (const token of tokens) {
    const sep = token.indexOf(":");
    const key = sep > 0 ? token.slice(0, sep).toLowerCase() : "";
    const value = sep > 0 ? unquote(token.slice(sep + 1)) : "";
    const lower = value.toLowerCase();
    if (key === "is" && lower === "unread") chips.unread = true;
    else if (key === "is" && lower === "starred") chips.starred = true;
    else if (key === "has" && lower === "attachment") chips.attachment = true;
    else if (key === "from" && value && chips.from === null) chips.from = value;
    else if (key === "after" && !chips.after && normalizeSearchDate(value))
      chips.after = normalizeSearchDate(value)!;
    else if (key === "before" && !chips.before && normalizeSearchDate(value))
      chips.before = normalizeSearchDate(value)!;
    else rest.push(token);
  }
  return { chips, text: rest.join(" ") };
}

// --------------------------------------------------------- Repli PocketBase

function pbEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Filtre PocketBase equivalent (repli quand le worker est injoignable). Une
 * requete en erreur ne doit RIEN ramener : filtre impossible.
 */
export function buildPocketBaseSearchFilter(
  p: ParsedSearchQuery,
  activeAccountId: string | "all" | null
): string {
  if (p.errors.length > 0) return `id = "__invalid_search__"`;
  const parts: string[] = [];
  if (activeAccountId && activeAccountId !== "all") parts.push(`account = "${pbEscape(activeAccountId)}"`);
  if (p.from.length > 0)
    parts.push(`(${p.from.map((v) => `from_address ~ "${pbEscape(v)}"`).join(" || ")})`);
  if (p.to.length > 0)
    parts.push(`(${p.to.map((v) => `to_addresses ~ "${pbEscape(v)}"`).join(" || ")})`);
  for (const v of p.subject) parts.push(`subject ~ "${pbEscape(v)}"`);
  if (p.hasAttachment) parts.push(`has_attachments = true`);
  if (p.isUnread) parts.push(`is_read = false`);
  if (p.isRead) parts.push(`is_read = true`);
  if (p.isStarred) parts.push(`is_starred = true`);
  // Format ESPACE de PocketBase (comparaison de chaines) : jamais un "T".
  if (p.after) parts.push(`date >= "${p.after} 00:00:00.000Z"`);
  if (p.before) parts.push(`date <= "${p.before} 23:59:59.999Z"`);
  const text = p.freeText.replace(/"/g, " ").trim();
  if (text) {
    const e = pbEscape(text);
    parts.push(`(subject ~ "${e}" || from_address ~ "${e}" || to_addresses ~ "${e}")`);
  }
  return parts.join(" && ");
}
