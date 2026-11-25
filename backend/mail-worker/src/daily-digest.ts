/**
 * Recapitulatif du matin : chaque jour vers 7 h (Paris), un mail depose NON LU
 * dans la boite de reception du compte principal de CHAQUE utilisateur, qui
 * resume la VEILLE (00:00 -> 24:00 Paris), puis une notification courte.
 *
 * Rubriques, dans l'ordre :
 *   1. mails importants encore non lus (client, relance, facturation...) :
 *      UN SEUL appel IA par utilisateur et par jour (aiFetch "daily-digest",
 *      entree plafonnee) ; si l'IA refuse ou echoue, repli SANS IA sur les
 *      expediteurs de confiance et les etiquettes Facture/Finance/Travail ;
 *   2. suivis : fiches qui ont bouge la veille + fiches ouvertes dont le
 *      dernier message vient d'un tiers sans reponse ("attend votre reponse") ;
 *   3. newsletters de la veille (syntheses deja faites, AUCUN appel IA) ;
 *   4. le lundi : "sujets qui montent" sur la semaine ecoulee (remplace le
 *      resume du lundi separe de newsletter-digest.ts, qui ne part plus seul).
 * Un jour sans rien : mail court "Rien d'important hier".
 *
 * - Interrupteur : users.daily_digest_disabled (inverse, false = actif pour
 *   tous par defaut, migration 074).
 * - Au plus une fois par jour : users.daily_digest_day ecrit AVANT le depot.
 * - Fenetre d'envoi : 7 h -> 12 h Paris (rattrapage apres un arret du worker ;
 *   au-dela, le bilan est perime et on n'envoie plus).
 * - Message-ID <imiel-digest-daily-...> : reconnu par imap.ts (jamais
 *   newsletter, ni categorise, ni notifie une seconde fois).
 */

import { backgroundModel } from "./ai-models";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { aiFetch, parisDay } from "./ai-budget";
import { buildImapConfig } from "./imap";
import {
  getUserDailyDigestInfo,
  listAccountsForUser,
  listActiveUserIds,
  listAllNewsletterPosts,
  listDigestMessages,
  listInboxFolderIds,
  listMessagesByThread,
  listTrackingEventsBetween,
  listTrackingItemsForDigest,
  listUserLabelNames,
  setUserDailyDigestDay,
  type PBAccount,
  type PBDigestMessage,
  type PBTrackingItem,
} from "./pocketbase";
import { sendPushToUser } from "./push";
import { getSenderTrust } from "./sender-trust";
import { addDays, getNewsletterStats, mondayOf } from "./newsletter-tags";
import { digestMessageId, isDigestMessageId } from "./digest-id";
import {
  buildDailyDigestContent,
  type DailyDigestData,
  type DigestMailItem,
  type DigestNewsletterItem,
  type DigestTrackingItem,
  type MailKind,
} from "./daily-digest-template";

export const DAILY_DIGEST_HOUR = 7;
const DAILY_DIGEST_LAST_HOUR = 12;
const TIMEZONE = "Europe/Paris";
const MAX_AI_CANDIDATES = 80;
const MAX_MAILS_SHOWN = 12;
const MAX_NEWSLETTERS_SHOWN = 6;
const MAX_TRACKING_SHOWN = 10;
/** Un fil sans reponse plus vieux que ca n'est plus un rappel utile. */
const AWAITING_MAX_DAYS = 14;
const AI_TIMEOUT_MS = 45_000;

function parisHour(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", hourCycle: "h23" }).format(d)
  );
}

