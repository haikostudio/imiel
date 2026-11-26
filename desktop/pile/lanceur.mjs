#!/usr/bin/env node
// Lanceur de la pile LOCALE d'iMiel (app d'ordinateur tout-en-un).
//
// Lance et surveille, sur 127.0.0.1 uniquement :
//   - la base (PocketBase 0.25 + migrations + pb_hooks du depot),
//   - le releveur de courrier (mail-worker, Node),
//   - l'interface (Next en standalone + server.custom.js pour /ws).
// Deux usages (option --mode) :
//   - « local » (version gratuite) : le releveur releve les boites lui-meme ;
//   - « cloud » (iMiel Cloud) : le releveur NE releve PAS (IMIEL_CLOUD=1) ; la
//     base locale est alimentee par le serveur de transfert, depuis
//     l'interface (frontend/src/lib/cloud/).
// Les donnees vivent dans le dossier de l'app fourni par l'OS (--donnees).
//
// Contrat avec l'app Tauri (desktop/src-tauri/src/pile.rs) :
//   - entree : node lanceur.mjs --pile <dossier des ressources> --donnees <dossier>
//   - sortie standard : UNE ligne « PRET {json} » quand tout repond, avec
//     l'adresse de l'interface et un jeton de session de l'utilisateur local ;
//     ou « ECHEC {json} » si la pile ne demarre pas.
//   - quand l'entree standard se ferme (app quittee, ou plantee), le lanceur
//     arrete proprement les trois processus et sort : aucun orphelin, meme
//     sous Windows ou tuer le parent ne tue pas les enfants.
//
// Aucun secret de l'editeur : la cle de chiffrement, le mot de passe
// administrateur et celui de l'utilisateur local sont GENERES sur la machine
// et gardes dans <donnees>/local.json (droits 0600).
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? ""]);
    return acc;
  }, [])
);

const PILE = path.resolve(args.pile || path.dirname(fileURLToPath(import.meta.url)));
const DONNEES = path.resolve(args.donnees || path.join(process.cwd(), "imiel-donnees"));
const MODE = args.mode === "cloud" ? "cloud" : "local";
const WIN = process.platform === "win32";
const NODE = process.execPath;
const PB_BIN = path.join(PILE, "base", WIN ? "pocketbase.exe" : "pocketbase");

fs.mkdirSync(path.join(DONNEES, "journaux"), { recursive: true });

// --- Reglages locaux (generes une fois) --------------------------------------
const FICHIER_LOCAL = path.join(DONNEES, "local.json");

function lireLocal() {
  try {
    return JSON.parse(fs.readFileSync(FICHIER_LOCAL, "utf8"));
  } catch {
    return null;
  }
}

function ecrireLocal(cfg) {
  const tmp = FICHIER_LOCAL + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FICHIER_LOCAL);
}

function secret(n = 24) {
  return randomBytes(n).toString("hex");
}

export function nouveauxReglages() {
  return {
    version: 1,
    ports: { interface: 0, base: 0, releveur: 0 },
    cleChiffrement: secret(32),
    admin: { email: "admin@imiel.local", motDePasse: secret(24) },
    utilisateur: { email: "moi@imiel.local", motDePasse: secret(24) },
  };
}

// --- Ports : stables d'un lancement a l'autre ---------------------------------
// L'origine de l'interface (http://127.0.0.1:<port>) porte la session et les
// reglages du navigateur integre : changer de port a chaque lancement
// deconnecterait l'utilisateur. On garde donc les ports choisis, et on n'en
// prend un nouveau que s'il est occupe.
function portLibre(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ host: "127.0.0.1", port }, () => srv.close(() => resolve(true)));
  });
}

function portAuHasard() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function choisirPorts(ports) {
  const out = { ...ports };
  const pris = new Set();
  for (const nom of ["interface", "base", "releveur"]) {
    let p = out[nom];
    if (!p || pris.has(p) || !(await portLibre(p))) {
      do p = await portAuHasard();
      while (pris.has(p));
    }
    out[nom] = p;
    pris.add(p);
  }
  return out;
}

// --- Journaux -----------------------------------------------------------------
const MAX_JOURNAL = 5 * 1024 * 1024;
function journal(nom) {
  const f = path.join(DONNEES, "journaux", `${nom}.log`);
  try {
    if (fs.statSync(f).size > MAX_JOURNAL) fs.renameSync(f, f + ".1");
  } catch {
    /* premier lancement */
  }
  return fs.openSync(f, "a", 0o600);
}

function note(msg) {
  fs.appendFileSync(path.join(DONNEES, "journaux", "lanceur.log"), `${new Date().toISOString()} ${msg}\n`);
}

