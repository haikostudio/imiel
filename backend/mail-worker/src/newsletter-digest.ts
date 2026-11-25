/**
 * Resume du lundi : chaque lundi vers 8 h (Paris), un mail depose NON LU dans
 * la boite de reception du compte principal, avec les sujets des newsletters
 * qui ont le plus monte sur la semaine ecoulee (lundi -> dimanche), puis une
 * notification courte.
 *
 * - Calcule a partir des etiquettes (newsletter-tags.ts), SANS appel IA.
 * - Au plus une fois par semaine et par utilisateur, meme apres un redemarrage
 *   du worker : la semaine ISO envoyee est ecrite dans
 *   users.newsletter_digest_week AVANT le depot (au plus une fois).
 * - Une semaine sans aucune newsletter : rien n'est envoye.
 * - Le mail porte un Message-ID reconnu a la synchronisation (digest-id.ts) :
 *   jamais agrege en newsletter, ni categorise, ni notifie une seconde fois.
 * - Sans compte IMAP actif : seule la notification part.
 *
 * DEPUIS LE RECAPITULATIF DU MATIN (daily-digest.ts) : runWeeklyDigests ne part
 * PLUS automatiquement ; le lundi, les "sujets qui montent" sont une rubrique du
 * recapitulatif. Seule la route manuelle POST /newsletters/digest/send reste.
 */

import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { parisDay } from "./ai-budget";
import { buildImapConfig } from "./imap";
import {
  getUserDigestInfo,
  listAccountsForUser,
  listAllNewsletterPosts,
  setUserDigestWeek,
  type PBAccount,
} from "./pocketbase";
import { sendPushToUser } from "./push";
import { addDays, getNewsletterStats, isoWeekKey, mondayOf, type NewsletterStats } from "./newsletter-tags";
import { digestMessageId } from "./digest-id";

const DIGEST_HOUR = 8;
const TIMEZONE = "Europe/Paris";

function parisHour(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", hourCycle: "h23" }).format(d)
  );
}

/** Semaine a resumer si c'est le moment (lundi/mardi apres 8 h), sinon null. */
export function digestWindow(now: Date): { week: string; from: string; to: string } | null {
  const today = parisDay(now);
  const monday = mondayOf(today);
  const isMonday = today === monday;
  const isTuesday = today === addDays(monday, 1);
  // Mardi : rattrapage d'un lundi ou le worker etait arrete. Plus tard, on
  // n'envoie plus un bilan devenu perime.
  if (!(isTuesday || (isMonday && parisHour(now) >= DIGEST_HOUR))) return null;
  const from = addDays(monday, -7);
  const to = addDays(monday, -1);
  const [y, m, d] = from.split("-").map(Number);
  return { week: isoWeekKey(new Date(Date.UTC(y, m - 1, d, 12))), from, to };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function frDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || "https://imiel.example.com").replace(/\/+$/, "");
}

/** Contenu du resume (sujet, HTML, texte) a partir des statistiques. */
export function buildDigestContent(stats: NewsletterStats): { subject: string; html: string; text: string } {
  const period = `du ${frDay(stats.from)} au ${frDay(stats.to)}`;
  const statsUrl = `${appUrl()}/#/newsletters/stats`;
  const rising = stats.rising.slice(0, 5);
  const top = stats.tags.slice(0, 8);
  const subject = rising.length
    ? `Vos newsletters de la semaine : ${rising.slice(0, 3).map((t) => t.tag).join(", ")} en hausse`
    : `Vos newsletters de la semaine (${stats.total})`;
  const totalLine = `${stats.total} newsletter${stats.total > 1 ? "s" : ""} recue${stats.total > 1 ? "s" : ""} ${period}${
    stats.prevTotal ? ` (${stats.prevTotal} la semaine precedente)` : ""
  }.`;

  const row = (label: string, value: string, accent = false) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #eef0f3;font-size:14px;color:#1f2937;word-break:break-word;overflow-wrap:anywhere;">${esc(label)}</td>` +
    `<td align="right" style="padding:8px 0 8px 12px;border-bottom:1px solid #eef0f3;font-size:14px;font-weight:bold;color:${accent ? "#047857" : "#1f2937"};white-space:nowrap;">${esc(value)}</td></tr>`;

  const block = (title: string, inner: string) =>
    `<tr><td style="padding:0 24px 20px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:12px;"><tr><td style="padding:16px 18px;">` +
    `<p style="margin:0 0 8px 0;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;font-weight:bold;">${esc(title)}</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${inner}</table></td></tr></table></td></tr>`;

  const risingRows = rising.length
    ? rising.map((t) => row(t.tag, `+${t.delta} (${t.count})`, true)).join("")
    : `<tr><td style="padding:6px 0;font-size:14px;color:#6b7280;">Aucun sujet en hausse cette semaine.</td></tr>`;
  const topRows = top.map((t) => row(t.tag, String(t.count))).join("");

  const html =
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:16px;">` +
    `<tr><td style="padding:24px 24px 8px 24px;"><p style="margin:0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#7c3aed;font-weight:bold;">Resume de la semaine</p>` +
    `<h1 style="margin:6px 0 4px 0;font-size:22px;line-height:28px;color:#111827;">Ce qui monte dans vos newsletters</h1>` +
    `<p style="margin:0 0 16px 0;font-size:14px;line-height:20px;color:#4b5563;">${esc(totalLine)}</p></td></tr>` +
    block("Sujets en plus forte hausse", risingRows) +
    (topRows ? block("Sujets les plus presents", topRows) : "") +
    `<tr><td style="padding:0 24px 8px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#7c3aed" style="border-radius:8px;">` +
    `<a href="${esc(statsUrl)}" style="display:block;padding:12px 20px;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">Voir les statistiques</a></td></tr></table>` +
    `<p style="margin:8px 0 0 0;font-size:12px;color:#6b7280;">Le bouton ne s'ouvre pas ? <a href="${esc(statsUrl)}" style="color:#6b7280;word-break:break-all;">${esc(statsUrl)}</a></p></td></tr>` +
    `<tr><td style="padding:16px 24px 24px 24px;font-size:12px;line-height:18px;color:#9ca3af;">Calcule a partir des etiquettes de vos newsletters, chaque lundi matin, par iMiel.</td></tr>` +
    `</table></td></tr></table></body></html>`;

  const text = [
    "RESUME DE LA SEMAINE - Ce qui monte dans vos newsletters",
    "",
    totalLine,
    "",
    "Sujets en plus forte hausse :",
    ...(rising.length ? rising.map((t) => `- ${t.tag} : +${t.delta} (${t.count})`) : ["- Aucun sujet en hausse cette semaine."]),
    ...(top.length ? ["", "Sujets les plus presents :", ...top.map((t) => `- ${t.tag} : ${t.count}`)] : []),
    "",
    `Voir les statistiques : ${statsUrl}`,
  ].join("\n");

  return { subject, html, text };
}

