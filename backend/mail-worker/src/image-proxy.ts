/**
 * Proxy des images distantes des mails.
 *
 * Les images d'un mail recu s'affichent d'office, mais le navigateur ne les
 * demande JAMAIS a l'expediteur : le frontend fait signer chaque URL
 * (POST /image-proxy/sign, jeton PocketBase de l'utilisateur), puis l'iframe
 * du mail charge /worker/image-proxy/img?u=&e=&s=. Le worker :
 *   1. verifie la signature HMAC (cle derivee d'ENCRYPTION_KEY) et l'expiration ;
 *   2. telecharge l'image en refusant toute adresse interne (IP privee,
 *      loopback, link-local, metadonnees...), y compris apres redirection et
 *      contre le DNS rebinding (la connexion se fait sur l'IP verifiee) ;
 *   3. controle le VRAI type par les octets magiques (JPEG, PNG, GIF, WebP,
 *      AVIF ; SVG refuse : c'est du code) ;
 *   4. REDESSINE l'image avec sharp (decodage complet puis re-encodage WebP,
 *      metadonnees retirees) : tout contenu cache (donnees apres la fin de
 *      l'image, EXIF, charge utile polyglotte) disparait ;
 *   5. met le resultat en cache disque (cle sha256(url), 7 jours).
 * Une image refusee ou introuvable rend un petit cadre neutre (200 +
 * X-Image-Rejected) : jamais d'icone cassee ni de script dans l'iframe.
 *
 * L'expediteur ne voit que le serveur (ni IP, ni appareil, ni cookie, ni
 * Referer). Les pixels espions sont retires cote frontend AVANT signature
 * (sanitize.ts : isSpyImage), ils ne sont donc jamais demandes.
 */
import crypto from "crypto";
import dns from "dns";
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import os from "os";
import path from "path";
import sharp from "sharp";

// --- Reglages ---

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_URL_LENGTH = 4096;
/** Validite d'une URL signee, arrondie au jour : l'URL reste stable (cache navigateur). */
const SIGN_TTL_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const CACHE_MAX_BYTES = 1024 * 1024 * 1024;
/** Re-encodages simultanes : une newsletter porte souvent 50+ images. */
const MAX_CONCURRENT_TRANSCODES = 2;
const USER_AGENT = "Mozilla/5.0 (compatible; iMiel-ImageProxy/1.0)";

sharp.cache(false);
sharp.concurrency(1);

// --- Signature ---

function signingKey(): Buffer {
  return crypto
    .createHash("sha256")
    .update(`haikomail-image-proxy:${process.env.ENCRYPTION_KEY || ""}`)
    .digest();
}

function hmac(url: string, exp: number): string {
  return crypto
    .createHmac("sha256", signingKey())
    .update(`${exp}.${url}`)
    .digest("base64url")
    .slice(0, 32);
}

/** Normalise une URL d'image distante (http/https uniquement) ; null sinon. */
export function normalizeRemoteUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim();
  if (!v || v.length > MAX_URL_LENGTH) return null;
  if (v.startsWith("//")) v = `https:${v}`;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  return u.toString();
}

/** Chemin signe servi au frontend (prefixe /worker par le rewrite Next). */
export function signImageUrl(url: string, now = Date.now()): string {
  const exp = Math.ceil((now + SIGN_TTL_MS) / DAY_MS) * DAY_MS;
  const u = Buffer.from(url, "utf8").toString("base64url");
  return `/worker/image-proxy/img?u=${u}&e=${exp}&s=${hmac(url, exp)}`;
}

/** URL d'origine si la signature est valide et non expiree ; null sinon. */
export function verifySignedParams(
  u: unknown,
  e: unknown,
  s: unknown,
  now = Date.now()
): string | null {
  if (typeof u !== "string" || typeof e !== "string" || typeof s !== "string") return null;
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < now) return null;
  let url: string;
  try {
    url = Buffer.from(u, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = hmac(url, exp);
  const a = Buffer.from(expected);
  const b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return normalizeRemoteUrl(url) === url ? url : null;
}

// --- Adresses interdites (SSRF) ---

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(addr, prefix, "ipv6");
}

