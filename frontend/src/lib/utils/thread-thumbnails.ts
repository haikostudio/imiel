/**
 * Vignettes de l'onglet "Pieces jointes" des Details de la conversation.
 *
 * Regle : toutes les images JOINTES ont leur vignette ; une image glissee dans
 * le texte d'un mail (`attachments.is_inline`) n'en a une que si elle est assez
 * lourde pour etre une vraie photo — les logos et icones de signature recus
 * arrivent en PJ inline de quelques Ko et sont ecartes — et que son nom ne dit
 * pas "logo" (mesure sur les vrais mails : haiko-logo.png fait 43 Ko, alors que
 * des captures collees font 24 Ko). Une image repetee dans plusieurs messages
 * (meme nom, meme poids) n'a qu'une vignette.
 */

/** Taille de vignette declaree sur `attachments.file` (migration 070) ; tant
 * qu'elle ne l'est pas, PocketBase rend l'image d'origine. */
export const THUMB_SIZE = "240x240";

/** En dessous, une image du texte est un logo / une icone de signature. */
export const INLINE_PHOTO_MIN_BYTES = 20 * 1024;

/** Noms d'images du texte qui sont des logos / icones de signature. */
const SIGNATURE_NAME_RE = /logo|icon|icone|signature|facebook|linkedin|twitter|instagram|youtube|whatsapp|banner|banniere/i;

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "heic", "heif", "avif"];

export function isImageFile(filename: string, contentType?: string): boolean {
  if (contentType?.startsWith("image/")) return true;
  const ext = filename.split(".").pop()?.toLowerCase();
  return !!ext && ext !== filename.toLowerCase() && IMAGE_EXTS.includes(ext);
}

export interface ThumbCandidate {
  filename: string;
  contentType?: string;
  size?: number;
  isInline: boolean;
}

export function pickThumbnailItems<T extends ThumbCandidate>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const att of items) {
    if (!isImageFile(att.filename, att.contentType)) continue;
    if (att.isInline && (!att.size || att.size < INLINE_PHOTO_MIN_BYTES || SIGNATURE_NAME_RE.test(att.filename))) {
      continue;
    }
    const key = `${att.filename.toLowerCase()}|${att.size ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(att);
  }
  return out;
}