/** Compte qui recoit le resume : compte par defaut, sinon premier IMAP actif. */
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
    // Sans drapeau \Seen : le resume arrive NON LU.
    await client.append(inbox?.path || "INBOX", raw, [], new Date());
  } finally {
    await client.logout().catch(() => {});
  }
}

async function buildRaw(account: PBAccount, content: ReturnType<typeof buildDigestContent>, messageId: string): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, newline: "unix", buffer: true });
  const info = (await transport.sendMail({
    from: { name: "iMiel", address: account.email },
    to: account.email,
    subject: content.subject,
    text: content.text,
    html: content.html,
    messageId,
    headers: { "X-iMiel-Digest": "weekly" },
  })) as unknown as { message: Buffer };
  return info.message;
}

export interface DigestResult {
  userId: string;
  week: string;
  status: "sent" | "push-only" | "already-sent" | "empty" | "error";
  error?: string;
}

/** Envoie (au plus une fois) le resume de la semaine `win` a un utilisateur. */
export async function sendWeeklyDigest(
  userId: string,
  win: { week: string; from: string; to: string }
): Promise<DigestResult> {
  const info = await getUserDigestInfo(userId);
  if (info.newsletter_digest_week === win.week) return { userId, week: win.week, status: "already-sent" };
  const stats = await getNewsletterStats(userId, win.from, win.to);
  if (stats.total === 0) return { userId, week: win.week, status: "empty" };

  // Marque AVANT le depot : jamais deux resumes pour la meme semaine.
  await setUserDigestWeek(userId, win.week);
  const content = buildDigestContent(stats);
  let status: DigestResult["status"] = "push-only";
  let error: string | undefined;
  try {
    const account = pickAccount(await listAccountsForUser(userId), info.default_account);
    if (account) {
      await appendToInbox(account, await buildRaw(account, content, digestMessageId(win.week, userId)));
      status = "sent";
    }
  } catch (err) {
    error = (err as Error).message;
    console.warn(`[digest] depot KO user=${userId}:`, error);
  }
  const lead = stats.rising.slice(0, 3).map((t) => t.tag).join(", ");
  await sendPushToUser(userId, {
    title: "\u{1F4CA} Votre resume de la semaine",
    body: lead
      ? `${stats.total} newsletters, en hausse : ${lead}`
      : `${stats.total} newsletter${stats.total > 1 ? "s" : ""} cette semaine`,
    tag: `newsletter-digest-${win.week}`,
    url: status === "sent" ? "/#/mail/inbox" : "/#/newsletters/stats",
    data: { type: "newsletter" },
  }).catch((err) => console.warn("[digest] push KO:", (err as Error).message));
  console.log(`[digest] ${status} user=${userId} week=${win.week} total=${stats.total}`);
  return { userId, week: win.week, status, error };
}

/** Passage periodique : envoie le resume a qui l'attend (lundi/mardi). */
export async function runWeeklyDigests(now = new Date()): Promise<DigestResult[]> {
  const win = digestWindow(now);
  if (!win) return [];
  // Utilisateurs ayant au moins une newsletter dans la semaine resumee.
  const lo = new Date(Date.parse(`${addDays(win.from, -1)}T00:00:00Z`)).toISOString().replace("T", " ");
  const hi = new Date(Date.parse(`${addDays(win.to, 2)}T00:00:00Z`)).toISOString().replace("T", " ");
  const posts = await listAllNewsletterPosts(`message_date >= "${lo}" && message_date < "${hi}"`, "user", 40);
  const users = Array.from(new Set(posts.map((p) => p.user).filter(Boolean)));
  const out: DigestResult[] = [];
  for (const userId of users) {
    try {
      out.push(await sendWeeklyDigest(userId, win));
    } catch (err) {
      out.push({ userId, week: win.week, status: "error", error: (err as Error).message });
    }
  }
  return out;
}

/** Fenetre de la DERNIERE semaine complete, quel que soit le jour (essai manuel). */
export function lastWeekWindow(now = new Date()): { week: string; from: string; to: string } {
  const monday = mondayOf(parisDay(now));
  const from = addDays(monday, -7);
  const [y, m, d] = from.split("-").map(Number);
  return { week: isoWeekKey(new Date(Date.UTC(y, m - 1, d, 12))), from, to: addDays(monday, -1) };
}
