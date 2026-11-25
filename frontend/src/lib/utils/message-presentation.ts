/**
 * Presentation d'un mail dans une conversation (charte des maquettes).
 *
 * - "bubble" : un echange ecrit par une personne -> bulle de texte (texte
 *   brut du mail ou tire de son HTML), historique cite replie derriere "..." ;
 *   la version HTML reste accessible par le menu du message ("Voir en HTML").
 * - "full"   : un mail mis en page (newsletter, facture, confirmation, alerte)
 *   -> sa version HTML d'origine s'affiche DIRECTEMENT dans le fil, dans un
 *   bloc gris (bg-muted + liseré) SANS marge, meme colonne que les bulles ;
 *   fond gris du gabarit efface, papier du cadre = couleur du bloc
 *   (EmailBodyFrame `bare` ; blanc en sombre). Choix utilisateur 2026-10-17.
 *   Plus de pastille "HTML" (choix utilisateur, 2026-10-17) ; htmlPillShown
 *   reste comme regle pure sans appelant.
 *
 * Regle PURE (sans base ni reseau), testee dans
 * lib/__tests__/message-presentation.test.ts. Les signaux, du plus sur au plus
 * fragile : en-tetes de liste / d'envoi automatique, adresse d'expediteur
 * automatique (no-reply...), expediteur suivi comme newsletter, mise en page
 * HTML riche (tableaux de mise en page, nombreuses images).
 */

export type MessagePresentation = "bubble" | "full";

export interface PresentableMessage {
  html_body?: string;
  text_body?: string;
  raw_headers?: string;
  from_address?: { name?: string; address?: string } | null;
  is_sent?: boolean;
}

export interface PresentationContext {
  /** Mail ecrit par l'utilisateur (envoye depuis un de ses comptes). */
  isMine?: boolean;
  /** Expediteur suivi comme source de newsletter. */
  isNewsletterSource?: boolean;
}

// Partie locale d'une adresse d'envoi automatique (jamais une personne).
const AUTOMATED_LOCAL_PART =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|dont[-_.]?reply|ne[-_.]?pas[-_.]?repondre|noreponse|no[-_.]?response|notifications?|notify|alerts?|mailer[-_.]?daemon|postmaster|bounces?|newsletters?|news|marketing|digest|updates?|automated|auto[-_.]?confirm|confirmations?|receipts?|invoices?|billing)(?:[-_.+][\w.-]*)?$/i;

// En-tetes d'un envoi de masse ou automatique.
const AUTOMATED_HEADERS: RegExp[] = [
  /^list-unsubscribe\s*:/im,
  /^list-id\s*:/im,
  /^precedence\s*:\s*(?:bulk|list|junk)/im,
  /^auto-submitted\s*:\s*auto-/im,
  /^x-campaign(?:id)?\s*:/im,
  /^x-mailchimp/im,
  /^x-sg-eid\s*:/im,
  /^feedback-id\s*:/im,
];

export function isAutomatedAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const local = address.split("@")[0]?.trim() ?? "";
  return AUTOMATED_LOCAL_PART.test(local);
}

export function hasAutomatedHeaders(rawHeaders: string | undefined | null): boolean {
  if (!rawHeaders) return false;
  return AUTOMATED_HEADERS.some((re) => re.test(rawHeaders));
}

