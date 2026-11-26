#!/usr/bin/env node
// Assemble la pile LOCALE embarquee dans l'app d'ordinateur « tout-en-un »
// (desktop/src-tauri/ressources/pile/), pour le systeme de la machine qui
// fabrique (la matrice de desktop-release.yml tourne sur chaque systeme : les
// modules natifs du releveur - better-sqlite3, sharp, onnxruntime - sont
// donc compiles pour le bon systeme).
//
//   pile/
//     lanceur.mjs            desktop/pile/lanceur.mjs
//     pile.json              versions embarquees
//     node/                  Node officiel (bin/node, ou node.exe sous Windows)
//     base/                  pocketbase[.exe] + pb_migrations + pb_hooks
//     releveur/              mail-worker compile (dist) + dependances de prod + modele local
//     interface/             Next en standalone + server.custom.js (canal /ws)
//
// Usage : node desktop/scripts/preparer-pile.mjs [--cible <dossier>] [--sans-construire]
//   --sans-construire : reprend les dist/ et .next/ deja construits.
// Aucune valeur de .env n'est lue ni copiee : la version pour tous n'embarque
// aucun secret (les secrets sont generes sur la machine par le lanceur).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ici = path.dirname(fileURLToPath(import.meta.url));
const racine = path.resolve(ici, "../..");
const args = process.argv.slice(2);
const opt = (nom, def) => {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 ? args[i + 1] : def;
};
const CIBLE = path.resolve(opt("cible", path.join(racine, "desktop/src-tauri/ressources/pile")));
const CONSTRUIRE = !args.includes("--sans-construire");
const POCKETBASE_VERSION = "0.25.9";
const NODE_VERSION = opt("node", process.versions.node);
const WIN = process.platform === "win32";

const plateforme = { darwin: "darwin", linux: "linux", win32: "win" }[process.platform];
const archNode = { x64: "x64", arm64: "arm64" }[process.arch];
const archPb = { x64: "amd64", arm64: "arm64" }[process.arch];
if (!plateforme || !archNode) throw new Error(`systeme non pris en charge : ${process.platform}/${process.arch}`);

const npm = WIN ? "npm.cmd" : "npm";
function run(cmd, argv, cwd, env = {}) {
  console.log(`$ ${cmd} ${argv.join(" ")}   (${path.relative(racine, cwd) || "."})`);
  execFileSync(cmd, argv, { cwd, stdio: "inherit", env: { ...process.env, ...env }, shell: WIN });
}

async function telecharger(url, fichier) {
  console.log(`telechargement ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  fs.writeFileSync(fichier, Buffer.from(await r.arrayBuffer()));
}

// GNU tar (Linux) ne lit pas les .zip : unzip, ou python3 en dernier recours.
// Windows et macOS : tar (bsdtar) les lit.
function dezipper(zip, dest) {
  if (WIN || process.platform === "darwin") return run("tar", ["-xf", zip, "-C", dest], dest);
  try {
    run("unzip", ["-o", "-q", zip, "-d", dest], dest);
  } catch {
    run("python3", ["-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zip, dest], dest);
  }
}

function copier(source, cible) {
  fs.cpSync(source, cible, { recursive: true, dereference: true });
}

// Garde-fou : aucune adresse de l'instance de l'editeur dans le JavaScript
// livre au navigateur de l'app pour tous.
export function verifierSansInstance(dossier) {
  const motif = /haiko\.studio|haiko-s1\.com|haikostudio\.cloud/;
  const fautifs = [];
  for (const f of fs.readdirSync(dossier, { recursive: true })) {
    const p = path.join(dossier, String(f));
    if (/\.(js|html|json|txt)$/.test(p) && fs.statSync(p).isFile() && motif.test(fs.readFileSync(p, "utf8"))) fautifs.push(path.relative(dossier, p));
  }
  if (fautifs.length) throw new Error(`adresse de l'instance de l'editeur dans l'interface : ${fautifs.slice(0, 5).join(", ")}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imiel-pile-"));
fs.rmSync(CIBLE, { recursive: true, force: true });
fs.mkdirSync(CIBLE, { recursive: true });

// 1) Lanceur
copier(path.join(racine, "desktop/pile/lanceur.mjs"), path.join(CIBLE, "lanceur.mjs"));

// 2) Node officiel
{
  const nom = `node-v${NODE_VERSION}-${plateforme}-${archNode}`;
  const ext = WIN ? "zip" : "tar.gz";
  const archive = path.join(tmp, `${nom}.${ext}`);
  await telecharger(`https://nodejs.org/dist/v${NODE_VERSION}/${nom}.${ext}`, archive);
  if (WIN) dezipper(archive, tmp);
  else run("tar", ["-xf", archive, "-C", tmp], tmp);
  const dest = path.join(CIBLE, "node");
  if (WIN) {
    fs.mkdirSync(dest, { recursive: true });
    copier(path.join(tmp, nom, "node.exe"), path.join(dest, "node.exe"));
  } else {
    fs.mkdirSync(path.join(dest, "bin"), { recursive: true });
    copier(path.join(tmp, nom, "bin", "node"), path.join(dest, "bin", "node"));
    fs.chmodSync(path.join(dest, "bin", "node"), 0o755);
  }
  copier(path.join(tmp, nom, "LICENSE"), path.join(dest, "LICENSE"));
}

// 3) Base : PocketBase + migrations + hooks du depot
{
  const zip = path.join(tmp, "pocketbase.zip");
  await telecharger(
    `https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_${plateforme === "win" ? "windows" : plateforme}_${archPb}.zip`,
    zip
  );
  const dest = path.join(CIBLE, "base");
  fs.mkdirSync(dest, { recursive: true });
  dezipper(zip, dest);
  if (!WIN) fs.chmodSync(path.join(dest, "pocketbase"), 0o755);
  for (const f of ["CHANGELOG.md"]) fs.rmSync(path.join(dest, f), { force: true });
  copier(path.join(racine, "backend/pb_migrations"), path.join(dest, "pb_migrations"));
  copier(path.join(racine, "backend/pb_hooks"), path.join(dest, "pb_hooks"));
}

// 4) Releveur de courrier
{
  const src = path.join(racine, "backend/mail-worker");
  const env = { NODE_ENV: "development" };
  if (CONSTRUIRE) {
    run(npm, ["ci", "--include=dev", "--no-audit", "--no-fund", "--onnxruntime-node-install-cuda=skip"], src, env);
    run(npm, ["run", "build"], src, env);
  }
  const dest = path.join(CIBLE, "releveur");
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ["dist", "package.json", "package-lock.json"]) copier(path.join(src, f), path.join(dest, f));
  // Modele local de recherche par le sens (fastembed), sans telechargement au lancement.
  if (fs.existsSync(path.join(src, "local_cache"))) copier(path.join(src, "local_cache"), path.join(dest, "local_cache"));
  run(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund", "--onnxruntime-node-install-cuda=skip"], dest, {
    NODE_ENV: "production",
  });
  // onnxruntime-node livre les binaires de TOUS les systemes (~200 Mo) : on ne
  // garde que celui de la machine cible.
  const ort = path.join(dest, "node_modules/onnxruntime-node/bin/napi-v3");
  if (fs.existsSync(ort)) {
    for (const sys of fs.readdirSync(ort)) {
      if (sys !== process.platform) fs.rmSync(path.join(ort, sys), { recursive: true, force: true });
      else for (const a of fs.readdirSync(path.join(ort, sys))) if (a !== process.arch) fs.rmSync(path.join(ort, sys, a), { recursive: true, force: true });
    }
  }
  // Essais et cartes de source inutiles a l'execution.
  for (const f of fs.readdirSync(path.join(dest, "dist"), { recursive: true })) {
    const p = path.join(dest, "dist", String(f));
    if (/\.test\.js(\.map)?$|\.map$/.test(p)) fs.rmSync(p, { force: true });
  }
}

