import { sanitizeHtml } from "./sanitize";

// Bloc "historique cite" (reponse) / "message transfere" (transfert) rattache au
// corps d'un brouillon. On l'enveloppe dans un <div class="haiko-quote"> : la
// classe survit a DOMPurify (contrairement aux data-*), ce qui permet de re-separer
// la partie redigee par l'utilisateur du bloc cite au rechargement d'un brouillon.
export const QUOTE_MARKER_CLASS = "haiko-quote";

type Lang = "fr" | "en" | "de" | "it";

interface QuoteAddress {
  name?: string;
  address?: string;
}

export interface QuoteMessage {
  from_address?: QuoteAddress | null;
  to_addresses?: QuoteAddress[] | null;
  cc_addresses?: QuoteAddress[] | null;
  subject?: string;
  date?: string;
  html_body?: string;
  text_body?: string;
}

// Libelles (sans accents, cf. convention du projet : pas d'accents dans le source).
const L10N: Record<Lang, {
  wrote: (date: string, who: string) => string;
  fwd: string;
  from: string;
  date: string;
  subject: string;
  to: string;
  cc: string;
}> = {
  fr: { wrote: (d, w) => `Le ${d}, ${w} a ecrit :`, fwd: "---------- Message transfere ----------", from: "De", date: "Date", subject: "Objet", to: "A", cc: "Cc" },
  en: { wrote: (d, w) => `On ${d}, ${w} wrote:`, fwd: "---------- Forwarded message ----------", from: "From", date: "Date", subject: "Subject", to: "To", cc: "Cc" },
  de: { wrote: (d, w) => `Am ${d} schrieb ${w}:`, fwd: "---------- Weitergeleitete Nachricht ----------", from: "Von", date: "Datum", subject: "Betreff", to: "An", cc: "Cc" },
  it: { wrote: (d, w) => `Il ${d}, ${w} ha scritto:`, fwd: "---------- Messaggio inoltrato ----------", from: "Da", date: "Data", subject: "Oggetto", to: "A", cc: "Cc" },
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function whoLabel(a?: QuoteAddress | null): string {
  if (!a) return "";
  const name = a.name?.trim();
  const addr = a.address?.trim() ?? "";
  return name && name !== addr ? `${name} <${addr}>` : addr;
}

function addrList(list?: QuoteAddress[] | null): string {
  return (list ?? []).map(whoLabel).filter(Boolean).join(", ");
}

function fmtDate(iso: string | undefined, lang: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    return d.toLocaleString(lang, {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d.toLocaleString();
  }
}

// Corps original nettoye. On conserve les images (allowExternalImages) pour que
// la citation reste fidele a l'original (comme les clients mail classiques).
function bodyHtml(msg: QuoteMessage): string {
  const raw = msg.html_body?.trim()
    ? msg.html_body
    : msg.text_body
      ? `<p>${esc(msg.text_body).replace(/\n/g, "<br>")}</p>`
      : "";
  return sanitizeHtml(raw, { allowExternalImages: true });
}

const QUOTE_STYLE = "margin:0 0 0 0.8ex;padding-left:1ex;border-left:2px solid #ccc;color:#666;";

/** Bloc cite pour une reponse : "Le <date>, <expediteur> a ecrit :" + blockquote. */
export function buildReplyQuote(msg: QuoteMessage, lang: string): string {
  const l = L10N[lang as Lang] ?? L10N.fr;
  const intro = esc(l.wrote(fmtDate(msg.date, lang), whoLabel(msg.from_address)));
  return `<div class="${QUOTE_MARKER_CLASS}"><p>${intro}</p><blockquote style="${QUOTE_STYLE}">${bodyHtml(msg)}</blockquote></div>`;
}

/** Bloc cite pour un transfert : en-tete (De/Date/Objet/A) + blockquote. */
export function buildForwardQuote(msg: QuoteMessage, lang: string): string {
  const l = L10N[lang as Lang] ?? L10N.fr;
  const lines = [
    `<b>${esc(l.from)} :</b> ${esc(whoLabel(msg.from_address))}`,
    `<b>${esc(l.date)} :</b> ${esc(fmtDate(msg.date, lang))}`,
    `<b>${esc(l.subject)} :</b> ${esc(msg.subject ?? "")}`,
    `<b>${esc(l.to)} :</b> ${esc(addrList(msg.to_addresses))}`,
  ];
  const cc = addrList(msg.cc_addresses);
  if (cc) lines.push(`<b>${esc(l.cc)} :</b> ${esc(cc)}`);
  return `<div class="${QUOTE_MARKER_CLASS}"><p>${esc(l.fwd)}</p><p>${lines.join("<br>")}</p><blockquote style="${QUOTE_STYLE}">${bodyHtml(msg)}</blockquote></div>`;
}

/**
 * Separe la partie redigee par l'utilisateur du bloc cite (rechargement d'un
 * brouillon). Renvoie { body, quote } ; quote = "" si aucun marqueur present
 * (nouveau message, ou ancien brouillon sans wrapper).
 */
export function splitQuotedBody(html: string): { body: string; quote: string } {
  if (typeof window === "undefined" || !html || !html.includes(QUOTE_MARKER_CLASS)) {
    return { body: html ?? "", quote: "" };
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const el = doc.querySelector(`.${QUOTE_MARKER_CLASS}`);
  if (!el) return { body: html, quote: "" };
  const quote = el.outerHTML;
  el.remove();
  return { body: doc.body.innerHTML.trim(), quote };
}

/** Recompose le corps complet (redige + cite) pour l'auto-save et l'envoi. */
export function joinQuotedBody(body: string, quote: string): string {
  if (!quote) return body ?? "";
  return `${body ?? ""}${quote}`;
}