/** Vrai si l'IP est interne/reservee (refusee par le proxy). */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4 mappee (::ffff:a.b.c.d) ou compatible : juger l'IPv4 dessous.
    const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    if (lower.startsWith("::ffff:")) return true;
    return blocked.check(ip, "ipv6");
  }
  return true;
}

export class ImageRejected extends Error {}

/**
 * Resolution DNS filtree : la connexion se fait sur l'IP qu'on vient de
 * verifier (pas de seconde resolution exploitable par DNS rebinding).
 */
function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    const ok = list.filter((a) => !isBlockedIp(a.address));
    if (!ok.length || ok.length !== list.length) {
      return callback(new ImageRejected(`blocked address for ${hostname}`), "", 0);
    }
    if (options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

function fetchOnce(url: URL): Promise<{ status: number; location?: string; body?: Buffer; type?: string }> {
  return new Promise((resolve, reject) => {
    // Une IP litterale ne passe pas par lookup : on la juge ici.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isBlockedIp(host)) {
      reject(new ImageRejected("blocked address"));
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.get(
      url,
      {
        lookup: safeLookup as unknown as typeof dns.lookup,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
        },
        timeout: FETCH_TIMEOUT_MS,
        agent: false,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, location: res.headers.location });
          return;
        }
        if (status !== 200) {
          res.resume();
          resolve({ status });
          return;
        }
        const declared = Number(res.headers["content-length"] || 0);
        if (declared > MAX_BYTES) {
          res.destroy();
          reject(new ImageRejected("too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > MAX_BYTES) {
            res.destroy();
            reject(new ImageRejected("too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks), type: String(res.headers["content-type"] || "") }));
        res.on("error", reject);
      }
    );
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), FETCH_TIMEOUT_MS);
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** Telecharge une image distante en suivant au plus MAX_REDIRECTS redirections, chacune re-verifiee. */
export async function fetchRemoteImage(url: string): Promise<Buffer> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new ImageRejected("bad protocol");
    }
    const r = await fetchOnce(current);
    if (r.location) {
      current = new URL(r.location, current);
      continue;
    }
    if (r.status !== 200 || !r.body) throw new ImageRejected(`status ${r.status}`);
    return r.body;
  }
  throw new ImageRejected("too many redirects");
}

// --- Controle du type reel + redessin ---

export type ImageKind = "jpeg" | "png" | "gif" | "webp" | "avif";

/** Type reel d'apres les octets magiques ; null = pas une image acceptee (SVG, HTML, script...). */
export function sniffImageType(buf: Buffer): ImageKind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  const head6 = buf.subarray(0, 6).toString("latin1");
  if (head6 === "GIF87a" || head6 === "GIF89a") return "gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return "avif";
  }
  return null;
}

const SHARP_FORMATS: Record<ImageKind, string> = {
  jpeg: "jpeg",
  png: "png",
  gif: "gif",
  webp: "webp",
  avif: "heif",
};

