// Integration du "Cerveau" (memoire centrale : https://memoire.example.com).
//
// L'API du Cerveau est TEXTE uniquement :
//   - POST /v1/memories            { texte, source?, projet?, discussion_id? }
//   - GET  /v1/memories/search     ?q=&k=&contexte=
//   - GET  /health                 (sans auth)
//
// Ici on transforme le contenu mail (mails, PJ/images, notes de thread) en
// memoires texte et on les pousse (push) ; on expose aussi la recherche (recall)
// pour injecter du contexte dans les features IA. Tout est best-effort et non
// bloquant : une erreur Cerveau ne doit jamais casser la sync ou une reponse IA.

import {
  type PBAccount,
  type PBEmailAddress,
  type PBMessageForCerveau,
  getUserCerveauKey,
  getUserOpenRouterKey,
  getUserPauseFlags,
  getAttachmentsForMessage,
  getPbBaseUrl,
  getFileToken,
} from "./pocketbase";
import { hasAnySecondaryLabel } from "./labels";
import { getSenderTrust } from "./sender-trust";

import { aiFetch } from "./ai-budget";

function getCerveauBase(): string {
  return (process.env.CERVEAU_API_URL || "https://memoire.example.com").replace(
    /\/+$/,
    ""
  );
}

const REQUEST_TIMEOUT_MS = 15_000;
// Cap du texte envoye : on garde une marge raisonnable, le Cerveau resume.
const MAX_MEMORY_CHARS = 8_000;
// Description d'image desactivee par defaut (cout LLM vision) : activer via env.
const VISION_ENABLED = process.env.CERVEAU_VISION_ENABLED === "true";
const VISION_MODEL =
  process.env.CERVEAU_VISION_MODEL ||
  process.env.OPENROUTER_VISION_MODEL ||
  "google/gemini-2.5-flash";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// --- Client HTTP Cerveau ----------------------------------------------------

export interface PushMemoryInput {
  texte: string;
  source?: string;
  projet?: string;
  discussion_id?: string;
}

export interface PushMemoryResult {
  ok: boolean;
  id?: string;
  garde?: boolean;
  error?: string;
}

