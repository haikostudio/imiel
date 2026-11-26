#!/usr/bin/env node
// Construit l'interface STATIQUE d'iMiel pour la copie complete de l'iPhone :
// la base embarquee (mobile/base/pbmobile) la sert a la meme adresse que l'API.
//
//   node mobile/scripts/construire-interface-locale.mjs [--cible <dossier>]
//   (par defaut mobile/ios/App/local/interface)
//
// Avec --web : construit l'APP WEB iMiel Cloud (app.getimiel.com) : la meme
// interface statique, dont la base vit dans le navigateur
// (NEXT_PUBLIC_IMIEL_WEB=1, frontend/src/lib/cloud/web). Adresse du serveur
// de transfert : IMIEL_CLOUD_URL (par defaut https://sync.getimiel.com).
//   node mobile/scripts/construire-interface-locale.mjs --web --cible <dossier>
//
// Construit dans une COPIE du dossier frontend (le depot n'est jamais modifie) :
//   - routes serveur Next retirees (src/app/api, proxy) : il n'y a pas de
//     serveur Next sur l'iPhone ;
//   - les trois ecrans a parametre (dossier, fil, compte) sortent de src/app
//     (le routage par fragment les importe directement) ;
//   - IMIEL_EXPORT=1 : export statique (next.config.ts).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const i = args.indexOf("--cible");
const WEB = args.includes("--web");
const CIBLE = path.resolve(i >= 0 ? args[i + 1] : WEB ? path.join(racine, "cloud/app-web/site") : path.join(racine, "mobile/ios/App/local/interface"));
const src = path.join(racine, "frontend");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imiel-interface-locale-"));
const copie = path.join(tmp, "frontend");
const IGNORES = new Set(["node_modules", ".next", "out", "test-results", ".turbo"]);

fs.cpSync(src, copie, {
  recursive: true,
  // Sans les fichiers .env* : rien de l'instance de l'editeur ne doit etre cuit
  // dans l'interface de l'app pour tous.
  filter: (s) => !IGNORES.has(path.basename(s)) && !path.basename(s).startsWith(".next-") && !path.basename(s).startsWith(".env"),
});
// Toutes les routes serveur (route.ts) sortent : aucune n'existe sans serveur Next.
for (const f of fs.readdirSync(path.join(copie, "src/app"), { recursive: true })) {
  if (path.basename(String(f)) === "route.ts") fs.rmSync(path.join(copie, "src/app", String(f)), { force: true });
}
fs.rmSync(path.join(copie, "src/app/api"), { recursive: true, force: true });
fs.rmSync(path.join(copie, "src/proxy.ts"), { force: true });
const ecrans = {
  "src/app/(app)/mail/[folder]/page.tsx": "dossier",
  "src/app/(app)/mail/thread/[id]/page.tsx": "fil",
  "src/app/(app)/settings/accounts/[id]/page.tsx": "compte",
};
fs.mkdirSync(path.join(copie, "src/ecrans-locaux"), { recursive: true });
const routeur = path.join(copie, "src/components/layout/HashRouter.tsx");
let r = fs.readFileSync(routeur, "utf8");
for (const [fichier, nom] of Object.entries(ecrans)) {
  fs.renameSync(path.join(copie, fichier), path.join(copie, `src/ecrans-locaux/${nom}.tsx`));
  const ancien = "@/" + fichier.slice(4).replace(/\.tsx$/, "");
  if (!r.includes(`"${ancien}"`)) throw new Error(`import introuvable dans HashRouter : ${ancien}`);
  r = r.replace(`"${ancien}"`, `"@/ecrans-locaux/${nom}"`);
}
fs.writeFileSync(routeur, r);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (argv, env) => execFileSync(npm, argv, { cwd: copie, stdio: "inherit", env: { ...process.env, ...env } });
run(["ci", "--include=dev", "--no-audit", "--no-fund"], { NODE_ENV: "development" });
// Un seul nom de version pour le JavaScript ET le fichier /build-version : sinon
// le guetteur de version annonce sans fin une « nouvelle version » (essai app web).
const BUILD_HASH = WEB ? process.env.BUILD_HASH || "web" : process.env.BUILD_HASH || "iphone";
const BUILD_TIME = process.env.BUILD_TIME || new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
run(["run", "build"], {
  NODE_ENV: "production",
  IMIEL_EXPORT: "1",
  NEXT_PUBLIC_POCKETBASE_URL: "",
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_IMIEL_EDITION: "tous",
  ...(WEB
    ? { NEXT_PUBLIC_IMIEL_WEB: "1", NEXT_PUBLIC_IMIEL_CLOUD_URL: process.env.IMIEL_CLOUD_URL || "https://sync.getimiel.com" }
    : { NEXT_PUBLIC_IMIEL_IPHONE_LOCAL: "1" }),
  BUILD_HASH,
  BUILD_TIME,
});
// /build-version (route serveur ailleurs) devient un fichier : le guetteur de
// version de l'interface le lit comme avant.
fs.writeFileSync(path.join(copie, "out", "build-version"), JSON.stringify({ version: `${BUILD_HASH}-${BUILD_TIME}` }));

{
  const motif = /haiko\.studio|haiko-s1\.com|haikostudio\.cloud/;
  const out = path.join(copie, "out");
  const fautifs = [];
  for (const f of fs.readdirSync(out, { recursive: true })) {
    const p = path.join(out, String(f));
    if (/\.(js|html|json|txt)$/.test(p) && fs.statSync(p).isFile() && motif.test(fs.readFileSync(p, "utf8"))) fautifs.push(String(f));
  }
  if (fautifs.length) throw new Error(`adresse de l'instance de l'editeur dans l'interface : ${fautifs.slice(0, 5).join(", ")}`);
}
fs.rmSync(CIBLE, { recursive: true, force: true });
fs.mkdirSync(path.dirname(CIBLE), { recursive: true });
fs.cpSync(path.join(copie, "out"), CIBLE, { recursive: true });
fs.rmSync(tmp, { recursive: true, force: true });
const taille = execFileSync("du", ["-sh", CIBLE]).toString().split("\t")[0];
console.log(`interface locale : ${path.relative(racine, CIBLE)} (${taille})`);
