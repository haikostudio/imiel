/**
 * Pieces jointes du chat IA : preparation cote navigateur.
 *
 * - image : redimensionnee (<= 1600 px, JPEG) -> data URL envoyee au modele
 *   vision + miniature 96 px gardee dans l'historique local.
 * - pdf : data URL brute, lue par le modele (part `file` OpenRouter).
 * - text : contenu lu ici, borne a MAX_TEXT_CHARS.
 * Le binaire ne part QU'AVEC le message qui l'a joint : l'historique
 * (localStorage) ne garde que les metadonnees + la miniature.
 */

export type ChatAttachmentKind = "image" | "pdf" | "text";

/** Ce que l'historique garde d'une piece jointe (jamais le binaire). */
export interface ChatAttachmentMeta {
  name: string;
  type: string;
  size: number;
  kind: ChatAttachmentKind;
  thumb?: string;
}

/** Piece jointe prete a partir avec le message en cours. */
export interface ChatAttachment extends ChatAttachmentMeta {
  id: string;
  data?: string; // data URL (image / pdf)
  text?: string; // contenu (fichier texte)
}

export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_CHARS = 60_000;
const IMAGE_MAX_SIDE = 1600;
const THUMB_SIDE = 96;

export const ACCEPT_ATTRIBUTE =
  "image/*,application/pdf,text/*,.txt,.md,.csv,.json,.log,.xml,.html,.eml,.ics,.vcf";

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|xml|html?|eml|ics|vcf|ya?ml)$/i;

export function attachmentKind(file: File): ChatAttachmentKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (file.type.startsWith("text/") || file.type === "application/json" || TEXT_EXT.test(file.name)) return "text";
  return null;
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error("lecture impossible"));
    r.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image illisible"));
    img.src = src;
  });
}

function drawScaled(img: HTMLImageElement, maxSide: number, quality: number): string {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas indisponible");
  // Fond blanc : une capture PNG transparente reste lisible en JPEG.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const url = canvas.toDataURL("image/jpeg", quality);
  // iOS Safari rend "data:," (vide) quand le canvas depasse sa memoire : une
  // image vide partirait sans rien que le modele puisse lire.
  if (!isUsableImageDataUrl(url)) throw new Error("canvas vide");
  return url;
}

/** Une data URL d'image reellement exploitable (pas "data:," ni un en-tete seul). */
export function isUsableImageDataUrl(url: string | undefined): boolean {
  return typeof url === "string" && /^data:image\/(jpeg|png|webp|gif);base64,/.test(url) && url.length > 200;
}

export type PrepareError = "unsupported" | "tooLarge" | "unreadable";

export async function prepareAttachment(
  file: File
): Promise<{ ok: true; attachment: ChatAttachment } | { ok: false; reason: PrepareError }> {
  const kind = attachmentKind(file);
  if (!kind) return { ok: false, reason: "unsupported" };
  const limit = kind === "image" ? MAX_IMAGE_BYTES : kind === "pdf" ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
  if (file.size > limit) return { ok: false, reason: "tooLarge" };
  const base: ChatAttachment = {
    id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: file.name || (kind === "image" ? "image.jpg" : "document"),
    type: file.type || (kind === "pdf" ? "application/pdf" : "text/plain"),
    size: file.size,
    kind,
  };
  try {
    if (kind === "image") {
      const raw = await readAsDataUrl(file);
      const img = await loadImage(raw);
      let data: string;
      try {
        data = drawScaled(img, IMAGE_MAX_SIDE, 0.85);
      } catch {
        // Reduction impossible : on garde l'original s'il est dans un format
        // lu par les modeles et de taille raisonnable, sinon on refuse.
        if (!isUsableImageDataUrl(raw) || file.size > 4 * 1024 * 1024) return { ok: false, reason: "unreadable" };
        data = raw;
      }
      let thumb: string | undefined;
      try {
        thumb = drawScaled(img, THUMB_SIDE, 0.7);
      } catch {
        thumb = undefined;
      }
      return { ok: true, attachment: { ...base, type: data.slice(5, data.indexOf(";")), data, ...(thumb ? { thumb } : {}) } };
    }
    if (kind === "pdf") {
      return { ok: true, attachment: { ...base, data: await readAsDataUrl(file) } };
    }
    const text = await file.text();
    return { ok: true, attachment: { ...base, text: text.slice(0, MAX_TEXT_CHARS) } };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

export function toMeta(a: ChatAttachment): ChatAttachmentMeta {
  return { name: a.name, type: a.type, size: a.size, kind: a.kind, ...(a.thumb ? { thumb: a.thumb } : {}) };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}
