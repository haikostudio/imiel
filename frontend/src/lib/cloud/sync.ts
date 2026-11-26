// Moteur de synchro iMiel Cloud, cote app (ordinateur, iPhone, navigateur).
//
// Le serveur de transfert lit chaque boite chez le fournisseur au moment ou
// l'app le demande et ne garde rien : c'est l'app qui garde sa copie. A chaque
// tour, pour chaque boite :
//   1. curseurs locaux (UIDVALIDITY, plus petit et plus grand UID par dossier) ;
//   2. POST /v1/synchro -> mails nouveaux, drapeaux, mails disparus ;
//   3. rangement dans la base locale (POST /api/cloud/ingest) ;
//   4. puis, au calme, une page d'historique par dossier principal.
// Les reglages (boites, signatures, regles, etiquettes, apparence, cle d'IA)
// vivent sur le serveur, chiffres au repos ; les donnees propres a iMiel
// (etiquettes posees, suivis, contacts) passent d'appareil a appareil par la
// file de transit.
import pb, { getCurrentUserId } from "@/lib/pocketbase";
import { clearMailListPageCache } from "@/lib/mail-list-api";
import { useMailStore } from "@/lib/stores/mail-store";
import { cloud, ouvrirFlux, useCloud, ErreurCloud, type Abonnement } from "./client";
import { lireSession, modeCloud } from "./config";

export interface BoiteCloud {
  id: string;
  email: string;
  label: string;
  display_name: string;
  color: string;
  signature: string;
  fournisseur: string;
  auth: string;
  oauth_provider: string;
  imap: { host?: string; port?: number; security?: string };
  smtp: { host?: string; port?: number; security?: string };
  a_reconnecter: boolean;
}

export interface ReglagesCloud {
  boites: BoiteCloud[];
  utilisateur: Record<string, unknown>;
  collections: Record<string, Record<string, unknown>[]>;
}

// Reglages de l'utilisateur qui suivent le compte d'un appareil a l'autre.
export const CHAMPS_UTILISATEUR = [
  "name", "theme", "language", "notifications_enabled", "notification_sound", "preview_lines", "density", "ui_scale",
  "reading_pane", "default_reply_all", "conversation_view", "auto_mark_read_seconds", "auto_save_interval",
  "blocked_senders", "grouped_senders", "openrouter_api_key", "design", "design_background",
] as const;
// Petites collections gardees avec les reglages (un nouvel appareil les
// retrouve meme si les autres sont eteints).
export const COLLECTIONS_REGLAGES = ["labels", "filter_rules", "newsletter_sources", "alert_topics"] as const;
// Donnees propres a iMiel qui passent par la file de transit.
export const COLLECTIONS_TRANSIT = ["thread_labels", "tracking_items", "tracking_events", "contacts", "calendar_events", "importance_rules"] as const;

const SYSTEME = new Set(["collectionId", "collectionName", "created", "updated", "expand"]);
const HISTORIQUE_MAX = 1500; // mails gardes par dossier principal sur l'appareil
const DOSSIERS_HISTORIQUE = new Set(["inbox", "sent", "archive"]);

interface Curseur { v: number; u: number; min: number; n?: number }
interface ResultatDossier { v: number; remise: boolean; mails: unknown[]; reste?: boolean; plusAncien?: boolean; min?: number; u?: number }
interface DossierCloud { id: string; path: string; type: string }

let enCours: Promise<void> | null = null;
let relancer = false;
let versionReglages = -1;
let silenceJusqua = 0; // ignore les echos de nos propres ecritures locales
const labelsConnus = new Map<string, string>();

function nettoyer(f: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) if (!SYSTEME.has(k)) out[k] = v;
  return out;
}

function rafraichirListes(nouveaux: boolean) {
  clearMailListPageCache();
  const s = useMailStore.getState();
  s.invalidateMessages();
  s.invalidateFolders();
  if (nouveaux) s.signalNewMessages();
}

