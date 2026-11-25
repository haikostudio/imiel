"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode, type AnchorHTMLAttributes } from "react";

// --- Route definitions ---

interface RouteDefinition {
  pattern: string;
  name: string;
}

const ROUTES: RouteDefinition[] = [
  { pattern: "/mail/thread/:id", name: "thread" },
  { pattern: "/mail/label/:labelId", name: "label" },
  { pattern: "/mail/:folder", name: "mail" },
  { pattern: "/settings/accounts/:id", name: "account-edit" },
  { pattern: "/settings/accounts", name: "accounts" },
  { pattern: "/settings", name: "settings" },
  { pattern: "/intro", name: "intro" },
  { pattern: "/dashboard", name: "dashboard" },
  { pattern: "/contacts", name: "contacts" },
  { pattern: "/calendar", name: "calendar" },
  { pattern: "/newsletters/stats", name: "newsletter-stats" },
  { pattern: "/newsletters", name: "newsletters" },
  { pattern: "/suivi", name: "suivi" },
  { pattern: "/activity", name: "activity" },
];

// Page d'atterrissage quand aucune page n'est specifiee (hash vide ou "/").
const DEFAULT_PATHNAME = "/intro";
// Vue mail par defaut (bare "/mail" -> tous les messages).
const DEFAULT_MAIL_PATHNAME = "/mail/all";

// --- Parsing ---

function parseHash(hash: string): { pathname: string; search: string } {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const qIndex = raw.indexOf("?");
  const pathname = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const search = qIndex >= 0 ? raw.slice(qIndex + 1) : "";
  const normalizedPathname = (pathname || DEFAULT_PATHNAME).replace(/\/+$/, "") || "/";
  return {
    pathname:
      normalizedPathname === "/"
        ? DEFAULT_PATHNAME
        : normalizedPathname === "/mail"
          ? DEFAULT_MAIL_PATHNAME
          : normalizedPathname,
    search,
  };
}

function matchRoute(pathname: string): { route: string; params: Record<string, string> } {
  for (const def of ROUTES) {
    const patternParts = def.pattern.split("/");
    const pathParts = pathname.split("/");
    if (patternParts.length !== pathParts.length) continue;

    const params: Record<string, string> = {};
    let match = true;
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(":")) {
        if (!pathParts[i]) {
          match = false;
          break;
        }
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return { route: def.name, params };
  }
  return { route: "mail", params: { folder: "all" } };
}

// --- External store for hash ---

let listeners: Array<() => void> = [];

function subscribe(callback: () => void) {
  listeners.push(callback);
  window.addEventListener("hashchange", callback);
  return () => {
    listeners = listeners.filter((l) => l !== callback);
    window.removeEventListener("hashchange", callback);
  };
}

function getSnapshot() {
  return window.location.hash;
}

function getServerSnapshot() {
  return "#/intro";
}

function notifyListeners() {
  for (const l of listeners) l();
}

// --- Navigation functions ---

export function hashNavigate(path: string) {
  window.location.hash = "#" + path;
}

export function hashReplace(path: string) {
  history.replaceState(null, "", "#" + path);
  notifyListeners();
}

export function hashBack() {
  history.back();
}

/**
 * Met a jour des parametres de l'adresse SANS toucher au chemin courant.
 *
 * Le chemin est relu depuis le hash REEL au moment de l'appel (jamais
 * reconstruit depuis une closure) : une mise a jour encore en vol depuis
 * l'ecran precedent ne peut donc pas ecraser la navigation qui vient d'avoir
 * lieu. Une valeur `null` retire le parametre.
 *
 * Par defaut on EMPILE une entree d'historique (le bouton "precedent" du
 * navigateur revient a l'ecran d'avant) ; `replace` remplace l'entree courante
 * pour les mises a jour qui ne sont pas une action de l'utilisateur
 * (restauration automatique d'une selection, par exemple).
 */
