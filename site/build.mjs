#!/usr/bin/env node
// Fabrique la vitrine statique getimiel.com dans site/dist (aucune dependance).
//   node site/build.mjs            -> site/dist
//   SITE_URL=https://getimiel.com   (adresse canonique, par defaut getimiel.com)
// Les positions de la page d'accueil sur ordinateur reprennent la maquette
// validee au cadrage (scene de 1440 px de large, hauteur STAGE_H).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { T, LANGS, PATHS, GITHUB, RELEASES, CONTACT } from './src/content.mjs';
import * as W from './src/widgets.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist');
const SITE = (process.env.SITE_URL || 'https://getimiel.com').replace(/\/$/, '');
const STAGE_H = 8330;

// ---------- icones (traits Lucide) ----------
const I = {
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  brief: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  news: '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8M15 18h-5M10 6h8v4h-8z"/>',
  spark: '<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  apple: '<path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z"/><path d="M10 2c1 .5 2 2 2 5"/>',
  win: '<rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/><rect x="3" y="13" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/>',
  linux: '<path d="M12 2a4 4 0 0 0-4 4v3c0 2-3 5-3 9a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3c0-4-3-7-3-9V6a4 4 0 0 0-4-4z"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>', down: '<path d="m6 9 6 6 6-6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  eyeoff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  laptop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>', server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
};
const ico = (k, s = 14, extra = '') => `<svg class="ico${extra ? ' ' + extra : ''}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;
const SVC_ICONS = ['mail', 'cal', 'users', 'brief', 'news', 'spark'];
const SVC_KEYS = ['inbox', 'cal', 'contacts', 'suivi', 'news', 'ai'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const strip = (s) => String(s).replace(/<br>/g, ' ').replace(/<[^>]+>/g, '');
const pos = (o) => Object.entries(o).map(([k, v]) => `--${k}:${typeof v === 'number' ? v + 'px' : v}`).join(';');

// ---------- fichiers statiques (empreinte pour le cache) ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(path.join(SRC, 'assets'), path.join(OUT, 'assets'), { recursive: true });
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
fs.copyFileSync(path.join(SRC, 'site.css'), path.join(OUT, 'assets', 'site.css'));
fs.copyFileSync(path.join(SRC, 'app.js'), path.join(OUT, 'assets', 'app.js'));
const CSS_V = hash(path.join(SRC, 'site.css'));
const JS_V = hash(path.join(SRC, 'app.js'));
const IMG = (n) => `/assets/img/${n}`;

// ---------- le fil : chemin Catmull-Rom de la maquette validee ----------
const arcY = (x) => 612 + 0.00066 * (x - 720) ** 2;
const RY = (i) => 1560 + 300 + i * 430;
const stX = [702, 758, 676, 790, 660, 742];
const stY = (i) => RY(i) + 175;
const arcPts = [150, 190, 280, 370, 465, 560, 640, 720, 800, 880, 975, 1070, 1160, 1250, 1330].map((x) => [x, arcY(x)]);
const mids = [[740, 0], [712, -10], [735, 14], [722, -8], [700, 10]];
const pts = [...arcPts, [1408, 1000], [1418, 1230], [1414, 1470], [1404, 1700], [1260, 1812], [980, 1832], [790, 1880], [722, 1960],
  ...[0, 1, 2, 3, 4, 5].flatMap((i) => { const a = [stX[i], stY(i)]; if (i === 5) return [a]; const m = mids[i]; return [a, [m[0], stY(i) + 215 + m[1]]]; }),
  [716, 4380], [640, 4520], [420, 4575], [150, 4590], [36, 4700], [30, 5000], [38, 5300], [120, 5395], [420, 5418], [800, 5405], [1180, 5420], [1385, 5460], [1418, 5700], [1410, 5950], [1402, 6100], [1200, 6145], [800, 6150], [420, 6142], [150, 6160], [52, 6300], [60, 6600], [48, 6860], [130, 6935], [420, 6950], [640, 6965], [702, 7050], [698, 7250], [740, 7350], [1000, 7385], [1300, 7400], [1412, 7500], [1415, 7700], [1330, 7840], [1000, 7870], [800, 7872], [722, 7896]];
function catmull(p) {
  let d = `M ${p[0][0]} ${p[0][1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0]} ${(+p2[1]).toFixed(1)}`;
  }
  return d;
}
const PATH = catmull(pts);
const thread = `<svg class="thread desk-only" width="1440" height="${STAGE_H}" viewBox="0 0 1440 ${STAGE_H}" aria-hidden="true" data-thread="desk">
<defs><mask id="flown" maskUnits="userSpaceOnUse" x="-50" y="-50" width="1540" height="${STAGE_H + 100}"><path data-mask d="${PATH}" stroke="#fff" stroke-width="30" fill="none" stroke-dasharray="0 999999"/></mask></defs>
<path class="dim" data-path d="${PATH}" stroke-width="2" stroke-dasharray="11 9" stroke-linecap="round" fill="none"/>
<g mask="url(#flown)"><path class="lit" d="${PATH}" stroke-width="2.8" stroke-dasharray="11 9" stroke-linecap="round" fill="none"/></g></svg>
<svg class="thread mob-only" aria-hidden="true" data-thread="mob"><defs><mask id="flownm" maskUnits="userSpaceOnUse"><path data-mask stroke="#fff" stroke-width="24" fill="none" stroke-dasharray="0 999999"/></mask></defs>
<path class="dim" data-path stroke-width="2" stroke-dasharray="9 8" stroke-linecap="round" fill="none"/><g mask="url(#flownm)"><path class="lit" stroke-width="2.6" stroke-dasharray="9 8" stroke-linecap="round" fill="none"/></g></svg>
<img class="plane" src="${IMG('plane.webp')}" width="63" height="65" alt="" data-plane>`;

// ---------- lumiere doree (maquette validee) ----------
const streak = (d, o, id) => `<path d="${d}" stroke="url(#${id})" stroke-width="26" fill="none" filter="url(#b22)" opacity="${o * 0.5}"/><path d="${d}" stroke="url(#${id})" stroke-width="6" fill="none" filter="url(#b8)" opacity="${o * 0.8}"/><path d="${d}" stroke="url(#${id})" stroke-width="1.6" fill="none" filter="url(#b2)" opacity="${o}"/>`;
const glows = [[720, 1000, 640, 320, 1], [1290, 120, 260, 200, 0.55], [120, 330, 240, 200, 0.45], [1200, 2300, 420, 300, 0.35], [200, 3500, 380, 300, 0.35], [1240, 4840, 420, 320, 0.4], [300, 6050, 400, 300, 0.3], [720, 7600, 620, 300, 0.6]];
const light = `<svg class="light desk-only" viewBox="0 0 1440 ${STAGE_H}" preserveAspectRatio="none" aria-hidden="true"><defs>
<linearGradient id="g1" x1="0" x2="1"><stop offset="0" stop-color="#ffb21e" stop-opacity="0"/><stop offset=".5" stop-color="#ffc34a" stop-opacity=".9"/><stop offset="1" stop-color="#ff9e10" stop-opacity="0"/></linearGradient>
<linearGradient id="g2" x1="1" x2="0"><stop offset="0" stop-color="#ffb21e" stop-opacity="0"/><stop offset=".5" stop-color="#ffcc5a" stop-opacity=".85"/><stop offset="1" stop-color="#ff9e10" stop-opacity="0"/></linearGradient>
<filter id="b8"><feGaussianBlur stdDeviation="8"/></filter><filter id="b22"><feGaussianBlur stdDeviation="22"/></filter><filter id="b2"><feGaussianBlur stdDeviation="1.2"/></filter>
<radialGradient id="r1"><stop offset="0" stop-color="#d98a12" stop-opacity=".42"/><stop offset="1" stop-color="#d98a12" stop-opacity="0"/></radialGradient></defs>
${glows.map(([x, y, rx, ry, o]) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="url(#r1)" opacity="${o}"/>`).join('')}
${streak('M-40 360 C 220 300 330 120 620 60', 1, 'g1')}${streak('M820 40 C 1080 10 1250 160 1480 70', 1, 'g2')}${streak('M-60 560 C 120 520 180 460 260 380', 0.6, 'g1')}
${streak('M1500 5300 C 1300 5210 1180 5430 980 5350', 0.7, 'g2')}${streak('M-60 7420 C 300 7300 520 7580 900 7460', 0.7, 'g1')}${streak('M900 7880 C 1100 7810 1250 7920 1500 7800', 0.6, 'g2')}
</svg>`;

// ---------- morceaux communs ----------
function head(t, page, alt) {
  const canonical = SITE + PATHS[page][t.lang];
  const alts = LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${SITE}${PATHS[page][l]}">`).join('') + `<link rel="alternate" hreflang="x-default" href="${SITE}${PATHS[page].fr}">`;
  const title = page === 'home' ? t.title : `${alt.title} — iMiel`;
  const desc = page === 'home' ? t.description : (alt.description || t.description);
  const ld = page === 'home' ? `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'iMiel', url: canonical, description: t.description,
    applicationCategory: 'CommunicationApplication', operatingSystem: 'macOS, Windows, Linux, iOS', inLanguage: LANGS,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' }, license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    codeRepository: GITHUB, publisher: { '@type': 'Organization', name: 'Haiko Studio', email: CONTACT },
    image: SITE + IMG('partage.jpg'),
  })}</script>` : '';
  const langs = JSON.stringify(Object.fromEntries(LANGS.map((l) => [l, PATHS[page][l]])));
  return `<!doctype html><html lang="${t.lang}" data-theme="dark" data-alt='${langs}'${page === 'home' && t.lang === 'fr' ? ' data-root' : ''}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">${alts}
<meta property="og:type" content="website"><meta property="og:site_name" content="iMiel"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${SITE}${IMG('partage.jpg')}"><meta property="og:locale" content="${t.locale}"><meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0c0804" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#fbf4e4" media="(prefers-color-scheme: light)">
<link rel="icon" type="image/png" sizes="48x48" href="${IMG('favicon-48.png')}"><link rel="apple-touch-icon" href="${IMG('apple-touch-icon.png')}">
<link rel="preload" href="/assets/fonts/fraunces-480.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/assets/fonts/inter-400.woff2" as="font" type="font/woff2" crossorigin>
<script>(function(){var d=document.documentElement,t=null;try{t=localStorage.getItem('imiel-theme')}catch(e){}
d.setAttribute('data-theme',t||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'));
function z(){d.style.setProperty('--z',Math.min(1,innerWidth/1440))}z();addEventListener('resize',z);
if(d.hasAttribute('data-root')&&!/bot|crawl|spider|slurp|lighthouse|preview/i.test(navigator.userAgent)){var c=null;try{c=localStorage.getItem('imiel-lang')}catch(e){}
if(!c){var L=(navigator.languages||[navigator.language||'fr']).map(function(x){return String(x).slice(0,2).toLowerCase()});for(var i=0;i<L.length;i++){if(L[i]==='fr')break;if(L[i]==='en'||L[i]==='de'||L[i]==='it'){location.replace(JSON.parse(d.getAttribute('data-alt'))[L[i]]);break}}}}})();</script>
<link rel="stylesheet" href="/assets/site.css?v=${CSS_V}">${ld}</head>`;
}

function nav(t, page) {
  const h = PATHS.home[t.lang];
  const langs = LANGS.map((l) => `<li><a href="${PATHS[page][l]}" hreflang="${l}" lang="${l}" data-lang="${l}"${l === t.lang ? ' aria-current="true"' : ''}>${T[l].langName}</a></li>`).join('');
  return `<header class="nav" data-nav>
<a class="brand" href="${h}" aria-label="iMiel"><img src="${IMG('logo.webp')}" width="30" height="30" alt=""><b>iMiel</b></a>
<nav class="links" aria-label="${esc(t.nav.menu)}"><a href="${h}#services">${t.nav.features}</a><a href="${h}#apps">${t.nav.apps}</a><a href="${h}#code">${t.nav.code}</a><a href="${h}#faq">${t.nav.faq}</a></nav>
<div class="grow"></div>
<details class="langsel"><summary aria-label="${esc(t.nav.lang)}">${ico('globe', 15)} ${t.lang.toUpperCase()} ${ico('down', 12)}</summary><ul class="glass">${langs}</ul></details>
<button class="iconbtn" type="button" data-theme-toggle aria-label="${esc(t.nav.theme)}">${ico('moon', 16, 'moon')}${ico('sun', 16, 'sun')}</button>
<a class="pill src" href="${GITHUB}" rel="noopener">${ico('github', 15)} ${t.nav.source}</a>
<a class="pill gold dl" href="${PATHS.download[t.lang]}">${t.nav.download}</a>
<button class="iconbtn burger" type="button" data-burger aria-label="${esc(t.nav.menu)}" aria-expanded="false">${ico('menu', 20)}</button>
</header>`;
}

function ctas(t) {
  return `<div class="ctas"><a class="btn btn-gold" href="${PATHS.download[t.lang]}#mac" data-os-cta data-labels='${esc(JSON.stringify(t.hero.cta))}' data-base="${PATHS.download[t.lang]}">${ico('apple', 17, 'os-ico')}<span data-os-label>${t.hero.cta.mac}</span>${ico('arrow', 16)}</a>
<a class="btn btn-ghost" href="${GITHUB}" rel="noopener">${ico('github', 17)} ${t.hero.code}</a></div>`;
}

function footer(t) {
  return `<span class="brand"><img src="${IMG('logo.webp')}" width="24" height="24" alt=""><b>iMiel</b></span><span>${t.footer.tagline}</span><span class="grow"></span>
<a href="${PATHS.home[t.lang]}#services">${t.nav.features}</a><a href="${PATHS.download[t.lang]}">${t.footer.download}</a><a href="${GITHUB}" rel="noopener">${t.nav.code}</a>
<a href="${PATHS.privacy[t.lang]}">${t.footer.privacy}</a><a href="${PATHS.legal[t.lang]}">${t.footer.legal}</a><span>© 2026 · AGPL-3.0</span>`;
}

const tilt = (html, l, top, r, s) => `<div class="abs tilt desk-only" style="${pos({ l, t: top })};transform:rotate(${r}deg) scale(${s});z-index:6"><div class="wshadow">${html}</div></div>`;
const shot = (k, alt, w) => `<figure class="shot glass"${w ? ` style="width:${w}px"` : ''}><img class="th-dark" src="${IMG(`ecran-${k}-sombre.webp`)}" alt="${esc(alt)}" loading="lazy" decoding="async"><img class="th-light" src="${IMG(`ecran-${k}.webp`)}" alt="${esc(alt)}" loading="lazy" decoding="async"></figure>`;
const phone = (img, alt, cls, style) => `<div class="phone ${cls}" style="${style}"><div class="scr"><div class="bar" aria-hidden="true"><span>9:41</span><i></i><span>●●●</span></div><img class="th-dark" src="${IMG(img + '-sombre.webp')}" alt="${esc(alt)}" loading="lazy"><img class="th-light" src="${IMG(img + '.webp')}" alt="${esc(alt)}" loading="lazy"></div></div>`;

// ---------- page d'accueil ----------
function home(t) {
  const s = t.services;
  const arc = [190, 370, 560, 880, 1070, 1250].map((x, i) => `<li><button type="button" class="pill ${i === 0 ? 'gold' : 'glass'} arc-st abs" style="${pos({ l: x, t: arcY(x).toFixed(1) + 'px' })}" data-svc="${i}" aria-pressed="${i === 0}">${ico(SVC_ICONS[i], 14, 'gico')} ${s[i]}</button></li>`).join('');
  const screens = SVC_KEYS.map((k, i) => `<figure class="${i === 0 ? 'on' : ''}" data-screen="${i}"><img class="th-dark" src="${IMG(`ordinateur-${k}-sombre.webp`)}" alt="${esc(`iMiel — ${s[i]}`)}" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" width="1640" height="1025"><img class="th-light" src="${IMG(`ordinateur-${k}.webp`)}" alt="${esc(`iMiel — ${s[i]}`)}" loading="lazy" decoding="async" width="1640" height="1025"></figure>`).join('');
  const rows = t.sec.rows.map(([h, p], i) => {
    const left = i % 2 === 0;
    const textPos = left ? { t: RY(i), l: 120 } : { t: RY(i), l: 880, w: 440 };
    const shotPos = { t: RY(i) + (i === 5 ? -20 : 20), l: left ? (i === 5 ? 900 : 820) : (i === 5 ? 160 : 90) };
    const rw = { 0: [W.importants(false), 760, 2150, -4, 0.66], 1: [W.agenda(false), 470, 2600, 3, 0.7], 3: [W.suivis(false), 436, 3452, -3, 0.66] }[i];
    return `<article class="row sec" data-row="${i}">
<span class="pill glass station abs" style="${pos({ l: stX[i], t: stY(i) })}" data-station="${i}">${String(i + 1).padStart(2, '0')} — ${s[i]}</span>
<div class="abs row-text" style="${pos(textPos)}"><div><h3 class="ser">${h.replace(/<br>/g, ' <br>')}</h3><p class="p">${p}</p></div></div>
<div class="abs row-shot" style="${pos(shotPos)}">${shot(SVC_KEYS[i], `iMiel — ${s[i]}`, i === 5 ? 416 : 556)}</div>
${rw ? tilt(rw[0], rw[1], rw[2], rw[3], rw[4]) : ''}</article>`;
  }).join('');
  const A0 = 4640, P0 = 5440, B0 = 6190, K0 = 6980, F0 = 7440, Z0 = 7900;
  const plat = [['apple', 0], ['win', 1], ['linux', 2], ['phone', 3]].map(([k, i]) => `<span class="pill ${i === 0 ? 'gold' : 'glass'}">${ico(k, 15, i === 0 ? '' : 'gico')} ${t.apps.platforms[i]}</span>`).join('');
  const hs = `<div class="abs hs" style="${pos({ l: 636, t: 50, w: 300, h: 612 })};border-radius:52px;background:#0b0805;border:2px solid rgba(255,200,110,.5);padding:12px;z-index:4;box-shadow:0 0 80px -16px rgba(245,170,40,.55),0 40px 80px -20px rgba(0,0,0,.9)" role="img" aria-label="${esc(t.apps.lockCaption)}">
<div style="width:276px;height:588px;border-radius:42px;overflow:hidden;position:relative;background:radial-gradient(120% 80% at 30% 10%,#7a4a10,#2a1a0a 55%,#120c06)">
<div style="display:flex;justify-content:space-between;padding:14px 26px 0;font-size:13px;font-weight:600;color:#fff;font-family:${W.WF}"><span>9:41</span><span style="width:90px;height:26px;border-radius:20px;background:#000;margin-top:-4px"></span><span>●●●</span></div>
<div style="position:absolute;left:12px;top:56px;transform:scale(.77);transform-origin:top left">${W.agenda(false)}</div>
<div style="position:absolute;left:12px;top:186px;transform:scale(.77);transform-origin:top left">${W.importants(false)}</div>
<div style="position:absolute;left:12px;top:316px;transform:scale(.77);transform-origin:top left">${W.suivis(false)}</div>
<div style="position:absolute;left:22px;top:452px;display:grid;grid-template-columns:repeat(4,50px);gap:16px 14px">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => i === 0 ? `<img src="${IMG('logo.webp')}" width="50" height="50" style="border-radius:12px" alt="">` : '<span style="width:50px;height:50px;border-radius:12px;background:rgba(255,236,200,.13);border:1px solid rgba(255,236,200,.12)"></span>').join('')}</div>
</div></div>`;
  const lock = `<div class="abs lockp" style="${pos({ l: 976, t: 110, w: 250, h: 510 })};border-radius:44px;background:#0b0805;border:2px solid rgba(255,200,110,.4);padding:10px;z-index:3;box-shadow:0 40px 80px -20px rgba(0,0,0,.9)" role="img" aria-label="${esc(t.apps.lockCaption)}">
<div style="width:226px;height:486px;border-radius:36px;overflow:hidden;position:relative;background:radial-gradient(100% 70% at 50% 20%,#4a3215,#140d06);color:#fff;font-family:${W.WF};text-align:center">
<div style="margin-top:46px;font-size:13px;font-weight:600;opacity:.85">${t.apps.lockDate}</div><div style="font-size:72px;font-weight:600;line-height:1;margin-top:2px;letter-spacing:-2px">8:31</div>
<div style="display:flex;justify-content:center;align-items:center;gap:14px;margin-top:14px">${W.lockCirc(3)}<div style="text-align:left">${W.lockRect()}</div></div>
<div style="position:absolute;bottom:22px;left:0;right:0;font-size:11px;opacity:.6">${t.apps.lockCaption}</div></div></div>`;
  const nodes = t.privacy.nodes.map(([b, sp], i) => `${i ? `<div class="link-dash" aria-hidden="true"><span>${ico('lock', 13)}</span></div>` : ''}<div class="node glass"><div class="ic">${ico(['laptop', 'cloud', 'phone'][i], 24)}</div><b>${b}</b><span>${sp}</span></div>`).join('');
  const tiles = [[120, B0 + 170, 600, 250, 'spark', true], [740, B0 + 170, 280, 250, 'shield'], [1040, B0 + 170, 280, 250, 'search'], [120, B0 + 440, 390, 230, 'eyeoff'], [530, B0 + 440, 390, 230, 'laptop'], [940, B0 + 440, 380, 230, 'code']]
    .map(([l, top, w, h, ic, g], i) => `<div class="abs tile ${g ? 'gold-tile' : 'glass'}" style="${pos({ l, t: top, w, h })}"><div class="ic">${ico(ic, 20)}</div><h3 class="ser">${t.why.tiles[i][0]}</h3><p>${t.why.tiles[i][1]}</p>${g ? '<div class="ser big" aria-hidden="true">0 €</div>' : ''}</div>`).join('');
  const faq = t.faq.items.map(([q, a], i) => `<details class="glass"${i === 0 ? ' open' : ''}><summary>${q}${ico('plus', 16, 'plus')}${ico('minus', 16, 'minus')}</summary><p>${a}</p></details>`).join('');
  const code = [['git clone', GITHUB], ['cd', 'imiel'], ['cp', '.env.example .env'], ['docker compose', 'up -d'], ['#', t.code.comment]]
    .map(([a, b], i) => `<span class="ln">${i + 1}</span>  ${a === '#' ? `<span class="cm"># ${b}</span>` : `<span class="kw">${a}</span> ${b}`}`).join('\n');
  const stats = t.stats.items.map(([n, sp]) => `<div class="it"><b class="ser">${n}</b><span>${sp}</span></div>`).join('');
  return `${head(t, 'home', {})}<body>
<main class="stage" style="--stage-h:${STAGE_H}px" data-stage>
${light}${nav(t, 'home')}
<section class="abs center hero-text" style="${pos({ t: 118 })}" aria-labelledby="h1">
<span class="kick">${ico('spark', 12)} ${t.hero.kicker}</span>
<h1 id="h1" class="ser">${t.hero.h1[0]}<br>${t.hero.h1[1]}</h1>
<p class="p lead">${t.hero.lead.replace(/<br>/g, ' <br>')}</p>
${ctas(t)}
<p class="note"><span data-os-note data-notes='${esc(JSON.stringify(t.hero.note))}'>${t.hero.note.mac}</span> · ${t.hero.license}</p>
</section>
<ul class="arc-list" role="list" aria-label="${esc(t.sec.kicker)}">${arc}</ul>
<div class="hero-visual">
<div class="abs laptop" style="${pos({ l: 300, t: 780, w: 840 })};z-index:2"><div class="lid"><div class="screen" data-carousel aria-live="polite">${screens}</div></div><div class="base"></div></div>
${phone('telephone', 'iMiel — iPhone', 'abs', `${pos({ l: 1150, t: 905, w: 210, h: 428 })};z-index:4`)}
</div>
${tilt(W.importants(false), 26, 872, -5, 0.64)}${tilt(W.agenda(false), 336, 716, 4, 0.62)}${tilt(W.suivis(false), 752, 664, -3, 0.58)}
<div class="abs desk-only" style="${pos({ l: 64, t: 1118 })};transform:rotate(3deg);z-index:6"><div class="lockchip">${W.lockCirc(3)}${W.lockRect()}</div></div>
<div class="abs center cap-wrap" style="${pos({ t: 1312 })}"><span class="pill glass carousel-cap"><b data-cap-name>${s[0]}</b> · <span data-cap-text data-caps='${esc(JSON.stringify(t.hero.captions))}' data-names='${esc(JSON.stringify(s))}'>${t.hero.captions[0]}</span> · <span class="n"><span data-cap-n>1</span> ${t.hero.of} 6</span></span></div>
<div class="abs glass stats" style="${pos({ t: 1366, l: 64, r: 64 })}"><div class="lbl">${t.stats.label}</div>${stats}</div>
<section id="services" aria-labelledby="h-services">
<div class="abs center sec-head" style="${pos({ t: 1560 })}"><span class="kick">${ico('spark', 12)} ${t.sec.kicker}</span><h2 id="h-services" class="ser h2">${t.sec.title}</h2><p class="p">${t.sec.sub}</p></div>
${rows}
</section>
<section id="apps" class="abs glass apps-card" style="${pos({ t: A0, l: 64, r: 64, h: 700 })}" aria-labelledby="h-apps">
<div class="abs apps-text" style="${pos({ l: 64, t: 90, w: 520 })}"><span class="kick">${ico('phone', 12)} ${t.apps.kicker}</span><h2 id="h-apps" class="ser h2">${t.apps.title}</h2><p class="p">${t.apps.text}</p><div class="plats">${plat}</div><small>${t.apps.note}</small></div>
<div class="apps-phones">${hs}${lock}</div>
</section>
<section class="privacy" aria-labelledby="h-priv">
<div class="abs center sec-head" style="${pos({ t: P0 })}"><span class="kick">${ico('lock', 12)} ${t.privacy.kicker}</span><h2 id="h-priv" class="ser h2">${t.privacy.title}</h2><p class="p">${t.privacy.sub}</p></div>
<div class="abs center nodes" style="${pos({ t: P0 + 300 })}">${nodes}</div>
<div class="abs glass kit" style="${pos({ t: P0 + 560, l: 330, w: 780 })}">${ico('key', 26)}<p><b>${t.privacy.kitTitle}</b> ${t.privacy.kit}</p></div>
</section>
<section class="why" aria-labelledby="h-why">
<div class="abs center sec-head" style="${pos({ t: B0 })}"><span class="kick">${ico('spark', 12)} ${t.why.kicker}</span><h2 id="h-why" class="ser h2">${t.why.title}</h2></div>
<div class="bento">${tiles}</div>
</section>
<section id="code" class="code-wrap" aria-labelledby="h-code">
<div class="abs code-text" style="${pos({ t: K0, l: 120, w: 520 })}"><span class="kick">${ico('code', 12)} ${t.code.kicker}</span><h2 id="h-code" class="ser h2">${t.code.title}</h2><p class="p">${t.code.text}</p>
<div class="btns"><a class="btn btn-ghost" href="${GITHUB}" rel="noopener">${ico('github', 16)} ${t.code.github}</a><a class="btn btn-ghost" href="${GITHUB}#readme" rel="noopener" style="color:var(--sub)">${t.code.guide}</a></div></div>
<div class="abs code-card" style="${pos({ t: K0 + 10, l: 760, w: 560 })}"><div class="dots" aria-hidden="true"><i style="background:#ef5b4b"></i><i style="background:#f5b22a"></i><i style="background:#45c46b"></i></div><pre><code>${code}</code></pre></div>
</section>
<section id="faq" class="faq" aria-labelledby="h-faq">
<div class="abs center head" style="${pos({ t: F0 })}"><span class="kick">FAQ</span><h2 id="h-faq" class="ser">${t.faq.title}</h2></div>
<div class="abs list" style="${pos({ t: F0 + 150, l: 330, w: 780 })}">${faq}</div>
</section>
<section class="abs center final" style="${pos({ t: Z0 })}" aria-labelledby="h-final"><img src="${IMG('logo.webp')}" width="54" height="54" alt="" data-final-logo><h2 id="h-final" class="ser">${t.final.title}</h2>${ctas(t)}</section>
<footer class="abs foot" style="${pos({ t: STAGE_H - 70, l: 64, r: 64, h: 50 })}">${footer(t)}</footer>
${thread}
</main>
<script src="/assets/app.js?v=${JS_V}" defer></script>
</body></html>`;
}

// ---------- pages secondaires ----------
function simplePage(t, page, title, body, description) {
  return `${head(t, page, { title, description })}<body>
<div class="stage-flat">${nav(t, page)}<main class="page">${body}</main>
<footer class="page"><div class="foot">${footer(t)}</div></footer></div>
<script src="/assets/app.js?v=${JS_V}" defer></script></body></html>`;
}

function download(t) {
  const d = t.dl;
  const card = (id, ic, [name, text, file], href, soon) => `<article class="dl-card glass" id="${id}" data-dl="${id}"><div class="ic">${ico(ic, 22)}</div><h2 class="ser">${name}</h2><p>${text}</p><small>${file}</small>
${soon ? `<a class="btn btn-ghost" aria-disabled="true">${d.soon}</a>` : `<a class="btn btn-gold" href="${href}" rel="noopener">${ico('arrow', 15)} ${d.get}</a>`}</article>`;
  const smart = (step) => `<div class="smart" aria-hidden="true"><h3>${d.smartTitle}</h3><p>${d.smartText}</p>
${step === 1 ? `<span class="more hl">${d.smartMore}</span><div class="bt"><span>${d.smartNo}</span></div>` : `<div class="meta">${d.smartApp}<br>${d.smartPub}</div><div class="bt"><span class="hl">${d.smartRun}</span><span>${d.smartNo}</span></div>`}</div>`;
  const body = `<h1 class="ser">${d.title}</h1><p class="sub">${d.sub}</p>
<div class="dl-grid">${card('mac', 'apple', d.mac, RELEASES)}${card('windows', 'win', d.windows, RELEASES)}${card('linux', 'linux', d.linux, RELEASES)}${card('iphone', 'phone', d.iphone, '', true)}</div>
<p class="dl-note">${d.releases}</p>
<section class="win glass" id="windows-premier-lancement"><h2 class="ser">${d.winTitle}</h2><p>${d.winText}</p>
<div class="win-steps"><div class="win-step"><b>1. ${d.winSteps[0]}</b>${smart(1)}</div><div class="win-step"><b>2. ${d.winSteps[1]}</b>${smart(2)}</div></div></section>
<article class="dl-card glass" style="margin-top:26px"><div class="ic">${ico('server', 22)}</div><h2 class="ser">${d.server[0]}</h2><p>${d.server[1]}</p><a class="btn btn-ghost" href="${GITHUB}#readme" rel="noopener">${ico('github', 15)} ${d.server[2]}</a></article>`;
  return simplePage(t, 'download', d.title, body, d.sub);
}

function legalLike(t, page, data) {
  const body = `<h1 class="ser">${data.title}</h1>${data.updated ? `<p class="updated">${data.updated}</p>` : ''}<div class="prose">${data.blocks.map(([h, p]) => `<h2 class="ser">${h}</h2><p>${p}</p>`).join('')}</div>`;
  return simplePage(t, page, data.title, body, strip(data.blocks[0][1]));
}

// ---------- ecriture ----------
const write = (p, html) => { const f = path.join(OUT, p, 'index.html'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, html); };
for (const l of LANGS) {
  const t = T[l];
  write(PATHS.home[l], home(t));
  write(PATHS.download[l], download(t));
  write(PATHS.privacy[l], legalLike(t, 'privacy', t.privacyPage));
  write(PATHS.legal[l], legalLike(t, 'legal', t.legalPage));
}
// 404
fs.writeFileSync(path.join(OUT, '404.html'), simplePage(T.fr, 'home', 'Page introuvable', `<h1 class="ser">Page introuvable</h1><p class="sub">Cette page n’existe pas ou plus. <a href="/" style="color:var(--g)">Retour à l’accueil</a> · <a href="/en/" style="color:var(--g)">Home</a></p>`, 'Page introuvable'));
// robots, sitemap, llms.txt
fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
const urls = Object.keys(PATHS).flatMap((page) => LANGS.map((l) => `<url><loc>${SITE}${PATHS[page][l]}</loc>${LANGS.map((a) => `<xhtml:link rel="alternate" hreflang="${a}" href="${SITE}${PATHS[page][a]}"/>`).join('')}</url>`));
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`);
const f = T.fr;
fs.writeFileSync(path.join(OUT, 'llms.txt'), `# iMiel

> ${f.description}

iMiel est un logiciel libre (licence AGPL-3.0) et gratuit, sans abonnement ni publicité. Il réunit six services dans une seule application : ${f.services.join(', ')}.

## En bref
- Applications : Mac, Windows, Linux et iPhone (avec widgets d'écran d'accueil et d'écran verrouillé).
- Les données (mails, contacts, rendez-vous, réglages) restent sur l'ordinateur de l'utilisateur.
- Un compte iMiel facultatif relie plusieurs appareils ; tout ce qui transite est chiffré avec une clé que seul l'utilisateur détient (mot de passe principal + clé secrète, kit de secours).
- L'assistant, les résumés et les traductions utilisent la clé d'IA de l'utilisateur ; sans clé, ils restent éteints.
- Gmail se relie par un mot de passe d'application ; Google Agenda par une connexion limitée à l'agenda.
- Le code est public : ${GITHUB}
- Langues : français, anglais, allemand, italien.

## Pages
- Accueil : ${SITE}/ (en : ${SITE}/en/, de : ${SITE}/de/, it : ${SITE}/it/)
- Télécharger : ${SITE}${PATHS.download.fr}
- Confidentialité : ${SITE}${PATHS.privacy.fr}
- Mentions légales : ${SITE}${PATHS.legal.fr}
- Contact : ${CONTACT}
`);
const count = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log(`vitrine fabriquee dans ${path.relative(process.cwd(), OUT) || OUT} : ${count(OUT)} fichiers, ${LANGS.length} langues`);
