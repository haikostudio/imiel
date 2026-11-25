/**
 * Assets d'une fiche de suivi : QR codes / codes-barres trouves dans les mails
 * des fils rattaches (bon de retrait Mondial Relay, code Colissimo/Pickup,
 * billet, code de validation...). DEUX sources :
 * - les PJ images des mails ;
 * - les IMAGES DISTANTES du corps HTML dont l'URL ressemble a un code
 *   (qr|barcode|aztec|datamatrix|pickuppass...) — la plupart des codes de
 *   retrait arrivent ainsi (ex: api/barcode/AztecCode de Pickup). On ne
 *   telecharge QUE ces URLs-la pour ne pas declencher les pixels de tracking.
 * Scan SANS LLM (jsqr en local, gratuit), incremental (PJ et URLs deja
 * examinees memorisees dans `assets.scanned` / `assets.scanned_urls`, jamais
 * re-telechargees). Les images distantes retenues sont embarquees en data URI
 * (jusqu'a EMBED_MAX_BYTES) pour rester visibles apres expiration de l'URL.
 * Declenche a l'ouverture de la fiche cote front (POST /tracking/assets/scan)
 * — best effort, jamais bloquant.
 */

import jsQR from "jsqr";
import { PNG } from "pngjs";
import * as jpeg from "jpeg-js";
import {
  getAttachmentsForMessage,
  getFileToken,
  getPbBaseUrl,
  getTrackingItem,
  listMessagesByThread,
  updateTrackingItem,
  type PBAttachment,
  type PBTrackingItem,
} from "./pocketbase";

export interface TrackingQrAsset {
  attachment: string; // id du record attachments ("" si image distante)
  message: string; // id du message d'origine
  file: string; // nom de fichier stocke (pour construire l'URL /api/files)
  filename: string; // nom d'origine de la PJ
  data: string; // contenu decode du QR ("" si non decodable, ex: Aztec)
  date: string; // date du message
  url?: string; // URL distante d'origine (image du corps HTML)
  image?: string; // data URI embarquee (survit a l'expiration de l'URL)
}

export interface TrackingAssets {
  scanned: string[]; // ids des PJ deja examinees (skip au prochain scan)
  scanned_urls?: string[]; // URLs distantes deja examinees
  qr: TrackingQrAsset[];
}

const MAX_FILE_BYTES = 8 * 1024 * 1024; // PJ image > 8 Mo : ignoree
const MAX_SCAN_PER_PASS = 30; // borne le nb de telechargements par scan
const MAX_SCANNED_MEMO = 400; // borne la liste `scanned` persistee
const MAX_QR = 12; // borne le nb de QR gardes sur une fiche
const FETCH_TIMEOUT_MS = 15000;
// Images distantes du corps HTML : on ne telecharge QUE les URLs qui ressemblent
// a un code scannable (jamais les autres -> pas de pixels de tracking declenches).
const CODE_URL_RE = /qr[-_]?code|[/?=&_-]qr[/?=&._-]|barcode|aztec|datamatrix|pickuppass|etiquette/i;
const MAX_REMOTE_PER_PASS = 12; // borne les telechargements distants par scan
const REMOTE_MAX_BYTES = 3 * 1024 * 1024; // image distante > 3 Mo : ignoree
const EMBED_MAX_BYTES = 40 * 1024; // au-dela on garde seulement l'URL distante
// jsqr travaille sur du RGBA plein : on reduit les grandes images (photos) a
// une taille raisonnable avant decodage (nearest neighbor, suffisant pour un QR).
const MAX_SIDE = 1600;

function parseAssets(item: PBTrackingItem): TrackingAssets {
  const raw = item.assets;
  const out: TrackingAssets = { scanned: [], qr: [] };
  if (!raw || typeof raw !== "object") return out;
  const o = raw as { scanned?: unknown; qr?: unknown };
  if (Array.isArray(o.scanned)) {
    out.scanned = o.scanned.filter((s): s is string => typeof s === "string");
  }
  const ou = (raw as { scanned_urls?: unknown }).scanned_urls;
  if (Array.isArray(ou)) {
    out.scanned_urls = ou.filter((s): s is string => typeof s === "string");
  }
  if (Array.isArray(o.qr)) {
    for (const q of o.qr) {
      if (!q || typeof q !== "object") continue;
      const a = q as Record<string, unknown>;
      if (typeof a.attachment !== "string" || typeof a.data !== "string") continue;
      out.qr.push({
        attachment: a.attachment,
        message: typeof a.message === "string" ? a.message : "",
        file: typeof a.file === "string" ? a.file : "",
        filename: typeof a.filename === "string" ? a.filename : "",
        data: a.data,
        date: typeof a.date === "string" ? a.date : "",
        ...(typeof a.url === "string" && a.url ? { url: a.url } : {}),
        ...(typeof a.image === "string" && a.image ? { image: a.image } : {}),
      });
    }
  }
  return out;
}

