// Base de l'APP WEB iMiel Cloud, gardee DANS LE NAVIGATEUR (IndexedDB).
//
// Le serveur de transfert ne garde aucun mail : l'app web garde donc sa
// propre copie, comme l'ordinateur et l'iPhone. Les fiches (memes collections
// que la base de l'app) vivent en memoire, sauf les corps des mails, lus dans
// IndexedDB a la demande ; chaque ecriture part vers IndexedDB par lots.
import { datePb, type Fiche } from "./filtre";

const DB = "imiel-web";
const VERSION = 1;
export const UTILISATEUR_ID = "imielwebmoi0001";
const CORPS = ["text_body", "html_body", "raw_headers"] as const;

// Relations suivies par les filtres (« folder.type », « message.account.user »).
const RELATIONS: Record<string, Record<string, string>> = {
  messages: { account: "accounts", folder: "folders", labels: "labels" },
  folders: { account: "accounts" },
  attachments: { message: "messages" },
  thread_labels: { label: "labels" },
  tracking_events: { item: "tracking_items", message: "messages" },
  tracking_items: { account: "accounts", first_message: "messages" },
  calendar_events: { group: "calendar_groups" },
  calendar_groups: { account: "accounts" },
  newsletter_posts: { message: "messages", account: "accounts" },
  read_receipts: { message: "messages", account: "accounts" },
};

export function cibleRelation(col: string, champ: string): string | null {
  if (champ === "user") return "users";
  return RELATIONS[col]?.[champ] || null;
}

const memoire = new Map<string, Map<string, Fiche>>();
let idb: IDBDatabase | null = null;
const ecritures = new Map<string, Fiche | null>();
const corpsEcrits = new Map<string, Record<string, unknown> | null>();
let minuteur: ReturnType<typeof setTimeout> | null = null;

type Ecouteur = (col: string, action: "create" | "update" | "delete", fiche: Fiche) => void;
const ecouteurs = new Set<Ecouteur>();
export function ecouter(fn: Ecouteur): () => void {
  ecouteurs.add(fn);
  return () => ecouteurs.delete(fn);
}

function ouvrirIdb(): Promise<IDBDatabase | null> {
  return new Promise((ok) => {
    if (typeof indexedDB === "undefined") return ok(null);
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("fiches")) d.createObjectStore("fiches");
      if (!d.objectStoreNames.contains("corps")) d.createObjectStore("corps");
      if (!d.objectStoreNames.contains("fichiers")) d.createObjectStore("fichiers");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ok(null);
  });
}

/** Charge la copie du navigateur en memoire (une fois, au lancement). */
export async function charger(): Promise<void> {
  idb = await ouvrirIdb();
  // Stockage persistant : le navigateur ne vide pas la copie sous la pression.
  void navigator.storage?.persist?.().catch(() => false);
  if (!idb) return;
  await new Promise<void>((ok) => {
    const tx = idb!.transaction("fiches", "readonly");
    const req = tx.objectStore("fiches").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return ok();
      const [col] = String(c.key).split(":");
      collection(col).set((c.value as Fiche).id, c.value as Fiche);
      c.continue();
    };
    req.onerror = () => ok();
  });
}

export function collection(col: string): Map<string, Fiche> {
  let m = memoire.get(col);
  if (!m) memoire.set(col, (m = new Map()));
  return m;
}

export function lire(col: string, id: unknown): Fiche | null {
  return typeof id === "string" ? collection(col).get(id) || null : null;
}

function planifier() {
  if (minuteur) return;
  minuteur = setTimeout(() => void vider(), 400);
}

async function vider(): Promise<void> {
  minuteur = null;
  if (!idb || (!ecritures.size && !corpsEcrits.size)) return;
  const f = new Map(ecritures);
  const c = new Map(corpsEcrits);
  ecritures.clear();
  corpsEcrits.clear();
  await new Promise<void>((ok) => {
    const tx = idb!.transaction(["fiches", "corps"], "readwrite");
    for (const [k, v] of f) v ? tx.objectStore("fiches").put(v, k) : tx.objectStore("fiches").delete(k);
    for (const [k, v] of c) v ? tx.objectStore("corps").put(v, k) : tx.objectStore("corps").delete(k);
    tx.oncomplete = () => ok();
    tx.onerror = () => ok();
  });
}