async function appliquerReglages(r: ReglagesCloud): Promise<void> {
  silenceJusqua = Date.now() + 4000;
  const uid = getCurrentUserId();
  if (uid && r.utilisateur && Object.keys(r.utilisateur).length) {
    const actuel = await pb.collection("users").getOne(uid).catch(() => null);
    const diff: Record<string, unknown> = {};
    for (const k of CHAMPS_UTILISATEUR) {
      if (r.utilisateur[k] !== undefined && JSON.stringify(actuel?.[k]) !== JSON.stringify(r.utilisateur[k])) diff[k] = r.utilisateur[k];
    }
    if (Object.keys(diff).length) await pb.collection("users").update(uid, diff).catch(() => {});
  }
  const fiches: Record<string, unknown>[] = [];
  for (const col of COLLECTIONS_REGLAGES) for (const f of r.collections?.[col] || []) fiches.push({ col, action: "maj", fiche: f });
  if (fiches.length) await pb.send("/api/cloud/fiches", { method: "POST", body: { fiches } }).catch(() => {});
  await pb.send("/api/cloud/boites", { method: "POST", body: { boites: r.boites, complet: true } });
}

/** Instantane des reglages locaux, pour les pousser au serveur. */
async function reglagesLocaux(): Promise<Pick<ReglagesCloud, "utilisateur" | "collections">> {
  const uid = getCurrentUserId();
  const u = uid ? await pb.collection("users").getOne(uid).catch(() => null) : null;
  const utilisateur: Record<string, unknown> = {};
  if (u) for (const k of CHAMPS_UTILISATEUR) if (u[k] !== undefined) utilisateur[k] = u[k];
  const collections: Record<string, Record<string, unknown>[]> = {};
  for (const col of COLLECTIONS_REGLAGES) {
    collections[col] = (await pb.collection(col).getFullList({ batch: 500 }).catch(() => [])).map((f) => nettoyer(f as unknown as Record<string, unknown>));
  }
  return { utilisateur, collections };
}

let minuteurReglages: ReturnType<typeof setTimeout> | null = null;
export function pousserReglagesBientot() {
  if (!modeCloud() || Date.now() < silenceJusqua) return;
  if (minuteurReglages) clearTimeout(minuteurReglages);
  minuteurReglages = setTimeout(() => void pousserReglages().catch(() => {}), 2500);
}

async function pousserReglages(essai = 0): Promise<void> {
  const local = await reglagesLocaux();
  try {
    const r = await cloud<{ version: number }>("PUT", "/v1/reglages", { version: versionReglages, ...local });
    versionReglages = r.version;
  } catch (e) {
    if (e instanceof ErreurCloud && e.statut === 409 && essai < 2) {
      versionReglages = Number(e.donnees.version);
      return pousserReglages(essai + 1);
    }
    throw e;
  }
}