interface Rgba {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Decode PNG/JPEG -> RGBA (pur JS, pas de dependance native). */
function decodeImage(buf: Buffer, contentType: string, filename: string): Rgba | null {
  const ct = contentType.toLowerCase();
  const name = filename.toLowerCase();
  try {
    if (ct.includes("png") || name.endsWith(".png")) {
      const png = PNG.sync.read(buf);
      return {
        data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
        width: png.width,
        height: png.height,
      };
    }
    if (ct.includes("jpeg") || ct.includes("jpg") || /\.jpe?g$/.test(name)) {
      const img = jpeg.decode(buf, {
        useTArray: true,
        formatAsRGBA: true,
        maxMemoryUsageInMB: 256,
      });
      return {
        data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length),
        width: img.width,
        height: img.height,
      };
    }
  } catch {
    /* image corrompue / format exotique : ignoree */
  }
  return null;
}

/** Reduction nearest-neighbor si l'image depasse MAX_SIDE (photos de telephone). */
function downscale(img: Rgba): Rgba {
  const maxSide = Math.max(img.width, img.height);
  if (maxSide <= MAX_SIDE) return img;
  const ratio = MAX_SIDE / maxSide;
  const w = Math.max(1, Math.round(img.width * ratio));
  const h = Math.max(1, Math.round(img.height * ratio));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.round(y / ratio));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.round(x / ratio));
      const si = (sy * img.width + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = img.data[si + 3];
    }
  }
  return { data: out, width: w, height: h };
}

function isImageAttachment(a: PBAttachment): boolean {
  const ct = (a.content_type || "").toLowerCase();
  const name = (a.filename || "").toLowerCase();
  return (
    ct.startsWith("image/png") ||
    ct.startsWith("image/jpeg") ||
    ct.startsWith("image/jpg") ||
    name.endsWith(".png") ||
    /\.jpe?g$/.test(name)
  );
}

