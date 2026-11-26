// iMiel Cloud : ou est le serveur de transfert, et l'appareil y est-il relie ?
//
// Trois apps parlent au serveur de transfert (cloud/ du depot) :
//   - l'app d'ordinateur en mode Cloud (Tauri pose window.__IMIEL_CLOUD__) ;
//   - l'app iPhone (copie locale embarquee, coquille native) ;
//   - l'app web installable (donnees gardees dans le navigateur,
//     window.__IMIEL_WEB__ pose par lib/cloud/web-store).
// Partout ailleurs (serveur iMiel de l'editeur, version gratuite), rien ne
// change.

export const CLOUD_URL_DEFAUT = process.env.NEXT_PUBLIC_IMIEL_CLOUD_URL || "https://sync.getimiel.com";

const CLE_SESSION = "imiel:cloud:session";
const CLE_URL = "imiel:cloud:url";

export interface CloudSession {
  jeton: string;
  appareilId: string;
  email: string;
}

type FenetreCloud = {
  __IMIEL_CLOUD__?: boolean;
  __IMIEL_CLOUD_URL__?: string;
  __IMIEL_WEB__?: boolean;
  __IMIEL_LOCAL__?: boolean;
  Capacitor?: { isNativePlatform?: () => boolean };
};

const w = (): FenetreCloud | null => (typeof window === "undefined" ? null : (window as unknown as FenetreCloud));

export function cloudUrl(): string {
  const f = w();
  const choisi = f?.__IMIEL_CLOUD_URL__ || (f ? safeGet(CLE_URL) : null);
  return String(choisi || CLOUD_URL_DEFAUT).replace(/\/+$/, "");
}

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

/** Application iPhone embarquee (copie locale). */
export function estIphoneLocal(): boolean {
  const f = w();
  if (!f?.__IMIEL_LOCAL__) return false;
  try {
    return !!f.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

/** App web installable (donnees dans le navigateur). */
export function estAppWeb(): boolean {
  return w()?.__IMIEL_WEB__ === true;
}

/** Ordinateur en mode iMiel Cloud. */
export function estOrdinateurCloud(): boolean {
  return w()?.__IMIEL_CLOUD__ === true;
}

/** Cette app fonctionne avec iMiel Cloud (relie ou pas encore). */
export function cloudDisponible(): boolean {
  return estOrdinateurCloud() || estIphoneLocal() || estAppWeb();
}

export function genreAppareil(): "ordinateur" | "iphone" | "web" {
  if (estIphoneLocal()) return "iphone";
  if (estAppWeb()) return "web";
  return "ordinateur";
}

export function lireSession(): CloudSession | null {
  if (!w()) return null;
  try {
    const s = JSON.parse(safeGet(CLE_SESSION) || "null");
    return s && s.jeton ? (s as CloudSession) : null;
  } catch {
    return null;
  }
}

export function ecrireSession(s: CloudSession | null): void {
  try {
    if (s) localStorage.setItem(CLE_SESSION, JSON.stringify(s));
    else localStorage.removeItem(CLE_SESSION);
  } catch {
    /* stockage indisponible */
  }
}

/** L'appareil est relie a iMiel Cloud : le courrier passe par le serveur de transfert. */
export function modeCloud(): boolean {
  return cloudDisponible() && !!lireSession();
}
