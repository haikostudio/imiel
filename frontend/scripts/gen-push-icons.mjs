// Genere les icones PNG des notifications push DISTINCTES (suivi + agenda).
// Lucide-style glyph (stroke blanc) sur fond de couleur arrondi, 192x192.
// Lancer depuis frontend/ : node scripts/gen-push-icons.mjs
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

// Glyph 24x24 (viewBox lucide) centre/scale dans un canvas 192.
function svg(bg, innerPaths) {
  const scale = 104 / 24; // glyph ~104px
  const margin = (192 - 24 * scale) / 2; // centre
  return `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="44" fill="${bg}"/>
  <g transform="translate(${margin},${margin}) scale(${scale})" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    ${innerPaths}
  </g>
</svg>`;
}

// Cloche (lucide "bell") = changement de statut / alerte.
const bell = `
    <path d="M10.268 21a2 2 0 0 0 3.464 0"/>
    <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>`;

// Calendrier (lucide "calendar-days") = agenda.
const calendar = `
    <path d="M8 2v4"/>
    <path d="M16 2v4"/>
    <rect width="18" height="18" x="3" y="4" rx="2"/>
    <path d="M3 10h18"/>
    <path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/>
    <path d="M8 18h.01"/><path d="M12 18h.01"/>`;

const targets = [
  { name: "tracking-192.png", bg: "#f59e0b", glyph: bell },     // ambre
  { name: "calendar-192.png", bg: "#2563eb", glyph: calendar }, // bleu
];

for (const t of targets) {
  const buf = Buffer.from(svg(t.bg, t.glyph));
  await sharp(buf).png().toFile(join(OUT, t.name));
  console.log("wrote", join(OUT, t.name));
}
