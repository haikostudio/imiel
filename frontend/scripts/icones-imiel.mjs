#!/usr/bin/env node
/**
 * Icones iMiel tirees de l'image ORIGINALE fournie par l'utilisateur
 * (icons-source/imiel-original.png : avion en papier raye facon abeille, en
 * relief sur un carre arrondi orange, fond blanc, 1254x1254 RGB).
 *
 * REGLE (decision utilisateur 2026-11-24) : l'image n'est JAMAIS redessinee,
 * vectorisee ni aplatie. Seules operations : rogner la marge, rendre le fond
 * blanc transparent, redimensionner (lanczos3), prolonger les pixels de bord.
 * Seule exception : le badge de notification Android (silhouette blanche,
 * le systeme n'accepte que la transparence).
 *
 * Relancable : node scripts/icones-imiel.mjs  (depuis frontend/)
 * Sorties :
 *   public/icons/icon-192.png, icon-512.png       (a) detoure, fond transparent
 *   public/icons/icon-maskable-192/512.png        (b) plein bord, zone sure 80 %
 *   public/icons/icon-180.png (apple-touch)       (b) plein bord RGB (iOS masque)
 *   public/icons/imiel-logo-168.png, -120.png     (a) page de connexion, Google
 *   public/icons/badge-96.png                     (d) silhouette blanche
 *   public/favicon.ico + src/app/favicon.ico (16/32/48), favicon-32/48  (a)
 *   ../mobile/ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png (b) RGB sans alpha
 *   ../desktop/icon-source-1024.png               (c) detoure dans la grille Apple
 *   icons-source/controle.png                     planche de controle a regarder
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = path.join(ROOT, "icons-source/imiel-original.png");
const OUT = path.join(ROOT, "public/icons");
const pub = (f) => path.join(ROOT, "public", f);

const { data: rgb, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;

// --- (a) Detourage : le fond blanc RELIE AU BORD devient transparent --------
// Remplissage depuis les bords a travers les pixels clairs (min(r,g,b) >= 200) :
// les reflets clairs DANS l'avion ne sont jamais touches. Alpha = (250 - min)/60
// sur ces seuls pixels, couleur de-melangee du blanc (ombre douce gardee).
const minc = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) minc[i] = Math.min(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
const outside = new Uint8Array(W * H);
const stack = [];
for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
while (stack.length) {
  const p = stack.pop();
  if (outside[p] || minc[p] < 200) continue;
  outside[p] = 1;
  const x = p % W;
  const y = (p / W) | 0;
  if (x > 0) stack.push(p - 1);
  if (x < W - 1) stack.push(p + 1);
  if (y > 0) stack.push(p - W);
  if (y < H - 1) stack.push(p + W);
}
const rgba = Buffer.alloc(W * H * 4);
let minX = W, minY = H, maxX = 0, maxY = 0;
for (let i = 0; i < W * H; i++) {
  let a = 1;
  if (outside[i]) a = Math.max(0, Math.min(1, (250 - minc[i]) / 60));
  for (let c = 0; c < 3; c++) {
    const v = rgb[i * 3 + c];
    rgba[i * 4 + c] = a > 0 ? Math.max(0, Math.min(255, Math.round((v - 255 * (1 - a)) / a))) : 0;
  }
  rgba[i * 4 + 3] = Math.round(a * 255);
  if (a > 0.04) {
    const x = i % W;
    const y = (i / W) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}
// Carre centre sur la boite utile (marge transparente egale).
const side = Math.max(maxX - minX + 1, maxY - minY + 1);
const cx = (minX + maxX) / 2;
const cy = (minY + maxY) / 2;
const left = Math.round(cx - side / 2);
const top = Math.round(cy - side / 2);
// (sharp applique extract AVANT extend dans un meme pipeline : deux passes.)
const padded = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
  .extend({ top: side, bottom: side, left: side, right: side, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();
const cut = await sharp(padded)
  .extract({ left: left + side, top: top + side, width: side, height: side })
  .png()
  .toBuffer();
console.log(`boite utile x ${minX}->${maxX}, y ${minY}->${maxY} ; carre ${side}`);

// --- (b) Plein bord : l'interieur du carre orange, sans coins ni biseau -----
// Rognage DANS la tuile (le coin arrondi et son biseau restent dehors), puis
// reduction a 82 % (l'avion retrouve la proportion de l'original et reste dans
// la zone sure de 80 % d'Android) et marge comblee en PROLONGEANT les pixels de
// bord, adoucie par un flou, l'image nette recollee avec un bord fondu.
const TILE = { x: 64, y: 81, w: 1122, h: 1102 };
const INSET = Math.round(TILE.w * 0.095);
const inner = await sharp(SRC)
  .removeAlpha()
  .extract({ left: TILE.x + INSET, top: TILE.y + INSET, width: TILE.w - 2 * INSET, height: TILE.h - 2 * INSET })
  .resize(1024, 1024, { fit: "fill", kernel: "lanczos3" })
  .png()
  .toBuffer();

async function fullBleed(size, k = 0.82) {
  const s = Math.round(size * k);
  const pad = Math.floor((size - s) / 2);
  const small = await sharp(inner).resize(s, s, { kernel: "lanczos3" }).png().toBuffer();
  const bg = await sharp(small)
    .extend({ top: pad, bottom: size - s - pad, left: pad, right: size - s - pad, extendWith: "copy" })
    .blur(Math.max(1, size * 0.03))
    .png()
    .toBuffer();
  // Masque a bord fondu (~4 %) pour recoller l'image nette sans cassure.
  const f = Math.max(1, Math.round(s * 0.04));
  const mask = await sharp({
    create: { width: s, height: s, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${s}" height="${s}"><rect x="${f}" y="${f}" width="${s - 2 * f}" height="${s - 2 * f}" fill="#fff"/></svg>`
        ),
      },
    ])
    .blur(f / 2)
    .extractChannel("red")
    .png()
    .toBuffer();
  const sharpTop = await sharp(small).removeAlpha().joinChannel(mask).png().toBuffer();
  return sharp(bg).composite([{ input: sharpTop, left: pad, top: pad }]).removeAlpha();
}

// --- (d) Badge : silhouette BLANCHE de l'avion sur transparent --------------
// L'avion (jaune, brun, reflets clairs) se distingue du carre orange par sa
// teinte ; on garde la plus grande zone connexe au centre.
async function badge(size) {
  const { data, info: bi } = await sharp(cut).resize(512, 512).raw().toBuffer({ resolveWithObject: true });
  const n = bi.width * bi.height;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255, a = data[i * 4 + 3];
    if (a < 200) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    const sat = mx ? d / mx : 0;
    const yellow = h >= 45 && h <= 70 && sat > 0.25;
    const brown = mx < 0.66 && h < 42 && sat > 0.35;
    const light = sat < 0.3 && mx > 0.8;
    if (yellow || brown || light) m[i] = 1;
  }
  // Plus grande composante connexe (l'avion).
  const lab = new Int32Array(n);
  let best = 0, bestSize = 0, cur = 0;
  for (let i = 0; i < n; i++) {
    if (!m[i] || lab[i]) continue;
    cur++;
    let sz = 0;
    const st = [i];
    lab[i] = cur;
    while (st.length) {
      const p = st.pop();
      sz++;
      const x = p % bi.width, y = (p / bi.width) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < bi.width - 1 ? p + 1 : -1, y > 0 ? p - bi.width : -1, y < bi.height - 1 ? p + bi.width : -1]) {
        if (q >= 0 && m[q] && !lab[q]) {
          lab[q] = cur;
          st.push(q);
        }
      }
    }
    if (sz > bestSize) {
      bestSize = sz;
      best = cur;
    }
  }
  // Trous bouches : tout ce qui n'est pas joignable depuis le bord sans
  // traverser l'avion en fait partie (rayures sombres, reflets).
  const reach = new Uint8Array(n);
  const st2 = [];
  for (let x = 0; x < bi.width; x++) st2.push(x, (bi.height - 1) * bi.width + x);
  for (let y = 0; y < bi.height; y++) st2.push(y * bi.width, y * bi.width + bi.width - 1);
  while (st2.length) {
    const p = st2.pop();
    if (reach[p] || lab[p] === best) continue;
    reach[p] = 1;
    const x = p % bi.width, y = (p / bi.width) | 0;
    if (x > 0) st2.push(p - 1);
    if (x < bi.width - 1) st2.push(p + 1);
    if (y > 0) st2.push(p - bi.width);
    if (y < bi.height - 1) st2.push(p + bi.width);
  }
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
    out[i * 4 + 3] = reach[i] ? 0 : 255;
  }
  // Recadre sur l'avion (marge 10 %), lissage par la reduction.
  // Lissage du contour (fermeture : flou puis seuil sur la transparence).
  const alpha = await sharp(out, { raw: { width: bi.width, height: bi.height, channels: 4 } })
    .extractChannel(3)
    .blur(3)
    .threshold(110)
    .png()
    .toBuffer();
  const white = await sharp({ create: { width: bi.width, height: bi.height, channels: 3, background: "#ffffff" } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
  const trimmed = await sharp(white).trim().png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  const sideB = Math.round(Math.max(meta.width, meta.height) / 0.8);
  const square = await sharp(trimmed)
    .extend({
      top: Math.floor((sideB - meta.height) / 2),
      bottom: Math.ceil((sideB - meta.height) / 2),
      left: Math.floor((sideB - meta.width) / 2),
      right: Math.ceil((sideB - meta.width) / 2),
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toBuffer();
  return sharp(square).resize(size, size, { kernel: "lanczos3" });
}

const detoured = (size) => sharp(cut).resize(size, size, { kernel: "lanczos3" });

// Anciennes icones rangees, jamais supprimees.
const RESERVE = path.join(OUT, "reserve");
fs.mkdirSync(RESERVE, { recursive: true });
for (const f of ["icon-180.png", "icon-192.png", "icon-512.png", "icon.svg"]) {
  const from = path.join(OUT, f);
  const to = path.join(RESERVE, f.replace(/(\.\w+)$/, "-haikomail$1"));
  if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
}
if (fs.existsSync(path.join(OUT, "icon.svg"))) fs.rmSync(path.join(OUT, "icon.svg"));

await detoured(192).png().toFile(path.join(OUT, "icon-192.png"));
await detoured(512).png().toFile(path.join(OUT, "icon-512.png"));
await detoured(168).png().toFile(path.join(OUT, "imiel-logo-168.png"));
await detoured(120).png().toFile(path.join(OUT, "imiel-logo-120.png"));
await detoured(32).png().toFile(pub("favicon-32.png"));
await detoured(48).png().toFile(pub("favicon-48.png"));
await (await fullBleed(192)).png().toFile(path.join(OUT, "icon-maskable-192.png"));
await (await fullBleed(512)).png().toFile(path.join(OUT, "icon-maskable-512.png"));
await (await fullBleed(180)).png().toFile(path.join(OUT, "icon-180.png"));
await (await badge(96)).png().toFile(path.join(OUT, "badge-96.png"));

// favicon.ico (16/32/48) : conteneur ICO a entrees PNG.
const icoSizes = [16, 32, 48];
const pngs = await Promise.all(icoSizes.map((s) => detoured(s).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
pngs.forEach((buf, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(icoSizes[i] % 256, e);
  header.writeUInt8(icoSizes[i] % 256, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(buf.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += buf.length;
});
fs.writeFileSync(pub("favicon.ico"), Buffer.concat([header, ...pngs]));
// Convention de Next (app/favicon.ico) : servie en tete des liens, elle doit
// etre la meme (sinon l'onglet garde l'ancienne icone).
fs.writeFileSync(path.join(ROOT, "src/app/favicon.ico"), Buffer.concat([header, ...pngs]));

// iPhone : un seul 1024 RGB SANS alpha (l'App Store refuse la transparence).
const ios = path.resolve(ROOT, "../mobile/ios/App/Assets.xcassets/AppIcon.appiconset");
if (fs.existsSync(ios)) {
  for (const f of fs.readdirSync(ios).filter((x) => x.endsWith(".png"))) {
    const to = path.join(RESERVE, `ios-${f.replace(/\.png$/, "")}-haikomail.png`);
    if (!fs.existsSync(to)) fs.copyFileSync(path.join(ios, f), to);
  }
  const iosName = (JSON.parse(fs.readFileSync(path.join(ios, "Contents.json"), "utf8")).images || []).find((i) => i.filename)?.filename || "AppIcon-1024.png";
  await (await fullBleed(1024)).removeAlpha().png().toFile(path.join(ios, iosName));
  console.log(`iPhone : ${iosName}`);
}

// Ordinateur (Tauri) : carre arrondi detoure pose dans la grille Apple
// (824 px dans 1024, marge transparente) ; `npx tauri icon` en tire tout.
const desk = path.resolve(ROOT, "../desktop");
if (fs.existsSync(desk)) {
  await sharp(await detoured(824).png().toBuffer())
    .extend({ top: 100, bottom: 100, left: 100, right: 100, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(desk, "icon-source-1024.png"));
}

// --- Planche de controle ----------------------------------------------------
const T = 256;
const fb = await (await fullBleed(T)).png().toBuffer();
const circle = Buffer.from(`<svg width="${T}" height="${T}"><circle cx="${T / 2}" cy="${T / 2}" r="${T * 0.4}" fill="#fff"/></svg>`);
const squircle = Buffer.from(`<svg width="${T}" height="${T}"><rect width="${T}" height="${T}" rx="${T * 0.225}" fill="#fff"/></svg>`);
const masked = (m) => sharp(fb).ensureAlpha().composite([{ input: m, blend: "dest-in" }]).png().toBuffer();
const tile = (buf, bg) =>
  sharp({ create: { width: T + 40, height: T + 40, channels: 4, background: bg } })
    .composite([{ input: buf, left: 20, top: 20 }])
    .png()
    .toBuffer();
const dark = { r: 30, g: 30, b: 34, alpha: 1 };
const light = { r: 245, g: 245, b: 245, alpha: 1 };
const cells = [
  await tile(await sharp(SRC).resize(T, T).png().toBuffer(), light),
  await tile(await detoured(T).png().toBuffer(), dark),
  await tile(await detoured(T).png().toBuffer(), light),
  await tile(fb, light),
  await tile(await masked(circle), dark),
  await tile(await masked(squircle), dark),
  await tile(await (await badge(T)).png().toBuffer(), dark),
  await tile(await sharp(await detoured(32).png().toBuffer()).resize(T, T, { kernel: "nearest" }).png().toBuffer(), dark),
];
const cw = T + 40;
await sharp({ create: { width: cw * 4, height: cw * 2, channels: 4, background: light } })
  .composite(cells.map((c, i) => ({ input: c, left: (i % 4) * cw, top: Math.floor(i / 4) * cw })))
  .png()
  .toFile(path.join(ROOT, "icons-source/controle.png"));
console.log("icones iMiel ecrites");
