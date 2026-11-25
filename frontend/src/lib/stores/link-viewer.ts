"use client";

import { create } from "zustand";
import { classifyLink, safariSchemeUrl, type LinkKind } from "@/lib/link-open";
import { isDesktopApp, isPwaStandalone, openExternalUrl } from "@/lib/desktop";

/**
 * Tiroir des liens de l'application installee (cf lib/link-open.ts). Un seul
 * tiroir global, monte dans AuthenticatedLayout ; ouvert par l'ecouteur de
 * clics global ou par les liens du corps des mails (EmailBodyFrame).
 * kind "file" : apercu d'un fichier de l'app ; kind "external" : SEULEMENT le
 * repli quand le navigateur n'a pas pu etre ouvert (bouton a toucher).
 */
interface LinkViewerState {
  url: string | null;
  kind: Exclude<LinkKind, "ignore"> | null;
  openLink: (url: string, kind: Exclude<LinkKind, "ignore">) => void;
  close: () => void;
}

export const useLinkViewer = create<LinkViewerState>((set) => ({
  url: null,
  kind: null,
  openLink: (url, kind) => set({ url, kind }),
  close: () => set({ url: null, kind: null }),
}));

/** Origine de PocketBase quand elle differe de l'app (fichiers /api/files). */
export function pocketbaseFileOrigins(): string[] {
  const raw = process.env.NEXT_PUBLIC_POCKETBASE_URL || "";
  if (!/^https?:\/\//.test(raw)) return [];
  try {
    return [new URL(raw).origin];
  } catch {
    return [];
  }
}

/** Classe un lien selon l'environnement courant (navigateur). */
export function classifyLinkHere(
  href: string,
  extra: { download?: boolean; target?: string | null } = {}
): LinkKind {
  if (typeof window === "undefined") return "ignore";
  return classifyLink(href, {
    origin: window.location.origin,
    pageHref: window.location.href,
    standalone: isPwaStandalone(),
    desktop: isDesktopApp(),
    fileOrigins: pocketbaseFileOrigins(),
    ...extra,
  });
}

function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPadOS se presente en "Macintosh" : on le reconnait au tactile.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

/** window.open ; rend false si le navigateur a refuse la fenetre. */
function tryWindowOpen(url: string): boolean {
  try {
    const w = window.open(url, "_blank");
    if (!w) return false;
    try {
      w.opener = null;
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

const SAFARI_FALLBACK_MS = 700;

/**
 * App installee : ouvre un AUTRE site dans le navigateur systeme. A appeler
 * DANS le geste (aucune attente reseau avant), sinon iOS bloque l'ouverture.
 * iPhone/iPad : schema x-safari-https:// (Safari complet, pas la fenetre web
 * native d'iOS) ; s'il est ignore (selon la version d'iOS), la page reste
 * visible -> repli window.open. Si tout est refuse, le tiroir propose un
 * bouton a toucher (nouveau geste).
 */
export function openOutsideApp(url: string): void {
  const fallback = () => {
    if (!tryWindowOpen(url)) useLinkViewer.getState().openLink(url, "external");
  };
  const safari = isIosDevice() ? safariSchemeUrl(url) : null;
  if (!safari) {
    fallback();
    return;
  }
  let left = false;
  const onHide = () => {
    if (document.visibilityState === "hidden") left = true;
  };
  const onPageHide = () => {
    left = true;
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onPageHide);
  try {
    window.location.href = safari;
  } catch {
    /* schema refuse : repli ci-dessous */
  }
  // Safari ouvert = app en arriere-plan : le minuteur est gele, puis tombe au
  // retour avec left=true -> rien a faire.
  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onPageHide);
    if (!left && document.visibilityState === "visible") fallback();
  }, SAFARI_FALLBACK_MS);
}

/** Aiguille un lien deja classe (ecouteur global, corps de mail). */
export function routeClassifiedLink(url: string, kind: Exclude<LinkKind, "ignore">): void {
  if (kind === "external") {
    openOutsideApp(url);
    return;
  }
  useLinkViewer.getState().openLink(url, kind);
}

/**
 * Ouvre un lien DEPUIS LE CODE (corps de mail, bouton) : app installee ->
 * fichier dans le tiroir, autre site dans le navigateur systeme ; sinon
 * ouverture systeme habituelle (onglet / Tauri).
 */
export function openLinkInApp(url: string): void {
  const kind = classifyLinkHere(url, { target: "_blank" });
  if (kind === "ignore") {
    openExternalUrl(url);
    return;
  }
  routeClassifiedLink(url, kind);
}