/** Decalage Paris - UTC (ms) a l'instant `ms`. */
function parisOffsetMs(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** Instant UTC (ISO) de minuit a Paris le jour `day` (AAAA-MM-JJ). */
export function parisMidnightIso(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  let ms = guess - parisOffsetMs(guess);
  ms = guess - parisOffsetMs(ms);
  return new Date(ms).toISOString();
}

export interface DailyWindow {
  /** Jour resume (la veille, Paris). */
  day: string;
  /** Bornes UTC ISO [lo, hi[ du jour resume. */
  lo: string;
  hi: string;
  /** Lundi : semaine ecoulee pour les "sujets qui montent". */
  week: { from: string; to: string } | null;
}

/** Fenetre du jour a resumer pour un jour Paris donne (sans condition d'heure). */
export function windowForToday(today: string): DailyWindow {
  const day = addDays(today, -1);
  const isMonday = mondayOf(today) === today;
  return {
    day,
    lo: parisMidnightIso(day),
    hi: parisMidnightIso(today),
    week: isMonday ? { from: addDays(today, -7), to: day } : null,
  };
}

/** La veille a resumer si c'est le moment (7 h -> 12 h Paris), sinon null. */
export function dailyDigestWindow(now: Date): DailyWindow | null {
  const h = parisHour(now);
  if (h < DAILY_DIGEST_HOUR || h >= DAILY_DIGEST_LAST_HOUR) return null;
  return windowForToday(parisDay(now));
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || "https://imiel.example.com").replace(/\/+$/, "");
}

function threadUrl(threadId: string, messageId: string): string {
  return `${appUrl()}/#/mail/all?t=${encodeURIComponent(threadId || messageId)}&m=${encodeURIComponent(messageId)}`;
}

/** Texte brut court depuis une synthese (souvent du HTML). */
export function plainExcerpt(html: string, max = 220): string {
  const text = String(html || "")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

const addr = (s?: string) => (s || "").toLowerCase().trim();

// Adresses d'envoi automatique : jamais "attend votre reponse".
const AUTOMATED_RE =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|ne[-_.]?pas[-_.]?repondre|nepasrepondre|notifications?|notify|alerts?|mailer[-_.]?daemon|postmaster|bounces?|newsletters?|news|digest|marketing|mailer|automated|auto[-_.]?confirm|updates?|info|suivi|tracking|commande|orders?|shipping|delivery|livraison)([-_.+].*)?@/i;

export function isAutomatedAddress(address: string): boolean {
  return AUTOMATED_RE.test(addr(address));
}

// ---------------------------------------------------------------------------
// 1. Mails importants
// ---------------------------------------------------------------------------

interface Candidate {
  msg: PBDigestMessage;
  labels: string[];
  trusted: boolean;
}

const IMPORTANT_LABEL_RE = /factur|financ|travail|invoice|paiement|payment|client|devis|contrat|admin|banque|impot|impôt/i;
const KINDS: MailKind[] = ["client", "relance", "facturation", "important"];

function labelKind(labels: string[]): MailKind {
  if (labels.some((l) => /factur|financ|invoice|paiement|payment|banque/i.test(l))) return "facturation";
  if (labels.some((l) => /client|travail|devis|contrat/i.test(l))) return "client";
  return "important";
}

/** Repli SANS IA : niveau "important", puis expediteurs de confiance + etiquettes importantes. */
export function fallbackSelect(cands: Candidate[]): { c: Candidate; kind: MailKind; summary: string }[] {
  return cands
    .filter(
      (c) =>
        c.msg.importance === "important" ||
        (c.msg.importance !== "low" && (c.trusted || c.labels.some((l) => IMPORTANT_LABEL_RE.test(l))))
    )
    .map((c) => ({ c, kind: labelKind(c.labels), summary: "" }));
}

const AI_SYSTEM = [
  "Tu tries les mails RECUS hier par un professionnel independant, encore NON LUS.",
  "Garde UNIQUEMENT ceux qui demandent son attention : un client ou un prospect qui ecrit,",
  "une relance (quelqu'un qui attend une reponse, un rappel d'echeance, un impaye),",
  "la facturation (facture, devis, paiement, prelevement, remboursement), ou un autre mail",
  "personnel ou administratif vraiment important.",
  "ECARTE : newsletters, promotions, publicites, notifications automatiques sans action,",
  "confirmations banales, alertes de reseaux sociaux, mails de masse.",
  'Reponds en JSON strict : {"items":[{"i":<numero>,"kind":"client|relance|facturation|important","summary":"<une phrase en francais, 140 signes max, ce qui est demande ou annonce>"}]}',
  'Liste vide si rien n\'est important : {"items":[]}.',
].join(" ");

