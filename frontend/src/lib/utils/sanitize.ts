import DOMPurify from "dompurify";

/**
 * Decode les entites HTML et supprime les caracteres de remplacement U+FFFD.
 * Utilise pour nettoyer les sujets, snippets et noms d'expediteurs avant affichage.
 */
// Reverse map for Windows-1252 specific characters (bytes 0x80-0x9F), used to
// recover the original byte when UTF-8 was wrongly decoded as Windows-1252.
const CP1252_REVERSE: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

const MOJIBAKE_MARKER = /[ÂÃâ]/;

/**
 * Repare le "mojibake": des octets UTF-8 decodes par erreur en
 * Latin-1/Windows-1252, produisant des sequences comme "â€™", "Ã©", "Â£"
 * (l'apostrophe U+2019 = E2 80 99 devient "â€™"). Re-encode la chaine vers ses
 * octets d'origine et les decode en UTF-8. Validation stricte (decode UTF-8
 * fatal) pour ne jamais corrompre un texte correctement encode.
 */
export function fixMojibake(text: string): string {
  if (!text || !MOJIBAKE_MARKER.test(text)) return text;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0xff) {
      bytes[i] = code;
    } else if (CP1252_REVERSE[code] !== undefined) {
      bytes[i] = CP1252_REVERSE[code];
    } else {
      return text; // vrai caractere Unicode -> pas du mojibake
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return text; // pas de l'UTF-8 valide une fois re-encode -> on garde
  }
}

export function stripReplacementChars(text: string): string {
  if (!text) return text;
  text = fixMojibake(text);
  const namedEntities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00A0",
  };
  return text
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => namedEntities[name.toLowerCase()] ?? _)
    .replace(/\uFFFD/g, "");
}

/**
 * Configuration DOMPurify pour le rendu sécurisé des emails HTML.
 * - Supprime les scripts et gestionnaires d'événements
 * - Images distantes servies par le proxy du worker (verifiees + redessinees),
 *   pixels espions retires, images a adresse relative introuvables retirees
 * - Autorise les balises HTML courantes pour les emails
 */
const ALLOWED_TAGS = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];

const ALLOWED_ATTR = [
  "href",
  "src",
  "alt",
  "title",
  "width",
  "height",
  "style",
  "class",
  "colspan",
  "rowspan",
  "cellpadding",
  "cellspacing",
  "border",
  "align",
  "valign",
  "bgcolor",
  "color",
  "dir",
  "target",
];

interface SanitizeOptions {
  /**
   * Garde les images distantes TELLES QUELLES (contenu propre a l'utilisateur :
   * brouillon, signature). Les pixels espions sont retires quand meme.
   */
  allowExternalImages?: boolean;
  /** Sources d'images toujours autorisees (ex. fichiers joints PocketBase). */
  trustedImageSrc?: (src: string) => boolean;
  /**
   * Adresse proxy (worker image-proxy, signee) d'une image distante, ou
   * null si elle n'est pas (encore) signee. Sans cette option (dossier
   * indesirables, resume IA...), aucune image distante n'est chargee.
   */
  proxyImageSrc?: (url: string) => string | null | undefined;
}

// --- Images espions (pixels de suivi d'ouverture) ---

// Chemins des pixels d'ouverture des routeurs courants. Liste courte et
// prudente : une vraie image n'y ressemble pas (la taille et le masquage
// attrapent le reste).
const SPY_URL_PATTERNS: RegExp[] = [
  /\/track(?:ing)?\/open/i,
  /\/trk\/open/i,
  /\/wf\/open/i, // SendGrid
  /\/open\.(?:gif|png|php|aspx?)\b/i,
  /\/o\.gif\b/i,
  /\/tr\/op\//i, // Brevo
  /mjt\.lu\/oo\//i, // Mailjet
  /__ptq\.gif/i, // HubSpot
  /\/e\/o\//i, // Customer.io
  /\/emimp\//i, // LinkedIn
  /\/beacon(?:[/.?]|$)/i,
  /\/pixel(?:\.gif|\.png|[/?]|$)/i,
  /google-analytics\.com\/collect/i,
];