/** Mise en page riche : tableaux de structure ou nombreuses images. */
export function hasRichLayout(html: string | undefined | null): boolean {
  if (!html) return false;
  const tables = (html.match(/<table\b/gi) || []).length;
  // Images visibles (on ignore les pixels de suivi 1x1).
  const images = (html.match(/<img\b[^>]*>/gi) || []).filter(
    (tag) => !/\b(?:width|height)\s*=\s*["']?[01](?:px)?["']?(?:\s|\/|>)/i.test(tag)
  ).length;
  if (tables >= 3) return true;
  if (images >= 3) return true;
  // Un tableau de mise en page centre de largeur fixe (gabarit d'emailing).
  if (/<table\b[^>]*\b(?:width\s*=\s*["']?(?:5\d\d|6\d\d|7\d\d)|align\s*=\s*["']?center)/i.test(html) && tables >= 1) {
    return true;
  }
  return false;
}

function plainTextOf(message: PresentableMessage): string {
  const text = (message.text_body || "").trim();
  if (text) return text;
  return htmlToText(message.html_body || "").trim();
}

/** Decide bulle ou affichage complet pour un mail. */
export function classifyMessagePresentation(
  message: PresentableMessage,
  ctx: PresentationContext = {}
): MessagePresentation {
  const mine = !!ctx.isMine || !!message.is_sent;
  // Sans texte lisible (mail fait d'images), seul l'affichage complet a du sens.
  if (!plainTextOf(message)) return "full";
  if (mine) return "bubble";
  if (ctx.isNewsletterSource) return "full";
  if (hasAutomatedHeaders(message.raw_headers)) return "full";
  if (isAutomatedAddress(message.from_address?.address)) return "full";
  if (hasRichLayout(message.html_body)) return "full";
  return "bubble";
}

/** La bulle porte-t-elle la pastille "HTML" (mise en page d'origine) ? */
export function htmlPillShown(
  presentation: MessagePresentation,
  message: Pick<PresentableMessage, "html_body">
): boolean {
  return presentation === "full" && !!message.html_body?.trim();
}

// ---------------------------------------------------------------- Texte

const BLOCK_TAGS = /<\/?(?:p|div|br|li|ul|ol|tr|table|h[1-6]|blockquote|section|article|header|footer)\b[^>]*>/gi;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Texte brut d'un HTML (sans DOM : utilisable partout, y compris en test). */
export function htmlToText(html: string): string {
  if (!html) return "";
  const withoutHidden = html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const withBreaks = withoutHidden.replace(BLOCK_TAGS, "\n");
  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, ""));
  return normalizeText(text);
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+$/g, "").replace(/^[ \t ]+/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Debut d'historique cite : "Le ... a ecrit :", "On ... wrote:", "Am ...
// schrieb", "Il ... ha scritto", separateurs "Original Message" et bloc Outlook
// "De : / Envoye :".
const ATTRIBUTION = /^(?:le|on|am|il|el)\b.{3,240}\b(?:a\s+[ée]crit|wrote|schrieb|ha\s+scritto|escribi[oó])\s*:?\s*$/i;
const ORIGINAL_SEPARATOR =
  /^-{2,}\s*(?:original message|message d'origine|messaggio originale|urspr[uü]ngliche nachricht|forwarded message|message transf[eé]r[eé])\s*-{2,}\s*$/i;
const OUTLOOK_FROM = /^(?:de|from|von|da)\s*:\s*\S/i;
const OUTLOOK_NEXT = /^(?:envoy[eé]|sent|gesendet|inviato|date|[àa]|to|an|objet|subject)\s*:/i;

function findQuoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (ORIGINAL_SEPARATOR.test(line)) return i;
    if (ATTRIBUTION.test(line)) return i;
    // Gmail coupe parfois l'attribution sur deux lignes.
    const next = (lines[i + 1] || "").trim();
    if (next && /^(?:le|on|am|il)\b/i.test(line) && ATTRIBUTION.test(`${line} ${next}`)) return i;
    if (/^_{8,}$/.test(line) && OUTLOOK_FROM.test((lines[i + 1] || "").trim())) return i;
    if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_NEXT.test(l.trim()))) {
      return i;
    }
    // Bloc de lignes citees "> ..." jusqu'a la fin (ou presque).
    if (line.startsWith(">")) {
      const rest = lines.slice(i).filter((l) => l.trim());
      const quoted = rest.filter((l) => l.trim().startsWith(">")).length;
      if (quoted / rest.length >= 0.6) return i;
    }
  }
  return -1;
}

export interface BubbleText {
  /** Le texte ecrit par l'auteur. */
  body: string;
  /** L'historique cite (null s'il n'y en a pas). */
  quoted: string | null;
}

/**
 * Separe le texte d'un mail en "ce que l'auteur a ecrit" et "historique cite".
 * Un mail qui ne contient QUE de la citation (transfert sans mot) garde tout
 * son texte : rien n'est jamais mange.
 */
export function splitQuotedText(text: string): BubbleText {
  const normalized = normalizeText(text);
  if (!normalized) return { body: "", quoted: null };
  const lines = normalized.split("\n");
  const start = findQuoteStart(lines);
  if (start <= 0) return { body: normalized, quoted: null };
  const body = lines.slice(0, start).join("\n").trim();
  const quoted = lines.slice(start).join("\n").trim();
  if (!body) return { body: normalized, quoted: null };
  return { body, quoted: quoted || null };
}

/** Texte de bulle d'un mail : texte brut si present, sinon tire du HTML. */
export function extractBubbleText(message: PresentableMessage): BubbleText {
  return splitQuotedText(plainTextOf(message));
}

/**
 * Coupe un historique cite en "ligne d'attribution" (affichee) et "reste"
 * (replie derriere le bouton "...").
 */
export function splitQuoteHeader(quoted: string): { header: string; rest: string } {
  const lines = quoted.split("\n");
  let end = 0;
  // L'attribution tient sur une ou deux lignes et finit par ":".
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    end = i + 1;
    if (/:\s*$/.test(lines[i].trim())) break;
  }
  const header = lines.slice(0, end).join(" ").replace(/\s+/g, " ").trim();
  const rest = lines
    .slice(end)
    .map((l) => l.replace(/^>\s?/, ""))
    .join("\n")
    .trim();
  return { header, rest };
}