// --- Attente de disponibilite -------------------------------------------------
async function attendre(url, delaiMs = 120_000) {
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return true;
    } catch {
      /* pas encore */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// --- Processus surveilles ----------------------------------------------------
let arret = false;
const surveilles = new Map();

function surveiller(nom, commande, argv, options) {
  const etat = { enfant: null, essais: 0, depuis: 0 };
  surveilles.set(nom, etat);
  const lancer = () => {
    if (arret) return;
    const fd = journal(nom);
    etat.depuis = Date.now();
    const enfant = spawn(commande, argv, { ...options, stdio: ["ignore", fd, fd], windowsHide: true });
    etat.enfant = enfant;
    enfant.on("exit", (code, signal) => {
      fs.closeSync(fd);
      if (arret) return;
      // Relance avec attente croissante (1 s, 2 s, 4 s ... 30 s), remise a
      // zero apres une minute de bon fonctionnement.
      if (Date.now() - etat.depuis > 60_000) etat.essais = 0;
      const attente = Math.min(30_000, 1000 * 2 ** etat.essais);
      etat.essais++;
      note(`${nom} arrete (code ${code ?? "-"}, signal ${signal ?? "-"}), relance dans ${attente} ms`);
      setTimeout(lancer, attente);
    });
  };
  lancer();
}

async function toutArreter() {
  if (arret) return;
  arret = true;
  note("arret demande");
  const enfants = [...surveilles.values()].map((e) => e.enfant).filter((e) => e && e.exitCode === null);
  for (const e of enfants) e.kill("SIGTERM");
  const fin = Date.now() + 5000;
  while (Date.now() < fin && enfants.some((e) => e.exitCode === null && e.signalCode === null)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const e of enfants) if (e.exitCode === null && e.signalCode === null) e.kill("SIGKILL");
  process.exit(0);
}

// --- Compte de l'utilisateur local ----------------------------------------------
async function pb(baseUrl, chemin, init = {}, jeton = "") {
  const r = await fetch(baseUrl + chemin, {
    ...init,
    headers: { "Content-Type": "application/json", ...(jeton ? { Authorization: jeton } : {}), ...(init.headers || {}) },
  });
  const corps = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${chemin} -> ${r.status} ${corps?.message || ""}`.trim());
  return corps;
}

async function sessionUtilisateur(baseUrl, cfg) {
  const admin = await pb(baseUrl, "/api/collections/_superusers/auth-with-password", {
    method: "POST",
    body: JSON.stringify({ identity: cfg.admin.email, password: cfg.admin.motDePasse }),
  });
  const filtre = encodeURIComponent(`email="${cfg.utilisateur.email}"`);
  const liste = await pb(baseUrl, `/api/collections/users/records?filter=${filtre}&perPage=1`, {}, admin.token);
  if (!liste.items?.length) {
    await pb(
      baseUrl,
      "/api/collections/users/records",
      {
        method: "POST",
        body: JSON.stringify({
          email: cfg.utilisateur.email,
          password: cfg.utilisateur.motDePasse,
          passwordConfirm: cfg.utilisateur.motDePasse,
          verified: true,
          name: "Moi",
        }),
      },
      admin.token
    );
    note("utilisateur local cree");
  }
  const sess = await pb(baseUrl, "/api/collections/users/auth-with-password", {
    method: "POST",
    body: JSON.stringify({ identity: cfg.utilisateur.email, password: cfg.utilisateur.motDePasse }),
  });
  return { token: sess.token, record: sess.record };
}

// --- Demarrage ------------------------------------------------------------------
async function demarrer() {
  let cfg = lireLocal();
  if (!cfg) {
    cfg = nouveauxReglages();
    note("premier lancement : reglages locaux generes");
  }
  cfg.ports = await choisirPorts(cfg.ports || {});
  ecrireLocal(cfg);

  const ORIGINE = `http://127.0.0.1:${cfg.ports.interface}`;
  const BASE = `http://127.0.0.1:${cfg.ports.base}`;
  const RELEVEUR = `http://127.0.0.1:${cfg.ports.releveur}`;
  const dossierBase = path.join(DONNEES, "base");
  const dossierReleveur = path.join(DONNEES, "releveur");
  fs.mkdirSync(dossierBase, { recursive: true });
  fs.mkdirSync(dossierReleveur, { recursive: true });

  const envCommun = {
    ...process.env,
    IMIEL_LOCAL: "1",
    IMIEL_EDITION: "tous",
    // iMiel Cloud : le serveur de transfert releve, pas cet ordinateur.
    IMIEL_CLOUD: MODE === "cloud" ? "1" : "",
    ENCRYPTION_KEY: cfg.cleChiffrement,
    // Jamais de cle de l'editeur dans la version pour tous.
    OPENROUTER_API_KEY: "",
    RSPAMD_URL: "off",
    CERVEAU_API_URL: "off",
    NODE_ENV: "production",
  };

  // 1) Base
  execFileSync(PB_BIN, ["superuser", "upsert", cfg.admin.email, cfg.admin.motDePasse, `--dir=${dossierBase}`], {
    stdio: "ignore",
    windowsHide: true,
  });
  surveiller(
    "base",
    PB_BIN,
    [
      "serve",
      `--http=127.0.0.1:${cfg.ports.base}`,
      `--dir=${dossierBase}`,
      `--migrationsDir=${path.join(PILE, "base", "pb_migrations")}`,
      `--hooksDir=${path.join(PILE, "base", "pb_hooks")}`,
      `--origins=${ORIGINE}`,
    ],
    { env: { ...envCommun, MAIL_WORKER_URL: RELEVEUR, NEXT_PUBLIC_APP_URL: ORIGINE } }
  );
  if (!(await attendre(`${BASE}/api/health`))) throw new Error("la base ne repond pas");

  let infosPile = {};
  try {
    infosPile = JSON.parse(fs.readFileSync(path.join(PILE, "pile.json"), "utf8"));
  } catch {
    /* pile assemblee a la main (essai) */
  }
  const google = infosPile.google
    ? { GOOGLE_DESKTOP_CLIENT_ID: infosPile.google.clientId, GOOGLE_DESKTOP_CLIENT_SECRET: infosPile.google.clientSecret || "" }
    : {};

  // 2) Releveur
  surveiller("releveur", NODE, [path.join(PILE, "releveur", "dist", "index.js")], {
    cwd: path.join(PILE, "releveur"),
    env: {
      ...envCommun,
      PORT: String(cfg.ports.releveur),
      HOST: "127.0.0.1",
      IMIEL_APP_ORIGIN: ORIGINE,
      POCKETBASE_URL: BASE,
      PB_ADMIN_EMAIL: cfg.admin.email,
      PB_ADMIN_PASSWORD: cfg.admin.motDePasse,
      PB_DATA_PATH: path.join(dossierBase, "data.db"),
      EMBEDDINGS_CACHE_PATH: path.join(dossierReleveur, "vecteurs.db"),
      FASTEMBED_CACHE_DIR: path.join(PILE, "releveur", "local_cache"),
      AI_BUDGET_STATE_PATH: path.join(dossierReleveur, "ai-budget.json"),
      NEXT_PUBLIC_APP_URL: ORIGINE,
      OAUTH_REDIRECT_BASE: ORIGINE,
      ...google,
    },
  });

  // 3) Interface
  surveiller("interface", NODE, [path.join(PILE, "interface", "server.js")], {
    cwd: path.join(PILE, "interface"),
    env: {
      ...envCommun,
      PORT: String(cfg.ports.interface),
      HOSTNAME: "127.0.0.1",
      IMIEL_PB_URL: BASE,
      IMIEL_WORKER_URL: RELEVEUR,
      POCKETBASE_INTERNAL_URL: BASE,
      POCKETBASE_URL: BASE,
      WORKER_INTERNAL_URL: RELEVEUR,
      MAIL_WORKER_URL: RELEVEUR,
      NEXT_PUBLIC_APP_URL: ORIGINE,
      OAUTH_REDIRECT_BASE: ORIGINE,
    },
  });

  const session = await sessionUtilisateur(BASE, cfg);
  const prets = await Promise.all([attendre(`${RELEVEUR}/health`), attendre(`${ORIGINE}/login`)]);
  if (!prets.every(Boolean)) throw new Error("le releveur ou l'interface ne repond pas");

  note(`pile prete sur ${ORIGINE}`);
  process.stdout.write(
    "PRET " + JSON.stringify({ adresse: ORIGINE + "/", jeton: session.token, utilisateur: session.record }) + "\n"
  );
}

// L'app parente tient notre entree standard : sa fermeture = arret.
process.stdin.on("end", () => void toutArreter());
process.stdin.on("close", () => void toutArreter());
process.stdin.resume();
process.on("SIGTERM", () => void toutArreter());
process.on("SIGINT", () => void toutArreter());

if (!process.env.IMIEL_LANCEUR_SANS_DEMARRAGE) {
  demarrer().catch((err) => {
    note(`echec : ${err.message}`);
    process.stdout.write("ECHEC " + JSON.stringify({ erreur: err.message }) + "\n");
    void toutArreter();
  });
}
