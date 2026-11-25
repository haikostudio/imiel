import crypto from "crypto";

import {
  createReadReceipt,
  getLastOpenReceipt,
  hasReceivedReceipt,
  getMessage,
  getAccount,
  type PBEmailAddress,
  type PBMessage,
} from "./pocketbase";

/**
 * Suivi de lecture des mails ENVOYES (pixel de tracking).
 *
 * Au moment de l'envoi SMTP, un pixel 1x1 est injecte dans le HTML sortant
 * (`injectTrackingPixel`). L'URL du pixel pointe vers l'app publique
 * (`/worker/track/open/:token`, rewrite Next -> worker) : chaque chargement
 * par le destinataire = un evenement "opened" dans `read_receipts`.
 *
 * Le token est auto-porteur (messageId + empreinte destinataire + HMAC-SHA256
 * tronque signe avec ENCRYPTION_KEY) : rien a stocker, impossible a forger.
 * Un envoi a plusieurs destinataires part en une copie SMTP par personne, avec
 * le meme en-tete To/Cc, pour que chaque ouverture nomme la bonne adresse.
 *
 * Limites honnetes (affichees cote UI) :
 * - le destinataire doit charger les images (proxy Gmail les charge par defaut) ;
 * - Apple Mail Privacy Protection pre-charge les pixels -> "lu" optimiste ;
 * - les mails envoyes avant le suivi par personne n'ont pas d'adresse sur l'ouverture.
 */

const TOKEN_SIG_LEN = 32; // hex chars (128 bits de HMAC, suffisant ici)
const RECIPIENT_KEY_LEN = 16;

export type TrackingTokenPayload = {
  messageId: string;
  recipientKey: string | null;
};

function getBaseUrl(): string {
  return (
    process.env.TRACKING_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://imiel.example.com"
  ).replace(/\/$/, "");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Empreinte courte et stable d'une adresse, sans la mettre en clair dans l'URL. */
export function recipientKeyFromEmail(email: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeEmail(email))
    .digest("hex")
    .slice(0, RECIPIENT_KEY_LEN);
}

function sign(payload: string): string {
  const key = process.env.ENCRYPTION_KEY || "";
  return crypto
    .createHmac("sha256", key)
    .update(payload)
    .digest("hex")
    .slice(0, TOKEN_SIG_LEN);
}

