#!/usr/bin/env node
// Pose l'adresse du serveur iMiel que charge l'app iPhone, dans les deux
// configurations Capacitor (racine mobile/ et copie embarquee mobile/ios/App/).
//
//   IMIEL_SERVER_URL=https://mail.example.com node mobile/scripts/poser-serveur.mjs
//   IMIEL_ALLOW_NAVIGATION=ancien.example.com  (facultatif, autres hotes permis, separes par des virgules)
//
// La fabrication (workflow mobile-ios) l'appelle avant l'archive : chacun
// fabrique ainsi l'app pour SON serveur sans toucher au code.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brute = (process.env.IMIEL_SERVER_URL || "").trim().replace(/\/+$/, "");
let url;
try { url = new URL(brute); } catch { url = null; }
const local = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
if (!url || (url.protocol !== "https:" && !local)) {
  console.error("IMIEL_SERVER_URL doit etre une adresse https:// (ou http://localhost en essai).");
  process.exit(1);
}
const autres = (process.env.IMIEL_ALLOW_NAVIGATION || "").split(",").map((h) => h.trim()).filter(Boolean);
const hotes = [...new Set([url.host, ...autres])];

for (const rel of ["capacitor.config.json", "ios/App/capacitor.config.json"]) {
  const fichier = path.join(racine, rel);
  const config = JSON.parse(readFileSync(fichier, "utf8"));
  config.server = { ...(config.server || {}), url: url.origin, allowNavigation: hotes };
  writeFileSync(fichier, JSON.stringify(config, null, 2) + "\n");
  console.log(`${rel} : ${url.origin} (${hotes.join(", ")})`);
}