// 5) Interface (Next standalone), edition « pour tous ». Construite dans une
// COPIE du dossier frontend SANS ses fichiers .env* : les valeurs propres a
// l'instance de l'editeur (adresses, cle publique de notification...) seraient
// sinon cuites dans le JavaScript de l'app pour tous.
{
  const src = path.join(racine, "frontend");
  let base = src;
  if (CONSTRUIRE) {
    const copieDir = fs.mkdtempSync(path.join(os.tmpdir(), "imiel-interface-"));
    base = path.join(copieDir, "frontend");
    const IGNORES = new Set(["node_modules", ".next", "out", "test-results"]);
    fs.cpSync(src, base, { recursive: true, filter: (f) => !IGNORES.has(path.basename(f)) && !path.basename(f).startsWith(".env") });
    const env = { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_IMIEL_EDITION: "tous", NEXT_PUBLIC_POCKETBASE_URL: "" };
    run(npm, ["ci", "--include=dev", "--no-audit", "--no-fund"], base, { NODE_ENV: "development" });
    run(npm, ["run", "build"], base, env);
  }
  const dest = path.join(CIBLE, "interface");
  copier(path.join(base, ".next/standalone"), dest);
  copier(path.join(base, ".next/static"), path.join(dest, ".next/static"));
  copier(path.join(base, "public"), path.join(dest, "public"));
  fs.renameSync(path.join(dest, "server.js"), path.join(dest, "server.next.js"));
  copier(path.join(src, "server.custom.js"), path.join(dest, "server.js"));
  // Jamais de fichier d'environnement ni de source dans le paquet.
  for (const f of fs.readdirSync(dest)) if (f.startsWith(".env") || f === "src") fs.rmSync(path.join(dest, f), { recursive: true, force: true });
  verifierSansInstance(path.join(dest, ".next/static"));
}

fs.writeFileSync(
  path.join(CIBLE, "pile.json"),
  JSON.stringify(
    {
      systeme: plateforme,
      arch: archNode,
      node: NODE_VERSION,
      pocketbase: POCKETBASE_VERSION,
      fabriquee: new Date().toISOString(),
      // Client OAuth Google de type « ordinateur » (agenda seul, PKCE) : son
      // identifiant n'est pas un secret ; absent = bouton d'agenda Google inactif.
      google: process.env.IMIEL_GOOGLE_DESKTOP_CLIENT_ID
        ? { clientId: process.env.IMIEL_GOOGLE_DESKTOP_CLIENT_ID, clientSecret: process.env.IMIEL_GOOGLE_DESKTOP_CLIENT_SECRET || "" }
        : null,
    },
    null,
    2
  )
);
fs.rmSync(tmp, { recursive: true, force: true });

// Controle : aucun fichier d'environnement ni cle privee dans le paquet.
const suspects = [];
for (const f of fs.readdirSync(CIBLE, { recursive: true })) {
  const n = String(f);
  if (/(^|[\\/])\.env(\.|$)|\.pem$|\.p8$|\.p12$/.test(n) && !n.includes("node_modules")) suspects.push(n);
}
if (suspects.length) throw new Error(`fichiers sensibles dans la pile : ${suspects.join(", ")}`);
console.log(`pile prete : ${path.relative(racine, CIBLE)}`);
