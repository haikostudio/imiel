/**
 * Origine utilisee pour construire le redirect_uri OAuth Google.
 *
 * Par defaut on prend l'origine reelle du navigateur (correct en prod et pour
 * un service multi-utilisateurs public). Mais un environnement (ex: instance
 * dev sur un domaine sslip.io non declare dans la console Google) peut forcer
 * une origine deja autorisee via NEXT_PUBLIC_OAUTH_REDIRECT_ORIGIN, pour eviter
 * un redirect_uri_mismatch sans avoir a whitelister chaque domaine.
 */
export function getOAuthRedirectOrigin(): string {
  const override = process.env.NEXT_PUBLIC_OAUTH_REDIRECT_ORIGIN;
  if (override && override.trim()) return override.trim().replace(/\/+$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}
