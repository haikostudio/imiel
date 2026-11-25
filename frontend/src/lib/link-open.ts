/**
 * Ouverture des liens dans l'APPLICATION INSTALLEE (PWA en mode autonome).
 *
 * Sans barre de navigation, un lien de la MEME origine (piece jointe servie par
 * /api/files, lien `download`/`target=_blank`) remplace tout l'ecran par la page
 * de fichier du systeme, sans retour possible. Deux aiguilles :
 *  - "external" : autre site http(s) -> TOUJOURS le navigateur systeme (Safari
 *    sur iPhone, via x-safari-https://, cf safariSchemeUrl), meme si le site
 *    accepterait un cadre : decision utilisateur 2026-10-06 (le cadre et la
 *    fenetre web native d'iOS se comportaient mal) ;
 *  - "file"  : fichier de l'application -> tiroir de l'app, recu par fetch puis
 *    montre en blob: (un cadre vers une adresse servie en `attachment`
 *    relancerait le telechargement).
 * Onglet classique et app de bureau (Tauri) : rien ne change ("ignore").
 *
 * Fonctions PURES (testees dans __tests__/link-open.test.ts).
 */

export type LinkKind = "ignore" | "external" | "file";

/** Attribut pose sur les liens FABRIQUES par le code (ex. "Enregistrer" du
 * tiroir) : l'ecouteur global les laisse passer. */
export const LINK_VIEWER_SKIP_ATTR = "data-link-viewer-skip";

export interface ClassifyOptions {
  /** Origine de la page (window.location.origin). */
  origin: string;
  /** Adresse complete de la page (pour reperer un simple changement de fragment). */
  pageHref: string;
  /** Application installee (mode autonome) ? */
  standalone: boolean;
  /** App de bureau Tauri ? (garde l'ouverture systeme existante) */
  desktop: boolean;
  /** Origines qui servent aussi les fichiers de l'app (PocketBase). */
  fileOrigins?: string[];
  /** Le lien porte `download` ? */
  download?: boolean;
  /** Valeur de `target` du lien. */
  target?: string | null;
}

const FILE_PATH_RE = /^\/(api\/files|worker\/(attachments|files|draft-attachments))\//;

export function classifyLink(href: string, opts: ClassifyOptions): LinkKind {
  if (!opts.standalone || opts.desktop) return "ignore";
  const raw = (href || "").trim();
  if (!raw || raw.startsWith("#")) return "ignore";
  let url: URL;
  try {
    url = new URL(raw, opts.pageHref || opts.origin);
  } catch {
    return "ignore";
  }
  // blob:/data:/mailto:/tel:/javascript: -> jamais retenus. Filtrer sur le
  // PROTOCOLE : new URL("blob:https://site/x").origin rend l'origine du site.
  if (url.protocol !== "http:" && url.protocol !== "https:") return "ignore";

  const fileOrigins = new Set([opts.origin, ...(opts.fileOrigins || [])]);
  const sameOrigin = url.origin === opts.origin;
  if (sameOrigin || fileOrigins.has(url.origin)) {
    if (FILE_PATH_RE.test(url.pathname)) return "file";
    if (!sameOrigin) return "external";
    // Meme page, autre fragment : changement d'ecran du hash-router.
    try {
      const page = new URL(opts.pageHref);
      if (page.pathname === url.pathname && page.search === url.search) return "ignore";
    } catch {
      /* ignore */
    }
    if (opts.download || (opts.target || "").toLowerCase() === "_blank") return "file";
    return "ignore";
  }
  return "external";
}

/**
 * Adresse qui force l'ouverture dans Safari depuis une app installee iOS
 * (schema x-safari-https:// / x-safari-http://). Selon la version d'iOS le
 * schema peut etre ignore : l'appelant garde un repli (window.open).
 */
export function safariSchemeUrl(href: string): string | null {
  const m = /^(https?):\/\/(.+)$/i.exec((href || "").trim());
  if (!m) return null;
  return `x-safari-${m[1].toLowerCase()}://${m[2]}`;
}

/** Nom de fichier lu dans un en-tete Content-Disposition. */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
  if (plain) return (plain[1] ?? plain[2] ?? "").trim() || null;
  return null;
}

/** Nom lisible depuis l'adresse (dernier segment), a defaut d'en-tete. */
export function filenameFromUrl(href: string): string {
  try {
    const u = new URL(href);
    const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last);
  } catch {
    return "fichier";
  }
}

/** Domaine affiche dans l'en-tete du tiroir. */
export function displayHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

/** Ce que le tiroir sait montrer d'un fichier recu. */
export function previewKindFor(contentType: string): "image" | "pdf" | "text" | "video" | "other" {
  const ct = (contentType || "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct === "application/pdf") return "pdf";
  if (ct.startsWith("video/") || ct.startsWith("audio/")) return "video";
  if (ct.startsWith("text/") || ct === "application/json") return "text";
  return "other";
}