/** Dimension en pixels d'un attribut ou d'une propriete CSS ; null si absente/relative. */
function pxDimension(img: Element, prop: "width" | "height"): number | null {
  const style = img.getAttribute("style") || "";
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([\\d.]+)\\s*(px)?\\s*(?:!important)?\\s*(?:;|$)`, "i"));
  const raw = m ? m[1] : img.getAttribute(prop);
  if (raw == null || raw === "" || /%/.test(raw)) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** Vrai pour un pixel de suivi d'ouverture : minuscule, masque ou adresse connue. */
export function isSpyImage(img: Element): boolean {
  const src = img.getAttribute("src") || "";
  if (src.includes("/track/open/")) return true;
  const w = pxDimension(img, "width");
  const h = pxDimension(img, "height");
  if (w !== null && h !== null && w <= 2 && h <= 2) return true;
  if ((w !== null && w <= 2 && h === null) || (h !== null && h <= 2 && w === null)) return true;
  const style = (img.getAttribute("style") || "").toLowerCase().replace(/\s+/g, "");
  if (/display:none|visibility:hidden|(?:^|;)opacity:0(?:\.0+)?(?:;|$)|max-height:0(?:px)?(?:;|$)/.test(style)) {
    return true;
  }
  if (/^(?:https?:)?\/\//i.test(src) && SPY_URL_PATTERNS.some((re) => re.test(src))) return true;
  return false;
}

/** Adresse http(s) absolue d'une image distante ("//x" -> https) ; null sinon. */
export function remoteImageUrl(src: string): string | null {
  const v = src.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("//")) return `https:${v}`;
  return null;
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

/**
 * Adresses des images distantes a faire signer pour ce HTML (img + fonds
 * CSS), pixels espions exclus : ceux-la ne sont jamais demandes.
 */
export function collectRemoteImageUrls(html: string): string[] {
  if (typeof window === "undefined" || !html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = new Set<string>();
  for (const img of doc.querySelectorAll("img")) {
    if (isSpyImage(img)) continue;
    const url = remoteImageUrl(img.getAttribute("src") || "");
    if (url) out.add(url);
  }
  for (const el of doc.querySelectorAll("[style]")) {
    for (const m of (el.getAttribute("style") || "").matchAll(CSS_URL_RE)) {
      const url = remoteImageUrl(m[2]);
      if (url) out.add(url);
    }
  }
  return [...out];
}

function isLocalImageSrc(src: string, trusted?: (src: string) => boolean): boolean {
  if (/^(?:data:image\/|blob:)/i.test(src)) return true;
  if (src.startsWith("/worker/image-proxy/")) return true;
  if (typeof window !== "undefined" && src.startsWith(`${window.location.origin}/worker/image-proxy/`)) return true;
  return !!trusted && trusted(src);
}

/** Cadre neutre d'une image distante non chargee (indesirables, non signee). */
function markBlocked(img: Element): void {
  img.setAttribute("src", "");
  img.setAttribute("alt", img.getAttribute("alt") ?? "[Image externe bloquée]");
  img.setAttribute("title", "Image externe bloquée pour votre sécurité");
  img.setAttribute(
    "style",
    "background: var(--muted); border: 1px dashed var(--border); min-width: 100px; min-height: 40px; display: inline-block;"
  );
}

/**
 * Nettoie du HTML pour un rendu sécurisé dans le navigateur.
 * Images distantes : jamais demandees directement a l'expediteur (proxy
 * signe ou cadre neutre), pixels espions retires, images a adresse relative
 * (introuvables chez nous) retirees pour ne pas montrer d'icone cassee.
 */
export function sanitizeHtml(
  html: string,
  options: SanitizeOptions = {}
): string {
  const { allowExternalImages = false, trustedImageSrc, proxyImageSrc } = options;

  const clean = DOMPurify.sanitize(stripReplacementChars(html), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: [
      "onerror",
      "onload",
      "onclick",
      "onmouseover",
      "onfocus",
      "onblur",
    ],
  });

  const parser = new DOMParser();
  const doc = parser.parseFromString(clean, "text/html");

  // Forcer les liens a s'ouvrir dans un nouvel onglet
  const links = doc.querySelectorAll("a");
  for (const link of links) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }

  // Pixels espions (dont NOTRE pixel de suivi de lecture, injecte a l'envoi
  // SMTP : relire son propre mail envoye ne doit JAMAIS compter comme une
  // lecture du destinataire) : retires, jamais demandes.
  for (const img of doc.querySelectorAll("img")) {
    if (isSpyImage(img)) img.remove();
  }

  if (allowExternalImages) return doc.body.innerHTML;

  for (const img of doc.querySelectorAll("img")) {
    const src = (img.getAttribute("src") ?? "").trim();
    if (isLocalImageSrc(src, trustedImageSrc)) continue;
    const remote = remoteImageUrl(src);
    if (!remote) {
      // Adresse relative ("/illustration.png"), cid: non resolu, vide... :
      // rien a servir chez nous -> retiree plutot qu'une icone cassee.
      img.remove();
      continue;
    }
    const proxied = proxyImageSrc?.(remote);
    if (proxied) img.setAttribute("src", proxied);
    else markBlocked(img);
  }

  // Fonds CSS distants : meme regle (proxy, sinon retires).
  for (const el of doc.querySelectorAll("[style]")) {
    const style = el.getAttribute("style") || "";
    const next = style.replace(CSS_URL_RE, (full, _q: string, raw: string) => {
      if (isLocalImageSrc(raw.trim(), trustedImageSrc)) return full;
      const remote = remoteImageUrl(raw);
      const proxied = remote ? proxyImageSrc?.(remote) : null;
      return proxied ? `url("${proxied}")` : "none";
    });
    if (next !== style) el.setAttribute("style", next);
  }

  return doc.body.innerHTML;
}
