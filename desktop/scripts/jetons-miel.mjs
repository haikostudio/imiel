#!/usr/bin/env node
// Recopie les JETONS de l'apparence Miel (frontend/src/app/miel.css) dans
// desktop/dist/miel.css pour l'ecran de premier lancement de l'app
// d'ordinateur : une seule source de couleurs, aucune couleur en dur dans
// l'ecran. Clair = bloc :root[data-design="miel"], sombre = bloc .dark,
// applique selon le reglage du systeme. Relancer apres un changement de
// miel.css : node desktop/scripts/jetons-miel.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ici = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(ici, "../../frontend/src/app/miel.css");
const cible = path.resolve(ici, "../dist/miel.css");
const css = fs.readFileSync(source, "utf8");

function bloc(selecteur) {
  const debut = css.indexOf(selecteur + " {");
  if (debut < 0) throw new Error(`bloc introuvable : ${selecteur}`);
  const ouvert = css.indexOf("{", debut);
  const ferme = css.indexOf("\n}", ouvert);
  return css
    .slice(ouvert + 1, ferme)
    .split("\n")
    // Les fonds illustres de l'app (url(/backgrounds/...)) ne sont pas embarques.
    .filter((l) => !l.includes("url("))
    .join("\n");
}

const clair = bloc(':root[data-design="miel"]');
const sombre = bloc(':root[data-design="miel"].dark');
fs.writeFileSync(
  cible,
  `/* Genere par desktop/scripts/jetons-miel.mjs depuis frontend/src/app/miel.css : ne pas modifier a la main. */\n` +
    `:root {${clair}\n}\n@media (prefers-color-scheme: dark) {\n  :root {${sombre}\n  }\n}\n`
);
console.log(`jetons Miel ecrits dans ${path.relative(process.cwd(), cible)}`);
