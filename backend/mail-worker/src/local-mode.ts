// Mode LOCAL (app d'ordinateur tout-en-un) : le worker tourne sur la machine
// de l'utilisateur, lance par le lanceur de l'app (desktop/pile/lanceur.mjs).
//
// Menace visee : une PAGE WEB ouverte dans le navigateur de l'utilisateur qui
// tenterait d'appeler http://127.0.0.1:<port>/... (CSRF, DNS rebinding). Un
// programme local du meme utilisateur n'est pas dans le perimetre : il lit
// deja les fichiers de donnees directement.
//
// Gardes (actives seulement si IMIEL_LOCAL=1) :
//   - ecoute sur 127.0.0.1 uniquement (HOST, voir index.ts) ;
//   - en-tete Host limite a 127.0.0.1 / localhost (bloque le DNS rebinding) ;
//   - en-tete Origin, s'il est present, limite a l'origine de l'app
//     (IMIEL_APP_ORIGIN) : un navigateur envoie toujours Origin sur un appel
//     d'une autre origine ; les appels serveur->worker (Next, pb_hooks) n'en
//     ont pas ;
//   - CORS restreint a cette meme origine (au lieu de cors(*)).
import type { NextFunction, Request, Response } from "express";

export function isLocalMode(): boolean {
  return process.env.IMIEL_LOCAL === "1";
}

/** Origine de l'interface locale (http://127.0.0.1:<port>), sans / final. */
export function localAppOrigin(): string {
  return (process.env.IMIEL_APP_ORIGIN || "").replace(/\/+$/, "");
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Nom d'hote d'un en-tete Host (sans port), en minuscules. */
export function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.indexOf(":");
  return colon >= 0 ? h.slice(0, colon) : h;
}

/**
 * Decide si une requete est acceptee en mode local. Fonction pure (testee).
 * `origin` vide = appel sans navigateur (serveur Next, pb_hooks, curl local).
 */
export function localRequestAllowed(
  host: string | undefined,
  origin: string | undefined,
  appOrigin: string
): { ok: true } | { ok: false; reason: string } {
  if (!LOCAL_HOSTS.has(hostnameOf(host))) {
    return { ok: false, reason: "hote refuse" };
  }
  const o = (origin || "").trim().replace(/\/+$/, "");
  if (o && o !== "null" && appOrigin && o === appOrigin) return { ok: true };
  if (o) return { ok: false, reason: "origine refusee" };
  return { ok: true };
}

/** Middleware Express des gardes locales (no-op hors mode local). */
export function localGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isLocalMode()) {
    next();
    return;
  }
  const verdict = localRequestAllowed(
    req.headers.host,
    typeof req.headers.origin === "string" ? req.headers.origin : undefined,
    localAppOrigin()
  );
  if (!verdict.ok) {
    res.status(403).json({ error: verdict.reason });
    return;
  }
  next();
}

/** Options CORS : origine de l'app seule en local, toutes ailleurs (inchange). */
export function corsOptions(): { origin: string | boolean } {
  if (!isLocalMode()) return { origin: true };
  const o = localAppOrigin();
  return { origin: o || false };
}

/** Adresse d'ecoute : 127.0.0.1 en local (ou HOST), toutes interfaces sinon. */
export function listenHost(): string | undefined {
  if (process.env.HOST) return process.env.HOST;
  return isLocalMode() ? "127.0.0.1" : undefined;
}

/** Service desactive explicitement (valeur "off" / vide en mode local). */
export function serviceDisabled(envValue: string | undefined): boolean {
  const v = (envValue ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return true;
  return isLocalMode() && envValue !== undefined && v === "";
}
