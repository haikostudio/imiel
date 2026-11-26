#!/usr/bin/env node
// Manifeste des MISES A JOUR de l'app d'ordinateur, au format du greffon de
// mise a jour Tauri (un seul fichier statique pour tous les systemes) :
//   { version, notes, pub_date, platforms: { "darwin-aarch64": { url, signature }, ... } }
// Il est servi par la vitrine (https://getimiel.com/mises-a-jour/latest.json,
// premiere adresse de tauri.conf.json) ; le serveur iMiel Cloud reste une
// adresse de secours. L'app compare elle-meme les versions et verifie la
// signature minisign de chaque paquet : un paquet falsifie ou signe par une
// autre cle est refuse, et rien ne s'installe sans le geste de l'utilisateur.
//
//   node desktop/scripts/manifeste-mises-a-jour.mjs --version 1.2.0 --notes notes.md \
//        --paquets <dossier des paquets .tar.gz/.zip + .sig> --base-url https://github.com/<depot>/releases/download/desktop-v1.2.0
//   -> site/src/mises-a-jour/latest.json (copie dans site/dist par site/build.mjs)
// ECRIT seulement : la publication (Release, mise en ligne de la vitrine) reste
// un geste de l'editeur.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, c, i, t) => (c.startsWith("--") ? [...acc, [c.slice(2), t[i + 1]]] : acc), []));
if (!a.version || !a.paquets || !a["base-url"]) {
  console.error("usage : --version <x.y.z> --paquets <dossier> --base-url <adresse des paquets> [--notes <fichier>] [--sortie <fichier>]");
  process.exit(2);
}
// Paquet de mise a jour -> cle de plateforme du greffon.
const CIBLES = [
  [/aarch64\.app\.tar\.gz$|arm64\.app\.tar\.gz$/i, "darwin-aarch64"],
  [/x64\.app\.tar\.gz$|x86_64\.app\.tar\.gz$/i, "darwin-x86_64"],
  [/\.app\.tar\.gz$/i, "darwin-aarch64"],
  [/\.AppImage\.tar\.gz$|\.AppImage$/i, "linux-x86_64"],
  [/-setup\.exe$|\.nsis\.zip$|\.msi(\.zip)?$/i, "windows-x86_64"],
];
const platforms = {};
for (const f of fs.readdirSync(a.paquets)) {
  if (f.endsWith(".sig")) continue;
  const cible = CIBLES.find(([re]) => re.test(f))?.[1];
  const sig = path.join(a.paquets, f + ".sig");
  if (!cible || !fs.existsSync(sig) || platforms[cible]) continue;
  platforms[cible] = { url: `${a["base-url"].replace(/\/+$/, "")}/${encodeURIComponent(f)}`, signature: fs.readFileSync(sig, "utf8").trim() };
}
if (!Object.keys(platforms).length) {
  console.error("aucun paquet signe (.sig) trouve : la cle de signature est-elle posee a la fabrication ?");
  process.exit(1);
}
const manifeste = {
  version: a.version,
  notes: a.notes && fs.existsSync(a.notes) ? fs.readFileSync(a.notes, "utf8").trim() : "",
  pub_date: new Date().toISOString(),
  platforms,
};
const sortie = path.resolve(a.sortie || path.join(racine, "site/src/mises-a-jour/latest.json"));
fs.mkdirSync(path.dirname(sortie), { recursive: true });
fs.writeFileSync(sortie, JSON.stringify(manifeste, null, 2) + "\n");
console.log(`manifeste ${a.version} : ${Object.keys(platforms).join(", ")} -> ${path.relative(racine, sortie)}`);