export const nouvelId = () => {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const o = new Uint8Array(15);
  crypto.getRandomValues(o);
  return Array.from(o, (x) => a[x % a.length]).join("");
};
const maintenant = () => datePb(new Date().toISOString()) as string;

/** Ecrit une fiche (creation ou mise a jour). Les corps de mail partent a part. */
export function ecrire(col: string, fiche: Record<string, unknown>, { silencieux = false } = {}): Fiche {
  const existe = typeof fiche.id === "string" ? lire(col, fiche.id) : null;
  const id = (fiche.id as string) || nouvelId();
  const base: Fiche = existe ? { ...existe } : { id, collectionId: col, collectionName: col, created: maintenant() };
  for (const [k, v] of Object.entries(fiche)) base[k] = datePb(v);
  base.updated = maintenant();
  if (col === "messages") {
    const corps: Record<string, unknown> = {};
    let a = false;
    for (const k of CORPS) {
      if (fiche[k] !== undefined) {
        corps[k] = fiche[k];
        a = true;
      }
      delete base[k];
    }
    if (a) corpsEcrits.set(`${col}:${id}`, { ...(corpsCache.get(id) || {}), ...corps });
    if (a) corpsCache.set(id, { ...(corpsCache.get(id) || {}), ...corps });
  }
  collection(col).set(id, base);
  ecritures.set(`${col}:${id}`, base);
  planifier();
  if (!silencieux) for (const e of ecouteurs) e(col, existe ? "update" : "create", base);
  return base;
}

export function supprimer(col: string, id: string): void {
  const f = lire(col, id);
  if (!f) return;
  collection(col).delete(id);
  ecritures.set(`${col}:${id}`, null);
  if (col === "messages") {
    corpsEcrits.set(`${col}:${id}`, null);
    corpsCache.delete(id);
    for (const a of [...collection("attachments").values()]) if (a.message === id) supprimer("attachments", a.id);
  }
  if (col === "accounts") {
    for (const m of [...collection("messages").values()]) if (m.account === id) supprimer("messages", m.id);
    for (const d of [...collection("folders").values()]) if (d.account === id) supprimer("folders", d.id);
  }
  planifier();
  for (const e of ecouteurs) e(col, "delete", f);
}

// --- Corps des mails (lus a la demande) ---
const corpsCache = new Map<string, Record<string, unknown>>();
export async function corpsDe(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const manquants = ids.filter((id) => {
    const c = corpsCache.get(id);
    if (c) out.set(id, c);
    return !c;
  });
  if (!manquants.length || !idb) return out;
  await new Promise<void>((ok) => {
    const tx = idb!.transaction("corps", "readonly");
    let reste = manquants.length;
    for (const id of manquants) {
      const r = tx.objectStore("corps").get(`messages:${id}`);
      r.onsuccess = () => {
        if (r.result) {
          out.set(id, r.result);
          if (corpsCache.size > 300) corpsCache.clear();
          corpsCache.set(id, r.result);
        }
        if (--reste === 0) ok();
      };
      r.onerror = () => --reste === 0 && ok();
    }
  });
  return out;
}

// --- Fichiers (pieces jointes de brouillon) ---
export async function ecrireFichier(cle: string, b: Blob): Promise<void> {
  if (!idb) return;
  await new Promise<void>((ok) => {
    const tx = idb!.transaction("fichiers", "readwrite");
    tx.objectStore("fichiers").put(b, cle);
    tx.oncomplete = () => ok();
    tx.onerror = () => ok();
  });
}
export async function lireFichier(cle: string): Promise<Blob | null> {
  if (!idb) return null;
  return new Promise((ok) => {
    const r = idb!.transaction("fichiers", "readonly").objectStore("fichiers").get(cle);
    r.onsuccess = () => ok((r.result as Blob) || null);
    r.onerror = () => ok(null);
  });
}

/** Efface toute la copie du navigateur (deconnexion, suppression du compte). */
export async function toutEffacer(): Promise<void> {
  memoire.clear();
  corpsCache.clear();
  ecritures.clear();
  corpsEcrits.clear();
  idb?.close();
  await new Promise<void>((ok) => {
    const r = indexedDB.deleteDatabase(DB);
    r.onsuccess = r.onerror = r.onblocked = () => ok();
  });
}