function aiPrompt(cands: Candidate[]): string {
  return cands
    .map((c, i) => {
      const from = `${c.msg.from_address?.name || ""} <${c.msg.from_address?.address || ""}>`.trim();
      const lbl = c.labels.length ? ` | etiquettes: ${c.labels.join(", ")}` : "";
      const trust = c.trusted ? " | correspondant connu" : "";
      const lvl = c.msg.importance === "important" ? " | classe IMPORTANT" : "";
      return `#${i + 1} De: ${from}${trust}${lvl}${lbl}\nSujet: ${c.msg.subject || "(sans sujet)"}\nExtrait: ${(c.msg.snippet || "").slice(0, 300)}`;
    })
    .join("\n\n");
}

/** Parse la reponse IA ; null si invalide. */
export function parseAiSelection(
  content: string,
  count: number
): { i: number; kind: MailKind; summary: string }[] | null {
  try {
    const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
    const data = JSON.parse(json) as { items?: { i?: unknown; kind?: unknown; summary?: unknown }[] };
    if (!Array.isArray(data.items)) return null;
    const seen = new Set<number>();
    const out: { i: number; kind: MailKind; summary: string }[] = [];
    for (const it of data.items) {
      const i = Number(it.i) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= count || seen.has(i)) continue;
      seen.add(i);
      const kind = KINDS.includes(it.kind as MailKind) ? (it.kind as MailKind) : "important";
      out.push({ i, kind, summary: String(it.summary || "").slice(0, 200).trim() });
    }
    return out;
  } catch {
    return null;
  }
}