export function hashSetParams(
  updates: Record<string, string | null>,
  opts?: { replace?: boolean }
) {
  const rawHash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const qIndex = rawHash.indexOf("?");
  const path = qIndex >= 0 ? rawHash.slice(0, qIndex) : rawHash;
  const params = new URLSearchParams(qIndex >= 0 ? rawHash.slice(qIndex + 1) : "");
  for (const [key, value] of Object.entries(updates)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const qs = params.toString();
  const next = `${path}${qs ? `?${qs}` : ""}`;
  if (opts?.replace) hashReplace(next);
  else hashNavigate(next);
}

// --- Context override (used by the modal-as-route pattern to freeze
// the underlying page's router state while a modal route is active) ---

const HashOverrideContext = createContext<string | null>(null);

export function HashOverrideProvider({ hash, children }: { hash: string; children: ReactNode }) {
  return <HashOverrideContext.Provider value={hash}>{children}</HashOverrideContext.Provider>;
}

// --- Hook ---

export function useHashRouter() {
  const liveHash = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const overrideHash = useContext(HashOverrideContext);
  const hash = overrideHash ?? liveHash;

  const { pathname, search } = useMemo(() => parseHash(hash), [hash]);
  const searchParams = useMemo(() => new URLSearchParams(search), [search]);
  const { route, params } = useMemo(() => matchRoute(pathname), [pathname]);

  const navigate = useCallback((path: string) => hashNavigate(path), []);
  const replace = useCallback((path: string) => hashReplace(path), []);
  const back = useCallback(() => hashBack(), []);

  return { pathname, searchParams, params, route, navigate, replace, back };
}

// --- Selection portee par l'adresse (liste + detail) ---

/**
 * Selection d'un ecran maitre/detail (fiche de suivi, contact...)
 * portee par l'ADRESSE plutot que par un etat local : recharger la page ou
 * partager le lien retombe sur le meme detail ouvert.
 *
 * Regles d'historique, calquees sur le comportement attendu du bouton
 * "precedent" :
 * - ouvrir un detail depuis la liste EMPILE une entree -> "precedent" referme
 *   le detail et revient a la liste ;
 * - passer d'un detail a un autre REMPLACE l'entree -> l'historique ne se
 *   remplit pas d'une entree par element parcouru ;
 * - fermer revient en arriere quand c'est nous qui avons empile, sinon retire
 *   simplement le parametre (arrivee directe par un lien : "precedent" doit
 *   rester la page d'avant, pas nous faire sortir de l'app).
 */
export function useHashSelection(key: string, extraKeys: string[] = []) {
  const { searchParams } = useHashRouter();
  const value = searchParams.get(key);
  const pushedRef = useRef(false);
  const extras = extraKeys.join(",");

  const open = useCallback(
    (next: string) => {
      const current = new URLSearchParams(window.location.hash.split("?")[1] || "");
      const hadSelection = current.get(key);
      if (hadSelection === next) return;
      if (!hadSelection) pushedRef.current = true;
      // Les parametres secondaires (message a mettre en evidence, par exemple)
      // appartiennent a la selection precedente : on les retire.
      const updates: Record<string, string | null> = { [key]: next };
      for (const extra of extras ? extras.split(",") : []) updates[extra] = null;
      hashSetParams(updates, { replace: !!hadSelection });
    },
    [key, extras]
  );

  const close = useCallback(() => {
    const cleared: Record<string, string | null> = { [key]: null };
    for (const extra of extras ? extras.split(",") : []) cleared[extra] = null;
    if (pushedRef.current) {
      pushedRef.current = false;
      hashBack();
      return;
    }
    hashSetParams(cleared, { replace: true });
  }, [key, extras]);

  return { value, open, close };
}

// --- HashLink component ---

interface HashLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children: ReactNode;
}

export function HashLink({ href, children, onClick, ...props }: HashLinkProps) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    onClick?.(e);
    hashNavigate(href);
  };

  return (
    <a href={"#" + href} onClick={handleClick} {...props}>
      {children}
    </a>
  );
}
