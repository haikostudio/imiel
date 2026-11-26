// Helpers client : detection du systeme d'exploitation (pour proposer le bon
// binaire) et detection du fait qu'on tourne deja DANS l'app de bureau Tauri
// (pour masquer la banniere de telechargement).

export type DesktopPlatform = "windows" | "mac" | "linux";
export type DetectedOs = DesktopPlatform | "unknown";

// Vrai dans la coquille native iMiel (application iPhone Capacitor), y compris
// quand cette application iPhone tourne sur un Mac Apple Silicon : sa vue web
// annonce alors "Macintosh" dans son user agent, ce qui faisait proposer l'app
// de bureau a quelqu'un qui est deja dans une app iMiel. Deux signaux :
// window.Capacitor (injecte par la coquille) et le suffixe "iMielApp/" ajoute
// au user agent (mobile/capacitor.config.json, appendUserAgent).
export function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const c = (window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  try {
    if (c?.isNativePlatform?.()) return true;
  } catch {
    // ignore : on se rabat sur le user agent
  }
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  return /\biMielApp\//i.test(ua);
}

// Systeme pour lequel proposer l'app de bureau. "unknown" = ne rien proposer :
// mobile, ou deja dans une app iMiel (bureau Tauri ou coquille native).
export function detectOs(): DetectedOs {
  if (typeof navigator === "undefined") return "unknown";
  if (isNativeShell() || isDesktopApp()) return "unknown";
  const ua = (navigator.userAgent || "").toLowerCase();
  // navigator.platform est deprecie mais reste fiable pour cette distinction.
  const plat = (navigator.platform || "").toLowerCase();
  if (/iphone|ipad|ipod|android/.test(ua)) return "unknown"; // mobile : pas d'app bureau
  if (plat.includes("mac") || ua.includes("mac")) return "mac";
  if (plat.includes("win") || ua.includes("win")) return "windows";
  if (plat.includes("linux") || ua.includes("linux")) return "linux";
  return "unknown";
}

// L'app de bureau injecte window.__IMIEL_DESKTOP__ via un script
// d'initialisation Tauri (cf desktop/src-tauri/src/main.rs). L'ancienne app
// (nom HaikoMail, encore installee chez certains) pose __HAIKOMAIL_DESKTOP__.
export function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as {
    __IMIEL_DESKTOP__?: boolean;
    __HAIKOMAIL_DESKTOP__?: boolean;
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return (
    w.__IMIEL_DESKTOP__ === true ||
    w.__HAIKOMAIL_DESKTOP__ === true ||
    !!w.__TAURI_INTERNALS__ ||
    !!w.__TAURI__
  );
}

// App d'ordinateur en mode « Sur cet ordinateur » (pile locale) : le script
// d'initialisation pose window.__IMIEL_LOCAL__ (desktop/src-tauri/src/pile.rs).
export function isLocalApp(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as { __IMIEL_LOCAL__?: boolean }).__IMIEL_LOCAL__ === true;
}

// L'app tourne-t-elle en PWA installee (mode standalone) ? Sur iOS/Android le
// mode standalone ouvre par defaut les liens target="_blank" dans un volet de
// navigation interne au lieu du navigateur systeme.
export function isPwaStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as unknown as { standalone?: boolean };
  return (
    nav.standalone === true ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches)
  );
}

// Faut-il intercepter les liens externes pour les rediriger vers le navigateur
// systeme ? Oui dans l'app de bureau (sinon un clic ne fait rien) et en PWA
// installee (sinon ca ouvre un volet interne). En onglet navigateur classique
// on laisse le comportement natif (nouvel onglet).
export function shouldInterceptExternalLinks(): boolean {
  return isDesktopApp() || isPwaStandalone();
}

// Ouvre une URL dans le navigateur systeme par defaut.
// - App de bureau (Tauri) : via le plugin opener (window.__TAURI__ expose par
//   withGlobalTauri) -> ouvre Chrome/Safari/navigateur par defaut de l'OS.
// - PWA / navigateur : window.open dans un nouvel onglet (le navigateur
//   systeme depuis une PWA standalone).
export function openExternalUrl(url: string): void {
  if (typeof window === "undefined" || !url) return;
  if (isDesktopApp()) {
    const t = (window as unknown as {
      __TAURI__?: { core?: { invoke?: (cmd: string, args?: unknown) => unknown } };
    }).__TAURI__;
    const invoke = t?.core?.invoke;
    if (typeof invoke === "function") {
      try {
        invoke("plugin:opener|open_url", { path: url });
        return;
      } catch {
        // repli navigateur ci-dessous
      }
    }
  }
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    window.location.href = url;
  }
}

export function osLabel(os: DetectedOs): string {
  switch (os) {
    case "mac":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "";
  }
}

export function formatBytes(n: number): string {
  if (!n) return "";
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} Mo`;
  return `${Math.max(1, Math.round(n / 1024))} Ko`;
}

export interface DesktopAssetInfo {
  name: string;
  kind: string;
  size: number;
}
export interface LatestReleaseInfo {
  available: boolean;
  reason?: string;
  version?: string;
  tag?: string;
  publishedAt?: string | null;
  assets?: Record<DesktopPlatform, DesktopAssetInfo[]>;
}

let cached: Promise<LatestReleaseInfo> | null = null;

export function fetchLatestRelease(): Promise<LatestReleaseInfo> {
  if (cached) return cached;
  cached = fetch("/api/desktop/latest", { cache: "no-store" })
    .then((r) => r.json() as Promise<LatestReleaseInfo>)
    .catch(() => ({ available: false, reason: "fetch-error" }));
  return cached;
}

export function downloadUrl(platform: DesktopPlatform, kind?: string): string {
  const q = new URLSearchParams({ platform });
  if (kind) q.set("kind", kind);
  return `/api/desktop/download?${q.toString()}`;
}