async function aiSelect(cands: Candidate[]): Promise<{ i: number; kind: MailKind; summary: string }[] | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !cands.length) return null;
  try {
    const res = await aiFetch("daily-digest", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
        "X-Title": "iMiel",
      },
      body: JSON.stringify({
        model: backgroundModel("OPENROUTER_MODEL_DIGEST"),
        messages: [
          { role: "system", content: AI_SYSTEM },
          { role: "user", content: aiPrompt(cands) },
        ],
        temperature: 0,
        max_tokens: 2500,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[daily-digest] IA HTTP ${res.status} : repli sans IA`);
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return parseAiSelection(data.choices?.[0]?.message?.content || "", cands.length);
  } catch (err) {
    console.warn("[daily-digest] IA KO, repli sans IA:", (err as Error).message);
    return null;
  }
}

async function collectMails(
  userId: string,
  accounts: PBAccount[],
  win: DailyWindow,
  ownAddresses: Set<string>,
  newsletterMessageIds: Set<string>,
  opts: { useAi: boolean }
): Promise<{ items: DigestMailItem[]; more: number; usedAi: boolean }> {
  const active = accounts.filter((a) => a.is_active !== false);
  const byAccount = new Map(active.map((a) => [a.id, a]));
  const folderIds = (await Promise.all(active.map((a) => listInboxFolderIds(a.id)))).flat();
  const msgs = await listDigestMessages(folderIds, win.lo, win.hi, 400);
  const labelNames = await listUserLabelNames(userId).catch(() => new Map<string, string>());

  const seen = new Set<string>();
  const unread = msgs.filter((m) => {
    if (m.is_read || isDigestMessageId(m.message_id) || newsletterMessageIds.has(m.id)) return false;
    if (ownAddresses.has(addr(m.from_address?.address))) return false;
    // Deux comptes lies recoivent le meme mail : une seule ligne.
    const key = m.message_id || m.id;
    if (seen.has(key)) return false;
    seen.add(key);
    // Tri en trois niveaux : un mail "peu utile" n'entre jamais dans le recap.
    return m.importance !== "low";
  });
  // Les mails classes "important" passent en tete (survivent au plafond).
  const rank = (m: { importance?: string }) => (m.importance === "important" ? 0 : 1);
  const capped = unread
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map((x) => x.m)
    .slice(0, MAX_AI_CANDIDATES);

  const cands: Candidate[] = [];
  for (const msg of capped) {
    const labels = (msg.labels || []).map((id) => labelNames.get(id) || "").filter(Boolean);
    let trusted = false;
    const acc = byAccount.get(msg.account);
    if (acc) {
      try {
        trusted = (await getSenderTrust(acc, msg.from_address?.address)).level === "trusted";
      } catch {
        /* confiance inconnue : non retenu par le repli */
      }
    }
    cands.push({ msg, labels, trusted });
  }

  let picked: { c: Candidate; kind: MailKind; summary: string }[];
  let usedAi = false;
  const ai = opts.useAi ? await aiSelect(cands) : null;
  if (ai) {
    usedAi = true;
    picked = ai.map((s) => ({ c: cands[s.i], kind: s.kind, summary: s.summary }));
  } else {
    picked = fallbackSelect(cands);
  }
  picked.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));

  const items = picked.slice(0, MAX_MAILS_SHOWN).map(({ c, kind, summary }) => ({
    senderName: c.msg.from_address?.name || "",
    senderAddress: c.msg.from_address?.address || "",
    subject: c.msg.subject || "(sans sujet)",
    summary: summary || plainExcerpt(c.msg.snippet || "", 160),
    kind,
    url: threadUrl(c.msg.thread_id, c.msg.id),
  }));
  return { items, more: Math.max(0, picked.length - MAX_MAILS_SHOWN), usedAi };
}

// ---------------------------------------------------------------------------
// 2. Suivis
// ---------------------------------------------------------------------------

function suiviUrl(itemId: string): string {
  return `${appUrl()}/#/suivi?f=${encodeURIComponent(itemId)}`;
}

export function isOpenItem(item: Pick<PBTrackingItem, "status">): boolean {
  return item.status === "active" || item.status === "waiting";
}

export interface ThreadTail {
  is_sent: boolean;
  from: string;
  date: string;
}

/**
 * Le fil attend-il une reponse de l'utilisateur ? Dernier message RECU (pas
 * envoye, pas d'une de ses adresses), d'un expediteur non automatique, dans
 * les AWAITING_MAX_DAYS derniers jours (par rapport a `hi`).
 */
export function isAwaitingReply(tail: ThreadTail | null, ownAddresses: Set<string>, hi: string): boolean {
  if (!tail || tail.is_sent) return false;
  const from = addr(tail.from);
  if (!from || ownAddresses.has(from) || isAutomatedAddress(from)) return false;
  const age = Date.parse(hi) - Date.parse(tail.date.replace(" ", "T"));
  return Number.isFinite(age) && age >= 0 && age <= AWAITING_MAX_DAYS * 86_400_000;
}

async function threadTail(item: PBTrackingItem): Promise<ThreadTail | null> {
  const threads = Array.from(new Set([item.thread_id, ...(item.thread_ids || [])].filter(Boolean))).slice(0, 6);
  let last: ThreadTail | null = null;
  for (const t of threads) {
    const msgs = await listMessagesByThread(t, 100);
    const m = msgs[msgs.length - 1];
    if (!m) continue;
    const cand = { is_sent: !!m.is_sent, from: m.from_address?.address || "", date: m.date };
    if (!last || cand.date > last.date) last = cand;
  }
  return last;
}

async function collectTracking(
  userId: string,
  win: DailyWindow,
  ownAddresses: Set<string>
): Promise<DigestTrackingItem[]> {
  const [items, events] = await Promise.all([
    listTrackingItemsForDigest(userId),
    listTrackingEventsBetween(userId, win.lo, win.hi),
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: DigestTrackingItem[] = [];
  const done = new Set<string>();

  // Fiches qui ont bouge la veille (evenement le plus recent d'abord).
  for (const ev of events) {
    const item = byId.get(ev.item);
    if (!item || done.has(item.id)) continue;
    done.add(item.id);
    out.push({
      title: item.title || item.merchant || "Suivi",
      status: item.status_label || "",
      reason: "moved",
      detail: plainExcerpt(ev.detail || ev.label || "", 160),
      url: suiviUrl(item.id),
    });
  }

  // Fiches ouvertes dont le dernier message attend une reponse.
  const recentFloor = Date.parse(win.hi) - AWAITING_MAX_DAYS * 86_400_000;
  const open = items
    .filter((i) => isOpenItem(i) && !done.has(i.id))
    .filter((i) => !i.last_message_date || Date.parse(i.last_message_date.replace(" ", "T")) >= recentFloor)
    .slice(0, 30);
  for (const item of open) {
    try {
      const tail = await threadTail(item);
      if (!isAwaitingReply(tail, ownAddresses, win.hi)) continue;
      const since = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", timeZone: TIMEZONE }).format(
        new Date(tail!.date.replace(" ", "T"))
      );
      out.push({
        title: item.title || item.merchant || "Suivi",
        status: item.status_label || "",
        reason: "awaiting",
        detail: `Dernier message de ${tail!.from}, le ${since}.`,
        url: suiviUrl(item.id),
      });
    } catch {
      /* fiche illisible : ignoree */
    }
  }
  return out.slice(0, MAX_TRACKING_SHOWN);
}

// ---------------------------------------------------------------------------
// 3. Newsletters
// ---------------------------------------------------------------------------

async function collectNewsletters(
  userId: string,
  win: DailyWindow
): Promise<{ items: DigestNewsletterItem[]; total: number; messageIds: Set<string> }> {
  const lo = win.lo.replace("T", " ");
  const hi = win.hi.replace("T", " ");
  const posts = await listAllNewsletterPosts(
    `user="${userId}" && message_date >= "${lo}" && message_date < "${hi}"`,
    "id,message,title,original_subject,source_name,source_address,summary,status,matched_alerts,message_date,thread_id",
    4
  );
  const messageIds = new Set(posts.map((p) => p.message).filter(Boolean));
  const ready = posts.filter((p) => p.status === "done");
  ready.sort((a, b) => {
    const al = (b.matched_alerts?.length || 0) - (a.matched_alerts?.length || 0);
    return al || String(b.message_date).localeCompare(String(a.message_date));
  });
  const items = ready.slice(0, MAX_NEWSLETTERS_SHOWN).map((p) => ({
    title: p.title || p.original_subject || "Newsletter",
    source: p.source_name || p.source_address || "",
    summary: plainExcerpt(p.summary || "", 200),
    alert: p.matched_alerts?.[0]?.name || "",
    url: `${appUrl()}/#/newsletters`,
  }));
  return { items, total: posts.length, messageIds };
}

// ---------------------------------------------------------------------------
// Assemblage, depot, passage periodique
// ---------------------------------------------------------------------------

/** Contenu complet du recapitulatif d'un utilisateur pour la fenetre `win`. */
export async function buildUserDailyDigest(
  userId: string,
  win: DailyWindow,
  opts: { useAi?: boolean } = {}
): Promise<{ data: DailyDigestData; usedAi: boolean; accounts: PBAccount[] }> {
  const accounts = await listAccountsForUser(userId);
  const own = new Set(accounts.map((a) => addr(a.email)).filter(Boolean));
  const news = await collectNewsletters(userId, win).catch((err) => {
    console.warn("[daily-digest] newsletters KO:", (err as Error).message);
    return { items: [], total: 0, messageIds: new Set<string>() };
  });
  const mails = await collectMails(userId, accounts, win, own, news.messageIds, { useAi: opts.useAi !== false }).catch(
    (err) => {
      console.warn("[daily-digest] mails KO:", (err as Error).message);
      return { items: [], more: 0, usedAi: false };
    }
  );
  const tracking = await collectTracking(userId, win, own).catch((err) => {
    console.warn("[daily-digest] suivis KO:", (err as Error).message);
    return [] as DigestTrackingItem[];
  });
  let trends: DailyDigestData["trends"] = null;
  let trendsTotal = 0;
  if (win.week) {
    const stats = await getNewsletterStats(userId, win.week.from, win.week.to).catch(() => null);
    if (stats && stats.total > 0) {
      trends = stats.rising.slice(0, 5).map((t) => ({ tag: t.tag, delta: t.delta, count: t.count }));
      trendsTotal = stats.total;
    }
  }
  return {
    data: {
      day: win.day,
      appUrl: appUrl(),
      mails: mails.items,
      moreMails: mails.more,
      newsletters: news.items,
      newsletterTotal: news.total,
      tracking,
      trends,
      trendsTotal,
    },
    usedAi: mails.usedAi,
    accounts,
  };
}

/** Compte qui recoit le recapitulatif : compte par defaut, sinon premier IMAP actif. */
function pickAccount(accounts: PBAccount[], defaultId?: string): PBAccount | null {
  const imap = accounts.filter((a) => a.protocol === "imap" && a.is_active !== false);
  return imap.find((a) => a.id === defaultId) || imap[0] || null;
}

async function appendToInbox(account: PBAccount, raw: Buffer): Promise<void> {
  const client = new ImapFlow(await buildImapConfig(account));
  try {
    await client.connect();
    const boxes = await client.list();
    const inbox = boxes.find((m) => m.specialUse === "\\Inbox" || m.path.toUpperCase() === "INBOX");
    // Sans drapeau \Seen : le recapitulatif arrive NON LU.
    await client.append(inbox?.path || "INBOX", raw, [], new Date());
  } finally {
    await client.logout().catch(() => {});
  }
}

async function buildRaw(
  account: PBAccount,
  content: { subject: string; html: string; text: string },
  messageId: string
): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, newline: "unix", buffer: true });
  const info = (await transport.sendMail({
    from: { name: "iMiel", address: account.email },
    to: account.email,
    subject: content.subject,
    text: content.text,
    html: content.html,
    messageId,
    headers: { "X-iMiel-Digest": "daily" },
  })) as unknown as { message: Buffer };
  return info.message;
}