let active = 0;
const waiters: Array<() => void> = [];
async function withTranscodeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_TRANSCODES) {
    await new Promise<void>((r) => waiters.push(r));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/**
 * Decode completement puis re-encode en WebP (animation conservee pour les
 * GIF/WebP animes). Aucun octet de l'original ne survit : metadonnees,
 * donnees ajoutees apres la fin de l'image ou charge cachee sont perdues.
 */
export async function reencodeImage(buf: Buffer): Promise<Buffer> {
  const kind = sniffImageType(buf);
  if (!kind) throw new ImageRejected("not an accepted image type");
  return withTranscodeSlot(async () => {
    const opts = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" as const };
    const meta = await sharp(buf, opts).metadata();
    if (meta.format !== SHARP_FORMATS[kind]) throw new ImageRejected("format mismatch");
    if (!meta.width || !meta.height) throw new ImageRejected("no dimensions");
    const animated = (meta.pages || 1) > 1 && (kind === "gif" || kind === "webp");
    let img = sharp(buf, { ...opts, animated });
    // L'orientation EXIF est appliquee avant que les metadonnees ne disparaissent.
    if (!animated) img = img.rotate();
    return img.webp({ quality: 85, alphaQuality: 100, effort: 3 }).toBuffer();
  });
}

let placeholder: Promise<Buffer> | null = null;
/** Petit cadre neutre rendu a la place d'une image refusee ou introuvable. */
export function rejectedPlaceholder(): Promise<Buffer> {
  if (!placeholder) {
    placeholder = sharp({
      create: { width: 48, height: 36, channels: 4, background: { r: 228, g: 228, b: 231, alpha: 0.6 } },
    })
      .png()
      .toBuffer();
  }
  return placeholder;
}

// --- Cache disque ---

function cacheDir(): string {
  if (process.env.IMAGE_PROXY_CACHE_DIR) return process.env.IMAGE_PROXY_CACHE_DIR;
  if (process.env.EMBEDDINGS_CACHE_PATH) {
    return path.join(path.dirname(process.env.EMBEDDINGS_CACHE_PATH), "image-proxy");
  }
  return path.join(os.tmpdir(), "imiel-image-proxy");
}

let cacheReady: Promise<string | null> | null = null;
function ensureCacheDir(): Promise<string | null> {
  if (!cacheReady) {
    const dir = cacheDir();
    cacheReady = fs.promises
      .mkdir(dir, { recursive: true })
      .then(() => dir)
      .catch((err) => {
        console.warn(`[image-proxy] cache disque indisponible (${dir}):`, (err as Error).message);
        return null;
      });
  }
  return cacheReady;
}

function cacheKey(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex");
}

async function readCache(url: string): Promise<Buffer | null> {
  const dir = await ensureCacheDir();
  if (!dir) return null;
  const file = path.join(dir, `${cacheKey(url)}.webp`);
  try {
    const st = await fs.promises.stat(file);
    if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null;
    return await fs.promises.readFile(file);
  } catch {
    return null;
  }
}

async function writeCache(url: string, data: Buffer): Promise<void> {
  const dir = await ensureCacheDir();
  if (!dir) return;
  const file = path.join(dir, `${cacheKey(url)}.webp`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
  } catch {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

/** Purge : fichiers de plus de 7 jours, puis les plus anciens au-dela de 1 Go. */
export async function pruneImageCache(): Promise<void> {
  const dir = await ensureCacheDir();
  if (!dir) return;
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  const live: Array<{ file: string; mtime: number; size: number }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fs.promises.stat(file);
      if (now - st.mtimeMs > CACHE_TTL_MS || name.endsWith(".tmp")) {
        await fs.promises.unlink(file).catch(() => {});
      } else {
        live.push({ file, mtime: st.mtimeMs, size: st.size });
      }
    } catch {
      /* fichier disparu entre-temps */
    }
  }
  let total = live.reduce((n, f) => n + f.size, 0);
  if (total <= CACHE_MAX_BYTES) return;
  live.sort((a, b) => a.mtime - b.mtime);
  for (const f of live) {
    if (total <= CACHE_MAX_BYTES) break;
    await fs.promises.unlink(f.file).catch(() => {});
    total -= f.size;
  }
}

// --- Point d'entree ---

/** Echecs recents (introuvable, refuse) : pas de nouvel essai pendant 1 h. */
const recentFailures = new Map<string, number>();
const FAILURE_TTL_MS = 3600 * 1000;
const inflight = new Map<string, Promise<Buffer | null>>();

/** Image redessinee (WebP) ou null si refusee/introuvable. */
export function getProxiedImage(url: string): Promise<Buffer | null> {
  const failedAt = recentFailures.get(url);
  if (failedAt && Date.now() - failedAt < FAILURE_TTL_MS) return Promise.resolve(null);
  const running = inflight.get(url);
  if (running) return running;
  const job = (async () => {
    const cached = await readCache(url);
    if (cached) return cached;
    try {
      const raw = await fetchRemoteImage(url);
      const out = await reencodeImage(raw);
      await writeCache(url, out);
      return out;
    } catch (err) {
      if (recentFailures.size > 5000) recentFailures.clear();
      recentFailures.set(url, Date.now());
      if (!(err instanceof ImageRejected)) {
        console.warn(`[image-proxy] echec ${new URL(url).host}:`, (err as Error).message);
      }
      return null;
    }
  })().finally(() => inflight.delete(url));
  inflight.set(url, job);
  return job;
}