async function synchroBoite(b: BoiteCloud): Promise<{ nouveaux: boolean; historique: boolean }> {
  let nouveaux = false;
  let encore = true;
  let tours = 0;
  let dossiers: DossierCloud[] = [];
  let curseurs: Record<string, Curseur> = {};
  while (encore && tours++ < 12) {
    curseurs = (await pb.send(`/api/cloud/curseurs?account=${b.id}`, {})).curseurs || {};
    const r = await cloud<{ dossiers: DossierCloud[]; resultats: Record<string, ResultatDossier> }>("POST", "/v1/synchro", { boite: b.id, dossiers: curseurs });
    dossiers = r.dossiers;
    const bilan = await pb.send("/api/cloud/ingest", { method: "POST", body: { boite: b.id, dossiers: r.dossiers, resultats: r.resultats } });
    if (bilan.crees || bilan.retires || bilan.maj || bilan.dossiers) rafraichirListes(!!bilan.nouveaux?.length);
    if (bilan.nouveaux?.length) nouveaux = true;
    encore = Object.values(r.resultats || {}).some((x) => x.reste);
  }
  // Historique, une page par dossier principal et par tour, au calme.
  curseurs = (await pb.send(`/api/cloud/curseurs?account=${b.id}`, {})).curseurs || {};
  let historique = false;
  for (const d of dossiers) {
    const c = curseurs[d.path];
    if (!DOSSIERS_HISTORIQUE.has(d.type) || !c || c.min <= 1 || (c.n || 0) >= HISTORIQUE_MAX) continue;
    const h = await cloud<{ v: number; mails: unknown[]; fini: boolean }>("POST", "/v1/historique", { boite: b.id, dossier: d.path, avant: c.min, n: 100 });
    if (h.v !== c.v || !h.mails.length) continue;
    const bilan = await pb.send("/api/cloud/ingest", { method: "POST", body: { boite: b.id, dossiers, resultats: { [d.path]: { v: h.v, remise: false, mails: h.mails } } } });
    if (bilan.crees) rafraichirListes(false);
    if (!h.fini) historique = true;
  }
  return { nouveaux, historique };
}

async function recevoirTransit(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const t = await cloud<{ entrees: { id: number; donnees: Record<string, unknown> }[]; reste: number }>("GET", "/v1/transit?limite=200");
    if (!t.entrees.length) return;
    silenceJusqua = Date.now() + 4000;
    const fiches = t.entrees.map((e) => e.donnees);
    for (const f of fiches) if (f.col === "messages") labelsConnus.set(String(f.id), JSON.stringify(f.labels || []));
    await pb.send("/api/cloud/fiches", { method: "POST", body: { fiches } });
    await cloud("POST", "/v1/transit/accuse", { ids: t.entrees.map((e) => e.id) });
    rafraichirListes(false);
    if (!t.reste) return;
  }
}

async function tour(): Promise<boolean> {
  const etat = useCloud.getState();
  etat.set({ synchro: "en-cours", erreur: null });
  let suite = false;
  try {
    const { version, reglages } = await cloud<{ version: number; reglages: ReglagesCloud }>("GET", "/v1/reglages");
    if (version !== versionReglages) {
      await appliquerReglages(reglages);
      versionReglages = version;
    }
    for (const b of reglages.boites) {
      if (b.a_reconnecter) continue;
      const r = await synchroBoite(b).catch((e) => {
        if (e instanceof ErreurCloud && (e.statut === 402 || e.statut === 401)) throw e;
        useCloud.getState().set({ erreur: `${b.email} : ${e.message}` });
        return { nouveaux: false, historique: false };
      });
      suite = suite || r.historique;
    }
    await recevoirTransit();
    useCloud.getState().set({ synchro: useCloud.getState().erreur ? "erreur" : "repos", derniereSynchro: Date.now() });
  } catch (e) {
    useCloud.getState().set({ synchro: "erreur", erreur: e instanceof Error ? e.message : String(e) });
  }
  return suite;
}

/** Lance un tour de synchro (un seul a la fois ; un appel pendant un tour en relance un). */
export function synchroniser(): Promise<void> {
  if (!modeCloud()) return Promise.resolve();
  if (enCours) {
    relancer = true;
    return enCours;
  }
  enCours = (async () => {
    let historique = false;
    do {
      relancer = false;
      historique = await tour();
    } while (relancer);
    enCours = null;
    // Historique restant : un autre tour un peu plus tard.
    if (historique) setTimeout(() => void synchroniser(), 4000);
  })();
  return enCours;
}

/** Donnees propres a iMiel modifiees ici : vers les autres appareils. */
async function envoyerTransit(fiches: Record<string, unknown>[]) {
  if (!fiches.length || !modeCloud()) return;
  await cloud("POST", "/v1/transit", { entrees: fiches }).catch(() => {});
}

