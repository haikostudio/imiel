// Appels au serveur de transfert iMiel Cloud (session d'appareil).
import { create } from "zustand";
import { cloudUrl, ecrireSession, lireSession } from "./config";

export interface Abonnement {
  etat: "essai" | "actif" | "arrete";
  prix: string;
  essaiFin: number | null;
  joursEssai: number | null;
  paiementEnPlace: boolean;
  retard: boolean;
  arreteLe: number | null;
  purgeLe: number | null;
}

export interface AppareilCloud {
  id: string;
  nom: string;
  genre: string;
  cree: number;
  vu: number;
  notifie: boolean;
  moi: boolean;
}

export interface EtatCloud {
  relie: boolean;
  /** Ecran de compte en cours (inscription puis « ajoutez votre premiere boite »). */
  ecran: boolean;
  email: string;
  abonnement: Abonnement | null;
  synchro: "repos" | "en-cours" | "erreur";
  derniereSynchro: number | null;
  erreur: string | null;
  set: (p: Partial<Omit<EtatCloud, "set">>) => void;
}

// L'ecran de compte peut survivre a un rechargement de la page (etape
// « ajoutez votre premiere boite » apres l'inscription).
function ecranEnCours(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("imiel:cloud:ecran") === "1";
  } catch {
    return false;
  }
}

export const useCloud = create<EtatCloud>((set) => ({
  relie: !!lireSession(),
  ecran: !lireSession() || ecranEnCours(),
  email: lireSession()?.email || "",
  abonnement: null,
  synchro: "repos",
  derniereSynchro: null,
  erreur: null,
  set: (p) => {
    if (p.ecran !== undefined) {
      try {
        if (p.ecran) localStorage.setItem("imiel:cloud:ecran", "1");
        else localStorage.removeItem("imiel:cloud:ecran");
      } catch {
        /* rien */
      }
    }
    set(p);
  },
}));

export class ErreurCloud extends Error {
  statut: number;
  donnees: Record<string, unknown>;
  constructor(statut: number, message: string, donnees: Record<string, unknown> = {}) {
    super(message);
    this.statut = statut;
    this.donnees = donnees;
  }
}

/** Appel JSON au serveur. 401 = appareil retire : la session tombe. 402 = abonnement arrete. */
export async function cloud<T = Record<string, unknown>>(
  methode: string,
  chemin: string,
  corps?: unknown,
  { sansSession = false }: { sansSession?: boolean } = {}
): Promise<T> {
  const s = lireSession();
  let r: Response;
  try {
    r = await fetch(cloudUrl() + chemin, {
      method: methode,
      headers: {
        ...(corps !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(s && !sansSession ? { Authorization: `Bearer ${s.jeton}` } : {}),
      },
      body: corps !== undefined ? JSON.stringify(corps) : undefined,
    });
  } catch {
    throw new ErreurCloud(0, "Le serveur iMiel Cloud ne repond pas. Verifiez la connexion a Internet.");
  }
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    if (r.status === 401 && s && !sansSession) {
      ecrireSession(null);
      useCloud.getState().set({ relie: false, ecran: true, abonnement: null });
    }
    if (r.status === 402 && d.abonnement) useCloud.getState().set({ abonnement: d.abonnement as unknown as Abonnement });
    throw new ErreurCloud(r.status, String(d.message || `Erreur ${r.status}`), d);
  }
  return d as T;
}

/** Contenu binaire (piece jointe lue chez le fournisseur). */
export async function cloudBinaire(chemin: string): Promise<Blob> {
  const s = lireSession();
  const r = await fetch(cloudUrl() + chemin, { headers: s ? { Authorization: `Bearer ${s.jeton}` } : {} });
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { message?: string };
    throw new ErreurCloud(r.status, d.message || `Erreur ${r.status}`);
  }
  return r.blob();
}

/** Canal temps reel : « un mail est arrive », « l'abonnement a change »... */
export function ouvrirFlux(surMessage: (m: Record<string, unknown>) => void): () => void {
  let ws: WebSocket | null = null;
  let arrete = false;
  let essais = 0;
  let ping: ReturnType<typeof setInterval> | null = null;
  const lancer = () => {
    const s = lireSession();
    if (arrete || !s) return;
    try {
      ws = new WebSocket(`${cloudUrl().replace(/^http/, "ws")}/v1/flux?jeton=${encodeURIComponent(s.jeton)}`);
    } catch {
      return void setTimeout(lancer, Math.min(60_000, 2000 * 2 ** essais++));
    }
    ws.onopen = () => {
      essais = 0;
      ping = setInterval(() => ws?.readyState === 1 && ws.send("ping"), 25_000);
    };
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      try {
        surMessage(JSON.parse(String(ev.data)));
      } catch {
        /* message illisible */
      }
    };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      if (!arrete) setTimeout(lancer, Math.min(60_000, 2000 * 2 ** essais++));
    };
  };
  lancer();
  return () => {
    arrete = true;
    if (ping) clearInterval(ping);
    ws?.close();
  };
}
