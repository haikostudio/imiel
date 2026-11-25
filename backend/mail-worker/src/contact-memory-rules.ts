// Memoire des contacts (fiche "qui est qui" donnee a l'IA de reponse) :
// regles PURES, sans base ni reseau, testees dans contact-memory-rules.test.ts.
// - quels mails sont de VRAIS echanges (pas newsletters, pubs, notifications),
// - qui sont les personnes liees au meme dossier,
// - comment fusionner une fiche existante avec ce que l'IA vient d'en deduire
//   SANS jamais ecraser ce que l'utilisateur a corrige.

export interface MemoryAddr {
  name?: string;
  address?: string;
}

/** Un mail tel que la memoire le lit (rempli par contact-memory.ts). */
export interface MemoryMail {
  id: string;
  message_id: string;
  thread_id: string;
  subject: string;
  date: string;
  from: MemoryAddr | null;
  to: MemoryAddr[];
  cc: MemoryAddr[];
  is_sent: boolean;
  /** Type du dossier (inbox, sent, archive, spam, trash, custom...) ; "" si inconnu. */
  folder_type: string;
  /** En-tete List-Unsubscribe / Precedence bulk : envoi en masse. */
  bulk: boolean;
  /** Porte un label secondaire ou de categorie automatique (Newsletter, Promotion...). */
  secondary: boolean;
  text: string;
}

export interface RelatedPerson {
  name: string;
  address: string;
  role: string;
}

/** Champs de la fiche que l'utilisateur peut corriger (ils deviennent alors fixes). */
export const MEMORY_TEXT_FIELDS = ["role", "organization", "relation"] as const;
export type MemoryTextField = (typeof MEMORY_TEXT_FIELDS)[number];

export interface ContactMemoryData {
  name: string;
  addresses: string[];
  role: string;
  organization: string;
  relation: string;
  facts: string[];
  related: RelatedPerson[];
  /** Note libre de l'utilisateur : prime sur tout, jamais touchee par l'IA. */
  user_notes: string;
  /** Champs corriges a la main : l'IA ne les reecrit plus. */
  locked: string[];
  /** Faits retires par l'utilisateur : l'IA ne doit plus les remettre. */
  dismissed: string[];
}

/** Ce que l'IA renvoie (avant normalisation). */
export interface AiMemory {
  name: string;
  role: string;
  organization: string;
  relation: string;
  facts: string[];
  related: RelatedPerson[];
  me_role: string;
}

export const MEMORY_MAX_FACTS = 12;
export const MEMORY_MAX_RELATED = 8;
/** Nombre de mails de la personne relus a la construction / a la mise a jour. */
export const MEMORY_MAX_MAILS = 30;

/** Adresse comparable : minuscules, sans le "+etiquette" de la partie locale. */
export function canonAddr(a: string | undefined | null): string {
  const v = (a || "").trim().toLowerCase();
  const at = v.indexOf("@");
  if (at <= 0) return v;
  const local = v.slice(0, at).replace(/\+.*$/, "");
  return `${local}${v.slice(at)}`;
}

const AUTOMATED_LOCAL_RE =
  /(?:^|[._+-])(?:no-?reply|do-?not-?reply|donotreply|noreply|no_reply|ne-?pas-?repondre|nepasrepondre|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|mailer|newsletters?|news|info-?mail|marketing|automated?)$/i;

/** Expediteur d'automate : jamais une personne avec qui on echange. */
export function isAutomatedAddress(a: string | undefined | null): boolean {
  const v = canonAddr(a);
  const at = v.indexOf("@");
  if (at <= 0) return true;
  return AUTOMATED_LOCAL_RE.test(v.slice(0, at));
}

const NON_REAL_FOLDERS = new Set(["spam", "trash", "drafts"]);

function isMineAddr(a: string | undefined | null, mine: Set<string>): boolean {
  const c = canonAddr(a);
  return !!c && mine.has(c);
}

export function isMailMine(m: MemoryMail, mine: Set<string>): boolean {
  return m.is_sent || isMineAddr(m.from?.address, mine);
}

/**
 * Vrai echange humain : ce que j'ai ecrit, ou un mail recu d'une personne
 * (pas d'automate, pas d'envoi en masse, pas de label newsletter/promo/notif),
 * hors spam / corbeille / brouillons.
 */
export function isRealExchange(m: MemoryMail, mine: Set<string>): boolean {
  if (NON_REAL_FOLDERS.has(m.folder_type)) return false;
  if (isMailMine(m, mine)) return true;
  if (m.bulk || m.secondary) return false;
  return !isAutomatedAddress(m.from?.address);
}

export type MemoryDirection = "in" | "out" | "group";

/**
 * Place d'un mail dans l'echange avec la personne : "in" (ecrit par elle),
 * "out" (ecrit par moi, elle en destinataire), "group" (un tiers ecrit, elle et
 * moi en copie). null : elle n'y figure pas.
 */
export function directionWith(
  m: MemoryMail,
  person: Set<string>,
  mine: Set<string>
): MemoryDirection | null {
  const from = canonAddr(m.from?.address);
  const rcpt = [...m.to, ...m.cc].map((a) => canonAddr(a.address));
  if (person.has(from)) return "in";
  const personIn = rcpt.some((r) => person.has(r));
  if (!personIn) return null;
  if (isMailMine(m, mine)) return "out";
  return "group";
}