export async function pushMemory(
  apiKey: string,
  input: PushMemoryInput
): Promise<PushMemoryResult> {
  if (!apiKey) return { ok: false, error: "cle Cerveau manquante" };
  const texte = (input.texte || "").trim();
  if (!texte) return { ok: false, error: "texte vide" };

  try {
    const res = await fetch(`${getCerveauBase()}/v1/memories`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Cerveau-Client": "haikomail",
      },
      body: JSON.stringify({
        texte: texte.slice(0, MAX_MEMORY_CHARS),
        source: input.source || "haikomail",
        ...(input.projet ? { projet: input.projet } : {}),
        ...(input.discussion_id ? { discussion_id: input.discussion_id } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      garde?: boolean;
    };
    return { ok: true, id: data.id, garde: data.garde };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

export interface CerveauMemory {
  id?: string;
  texte?: string;
  niveau?: string;
  score?: number;
  source?: string;
  projet?: string;
}

export async function searchMemory(
  apiKey: string,
  query: string,
  k = 5,
  contexte?: string
): Promise<CerveauMemory[]> {
  if (!apiKey || !query.trim()) return [];
  const params = new URLSearchParams({
    q: query.trim(),
    k: String(Math.min(Math.max(k, 1), 50)),
  });
  if (contexte) params.set("contexte", contexte);
  try {
    const res = await fetch(
      `${getCerveauBase()}/v1/memories/search?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, "X-Cerveau-Client": "haikomail" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (!res.ok) return [];
    const data = (await res.json().catch(() => ({}))) as {
      resultats?: CerveauMemory[];
    };
    return Array.isArray(data.resultats) ? data.resultats : [];
  } catch {
    return [];
  }
}

export interface CheckResult {
  ok: boolean;
  error?: string;
}

/** Valide une cle Cerveau via une mini-recherche (ne stocke rien). */
export async function checkCerveauKey(apiKey: string): Promise<CheckResult> {
  if (!apiKey) return { ok: false, error: "cle manquante" };
  try {
    const res = await fetch(
      `${getCerveauBase()}/v1/memories/search?q=ping&k=1`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, "X-Cerveau-Client": "haikomail" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "cle invalide" };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

// --- Rendu mail -> texte ----------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function fmtAddr(a?: PBEmailAddress): string {
  if (!a || !a.address) return "";
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function fmtAddrs(list?: PBEmailAddress[]): string {
  if (!Array.isArray(list) || list.length === 0) return "";
  return list.map(fmtAddr).filter(Boolean).join(", ");
}

export interface CerveauMessageInput {
  id: string;
  subject?: string;
  from?: PBEmailAddress;
  to?: PBEmailAddress[];
  cc?: PBEmailAddress[];
  date?: string;
  textBody?: string;
  htmlBody?: string;
  snippet?: string;
  folderType?: string;
  isSent?: boolean;
  hasAttachments?: boolean;
  labelNames?: string[];
}

/**
 * Decrit une image jointe via un modele vision OpenRouter (best-effort).
 * Necessite VISION_ENABLED + une cle OpenRouter. Retourne null sinon / si echec.
 */
async function describeImage(
  attachmentId: string,
  fileName: string,
  contentType: string,
  size: number,
  openRouterKey: string
): Promise<string | null> {
  if (!VISION_ENABLED || !openRouterKey) return null;
  if (!contentType.startsWith("image/")) return null;
  if (size > MAX_IMAGE_BYTES) return null;
  try {
    const token = await getFileToken();
    const url = `${getPbBaseUrl()}/api/files/attachments/${attachmentId}/${encodeURIComponent(
      fileName
    )}?token=${token}`;
    const fileRes = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!fileRes.ok) return null;
    const buf = Buffer.from(await fileRes.arrayBuffer());
    const dataUri = `data:${contentType};base64,${buf.toString("base64")}`;

    const res = await aiFetch("cerveau-vision", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
        "X-Title": "iMiel",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Decris en une phrase concise le contenu de cette image jointe a un email (en francais).",
              },
              { type: "image_url", image_url: { url: dataUri } },
            ],
          },
        ],
        max_tokens: 120,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const desc = data.choices?.[0]?.message?.content?.trim();
    return desc || null;
  } catch {
    return null;
  }
}

/** Rend la liste des PJ d'un message en texte (+ description image best-effort). */
async function renderAttachments(
  messageId: string,
  openRouterKey: string
): Promise<string> {
  let atts;
  try {
    atts = await getAttachmentsForMessage(messageId);
  } catch {
    return "";
  }
  if (!atts.length) return "";
  const lines: string[] = [];
  for (const a of atts) {
    if (a.is_inline) continue;
    const kb = a.size ? `${Math.round(a.size / 1024)} Ko` : "";
    let line = `- ${a.filename || "(sans nom)"} (${a.content_type || "?"}${
      kb ? ", " + kb : ""
    })`;
    const desc = await describeImage(
      a.id,
      a.filename || "image",
      a.content_type || "",
      a.size || 0,
      openRouterKey
    );
    if (desc) line += ` -> ${desc}`;
    lines.push(line);
  }
  return lines.length ? `\nPieces jointes :\n${lines.join("\n")}` : "";
}

/** Construit le texte de memoire pour un mail. */
export async function renderMessageMemory(
  msg: CerveauMessageInput,
  userId: string
): Promise<string> {
  const body =
    (msg.textBody && msg.textBody.trim()) ||
    (msg.htmlBody ? stripHtml(msg.htmlBody) : "") ||
    msg.snippet ||
    "";

  const header: string[] = [];
  header.push(`Email ${msg.isSent ? "envoye" : "recu"} via iMiel`);
  const fromStr = fmtAddr(msg.from);
  if (fromStr) header.push(`De : ${fromStr}`);
  const toStr = fmtAddrs(msg.to);
  if (toStr) header.push(`A : ${toStr}`);
  const ccStr = fmtAddrs(msg.cc);
  if (ccStr) header.push(`Cc : ${ccStr}`);
  if (msg.date) header.push(`Date : ${msg.date}`);
  if (msg.folderType) header.push(`Dossier : ${msg.folderType}`);
  if (msg.labelNames && msg.labelNames.length) {
    header.push(`Categories : ${msg.labelNames.join(", ")}`);
  }
  header.push(`Sujet : ${msg.subject || "(sans sujet)"}`);

  let attachmentsBlock = "";
  if (msg.hasAttachments) {
    const orKey = VISION_ENABLED ? await getUserOpenRouterKey(userId) : "";
    attachmentsBlock = await renderAttachments(msg.id, orKey);
  }

  return `${header.join("\n")}\n\n${body}${attachmentsBlock}`.trim();
}

export function messageDiscussionId(messageId: string): string {
  return `haikomail:msg:${messageId}`;
}

export function threadBriefDiscussionId(threadId: string): string {
  return `haikomail:thread:${threadId}`;
}

/** Mappe un PBMessageForCerveau (backfill) vers l'input de rendu. */
export function toCerveauInput(m: PBMessageForCerveau): CerveauMessageInput {
  const labelNames = (m.expand?.labels || [])
    .map((l) => l.name)
    .filter(Boolean);
  return {
    id: m.id,
    subject: m.subject,
    from: m.from_address,
    to: m.to_addresses,
    cc: m.cc_addresses,
    date: m.date,
    textBody: m.text_body,
    htmlBody: m.html_body,
    snippet: m.snippet,
    isSent: m.is_sent,
    hasAttachments: m.has_attachments,
    labelNames,
  };
}

// --- Filtre "vrais echanges" -----------------------------------------------
//
// On ne pousse vers le Cerveau QUE la vraie correspondance humaine, pas le flux
// automatique (newsletters, promotions, notifications, no-reply, spam...). Sinon
// la memoire centrale se noie dans du bruit inutile.

// Dossiers consideres comme contenant de la vraie correspondance.
const REAL_FOLDER_TYPES = new Set(["inbox", "sent", "archive"]);

// Expediteurs manifestement automatiques (jamais de vrai echange a deux sens).
const AUTOMATED_SENDER_RE =
  /(?:^|[._+-])(?:no-?reply|do-?not-?reply|donotreply|noreply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|mailer|newsletter|no_reply)@/i;

export function isAutomatedSender(email?: string | null): boolean {
  if (!email) return false;
  return AUTOMATED_SENDER_RE.test(email.toLowerCase().trim());
}

/**
 * Decide si un mail merite d'etre agrege dans le Cerveau (vrai echange).
 * - dossier reel (inbox/sent/archive), pas spam/trash/drafts
 * - pas de label secondaire (newsletter/promo/notification/marketing/social)
 * - mail envoye par l'utilisateur => toujours un vrai echange
 * - mail recu => uniquement si l'utilisateur a DEJA ECRIT a cet expediteur
 *   (sentToCount >= 1) : c'est le seul signe fiable d'un echange a deux sens.
 *   On n'utilise PAS "trusted" tout court : son critere contactMessageCount/
 *   knownDomain laisse passer les newsletters (expediteurs dont on RECOIT
 *   beaucoup mais a qui on n'ecrit jamais).
 */
export async function shouldAggregateMail(
  account: PBAccount,
  opts: {
    isSent: boolean;
    folderType?: string;
    senderEmail?: string | null;
    isSecondary: boolean;
  }
): Promise<boolean> {
  if (opts.folderType && !REAL_FOLDER_TYPES.has(opts.folderType)) return false;
  if (opts.isSecondary) return false;
  if (opts.isSent) return true;
  if (isAutomatedSender(opts.senderEmail)) return false;
  const trust = await getSenderTrust(account, opts.senderEmail);
  return trust.sentToCount >= 1;
}

/**
 * Applique le filtre "vrai echange" puis enqueue le push si le mail passe.
 * No-op si la cle Cerveau n'est pas configuree ou si le push est en pause.
 */
export async function aggregateMailIfReal(
  account: PBAccount,
  msg: CerveauMessageInput,
  folderType: string,
  labelIds: string[]
): Promise<void> {
  try {
    const apiKey = await getUserCerveauKey(account.user);
    if (!apiKey) return;
    const flags = await getUserPauseFlags(account.user);
    if (flags.cerveau_paused) return;
    const isSecondary = labelIds.length
      ? await hasAnySecondaryLabel(account.user, labelIds)
      : false;
    const ok = await shouldAggregateMail(account, {
      isSent: !!msg.isSent,
      folderType,
      senderEmail: msg.from?.address,
      isSecondary,
    });
    if (!ok) return;
    enqueueCerveauPush(msg, account.user);
  } catch (err) {
    console.warn("[cerveau] aggregateMailIfReal failed:", (err as Error).message);
  }
}

// --- File d'attente de push live (calque enqueueEmbedding) ------------------

interface QueueItem {
  msg: CerveauMessageInput;
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
      const apiKey = await getUserCerveauKey(item.userId);
      if (!apiKey) continue;
      const flags = await getUserPauseFlags(item.userId);
      if (flags.cerveau_paused) continue;
      const texte = await renderMessageMemory(item.msg, item.userId);
      const r = await pushMemory(apiKey, {
        texte,
        source: "haikomail",
        discussion_id: messageDiscussionId(item.msg.id),
      });
      if (!r.ok) {
        console.warn(`[cerveau] push ${item.msg.id} echoue: ${r.error}`);
      }
    } catch (err) {
      console.error("[cerveau] drain item failed:", err);
    }
  }
  draining = false;
}

/** Pousse un mail vers le Cerveau en arriere-plan (non bloquant). */
export function enqueueCerveauPush(
  msg: CerveauMessageInput,
  userId: string
): void {
  queue.push({ msg, userId });
  void drain();
}

/** Pousse une note IA de thread vers le Cerveau. */
export async function pushThreadBrief(
  apiKey: string,
  threadId: string,
  content: string
): Promise<PushMemoryResult> {
  const texte = `Note de discussion (iMiel)\nThread : ${threadId}\n\n${content || ""}`;
  return pushMemory(apiKey, {
    texte,
    source: "haikomail-note",
    discussion_id: threadBriefDiscussionId(threadId),
  });
}
