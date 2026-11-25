import { simpleParser, ParsedMail, Attachment } from "mailparser";
import * as iconv from "iconv-lite";

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface ParsedEmail {
  messageId: string;
  subject: string;
  from: EmailAddress;
  toAddresses: EmailAddress[];
  ccAddresses: EmailAddress[];
  bccAddresses: EmailAddress[];
  replyTo: string;
  date: string;
  textBody: string;
  htmlBody: string;
  snippet: string;
  references: string[];
  inReplyTo: string;
  attachments: ParsedAttachment[];
  hasAttachments: boolean;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
  contentId: string;
  isInline: boolean;
}

function formatAddressListString(
  addresses:
    | ParsedMail["to"]
    | ParsedMail["cc"]
    | ParsedMail["bcc"]
    | ParsedMail["replyTo"]
): string {
  if (!addresses) return "";

  const list = Array.isArray(addresses) ? addresses : [addresses];
  const result: string[] = [];

  for (const group of list) {
    if ("value" in group) {
      for (const addr of group.value) {
        if (addr.name) {
          result.push(`${fixMojibake(addr.name)} <${addr.address}>`);
        } else {
          result.push(addr.address || "");
        }
      }
    }
  }

  return result.join(", ");
}

function formatAddressListStructured(
  addresses:
    | ParsedMail["to"]
    | ParsedMail["cc"]
    | ParsedMail["bcc"]
    | ParsedMail["replyTo"]
): EmailAddress[] {
  if (!addresses) return [];

  const list = Array.isArray(addresses) ? addresses : [addresses];
  const result: EmailAddress[] = [];

  for (const group of list) {
    if ("value" in group) {
      for (const addr of group.value) {
        result.push({
          name: addr.name ? fixMojibake(addr.name) : undefined,
          address: addr.address || "",
        });
      }
    }
  }

  return result;
}

export function stripHtmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#?\w+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrait d'un mail ENVOYE depuis l'app (reponse / transfert) : seul le texte
 * ecrit par l'utilisateur, sans l'historique cite (bloc .haiko-quote pose par
 * la fenetre de redaction, <blockquote>, lignes "> ..." ou "Le ... a ecrit :").
 * Sans extrait, la ligne de conversation n'affiche que le sujet.
 */
export function buildSentSnippet(textBody: string, htmlBody: string): string {
  if (htmlBody) {
    let html = htmlBody;
    const quoteAt = html.search(/<[^>]+class="[^"]*haiko-quote|<blockquote/i);
    if (quoteAt >= 0) html = html.slice(0, quoteAt);
    const fromHtml = generateSnippet(stripHtmlToText(html));
    if (fromHtml) return fromHtml;
  }
  if (textBody) {
    const lines: string[] = [];
    for (const line of textBody.replace(/\r\n/g, "\n").split("\n")) {
      if (/^\s*>/.test(line)) break;
      if (/^\s*(Le|On|Am|Il)\b.*(a [ée]crit|wrote|schrieb|ha scritto)\s*:\s*$/i.test(line)) break;
      lines.push(line);
    }
    return generateSnippet(lines.join("\n"));
  }
  return "";
}

export function generateSnippet(text: string, maxLength = 200): string {
  if (!text) return "";

  const cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\s+/gm, "")
    .trim();

  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.substring(0, maxLength).trim() + "...";
}

function sanitizeHtml(html: string): string {
  if (!html) return "";

  return html
    // Remove script tags and content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    // Remove event handlers
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // Remove javascript: URLs
    .replace(/href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, "")
    // Remove embedded objects
    .replace(/<(?:embed|object|applet)\b[^>]*>.*?<\/(?:embed|object|applet)>/gis, "")
    // Remove form elements
    .replace(/<\/?(?:form|input|button|select|textarea)\b[^>]*>/gi, "");
}

const HAS_REPLACEMENT_CHAR = /\uFFFD/;

// Reverse map for the Windows-1252 specific characters (bytes 0x80-0x9F).
// When UTF-8 bytes are wrongly decoded as Windows-1252, these bytes become
// these high codepoints; we need to map them back to their original byte.
const CP1252_REVERSE: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

// Markers of UTF-8 text mis-decoded as Latin-1/Windows-1252 (mojibake).
// e.g. "n'avez" (apostrophe U+2019 = E2 80 99) becomes "na\u00E2\u201A\u00ACavez".
const MOJIBAKE_MARKER = /[\u00C2\u00C3\u00E2]/;

/**
 * Repair "mojibake": UTF-8 bytes that were decoded as Latin-1/Windows-1252,
 * producing sequences like "\u00E2\u20AC\u2122", "\u00C3\u00A9", "\u00C2\u00A3". Re-encodes the string to its
 * original bytes and decodes them as UTF-8. Strictly validated (fatal UTF-8
 * decode) so correctly-encoded text is never corrupted.
 */
