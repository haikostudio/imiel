#!/usr/bin/env node
// Prepare la fabrication de la version « copie complete » de l'app iPhone
// (base + interface embarquees, mobile/ios/App/LocalStack.swift) :
//   - Capacitor charge l'interface servie par la base locale (127.0.0.1:8099) ;
//   - project.yml (copie de travail de la fabrication, jamais versionnee
//     ainsi) : Pbmobile.xcframework, ressources local/, condition de
//     compilation IMIEL_COPIE_LOCALE, liaison libresolv (resolveur DNS de Go),
//     reseau local autorise par ATS.
// Prerequis : mobile/ios/Pbmobile.xcframework (gomobile bind de mobile/base)
// et mobile/ios/App/local/{base,interface} (construire-interface-locale.mjs).
//   node mobile/scripts/poser-copie-locale.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADRESSE = "http://127.0.0.1:8099";

for (const rel of ["capacitor.config.json", "ios/App/capacitor.config.json"]) {
  const f = path.join(racine, rel);
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.server = { url: ADRESSE, cleartext: true, allowNavigation: ["127.0.0.1"] };
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
  console.log(`${rel} : ${ADRESSE}`);
}

for (const d of ["ios/Pbmobile.xcframework", "ios/App/local/interface/index.html", "ios/App/local/base/pb_migrations"]) {
  if (!fs.existsSync(path.join(racine, d))) throw new Error(`manquant : mobile/${d}`);
}

const fy = path.join(racine, "ios/project.yml");
let y = fs.readFileSync(fy, "utf8");
const remplacer = (avant, apres) => {
  if (!y.includes(avant)) throw new Error(`project.yml : bloc introuvable\n${avant}`);
  y = y.replace(avant, apres);
};
remplacer(
  `        excludes:
          - "public"
          - "public/**"
      - path: App/public
        type: folder`,
  `        excludes:
          - "public"
          - "public/**"
          - "local"
          - "local/**"
      - path: App/public
        type: folder
      - path: App/local
        type: folder`
);
remplacer(
  `      - package: Capacitor
        product: Cordova`,
  `      - package: Capacitor
        product: Cordova
      - framework: Pbmobile.xcframework
        embed: false`
);
remplacer(
  `        NSAppTransportSecurity:
          NSAllowsArbitraryLoads: false`,
  `        NSAppTransportSecurity:
          NSAllowsArbitraryLoads: false
          NSAllowsLocalNetworking: true`
);
remplacer(
  `        PRODUCT_BUNDLE_IDENTIFIER: studio.haiko.imiel
        PRODUCT_NAME: iMiel`,
  `        PRODUCT_BUNDLE_IDENTIFIER: studio.haiko.imiel
        PRODUCT_NAME: iMiel
        SWIFT_ACTIVE_COMPILATION_CONDITIONS: "$(inherited) IMIEL_COPIE_LOCALE"
        OTHER_LDFLAGS: "$(inherited) -lresolv"`
);
fs.writeFileSync(fy, y);
console.log("ios/project.yml : copie complete (base + interface embarquees)");
