// App web iMiel Cloud (fabriquee avec NEXT_PUBLIC_IMIEL_WEB=1) : la base de
// l'app vit DANS LE NAVIGATEUR. Ce module, charge avant le client de la base
// (lib/pocketbase.ts), remplace pour les adresses /api/* et /worker/* :
//   - fetch()        -> lib/cloud/web/routes.ts (memes reponses que la base) ;
//   - EventSource    -> temps reel local (/api/realtime, memes evenements).
// Et pose la session de l'utilisateur local : l'app s'ouvre sans connexion
// a une base ; c'est le compte iMiel Cloud qui relie l'app au courrier.
import { charger, ecouter, toutEffacer } from "./base";
import { jetonLocal, servir, utilisateurLocal } from "./routes";

type Fen = typeof window & { __IMIEL_WEB__?: boolean; __imielWebInstalle?: boolean };

function installer() {
  if (typeof window === "undefined") return;
  const w = window as Fen;
  if (w.__imielWebInstalle) return;
  w.__imielWebInstalle = true;
  w.__IMIEL_WEB__ = true;
  const pret = charger().then(() => {
    utilisateurLocal();
    try {
      localStorage.setItem("pocketbase_auth", JSON.stringify({ token: jetonLocal(), record: utilisateurLocal(), model: utilisateurLocal() }));
    } catch {
      /* stockage indisponible */
    }
  });
  // Session posee tout de suite (l'utilisateur local existe des le 1er lancement).
  try {
    if (!localStorage.getItem("pocketbase_auth")) {
      localStorage.setItem(
        "pocketbase_auth",
        JSON.stringify({ token: jetonLocal(), record: { id: "imielwebmoi0001", email: "moi@imiel.local", collectionName: "users" }, model: null })
      );
    }
  } catch {
    /* rien */
  }

  const fetchOrigine = window.fetch.bind(window);
  window.fetch = async (entree: RequestInfo | URL, init?: RequestInit) => {
    const brut = typeof entree === "string" ? entree : entree instanceof URL ? entree.href : entree.url;
    const url = new URL(brut, location.href);
    const local = url.origin === location.origin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/worker/"));
    if (!local) return fetchOrigine(entree, init);
    await pret;
    const methode = (init?.method || (entree instanceof Request ? entree.method : "GET")).toUpperCase();
    let corps: unknown = init?.body;
    if (typeof corps === "string") {
      try {
        corps = JSON.parse(corps);
      } catch {
        /* texte brut */
      }
    }
    const r = url.pathname.startsWith("/worker/") ? { statut: 503, json: { error: "Indisponible dans l'app web." } } : await servir(methode, url, corps);
    if (r.blob) return new Response(r.blob, { status: 200, headers: { "Content-Type": r.blob.type || "application/octet-stream" } });
    if (r.statut === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.statut, headers: { "Content-Type": "application/json" } });
  };

  // --- Temps reel local ---
  const SourceOrigine = window.EventSource;
  class SourceLocale extends EventTarget {
    readyState = 0;
    url: string;
    withCredentials = false;
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    private arret: (() => void) | null = null;
    constructor(url: string) {
      super();
      this.url = url;
      const clientId = `local${Math.random().toString(36).slice(2, 12)}`;
      void pret.then(() => {
        this.readyState = 1;
        this.onopen?.(new Event("open"));
        this.dispatchEvent(new MessageEvent("PB_CONNECT", { data: JSON.stringify({ clientId }), lastEventId: clientId }));
      });
      this.arret = ecouter((col, action, fiche) => {
        const { text_body: _t, html_body: _h, raw_headers: _r, ...leger } = fiche as Record<string, unknown>;
        const data = JSON.stringify({ action, record: { ...leger, collectionName: col } });
        for (const sujet of abonnements) {
          const base = sujet.split("?")[0];
          if (base === `${col}/*` || base === `${col}/${fiche.id}` || base === col) this.dispatchEvent(new MessageEvent(sujet, { data }));
        }
      });
    }
    close() {
      this.readyState = 2;
      this.arret?.();
    }
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
  }
  const abonnements = new Set<string>();
  // Les abonnements arrivent par POST /api/realtime : on les releve au passage.
  const fetchAvecAbonnements = window.fetch;
  window.fetch = async (entree: RequestInfo | URL, init?: RequestInit) => {
    const brut = typeof entree === "string" ? entree : entree instanceof URL ? entree.href : entree.url;
    if (brut.includes("/api/realtime") && init?.body && typeof init.body === "string") {
      try {
        const b = JSON.parse(init.body) as { subscriptions?: string[] };
        abonnements.clear();
        for (const s of b.subscriptions || []) abonnements.add(s);
      } catch {
        /* rien */
      }
    }
    return fetchAvecAbonnements(entree, init);
  };
  window.EventSource = function (url: string | URL, cfg?: EventSourceInit) {
    const u = new URL(String(url), location.href);
    if (u.origin === location.origin && u.pathname === "/api/realtime") return new SourceLocale(u.href) as unknown as EventSource;
    return new SourceOrigine(url, cfg);
  } as unknown as typeof EventSource;

  // Deconnexion d'iMiel Cloud : la copie du navigateur s'efface.
  window.addEventListener("imiel-cloud-deconnecte", () => void toutEffacer());
}

installer();