export interface DailyDigestResult {
  userId: string;
  day: string;
  status: "sent" | "push-only" | "already-sent" | "disabled" | "error";
  empty?: boolean;
  usedAi?: boolean;
  error?: string;
}

/**
 * Envoie (au plus une fois par jour) le recapitulatif de `win` a un
 * utilisateur. `force` (essai manuel) ignore l'interrupteur et la marque du jour.
 */
export async function sendDailyDigest(
  userId: string,
  win: DailyWindow,
  opts: { force?: boolean } = {}
): Promise<DailyDigestResult> {
  const info = await getUserDailyDigestInfo(userId);
  if (!opts.force) {
    if (info.disabled) return { userId, day: win.day, status: "disabled" };
    if (info.day === win.day) return { userId, day: win.day, status: "already-sent" };
  }
  // Marque AVANT de construire et deposer : jamais deux recapitulatifs le meme
  // jour, meme si le worker redemarre au milieu.
  await setUserDailyDigestDay(userId, win.day);

  const { data, usedAi, accounts } = await buildUserDailyDigest(userId, win);
  const content = buildDailyDigestContent(data);
  let status: DailyDigestResult["status"] = "push-only";
  let error: string | undefined;
  try {
    const account = pickAccount(accounts, info.default_account);
    if (account) {
      const id = digestMessageId(`daily-${win.day}${opts.force ? `-${Date.now()}` : ""}`, userId);
      await appendToInbox(account, await buildRaw(account, content, id));
      status = "sent";
    }
  } catch (err) {
    error = (err as Error).message;
    console.warn(`[daily-digest] depot KO user=${userId}:`, error);
  }
  await sendPushToUser(userId, {
    title: "☀️ Récapitulatif du matin",
    body: content.subject,
    tag: `daily-digest-${win.day}`,
    url: "/#/mail/inbox",
    data: { type: "digest" },
  }).catch((err) => console.warn("[daily-digest] push KO:", (err as Error).message));
  console.log(
    `[daily-digest] ${status} user=${userId} day=${win.day} mails=${data.mails.length + data.moreMails} suivis=${data.tracking.length} newsletters=${data.newsletters.length} ia=${usedAi}`
  );
  return { userId, day: win.day, status, empty: content.empty, usedAi, error };
}

let running = false;

/** Passage periodique : envoie le recapitulatif a qui l'attend (7 h -> 12 h). */
export async function runDailyDigests(now = new Date()): Promise<DailyDigestResult[]> {
  const win = dailyDigestWindow(now);
  if (!win || running) return [];
  running = true;
  const out: DailyDigestResult[] = [];
  try {
    const users = await listActiveUserIds();
    for (const userId of users) {
      try {
        out.push(await sendDailyDigest(userId, win));
      } catch (err) {
        out.push({ userId, day: win.day, status: "error", error: (err as Error).message });
      }
    }
  } finally {
    running = false;
  }
  return out;
}