export function fixMojibake(input: string): string {
  if (!input || !MOJIBAKE_MARKER.test(input)) return input;
  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code <= 0xff) {
      bytes[i] = code;
    } else if (CP1252_REVERSE[code] !== undefined) {
      bytes[i] = CP1252_REVERSE[code];
    } else {
      // genuine Unicode char -> string is not pure mojibake, leave untouched
      return input;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // not valid UTF-8 once re-encoded -> wasn't mojibake, keep original
    return input;
  }
}

function detectCharsetFromSource(rawSource: Buffer): string | null {
  // Read the first 4KB to look for charset hints (headers + start of body)
  const head = rawSource.subarray(0, 4096).toString("ascii");

  // Check Content-Type header charset
  const ctMatch = head.match(/Content-Type:[^\r\n]*charset\s*=\s*"?([^\s";,\r\n]+)/i);
  if (ctMatch) {
    const charset = ctMatch[1].toLowerCase();
    if (charset !== "utf-8" && charset !== "utf8" && iconv.encodingExists(charset)) {
      return charset;
    }
  }

  // Check HTML meta charset
  const metaMatch = head.match(/<meta[^>]+charset\s*=\s*"?([^\s"';>]+)/i);
  if (metaMatch) {
    const charset = metaMatch[1].toLowerCase();
    if (charset !== "utf-8" && charset !== "utf8" && iconv.encodingExists(charset)) {
      return charset;
    }
  }

  return null;
}

const FALLBACK_CHARSETS = ["latin1", "windows-1252"];

async function parseWithCharsetFallback(
  rawEmail: Buffer,
  initialParsed: ParsedMail
): Promise<ParsedMail> {
  const text = initialParsed.text || "";
  const html = initialParsed.html || "";

  if (!HAS_REPLACEMENT_CHAR.test(text) && !HAS_REPLACEMENT_CHAR.test(html)) {
    return initialParsed;
  }

  // Try detected charset first, then fallbacks
  const detected = detectCharsetFromSource(rawEmail);
  const charsets = detected
    ? [detected, ...FALLBACK_CHARSETS.filter((c) => c !== detected)]
    : FALLBACK_CHARSETS;

  for (const charset of charsets) {
    try {
      const decoded = iconv.decode(rawEmail, charset);
      const retried = await simpleParser(decoded);
      const retText = retried.text || "";
      const retHtml = retried.html || "";
      if (!HAS_REPLACEMENT_CHAR.test(retText) && !HAS_REPLACEMENT_CHAR.test(retHtml)) {
        return retried;
      }
    } catch {
      // charset not supported or parse error, try next
    }
  }

  return initialParsed;
}

function formatReferencesArray(refs: string | string[] | undefined): string[] {
  if (!refs) return [];
  if (Array.isArray(refs)) return refs;
  return refs.split(/\s+/).filter(Boolean);
}

export async function parseEmail(rawEmail: Buffer | string): Promise<ParsedEmail> {
  let parsed = await simpleParser(rawEmail);

  // Fallback charset detection if U+FFFD replacement characters are found
  if (Buffer.isBuffer(rawEmail)) {
    parsed = await parseWithCharsetFallback(rawEmail, parsed);
  }

  const fromAddr = parsed.from?.value?.[0];
  const attachments: ParsedAttachment[] = (parsed.attachments || []).map(
    (att: Attachment) => {
      const contentType = att.contentType || "application/octet-stream";
      let filename = att.filename || "attachment";
      // Assign .ics extension to text/calendar parts without proper filename
      if (
        contentType.includes("calendar") &&
        !filename.toLowerCase().endsWith(".ics")
      ) {
        filename = "invite.ics";
      }
      return {
        filename,
        contentType,
        size: att.size,
        content: att.content,
        contentId: att.contentId || "",
        isInline: att.contentDisposition === "inline",
      };
    }
  );

  const textBody = fixMojibake(parsed.text || "");
  const htmlBody = fixMojibake(parsed.html || "");

  return {
    messageId: parsed.messageId || "",
    subject: fixMojibake(parsed.subject || "(no subject)"),
    from: {
      name: fromAddr?.name ? fixMojibake(fromAddr.name) : undefined,
      address: fromAddr?.address || "",
    },
    toAddresses: formatAddressListStructured(parsed.to),
    ccAddresses: formatAddressListStructured(parsed.cc),
    bccAddresses: formatAddressListStructured(parsed.bcc),
    replyTo: formatAddressListString(parsed.replyTo),
    date: parsed.date?.toISOString() || new Date().toISOString(),
    textBody,
    htmlBody: sanitizeHtml(htmlBody),
    snippet: generateSnippet(textBody || stripHtmlToText(htmlBody)),
    references: formatReferencesArray(parsed.references),
    inReplyTo: parsed.inReplyTo || "",
    attachments,
    hasAttachments: attachments.filter((a) => !a.isInline).length > 0,
  };
}
