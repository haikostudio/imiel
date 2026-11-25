// Reponse redigee par l'agent (bouton du champ de reponse) : regles PURES
// partagees entre la route serveur /api/ai/reply-agent et l'ecran.
// - qui est l'auteur (adresse + autres adresses de sa fiche contact),
// - quels sont les 20 derniers echanges avec lui, dans les deux sens,
// - lecture du flux d'avancement (SSE) cote ecran.

export interface AddressLike {
  name?: string;
  address?: string;
}

export interface ExchangeCandidate {
  id: string;
  message_id?: string;
  subject?: string;
  date?: string;
  from_address?: AddressLike | null;
  to_addresses?: AddressLike[] | null;
  cc_addresses?: AddressLike[] | null;
  is_draft?: boolean;
  text_body?: string;
}

export interface Exchange {
  id: string;
  direction: "in" | "out";
  subject: string;
  date: string;
  text: string;
}

export const REPLY_AGENT_EXCHANGES = 20;
/** En dessous de ce nombre de mes envois a l'auteur, on complete par mes derniers envois. */
export const REPLY_AGENT_MIN_OWN = 5;

export function normAddr(a: string | undefined | null): string {
  return (a || "").trim().toLowerCase();
}

export function normName(n: string | undefined | null): string {
  return (n || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Adresses qui designent l'auteur : son adresse d'envoi, plus celles des
 * fiches contact portant le MEME nom (une fiche par adresse dans `contacts`,
 * une personne qui ecrit depuis deux adresses a donc deux fiches au meme nom).
 * Un nom d'une seule lettre ou egal a une adresse n'est pas un signal fiable.
 * Les adresses de l'utilisateur ne sont jamais reprises.
 */
export function authorAddresses(
  from: AddressLike,
  contacts: { name?: string; email?: string }[],
  myAddrs: Iterable<string>
): string[] {
  const mine = new Set(Array.from(myAddrs, normAddr));
  const out = new Set<string>();
  const main = normAddr(from.address);
  if (main) out.add(main);
  const name = normName(from.name);
  const reliableName = name.length >= 3 && !name.includes("@") && name.includes(" ");
  for (const c of contacts) {
    const email = normAddr(c.email);
    if (!email) continue;
    if (email === main || (reliableName && normName(c.name) === name)) out.add(email);
  }
  for (const m of mine) out.delete(m);
  return Array.from(out);
}

/** Retire l'historique cite d'un corps texte (lignes ">" et "Le ... a ecrit :"). */
export function stripQuoted(text: string): string {
  const lines = (text || "").replace(/\r/g, "").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    if (/^>/.test(l)) continue;
    if (
      /^(le|on|am|il)\s.+(a ecrit|a écrit|wrote|schrieb|ha scritto)\s*:?\s*$/i.test(l) ||
      /^-{2,}\s*(original message|message d'origine|urspr[uü]ngliche nachricht)/i.test(l) ||
      /^(de|from|von)\s*:\s.+@/i.test(l)
    ) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function recipients(m: ExchangeCandidate): string[] {
  return [...(m.to_addresses || []), ...(m.cc_addresses || [])].map((a) => normAddr(a?.address));
}

/**
 * Les derniers echanges avec l'auteur, dans les deux sens : ses mails a lui
 * ("in") et les miens qui lui sont adresses ("out"). Doublons (deux comptes
 * relies recoivent le meme mail) ecartes par Message-ID ; brouillons exclus ;
 * du plus recent au plus ancien, borne a `limit`.
 */
export function selectExchanges(
  messages: ExchangeCandidate[],
  author: Iterable<string>,
  myAddrs: Iterable<string>,
  limit = REPLY_AGENT_EXCHANGES
): Exchange[] {
  const authorSet = new Set(Array.from(author, normAddr));
  const mine = new Set(Array.from(myAddrs, normAddr));
  const seen = new Set<string>();
  const out: (Exchange & { t: number })[] = [];
  for (const m of messages) {
    if (!m || m.is_draft) continue;
    const key = (m.message_id || "").trim() || m.id;
    if (seen.has(key)) continue;
    const from = normAddr(m.from_address?.address);
    let direction: "in" | "out" | null = null;
    if (authorSet.has(from)) direction = "in";
    else if (mine.has(from) && recipients(m).some((r) => authorSet.has(r))) direction = "out";
    if (!direction) continue;
    seen.add(key);
    const t = new Date((m.date || "").replace(" ", "T")).getTime();
    out.push({
      id: m.id,
      direction,
      subject: m.subject || "",
      date: m.date || "",
      text: stripQuoted(m.text_body || ""),
      t: Number.isNaN(t) ? 0 : t,
    });
  }
  out.sort((a, b) => b.t - a.t);
  return out.slice(0, limit).map(({ t: _t, ...e }) => e);
}

// --- Conversation : qui a ecrit quoi, a qui repondre -------------------------

export interface ThreadMessage extends ExchangeCandidate {
  is_sent?: boolean;
}

/** Meme regle que le fil (ThreadView) : envoye depuis l'app OU depuis une de mes adresses. */
export function isMine(m: ThreadMessage, myAddrs: Iterable<string>): boolean {
  if (m.is_sent) return true;
  const from = normAddr(m.from_address?.address);
  if (!from) return false;
  for (const a of myAddrs) if (normAddr(a) === from) return true;
  return false;
}

function msgTime(m: { date?: string }): number {
  const t = new Date((m.date || "").replace(" ", "T")).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Messages d'un fil sans brouillons ni doublons (meme Message-ID recu sur deux
 * comptes relies), du plus ancien au plus recent.
 */
export function orderThread<T extends ThreadMessage>(messages: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const m of messages) {
    if (!m || m.is_draft) continue;
    const key = (m.message_id || "").trim() || m.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out.sort((a, b) => msgTime(a) - msgTime(b));
}

export type ReplyMode = "reply" | "followup";

export interface ReplyTarget<T extends ThreadMessage = ThreadMessage> {
  /** reply = l'autre a ecrit en dernier ; followup = c'est moi (relance). */
  mode: ReplyMode;
  last: T | null;
  lastIncoming: T | null;
  lastMine: T | null;
  /** La personne a qui j'ecris : auteur du dernier message recu, sinon destinataire de mon dernier envoi. */
  interlocutor: AddressLike | null;
}

export function pickReplyTarget<T extends ThreadMessage>(messages: T[], myAddrs: Iterable<string>): ReplyTarget<T> {
  const mine = new Set(Array.from(myAddrs, normAddr));
  const ordered = orderThread(messages);
  let lastIncoming: T | null = null;
  let lastMine: T | null = null;
  for (const m of ordered) {
    if (isMine(m, mine)) lastMine = m;
    else lastIncoming = m;
  }
  const last = ordered[ordered.length - 1] ?? null;
  const mode: ReplyMode = last && isMine(last, mine) ? "followup" : "reply";
  let interlocutor: AddressLike | null = null;
  if (lastIncoming?.from_address?.address) interlocutor = lastIncoming.from_address;
  else if (lastMine) {
    interlocutor =
      [...(lastMine.to_addresses || []), ...(lastMine.cc_addresses || [])].find(
        (a) => a?.address && !mine.has(normAddr(a.address))
      ) || null;
  }
  return { mode, last, lastIncoming, lastMine, interlocutor };
}

/**
 * Repondre a MON propre message : la reponse va aux personnes a qui je l'avais
 * adresse (To), "Repondre a tous" ajoute la copie (Cc) ; je n'en fais jamais
 * partie. Envoi a moi seul : repli sur mon adresse (rien d'autre a viser).
 */
export function ownMessageRecipients(
  m: ThreadMessage,
  myAddrs: Iterable<string>
): { to: string[]; cc: string[] } {
  const mine = new Set(Array.from(myAddrs, normAddr));
  const seen = new Set<string>();
  const pick = (list?: AddressLike[] | null) => {
    const out: string[] = [];
    for (const a of list || []) {
      const email = (a?.address || "").trim();
      const key = normAddr(email);
      if (!key || mine.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(email);
    }
    return out;
  };
  const to = pick(m.to_addresses);
  const cc = pick(m.cc_addresses);
  if (to.length === 0 && cc.length === 0 && m.from_address?.address) return { to: [m.from_address.address], cc: [] };
  return to.length ? { to, cc } : { to: cc, cc: [] };
}

/**
 * "Repondre a tous" a un message RECU : on reprend sa configuration. L'auteur
 * passe en A avec les autres destinataires du A, les copies restent en Cc ;
 * toutes mes adresses (tous comptes) sont retirees, sans doublon (casse
 * ignoree ; une adresse presente en A et en Cc reste en A). Message que j'ai
 * envoye moi-meme : ownMessageRecipients (ses destinataires d'origine).
 */
export function replyAllRecipients(
  m: ThreadMessage,
  myAddrs: Iterable<string>
): { to: string[]; cc: string[] } {
  const mineList = Array.from(myAddrs, normAddr);
  if (isMine(m, mineList)) return ownMessageRecipients(m, mineList);
  const mine = new Set(mineList);
  const seen = new Set<string>();
  const pick = (list: (AddressLike | null | undefined)[]) => {
    const out: string[] = [];
    for (const a of list) {
      const email = (a?.address || "").trim();
      const key = normAddr(email);
      if (!key || mine.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(email);
    }
    return out;
  };
  const to = pick([m.from_address, ...(m.to_addresses || [])]);
  const cc = pick(m.cc_addresses || []);
  return { to, cc };
}

/** "Repondre a tous" vise-t-il plus d'une personne (sinon il equivaut a "Repondre") ? */
export function hasReplyAllExtra(m: ThreadMessage, myAddrs: Iterable<string>): boolean {
  const r = replyAllRecipients(m, myAddrs);
  return r.to.length + r.cc.length > 1;
}

/**
 * Le message auquel le bouton "Repondre" du bas d'une conversation repond : le
 * dernier message RECU (pas le mien, pas un brouillon). Fil sans message recu :
 * le dernier message (relance).
 */
export function lastReceivedMessage<T extends ThreadMessage>(messages: T[], myAddrs: Iterable<string>): T | null {
  const mine = Array.from(myAddrs, normAddr);
  const ordered = orderThread(messages);
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (!isMine(ordered[i], mine)) return ordered[i];
  }
  return ordered[ordered.length - 1] ?? null;
}

/**
 * Nom affiche de chaque adresse d'un ou plusieurs messages (cle = adresse en
 * minuscules) : sert aux etiquettes des destinataires pre-remplis, qui montrent
 * "Olivier Girard" plutot que l'adresse brute. Le champ envoye garde, lui,
 * les seules adresses. Un nom vide ou egal a l'adresse n'est pas retenu.
 */
export function addressNames(
  lists: (AddressLike | null | undefined)[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of lists) {
    const key = normAddr(a?.address);
    const name = (a?.name || "").replace(/^["']+|["']+$/g, "").trim();
    if (!key || !name || normAddr(name) === key || out[key]) continue;
    out[key] = name;
  }
  return out;
}

/** Toutes les adresses nommees d'un message (expediteur, A, Cc, Cci). */
export function messageAddressNames(m: {
  from_address?: AddressLike | null;
  to_addresses?: AddressLike[] | null;
  cc_addresses?: AddressLike[] | null;
  bcc_addresses?: AddressLike[] | null;
}): Record<string, string> {
  return addressNames([
    m.from_address,
    ...(m.to_addresses || []),
    ...(m.cc_addresses || []),
    ...(m.bcc_addresses || []),
  ]);
}

export function addressLabel(a: AddressLike | null | undefined): string {
  return (a?.name || "").trim() || normAddr(a?.address);
}

export const THREAD_CONTEXT_MAX = 12_000;
const THREAD_MESSAGE_MAX = 1_500;

/**
 * La conversation telle que l'IA doit la lire : du plus ancien au plus recent,
 * chaque message etiquete "MOI" ou au nom de son auteur, historique cite
 * retire. Les messages les plus recents sont gardes en priorite sous `maxChars`.
 */
export function formatThread(
  messages: ThreadMessage[],
  myAddrs: Iterable<string>,
  maxChars = THREAD_CONTEXT_MAX
): string {
  const mine = new Set(Array.from(myAddrs, normAddr));
  const ordered = orderThread(messages);
  const blocks: string[] = [];
  let used = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const m = ordered[i];
    const own = isMine(m, mine);
    const others = [...(m.to_addresses || [])].filter((a) => a?.address && !mine.has(normAddr(a.address)));
    const who = own
      ? `MOI -> ${others.map(addressLabel).filter(Boolean).join(", ") || "?"}`
      : `${addressLabel(m.from_address) || "?"} -> MOI`;
    const text = stripQuoted(m.text_body || "").slice(0, THREAD_MESSAGE_MAX) || "(vide)";
    const block = `[${(m.date || "").slice(0, 16)}] ${who}\n${text}`;
    if (used + block.length > maxChars && blocks.length > 0) break;
    blocks.push(block);
    used += block.length + 7;
  }
  return blocks.reverse().join("\n\n---\n\n");
}

// --- Flux d'avancement (SSE) ------------------------------------------------

export type ReplyAgentStep = "collect" | "memory" | "style" | "understand" | "write" | "translate";

export type ReplyAgentEvent =
  | { type: "step"; step: ReplyAgentStep; pct: number }
  | { type: "done"; html: string; language: string; translationFr?: string; exchanges?: number }
  | { type: "error"; message: string };

/**
 * Decoupe un tampon SSE en evenements complets ; renvoie le reste (evenement
 * pas encore termine) a reinjecter avec le prochain morceau recu.
 */
export function parseSseBuffer(buffer: string): { events: ReplyAgentEvent[]; rest: string } {
  const events: ReplyAgentEvent[] = [];
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const data = part
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const ev = JSON.parse(data) as ReplyAgentEvent;
      if (ev && typeof ev === "object" && "type" in ev) events.push(ev);
    } catch {
      // morceau illisible : ignore (jamais bloquant)
    }
  }
  return { events, rest };
}