function ecouterChangementsLocaux(): () => void {
  const arrets: (() => void)[] = [];
  const attente: Record<string, unknown>[] = [];
  let minuteur: ReturnType<typeof setTimeout> | null = null;
  const pousser = (f: Record<string, unknown>) => {
    attente.push(f);
    if (minuteur) clearTimeout(minuteur);
    minuteur = setTimeout(() => void envoyerTransit(attente.splice(0)), 1500);
  };
  const ecoute = (col: string, fn: (e: { action: string; record: Record<string, unknown> }) => void) => {
    pb.collection(col)
      .subscribe("*", (e) => {
        if (Date.now() < silenceJusqua) return;
        fn(e as unknown as { action: string; record: Record<string, unknown> });
      })
      .then((stop) => arrets.push(stop))
      .catch(() => {});
  };
  for (const col of COLLECTIONS_REGLAGES) ecoute(col, () => pousserReglagesBientot());
  const uid = getCurrentUserId();
  if (uid) ecoute("users", (e) => e.record.id === uid && pousserReglagesBientot());
  for (const col of COLLECTIONS_TRANSIT) {
    ecoute(col, (e) =>
      pousser(e.action === "delete" ? { col, action: "suppr", id: e.record.id } : { col, action: "maj", fiche: nettoyer(e.record) })
    );
  }
  ecoute("messages", (e) => {
    if (e.action !== "update") return;
    const id = String(e.record.id);
    const labels = JSON.stringify(e.record.labels || []);
    if (labelsConnus.get(id) === labels) return;
    const connu = labelsConnus.has(id);
    labelsConnus.set(id, labels);
    if (connu || labels !== "[]") pousser({ col: "messages", id, labels: e.record.labels || [] });
  });
  return () => arrets.forEach((a) => a());
}

/** Demarre la synchro de l'appareil (une fois la session iMiel Cloud ouverte). */
export function demarrerCloud(): () => void {
  if (!modeCloud()) return () => {};
  let minuteur: ReturnType<typeof setTimeout> | null = null;
  const bientot = (ms = 1200) => {
    if (minuteur) clearTimeout(minuteur);
    minuteur = setTimeout(() => void synchroniser(), ms);
  };
  const fermerFlux = ouvrirFlux((m) => {
    if (m.abonnement) useCloud.getState().set({ abonnement: m.abonnement as Abonnement });
    if (m.t === "changement" || m.t === "reglages" || m.t === "transit") bientot(m.t === "changement" ? 800 : 300);
    if (m.t === "bonjour") bientot(100);
    if (m.t === "compte-supprime") {
      useCloud.getState().set({ relie: false, ecran: true });
    }
  });
  const periodique = setInterval(() => bientot(0), 120_000);
  const auRetour = () => document.visibilityState === "visible" && bientot(300);
  document.addEventListener("visibilitychange", auRetour);
  const arreterEcoutes = ecouterChangementsLocaux();
  // iPhone : jeton de notification (pose par l'app native) -> le serveur
  // notifie chaque nouveau mail, app fermee.
  const envoyerApns = (jeton: unknown) => {
    if (typeof jeton === "string" && /^[0-9a-f]{32,200}$/i.test(jeton)) void cloud("PUT", "/v1/appareils/moi", { apns: jeton }).catch(() => {});
  };
  envoyerApns((window as unknown as { __IMIEL_APNS__?: string }).__IMIEL_APNS__);
  const surApns = (e: Event) => envoyerApns((e as CustomEvent).detail);
  window.addEventListener("imiel-apns", surApns);
  void cloud<Abonnement>("GET", "/v1/abonnement").then((a) => useCloud.getState().set({ abonnement: a, relie: true, email: lireSession()?.email || "" })).catch(() => {});
  void synchroniser();
  return () => {
    fermerFlux();
    clearInterval(periodique);
    document.removeEventListener("visibilitychange", auRetour);
    window.removeEventListener("imiel-apns", surApns);
    arreterEcoutes();
    if (minuteur) clearTimeout(minuteur);
  };
}
