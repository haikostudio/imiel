// Images integrees aux mails : resolution des references cid: vers le fichier
// joint conserve dans PocketBase, detection des images, tailles/alignements
// de l'editeur (partages avec l'envoi).
import pb, { getFileUrl, attachments as attachmentsCollection, type Attachment, type Message } from "@/lib/pocketbase";

export interface MessageAttachmentItem {
  id: string;
  filename: string;
  url: string;
  contentType?: string;
  size?: number;
  contentId?: string;
  isInline?: boolean;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic"];

export function isImageAttachment(filename: string, contentType?: string): boolean {
  if (contentType?.toLowerCase().startsWith("image/")) return true;
  const ext = filename.split(".").pop()?.toLowerCase();
  return !!ext && IMAGE_EXTS.includes(ext);
}

/** "<abc@x>" -> "abc@x" (mailparser garde les chevrons du Content-ID). */
export function normalizeCid(cid: string | undefined | null): string {
  return (cid || "").trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

const CID_SRC_RE = /(\ssrc\s*=\s*)(["'])cid:([^"']+)\2/gi;

/** Ensemble des Content-ID references par le corps HTML. */
export function referencedCids(html: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!html) return out;
  for (const m of html.matchAll(CID_SRC_RE)) {
    let v = m[3];
    try { v = decodeURIComponent(v); } catch { /* garde brut */ }
    out.add(normalizeCid(v));
  }
  return out;
}

/** Remplace src="cid:X" par l'URL du fichier joint dont le content_id vaut X. */
export function resolveCidImages(html: string, items: MessageAttachmentItem[]): string {
  if (!html || !items.length || !/cid:/i.test(html)) return html;
  const byCid = new Map<string, string>();
  for (const it of items) {
    const cid = normalizeCid(it.contentId);
    if (cid) byCid.set(cid, it.url);
  }
  if (!byCid.size) return html;
  return html.replace(CID_SRC_RE, (full, pre: string, q: string, raw: string) => {
    let v = raw;
    try { v = decodeURIComponent(v); } catch { /* garde brut */ }
    const url = byCid.get(normalizeCid(v));
    return url ? `${pre}${q}${url}${q}` : full;
  });
}

/** URL servie par PocketBase pour un fichier joint (reconnue comme sure). */
export function isPocketBaseFileUrl(src: string): boolean {
  if (!src) return false;
  if (src.startsWith("/api/files/")) return true;
  const base = (pb.baseURL || "").replace(/\/+$/, "");
  return !!base && base !== "" && src.startsWith(`${base}/api/files/`);
}

// Cache par message : la liste des PJ, le corps et la visionneuse lisent la
// meme requete (une seule par message).
const cache = new Map<string, Promise<MessageAttachmentItem[]>>();

export function fetchMessageAttachments(message: Message): Promise<MessageAttachmentItem[]> {
  const fallback = (): MessageAttachmentItem[] =>
    (message.attachments || []).map((filename) => ({
      id: `${message.id}-${filename}`,
      filename,
      url: getFileUrl(message, filename),
    }));
  const hit = cache.get(message.id);
  if (hit) return hit;
  const p = attachmentsCollection()
    .getFullList<Attachment>({ filter: `message="${message.id}"`, requestKey: null })
    .then((records) =>
      records.length > 0
        ? records.map((rec) => ({
            id: rec.id,
            filename: rec.filename,
            url: getFileUrl(rec, rec.file),
            contentType: rec.content_type || undefined,
            size: rec.size > 0 ? rec.size : undefined,
            contentId: rec.content_id || undefined,
            isInline: !!rec.is_inline,
          }))
        : fallback(),
    )
    .catch(() => {
      cache.delete(message.id);
      return fallback();
    });
  cache.set(message.id, p);
  return p;
}

export function invalidateMessageAttachments(messageId: string) {
  cache.delete(messageId);
}

// --- Tailles et alignements (editeur + envoi) ---

export type InlineImageSize = "small" | "medium" | "original";
export type InlineImageAlign = "left" | "center" | "right";

/**
 * Style inline respecte par la plupart des messageries (pas de classe CSS :
 * les feuilles de style sont retirees par Gmail/Outlook).
 */
export function inlineImageStyle(size: InlineImageSize, align: InlineImageAlign): string {
  const width = size === "small" ? "width:160px;" : size === "medium" ? "width:50%;" : "";
  const margin =
    align === "center" ? "margin-left:auto;margin-right:auto;"
    : align === "right" ? "margin-left:auto;margin-right:0;"
    : "margin-left:0;margin-right:auto;";
  return `display:block;${width}max-width:100%;height:auto;${margin}`;
}