export function uniqueRecipientEmails(message: {
  to_addresses?: PBEmailAddress[];
  cc_addresses?: PBEmailAddress[];
  bcc_addresses?: PBEmailAddress[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const lists = [
    message.to_addresses,
    message.cc_addresses,
    message.bcc_addresses,
  ];
  for (const list of lists) {
    for (const a of list || []) {
      const email = normalizeEmail(a.address || "");
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

export function matchRecipientEmail(
  message: Pick<PBMessage, "to_addresses" | "cc_addresses" | "bcc_addresses">,
  recipientKey: string
): string | null {
  for (const email of uniqueRecipientEmails(message)) {
    if (recipientKeyFromEmail(email) === recipientKey) return email;
  }
  return null;
}

export function makeTrackingToken(
  messageId: string,
  recipientEmail?: string
): string {
  const email = recipientEmail ? normalizeEmail(recipientEmail) : "";
  if (!email) {
    return `${messageId}.${sign(messageId)}`;
  }
  const recipientKey = recipientKeyFromEmail(email);
  return `${messageId}.${recipientKey}.${sign(`${messageId}.${recipientKey}`)}`;
}

/** Verifie un token de pixel ; renvoie le messageId ou null si invalide. */
export function verifyTrackingToken(token: string): string | null {
  return parseTrackingToken(token)?.messageId ?? null;
}

export function parseTrackingToken(token: string): TrackingTokenPayload | null {
  const parts = (token || "").split(".");
  if (parts.length === 2) {
    const [messageId, sig] = parts;
    if (!/^[a-zA-Z0-9]{10,40}$/.test(messageId)) return null;
    const expected = sign(messageId);
    if (!safeEqualHex(sig, expected)) return null;
    return { messageId, recipientKey: null };
  }
  if (parts.length === 3) {
    const [messageId, recipientKey, sig] = parts;
    if (!/^[a-zA-Z0-9]{10,40}$/.test(messageId)) return null;
    if (!/^[a-f0-9]{16}$/.test(recipientKey)) return null;
    const expected = sign(`${messageId}.${recipientKey}`);
    if (!safeEqualHex(sig, expected)) return null;
    return { messageId, recipientKey };
  }
  return null;
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function trackingPixelUrl(
  messageId: string,
  recipientEmail?: string
): string {
  return `${getBaseUrl()}/worker/track/open/${makeTrackingToken(messageId, recipientEmail)}`;
}

/** Marqueur reconnaissable pour que le front puisse retirer NOTRE pixel du rendu. */
export const TRACKING_PIXEL_MARKER = "/track/open/";

/**
 * Injecte le pixel de tracking dans le HTML sortant (avant </body> si present,
 * sinon en fin de document). Idempotent : n'injecte pas deux fois.
 */
export function injectTrackingPixel(
  html: string,
  messageId: string,
  recipientEmail?: string
): string {
  if (!html) return html;
  if (html.includes(TRACKING_PIXEL_MARKER)) return html;
  const img = `<img src="${trackingPixelUrl(messageId, recipientEmail)}" width="1" height="1" alt="" style="display:none;max-width:1px;max-height:1px;" />`;
  const bodyClose = html.lastIndexOf("</body>");
  if (bodyClose >= 0) {
    return html.slice(0, bodyClose) + img + html.slice(bodyClose);
  }
  return html + img;
}

/** Libelle client lisible derive du user-agent du hit pixel. */
export function clientLabelFromUserAgent(ua: string): string {
  const s = (ua || "").toLowerCase();
  if (!s) return "";
  if (s.includes("googleimageproxy")) return "Gmail";
  if (s.includes("yahoomailproxy") || s.includes("yahoo")) return "Yahoo Mail";
  if (s.includes("outlook") || s.includes("office365")) return "Outlook";
  if (s.includes("thunderbird")) return "Thunderbird";
  if (s.includes("iphone") || s.includes("ipad")) return "iPhone/iPad";
  if (s.includes("macintosh") && s.includes("applewebkit") && !s.includes("chrome"))
    return "Apple Mail";
  if (s.includes("android")) return "Android";
  if (s.includes("windows")) return "Windows";
  return "";
}

/** Evenement "sent" a l'acceptation SMTP. Best effort, jamais bloquant. */
export async function recordSentReceipt(messageId: string): Promise<void> {
  try {
    const message = await getMessage(messageId);
    const account = await getAccount(message.account);
    await createReadReceipt({
      user: account.user,
      account: account.id,
      message: messageId,
      kind: "sent",
      date: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("[read-receipts] sent event failed:", (err as Error).message);
  }
}

// Fenetre de debounce : certains clients chargent le pixel plusieurs fois lors
// d'une meme ouverture (prefetch + rendu). Deux hits rapproches = une lecture.
const OPEN_DEBOUNCE_MS = 2 * 60 * 1000;

// Fenetre de grace anti-scanner : Gmail/Outlook SCANNENT les images a la
// LIVRAISON (verifie en prod : hit Google 74.125.x.x, UA Chrome/42 antique,
// 2s apres l'envoi). Un hit dans les 90s suivant l'envoi = scan de
// distribution, pas une lecture humaine -> ignore. Les vraies ouvertures
// suivantes passent (le proxy Gmail re-fetch a chaque ouverture, no-store).
const SCANNER_GRACE_MS = 90 * 1000;

// Signatures UA des scanners de livraison (Chrome 42 fige depuis des annees :
// utilise par les scanners Google et Microsoft SafeLinks, jamais par un
// navigateur reel aujourd'hui).
const SCANNER_UA_RE = /Chrome\/4[0-9]\.0\.2\d{3}\./i;

function isDeliveryScan(userAgent: string, sentAt: number): boolean {
  if (SCANNER_UA_RE.test(userAgent)) return true;
  return Date.now() - sentAt < SCANNER_GRACE_MS;
}

/**
 * Evenement "opened" sur hit du pixel. Deduplique les hits rapproches et
 * ignore les hits venant de l'app elle-meme (referer) — le HTML du dossier
 * Envoyes contient aussi le pixel.
 */
export async function recordOpenReceipt(params: {
  messageId: string;
  recipientKey?: string | null;
  userAgent?: string;
  ip?: string;
  referer?: string;
}): Promise<void> {
  const {
    messageId,
    recipientKey = null,
    userAgent = "",
    ip = "",
    referer = "",
  } = params;

  // Auto-ouverture depuis l'app (l'utilisateur relit son propre envoi) : le
  // front retire le pixel du rendu, ceinture + bretelles cote serveur.
  const base = getBaseUrl();
  if (referer && (referer.startsWith(base) || referer.includes("localhost"))) {
    return;
  }

  try {
    const message = await getMessage(messageId);
    const recipient = recipientKey
      ? matchRecipientEmail(message, recipientKey)
      : null;

    const last = await getLastOpenReceipt(messageId, recipient || undefined);
    if (last) {
      const lastTime = new Date(last.date.replace(" ", "T")).getTime();
      if (Date.now() - lastTime < OPEN_DEBOUNCE_MS) return;
    }

    // Scan de livraison (anti-spam Gmail/Outlook) : pas une vraie lecture,
    // mais la preuve que le mail est ARRIVE -> evenement "received" (un seul
    // par destinataire, jamais compte comme une vue). Le debounce ci-dessus ne
    // lit que les "opened" : un "received" ne retarde jamais la 1re lecture.
    const sentAt = new Date(
      (message.date || "").replace(" ", "T") || Date.now()
    ).getTime();
    if (isDeliveryScan(userAgent, sentAt)) {
      if (await hasReceivedReceipt(messageId, recipient || undefined)) return;
      const acc = await getAccount(message.account);
      await createReadReceipt({
        user: acc.user,
        account: acc.id,
        message: messageId,
        kind: "received",
        date: new Date().toISOString(),
        user_agent: userAgent.slice(0, 990),
        ip: ip.slice(0, 90),
        client: clientLabelFromUserAgent(userAgent),
        recipient: recipient || "",
      });
      console.log(
        `[read-receipts] delivery scan recorded as received for ${messageId} (${recipient || "destinataire inconnu"}, ip ${ip}, ua ${userAgent.slice(0, 60)})`
      );
      return;
    }

    const account = await getAccount(message.account);
    await createReadReceipt({
      user: account.user,
      account: account.id,
      message: messageId,
      kind: "opened",
      date: new Date().toISOString(),
      user_agent: userAgent.slice(0, 990),
      ip: ip.slice(0, 90),
      client: clientLabelFromUserAgent(userAgent),
      recipient: recipient || "",
    });
    console.log(
      `[read-receipts] open recorded for message ${messageId} (${recipient || "destinataire inconnu"}, ${clientLabelFromUserAgent(userAgent) || "client inconnu"})`
    );
  } catch (err) {
    console.warn("[read-receipts] open event failed:", (err as Error).message);
  }
}

/** GIF transparent 1x1 renvoye au client mail. */
export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);
