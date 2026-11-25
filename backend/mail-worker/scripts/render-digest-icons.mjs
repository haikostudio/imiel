// Dessine les pictogrammes PNG du recapitulatif du matin (daily-digest-template.ts)
// dans frontend/public/images/digest/. Gmail ignore le SVG : on rend chaque
// icone (grille 24, trait Lucide) dans Chrome en 3x avec fond transparent.
//
// Lancer : PLAYWRIGHT=/chemin/vers/node_modules/playwright node scripts/render-digest-icons.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../frontend/public/images/digest");
mkdirSync(out, { recursive: true });

const ICONS = {
  mail: ["#1d4ed8", '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'],
  newsletter: [
    "#6d28d9",
    '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/>',
  ],
  tracking: [
    "#b45309",
    '<path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="m7.5 4.27 9 5.15"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/><circle cx="18.5" cy="15.5" r="2.5"/><path d="M20.27 17.27 22 19"/>',
  ],
  trending: ["#047857", '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>'],
  check: ["#047857", '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'],
};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ deviceScaleFactor: 3, viewport: { width: 22, height: 22 } });
for (const [name, [color, body]] of Object.entries(ICONS)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.locator("svg").screenshot({ path: `${out}/${name}.png`, omitBackground: true });
  console.log(`${out}/${name}.png`);
}
await browser.close();
