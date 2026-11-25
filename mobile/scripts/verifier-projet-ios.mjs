// Controle hors ligne de la fabrication iPhone (aucun Mac requis) :
//  - le workflow ne vise QUE le Mac mini (pas de machine louee, pas de brew,
//    pas de choix dynamique) et nettoie toujours le trousseau ;
//  - les profils nommes dans le workflow sont ceux du projet XcodeGen ;
//  - la signature des requetes de l'app suit celle du worker.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wf = fs.readFileSync(path.join(root, ".github/workflows/mobile-ios.yml"), "utf8");
const proj = fs.readFileSync(path.join(root, "mobile/ios/project.yml"), "utf8");
const swift = fs.readFileSync(path.join(root, "mobile/ios/Shared/HaikoAPI.swift"), "utf8");
const worker = fs.readFileSync(path.join(root, "backend/mail-worker/src/index.ts"), "utf8");

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

ok(/runs-on:\s*\[self-hosted, macOS, mac-mini\]/.test(wf), "le job doit viser [self-hosted, macOS, mac-mini]");
ok(!/macos-|ubuntu-|fromJSON|brew install|allowProvisioningUpdates/.test(wf), "ni machine louee, ni fromJSON, ni brew, ni signature automatique");
ok(/if: always\(\)[\s\S]*delete-keychain/.test(wf), "le trousseau doit etre retire en if: always()");
ok(/HAIKO_KC=\$KC" >> "\$GITHUB_ENV"[\s\S]*security import/.test(wf), "le chemin du trousseau doit etre note AVANT l'import");
ok(!/push:\s*\n\s*branches/.test(wf), "jamais de fabrication a chaque commit");
for (const [bundle, profile] of [["studio.haiko.imiel", "iMiel App Store"], ["studio.haiko.imiel.Widgets", "iMiel Widgets App Store"]]) {
  ok(proj.includes(`PRODUCT_BUNDLE_IDENTIFIER: ${bundle}`), `project.yml : bundle ${bundle}`);
  ok(proj.includes(`PROVISIONING_PROFILE_SPECIFIER: "${profile}"`), `project.yml : profil ${profile}`);
  ok(wf.includes(`<key>${bundle}</key><string>${profile}</string>`), `ExportOptions : ${bundle} -> ${profile}`);
}
ok(!/application-groups/.test(proj), "pas d'App Group (partage par le trousseau)");
ok((proj.match(/^\s+keychain-access-groups:/gm) || []).length === 2, "trousseau partage sur l'app ET les widgets");
ok(swift.includes('"\\(method.uppercased()) \\(path)\\n"'), "Swift : canonique = METHODE chemin \\n corps");
ok(worker.includes("`${req.method.toUpperCase()} ${req.path}\\n`"), "worker : meme canonique");
ok(swift.includes('"/worker" + path'), "Swift : appels par /worker (reecriture Next)");

if (fails.length) {
  console.error("ECHEC :\n- " + fails.join("\n- "));
  process.exit(1);
}
console.log("Projet iPhone : controles hors ligne OK");