/** Mails d'echange avec la personne : vrais echanges, sans doublons, du plus recent au plus ancien. */
export function selectPersonMails(
  mails: MemoryMail[],
  person: Set<string>,
  mine: Set<string>,
  limit = MEMORY_MAX_MAILS
): (MemoryMail & { direction: MemoryDirection })[] {
  const seen = new Set<string>();
  const out: (MemoryMail & { direction: MemoryDirection })[] = [];
  const sorted = mails.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const m of sorted) {
    const key = (m.message_id || "").trim() || m.id;
    if (seen.has(key)) continue;
    if (!isRealExchange(m, mine)) continue;
    const direction = directionWith(m, person, mine);
    if (!direction) continue;
    seen.add(key);
    out.push({ ...m, direction });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Personnes du meme dossier : les autres participants des vrais echanges avec
 * la personne (expediteur, destinataires, copies), hors moi, hors elle, hors
 * automates ; les plus presentes d'abord.
 */
export function relatedParticipants(
  mails: MemoryMail[],
  person: Set<string>,
  mine: Set<string>,
  limit = 4
): { address: string; name: string; count: number }[] {
  const counts = new Map<string, { address: string; name: string; count: number }>();
  for (const m of mails) {
    for (const a of [m.from, ...m.to, ...m.cc]) {
      const c = canonAddr(a?.address);
      if (!c || person.has(c) || mine.has(c) || isAutomatedAddress(c)) continue;
      const cur = counts.get(c) || { address: c, name: "", count: 0 };
      cur.count++;
      const n = (a?.name || "").trim();
      if (n && !n.includes("@") && n.length > cur.name.length) cur.name = n;
      counts.set(c, cur);
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || a.address.localeCompare(b.address))
    .slice(0, limit);
}

// --- Sortie de l'IA ----------------------------------------------------------

function asText(v: unknown, max = 300): string {
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim().slice(0, max);
  if (Array.isArray(v)) return asText(v.filter((x) => typeof x === "string").join(" ; "), max);
  return "";
}

function asList(v: unknown, max: number): string[] {
  const list = Array.isArray(v) ? v.map((x) => asText(x, 300)) : [asText(v, 300)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of list) {
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function asRelated(v: unknown): RelatedPerson[] {
  if (!Array.isArray(v)) return [];
  const out: RelatedPerson[] = [];
  for (const r of v) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const name = asText(o.name, 120);
    const address = canonAddr(asText(o.address ?? o.email, 200));
    const role = asText(o.role, 200);
    if (!name && !address) continue;
    out.push({ name, address: address.includes("@") ? address : "", role });
    if (out.length >= MEMORY_MAX_RELATED) break;
  }
  return out;
}

/** Le JSON du modele n'est pas garanti : chaque champ est ramene a sa forme. */
export function normalizeAiMemory(raw: unknown): AiMemory {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    name: asText(r.name, 120),
    role: asText(r.role),
    organization: asText(r.organization ?? r.organisation, 200),
    relation: asText(r.relation ?? r.relation_with_me),
    facts: asList(r.facts, MEMORY_MAX_FACTS),
    related: asRelated(r.related),
    me_role: asText(r.me_role, 300),
  };
}

function relatedKey(p: RelatedPerson): string {
  return p.address || p.name.toLowerCase();
}

/**
 * Fiche mise a jour = ce que l'IA vient de deduire, SAUF :
 * - un champ corrige par l'utilisateur (locked, nom compris) garde sa valeur ;
 * - un fait retire par l'utilisateur (dismissed) ne revient pas ;
 * - la note libre de l'utilisateur n'est jamais touchee ;
 * - un champ que l'IA laisse vide garde l'ancienne valeur ;
 * - les personnes liees deja connues restent (mises a jour si l'IA en dit plus).
 */
export function mergeMemory(existing: ContactMemoryData, ai: AiMemory): ContactMemoryData {
  const locked = new Set(existing.locked || []);
  const dismissed = new Set((existing.dismissed || []).map((f) => f.toLowerCase()));
  const next: ContactMemoryData = {
    ...existing,
    locked: [...(existing.locked || [])],
    dismissed: [...(existing.dismissed || [])],
  };
  // Le nom signe dans les mails vaut mieux que le nom affiche ("X - Coordinateur ...").
  if (ai.name && !locked.has("name")) next.name = ai.name;
  for (const f of MEMORY_TEXT_FIELDS) {
    if (locked.has(f)) continue;
    if (ai[f]) next[f] = ai[f];
  }
  const facts = ai.facts.length ? ai.facts : existing.facts || [];
  next.facts = facts.filter((f) => !dismissed.has(f.toLowerCase())).slice(0, MEMORY_MAX_FACTS);

  const rel = new Map<string, RelatedPerson>();
  for (const p of existing.related || []) rel.set(relatedKey(p), p);
  for (const p of ai.related) {
    const k = relatedKey(p);
    const cur = rel.get(k);
    rel.set(k, cur ? { name: p.name || cur.name, address: p.address || cur.address, role: p.role || cur.role } : p);
  }
  const own = new Set(existing.addresses.map(canonAddr));
  next.related = Array.from(rel.values())
    .filter((p) => !p.address || !own.has(p.address))
    .slice(0, MEMORY_MAX_RELATED);
  return next;
}

/** Mails posterieurs a la derniere analyse (dates PocketBase comparables en texte). */
export function mailsAfter<T extends { date: string }>(mails: T[], lastDate: string): T[] {
  if (!lastDate) return mails;
  return mails.filter((m) => m.date > lastDate);
}