async function downloadAttachment(att: PBAttachment, token: string): Promise<Buffer | null> {
  try {
    const url = `${getPbBaseUrl()}/api/files/attachments/${att.id}/${encodeURIComponent(
      att.file
    )}?token=${token}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** URLs des <img> du corps HTML dont l'adresse ressemble a un code scannable
 * (QR / code-barres / Aztec). On ne remonte QUE celles-la : telecharger les
 * autres images declencherait les pixels de tracking du mail. */
function extractCodeImageUrls(html: string): string[] {
  if (!html) return [];
  const out: string[] = [];
  const re = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    // Entites HTML frequentes dans les URLs de mails (&amp;)
    const url = m[1].replace(/&amp;/g, "&").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (!CODE_URL_RE.test(url)) continue;
    if (!out.includes(url)) out.push(url);
    if (out.length >= 20) break;
  }
  return out;
}

/** Type MIME d'une image par ses magic bytes (PNG/JPEG/GIF), sinon "". */
function sniffImageType(buf: Buffer): string {
  if (buf.length < 4) return "";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  return "";
}

async function downloadRemoteImage(
  url: string
): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (iMiel)" },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > REMOTE_MAX_BYTES) return null;
    const sniffed = sniffImageType(buf);
    const headerType = (res.headers.get("content-type") || "").split(";")[0].trim();
    const contentType = sniffed || (headerType.startsWith("image/") ? headerType : "");
    if (!contentType) return null; // pas une image
    return { buf, contentType };
  } catch {
    return null;
  }
}

/** Cle de memo pour une URL distante (bornee, les URLs de mails sont longues). */
function urlMemoKey(url: string): string {
  return url.slice(0, 300);
}

// Un seul scan a la fois par fiche (l'ouverture repetee du detail ne doit pas
// empiler les telechargements).
const scanning = new Set<string>();

/**
 * Scanne les PJ images des fils d'une fiche a la recherche de QR codes.
 * Incremental : ne re-telecharge jamais une PJ deja examinee. Persiste le
 * resultat dans `tracking_items.assets` et le retourne.
 */
export async function scanTrackingAssets(itemId: string): Promise<TrackingAssets | null> {
  const item = await getTrackingItem(itemId);
  if (!item) return null;
  const assets = parseAssets(item);
  if (scanning.has(itemId)) return assets;
  scanning.add(itemId);
  try {
    // Tous les fils de la fiche (principal + rattaches)
    const threadIds = new Set<string>();
    if (item.thread_id) threadIds.add(item.thread_id);
    for (const t of Array.isArray(item.thread_ids) ? item.thread_ids : []) {
      if (t) threadIds.add(t);
    }

    // Candidats non encore examines : PJ images + images distantes "code" du corps
    const scanned = new Set(assets.scanned);
    const scannedUrls = new Set(assets.scanned_urls || []);
    const candidates: { att: PBAttachment; messageId: string; date: string }[] = [];
    const remoteCandidates: { url: string; messageId: string; date: string }[] = [];
    for (const tid of threadIds) {
      let messages;
      try {
        messages = await listMessagesByThread(tid);
      } catch {
        continue;
      }
      for (const m of messages) {
        for (const url of extractCodeImageUrls(m.html_body || "")) {
          if (scannedUrls.has(urlMemoKey(url))) continue;
          remoteCandidates.push({ url, messageId: m.id, date: m.date || "" });
        }
        if (!m.has_attachments) continue;
        let atts: PBAttachment[];
        try {
          atts = await getAttachmentsForMessage(m.id);
        } catch {
          continue;
        }
        for (const a of atts) {
          if (scanned.has(a.id)) continue;
          if (!isImageAttachment(a)) continue;
          if ((a.size || 0) > MAX_FILE_BYTES) continue;
          candidates.push({ att: a, messageId: m.id, date: m.date || "" });
        }
      }
    }
    if (candidates.length === 0 && remoteCandidates.length === 0) return assets;

    let token = "";
    if (candidates.length > 0) {
      try {
        token = await getFileToken();
      } catch {
        /* PJ inaccessibles : on tente quand meme les images distantes */
      }
    }

    let found = 0;

    // --- Images distantes "code" du corps HTML -------------------------------
    for (const c of remoteCandidates.slice(0, MAX_REMOTE_PER_PASS)) {
      scannedUrls.add(urlMemoKey(c.url));
      if (assets.qr.length >= MAX_QR) break;
      if (assets.qr.some((q) => q.url === c.url)) continue;
      const dl = await downloadRemoteImage(c.url);
      if (!dl) continue;
      // Decodage best effort (QR uniquement ; un Aztec/code-barres reste garde
      // sans contenu decode, l'URL a deja ete filtree comme "code")
      let data = "";
      const decoded = decodeImage(dl.buf, dl.contentType, "");
      if (decoded) {
        const img = downscale(decoded);
        try {
          const qr = jsQR(img.data, img.width, img.height);
          if (qr && qr.data) data = qr.data.trim().slice(0, 2000);
        } catch {
          /* non decodable : garde quand meme */
        }
      }
      assets.qr.push({
        attachment: "",
        message: c.messageId,
        file: "",
        filename: "",
        data,
        date: c.date,
        url: c.url,
        // Embarque l'image (les URLs de codes expirent) si raisonnable
        ...(dl.buf.length <= EMBED_MAX_BYTES
          ? { image: `data:${dl.contentType};base64,${dl.buf.toString("base64")}` }
          : {}),
      });
      found++;
    }
    // --- PJ images ------------------------------------------------------------
    for (const c of token ? candidates.slice(0, MAX_SCAN_PER_PASS) : []) {
      scanned.add(c.att.id);
      const buf = await downloadAttachment(c.att, token);
      if (!buf) continue;
      const decoded = decodeImage(buf, c.att.content_type || "", c.att.filename || "");
      if (!decoded) continue;
      const img = downscale(decoded);
      try {
        const qr = jsQR(img.data, img.width, img.height);
        if (qr && qr.data && qr.data.trim()) {
          if (!assets.qr.some((q) => q.attachment === c.att.id)) {
            assets.qr.push({
              attachment: c.att.id,
              message: c.messageId,
              file: c.att.file,
              filename: c.att.filename || "",
              data: qr.data.trim().slice(0, 2000),
              date: c.date,
            });
            found++;
          }
        }
      } catch {
        /* decodage QR rate : PJ quand meme marquee examinee */
      }
      if (assets.qr.length >= MAX_QR) break;
    }

    assets.scanned = Array.from(scanned).slice(-MAX_SCANNED_MEMO);
    assets.scanned_urls = Array.from(scannedUrls).slice(-MAX_SCANNED_MEMO);
    // Persiste (aussi quand rien trouve : le memo `scanned` evite de re-scanner)
    try {
      await updateTrackingItem(item.id, { assets });
    } catch (err) {
      console.warn("[tracking-assets] persist error:", err);
    }
    if (found > 0) {
      console.log(`[tracking-assets] ${found} QR code(s) trouves sur la fiche ${item.id}`);
    }
    return assets;
  } finally {
    scanning.delete(itemId);
  }
}
