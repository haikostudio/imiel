#!/usr/bin/env node
// Fabrique la vitrine statique getimiel.com dans site/dist (aucune dependance).
//   node site/build.mjs            -> site/dist
//   SITE_URL=https://getimiel.com   (adresse canonique, par defaut getimiel.com)
// La page d'accueil est en flux ; seule la scene de la demo (1440 px, mise a
// l'echelle par --z) garde des positions fixes. Le fil et l'avion sont traces
// par app.js a partir des boites reelles de la page.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { T, LANGS, PATHS, GITHUB, RELEASES, CONTACT, APP_WEB } from './src/content.mjs';
import * as W from './src/widgets.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist');
const SITE = (process.env.SITE_URL || 'https://getimiel.com').replace(/\/$/, '');

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
  flash: '<path d="M9 2h6l-1 7h4l-8 13 2-9H8z"/>', cam: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>', close: '<path d="M18 6 6 18M6 6l12 12"/>', check: '<path d="M20 6 9 17l-5-5"/>', server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
};
const ico = (k, s = 14, extra = '') => `<svg class="ico${extra ? ' ' + extra : ''}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;
const SVC_ICONS = ['mail', 'cal', 'users', 'brief', 'news', 'spark'];
const SVC_KEYS = ['inbox', 'cal', 'contacts', 'suivi', 'news', 'ai'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const strip = (s) => String(s).replace(/<br>/g, ' ').replace(/<[^>]+>/g, '');

// ---------- fichiers statiques (empreinte pour le cache) ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(path.join(SRC, 'assets'), path.join(OUT, 'assets'), { recursive: true });
// Manifeste signe des mises a jour de l'app d'ordinateur (s'il a ete produit
// par desktop/scripts/manifeste-mises-a-jour.mjs) : l'app le lit ici.
if (fs.existsSync(path.join(SRC, 'mises-a-jour'))) fs.cpSync(path.join(SRC, 'mises-a-jour'), path.join(OUT, 'mises-a-jour'), { recursive: true });
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
fs.copyFileSync(path.join(SRC, 'site.css'), path.join(OUT, 'assets', 'site.css'));
fs.copyFileSync(path.join(SRC, 'app.js'), path.join(OUT, 'assets', 'app.js'));
const CSS_V = hash(path.join(SRC, 'site.css'));
const JS_V = hash(path.join(SRC, 'app.js'));
const IMG = (n) => `/assets/img/${n}`;

// ---------- le fil et l'avion : trace calcule par app.js sur les boites reelles ----------
const thread = `<svg class="thread" data-thread aria-hidden="true"><defs><mask id="flown" maskUnits="userSpaceOnUse"><path data-mask stroke="#fff" stroke-width="34" fill="none" stroke-dasharray="0 999999"/></mask></defs>
<path class="dim" data-path stroke-width="1.6" stroke-dasharray="8 11" stroke-linecap="round" fill="none"/><g mask="url(#flown)"><path class="lit" stroke-width="2" stroke-dasharray="8 11" stroke-linecap="round" fill="none"/></g></svg>
<img class="plane" src="${IMG('plane.webp')}" width="60" height="62" alt="" data-plane>`;

// ---------- lumiere doree du haut (pleine largeur) ----------
const streak = (d, id) => `<path d="${d}" stroke="url(#${id})" stroke-width="26" fill="none" filter="url(#b22)" opacity=".45"/><path d="${d}" stroke="url(#${id})" stroke-width="5" fill="none" filter="url(#b8)" opacity=".6"/>`;
const light = `<div class="bgfx" aria-hidden="true"><svg class="streaks" viewBox="0 0 1440 1200" preserveAspectRatio="none"><defs>
<linearGradient id="g1" x1="0" x2="1"><stop offset="0" stop-color="#ffb21e" stop-opacity="0"/><stop offset=".5" stop-color="#ffc34a" stop-opacity=".9"/><stop offset="1" stop-color="#ff9e10" stop-opacity="0"/></linearGradient>
<linearGradient id="g2" x1="1" x2="0"><stop offset="0" stop-color="#ffb21e" stop-opacity="0"/><stop offset=".5" stop-color="#ffcc5a" stop-opacity=".85"/><stop offset="1" stop-color="#ff9e10" stop-opacity="0"/></linearGradient>
<filter id="b8"><feGaussianBlur stdDeviation="8"/></filter><filter id="b22"><feGaussianBlur stdDeviation="22"/></filter></defs>
${streak('M-40 380 C 220 300 330 120 620 50', 'g1')}${streak('M820 40 C 1080 10 1250 160 1480 70', 'g2')}</svg></div>`;

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
if(!matchMedia('(prefers-reduced-motion: reduce)').matches)d.classList.add('anim');d.classList.add('js');
function z(){d.style.setProperty('--z',Math.min(1,innerWidth/1440))}z();addEventListener('resize',z);
if(d.hasAttribute('data-root')&&!/bot|crawl|spider|slurp|lighthouse|preview/i.test(navigator.userAgent)){var c=null;try{c=localStorage.getItem('imiel-lang')}catch(e){}
if(!c){var L=(navigator.languages||[navigator.language||'fr']).map(function(x){return String(x).slice(0,2).toLowerCase()});for(var i=0;i<L.length;i++){if(L[i]==='fr')break;if(L[i]==='en'||L[i]==='de'||L[i]==='it'){location.replace(JSON.parse(d.getAttribute('data-alt'))[L[i]]);break}}}}})();</script>
<link rel="stylesheet" href="/assets/site.css?v=${CSS_V}">${ld}</head>`;
}

// Un retour a la ligne garde son espace quand il est masque sur telephone.
const br = (s) => String(s).replace(/<br>/g, ' <br>');
// Libelle double : le texte bascule au survol (la copie est cachee aux lecteurs d'ecran).
const roll = (txt, attr = '') => `<span class="roll"><span class="r1"${attr}>${txt}</span><span class="r2" aria-hidden="true"${attr}>${txt}</span></span>`;

function nav(t, page) {
  const h = PATHS.home[t.lang];
  const langs = LANGS.map((l) => `<li><a href="${PATHS[page][l]}" hreflang="${l}" lang="${l}" data-lang="${l}"${l === t.lang ? ' aria-current="true"' : ''}>${T[l].langName}</a></li>`).join('');
  const menuLinks = [[`${h}#services`, t.nav.features], [`${h}#tarifs`, t.nav.pricing], [`${h}#apps`, t.nav.apps], [`${h}#code`, t.nav.code], [`${h}#faq`, t.nav.faq]];
  // Menu du telephone : un panneau pose PAR-DESSUS la page, sous la barre (la barre ne grandit pas).
  const panel = `<div class="mpanel glass" id="menu-tel" data-mpanel hidden><nav aria-label="${esc(t.nav.menu)}">${menuLinks.map(([href, x]) => `<a href="${href}">${x}</a>`).join('')}<a href="${GITHUB}" rel="noopener">${ico('github', 20)} ${t.nav.source}</a></nav>
<a class="btn btn-gold mdl" href="${PATHS.download[t.lang]}">${t.nav.download} ${ico('arrow', 20)}</a></div>`;
  return `<header class="topnav"><div class="navin" data-nav>
<a class="brand" href="${h}" aria-label="iMiel"><img src="${IMG('logo.webp')}" width="30" height="30" alt=""><b>iMiel</b></a>
<nav class="links" aria-label="${esc(t.nav.menu)}">${menuLinks.map(([href, x]) => `<a href="${href}">${roll(x)}</a>`).join('')}</nav>
<div class="grow"></div>
<details class="langsel"><summary aria-label="${esc(t.nav.lang)}">${ico('globe', 20)} ${t.lang.toUpperCase()} ${ico('down', 14)}</summary><ul class="glass">${langs}</ul></details>
<button class="iconbtn" type="button" data-theme-toggle aria-label="${esc(t.nav.theme)}">${ico('moon', 22, 'moon')}${ico('sun', 22, 'sun')}</button>
<a class="pill2 ghostp src" href="${GITHUB}" rel="noopener">${ico('github', 18)} ${roll(t.nav.source)}</a>
<a class="pill2 goldp dl" href="${PATHS.download[t.lang]}">${roll(t.nav.download)}</a>
<button class="iconbtn burger" type="button" data-burger aria-label="${esc(t.nav.menu)}" aria-expanded="false" aria-controls="menu-tel">${ico('menu', 24, 'm-open')}${ico('close', 24, 'm-close')}</button>
${panel}</div></header>`;
}

function ctas(t) {
  return `<div class="ctas"><a class="btn btn-gold" href="${PATHS.download[t.lang]}#mac" data-os-cta data-labels='${esc(JSON.stringify(t.hero.cta))}' data-base="${PATHS.download[t.lang]}">${ico('apple', 20, 'os-ico')}${roll(t.hero.cta.mac, ' data-os-label')}${ico('arrow', 20)}</a>
<a class="btn btn-ghost" href="${GITHUB}" rel="noopener">${ico('github', 20)} ${roll(t.hero.code)}</a></div>`;
}

function footer(t) {
  const links = [[`${PATHS.home[t.lang]}#services`, t.nav.features], [PATHS.download[t.lang], t.footer.download], [GITHUB, t.nav.code], [PATHS.privacy[t.lang], t.footer.privacy], [PATHS.terms[t.lang], t.footer.terms], [PATHS.legal[t.lang], t.footer.legal]]
    .map(([href, x]) => `<a href="${href}"${href.startsWith('http') ? ' rel="noopener"' : ''}>${roll(x)}</a>`).join('');
  return `<footer class="foot2"><div class="wrap frow"><span class="brand"><img src="${IMG('logo.webp')}" width="26" height="26" alt=""><b>iMiel</b></span><span class="tag">${t.footer.tagline}</span><span class="grow"></span>
<nav aria-label="iMiel">${links}</nav></div>
<div class="wrap fsmall"><span>© 2026 · AGPL-3.0</span></div>
<div class="bigname ser" aria-hidden="true">iMiel</div></footer>`;
}

// Barre d'etat d'un iPhone (heure, ilot, reseau, wifi, batterie).
const statusBar = (dark) => `<div class="sb${dark ? ' sbd' : ''}" aria-hidden="true"><span>9:41</span><i class="island"></i><span class="sbi"><svg width="17" height="11" viewBox="0 0 17 11"><rect x="0" y="7" width="3" height="4" rx=".8" fill="currentColor"/><rect x="4.5" y="5" width="3" height="6" rx=".8" fill="currentColor"/><rect x="9" y="2.5" width="3" height="8.5" rx=".8" fill="currentColor"/><rect x="13.5" y="0" width="3" height="11" rx=".8" fill="currentColor"/></svg><svg width="15" height="11" viewBox="0 0 15 11"><path d="M7.5 2.2c2.2 0 4.2.9 5.6 2.3l1.1-1.1C12.5 1.6 10.1.6 7.5.6S2.5 1.6.8 3.4l1.1 1.1C3.3 3.1 5.3 2.2 7.5 2.2Zm0 3.2c1.3 0 2.5.5 3.4 1.4L12 5.7C10.8 4.5 9.2 3.8 7.5 3.8S4.2 4.5 3 5.7l1.1 1.1c.9-.9 2.1-1.4 3.4-1.4Zm0 3.2c-.5 0-1 .2-1.3.6L7.5 10.5l1.3-1.3c-.3-.4-.8-.6-1.3-.6Z" fill="currentColor"/></svg><svg width="25" height="12" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21" height="11" rx="3.2" fill="none" stroke="currentColor" opacity=".45"/><rect x="2" y="2" width="16" height="8" rx="2" fill="currentColor"/><rect x="22.6" y="4" width="1.6" height="4" rx=".8" fill="currentColor" opacity=".45"/></svg></span></div>`;
// Element qui flotte (rotation et echelle de base, duree et retard propres).
let flIndex = 0;
const flv = () => { const i = flIndex++; return `--fd:${(6.4 + (i * 1.37) % 3.4).toFixed(2)}s;--fdl:${(-((i * 2.3) % 6)).toFixed(2)}s`; };
const tilt = (html, l, top, r, s) => `<div class="flt fl" style="left:${l}px;top:${top}px;--r:${r}deg;--s:${s};${flv()}"><div class="wshadow">${html}</div></div>`;
// Dimensions des captures (la page ne saute pas pendant leur chargement).
const SHOT_SIZE = { ai: [800, 978] };
const shot = (k, alt) => { const [w, h] = SHOT_SIZE[k] || [1080, 675]; return `<figure class="shot glass"><img class="th-dark" src="${IMG(`ecran-${k}-sombre.webp`)}" alt="${esc(alt)}" width="${w}" height="${h}" loading="lazy" decoding="async"><img class="th-light" src="${IMG(`ecran-${k}.webp`)}" alt="${esc(alt)}" width="${w}" height="${h}" loading="lazy" decoding="async"></figure>`; };
// La ligne des services passe SOUS la demo : y = 620 - 0,0003 (x - 720)^2 dans la scene de 1440 px.
const ARC_X = [170, 360, 560, 880, 1080, 1270];
const arcY = (x) => 620 - 0.0003 * (x - 720) ** 2;

// ---------- page d'accueil ----------
function home(t) {
  flIndex = 0;
  const s = t.services;
  const arc = ARC_X.map((x, i) => `<div class="st arc below" data-st data-svc="${i}" style="left:${x}px;top:${arcY(x).toFixed(1)}px;--off:${(16 + Math.abs(0.0006 * (x - 720)) * 64).toFixed(0)}px" aria-hidden="true"><i class="dot"></i><span class="bub${i === 0 ? ' goldb' : ''}">${ico(SVC_ICONS[i], 16, 'gico')} ${s[i]}</span></div>`).join('');
  const chips = s.map((x, i) => `<span class="mst" data-chip="${i}"><i class="dot"></i><span class="bub${i === 0 ? ' goldb' : ''}">${ico(SVC_ICONS[i], 16, 'gico')} ${x}</span></span>`).join('');
  const screens = SVC_KEYS.map((k, i) => `<figure class="${i === 0 ? 'on' : ''}" data-screen="${i}"><img class="th-dark" src="${IMG(`ordinateur-${k}-sombre.webp`)}" alt="${esc(`iMiel — ${s[i]}`)}" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" width="1640" height="1025"><img class="th-light" src="${IMG(`ordinateur-${k}.webp`)}" alt="${esc(`iMiel — ${s[i]}`)}" ${i === 0 ? '' : 'loading="lazy" '}decoding="async" width="1640" height="1025"></figure>`).join('');
  const cursor = `<div class="cursor" data-cursor aria-hidden="true"><span class="ripple"></span><svg width="40" height="50" viewBox="0 0 30 38"><path d="M3 2 L3 31 L10.2 24.6 L14.8 35.2 L19.6 33.1 L15 22.7 L24.6 22.4 Z" fill="#fff" stroke="#111" stroke-width="2" stroke-linejoin="round"/></svg></div>`;
  const heroPhone = `<div class="phone2 fl" style="left:1150px;top:130px;width:176px;height:340px;${flv()}"><div class="scr2">${statusBar(false)}<img class="th-light" src="${IMG('telephone.webp')}" alt="iMiel — iPhone" width="420" height="909" loading="lazy"><img class="th-dark" src="${IMG('telephone-sombre.webp')}" alt="iMiel — iPhone" width="420" height="909" loading="lazy"></div></div>`;
  const hero = `<section class="hero" aria-labelledby="h1">
<div class="hero-text">
<span class="kick" data-rv>${ico('spark', 14)} ${t.hero.kicker}</span>
<h1 id="h1" class="ser" data-rv>${t.hero.h1[0]} <br>${t.hero.h1[1]}</h1>
<p class="p lead" data-rv>${br(t.hero.lead)}</p>
<div data-rv>${ctas(t)}</div>
<p class="note" data-rv><span data-os-note data-notes='${esc(JSON.stringify(t.hero.note))}'>${t.hero.note.mac}</span> · ${t.hero.license}</p>
</div>
<div class="hv" data-hv>
${arc}
<div class="laptop2" style="left:360px;top:10px;width:720px" data-demo><div class="lid"><div class="screen" data-screens aria-live="polite">${screens}</div></div><div class="base"></div>${cursor}</div>
${heroPhone}
${tilt(W.agenda(false), 64, 14, 4, 0.6)}${tilt(W.suivis(false), 1112, -6, -3, 0.58)}${tilt(W.importants(false), 40, 168, -5, 0.64)}
<div class="flt fl" style="left:30px;top:318px;--r:3deg;--s:1;${flv()}"><div class="lockchip">${W.lockCirc(3)}${W.lockRect()}</div></div>
<div class="mchips" aria-hidden="true">${chips}</div>
<div class="cap-wrap"><span class="pill glass carousel-cap"><b data-cap-name>${s[0]}</b> · <span data-cap-text data-caps='${esc(JSON.stringify(t.hero.captions))}' data-names='${esc(JSON.stringify(s))}'>${t.hero.captions[0]}</span> · <span class="n"><span data-cap-n>1</span> ${t.hero.of} 6</span></span></div>
</div>
</section>`;
  const stats = `<section class="wrap statsbar glass" data-rv data-stats aria-label="${esc(t.stats.label)}"><div class="lbl">${t.stats.label}</div>${t.stats.items.map(([n, sp]) => `<div class="it"><b class="ser">${n}</b><span>${sp}</span></div>`).join('')}</section>`;

  const rowWidget = { 0: [W.importants(false), -4, 0.78], 1: [W.agenda(false), 3, 0.8], 3: [W.suivis(false), -3, 0.78] };
  const rows = t.sec.rows.map(([h, p], i) => {
    const left = i % 2 === 0;
    const rw = rowWidget[i];
    const text = `<div class="rtext"><h3 class="ser" data-rv>${br(h)}</h3><p class="p" data-rv>${p}</p>${rw ? `<div class="rw" data-rv><div class="fl rwi" style="--r:${rw[1]}deg;--s:${rw[2]};${flv()}"><div class="wshadow">${rw[0]}</div></div></div>` : ''}</div>`;
    const sh = `<div class="rshot" data-rv><div class="fl rshot-fl" style="--r:${left ? .6 : -.6}deg;${flv()}">${shot(SVC_KEYS[i], `iMiel — ${s[i]}`)}</div></div>`;
    const gut = `<div class="gut" aria-hidden="true"><div class="st row ${i % 2 ? 'side-l' : 'side-r'}" data-st style="--dx:${i % 2 ? 26 : -26}px"><i class="dot"></i><span class="bub">${String(i + 1).padStart(2, '0')} — ${s[i]}</span></div></div>`;
    return `<article class="row2${left ? '' : ' rev'}" data-row="${i}">${left ? text + gut + sh : sh + gut + text}</article>`;
  }).join('');
  const services = `<section class="wrap sect" id="services" aria-labelledby="h-services"><div class="sec-head"><span class="kick" data-rv>${ico('spark', 14)} ${t.sec.kicker}</span><h2 id="h-services" class="ser h2" data-rv>${br(t.sec.title)}</h2><p class="p" data-rv>${t.sec.sub}</p></div>${rows}</section>`;

  const hs = `<div class="phone3 hs fl" style="${flv()}" role="img" aria-label="${esc(t.apps.lockCaption)}"><div class="scr3 wall1">${statusBar(true)}
<div class="wgs">${['agenda', 'importants', 'suivis'].map((k) => `<div class="wg">${W[k](false)}</div>`).join('')}</div>
<div class="spot">${ico('search', 13)} Rechercher</div><i class="homebar"></i></div></div>`;
  const lock = `<div class="phone3 lk fl" style="${flv()}" role="img" aria-label="${esc(t.apps.lockCaption)}"><div class="scr3 wall2">${statusBar(true)}
<div class="lkic">${ico('lock', 14)}</div><div class="lkdate">${t.apps.lockDate}</div><div class="lktime">8:31</div>
<div class="lkw"><div class="lkc">${ico('mail', 14)}<b>3</b></div><div class="lkr"><b>10:00</b><b>Point équipe</b><span>Visio · dans 1 h 29 min</span></div></div>
<div class="notif"><img src="${IMG('logo.webp')}" alt=""><div><div class="nh"><b>iMiel</b><span>maintenant</span></div><b>Camille Martin</b><span>Devis rénovation — version signée</span></div></div>
<div class="lkb l">${ico('flash', 17)}</div><div class="lkb r">${ico('cam', 17)}</div><i class="homebar"></i></div></div>`;
  const plat = [['apple', 0], ['win', 1], ['linux', 2], ['phone', 3]].map(([k, i]) => `<a class="pill2 ${i === 0 ? 'goldp' : 'ghostp'} big" href="${PATHS.download[t.lang]}#${['mac', 'windows', 'linux', 'iphone'][i]}">${ico(k, 18)} ${roll(t.apps.platforms[i])}</a>`).join('');
  const apps = `<section class="wrap sect apps2 glass" id="apps" data-apps aria-labelledby="h-apps"><div class="atext"><span class="kick" data-rv>${ico('phone', 14)} ${t.apps.kicker}</span><h2 id="h-apps" class="ser h2" data-rv>${br(t.apps.title)}</h2><p class="p" data-rv>${t.apps.text}</p><div class="plats" data-rv>${plat}</div><small data-rv>${t.apps.note}</small></div><div class="aphones">${hs}${lock}</div></section>`;

  const nodes = t.privacy.nodes.map(([b, sp], i) => `${i ? `<div class="lk2" aria-hidden="true"><span>${ico('lock', 15)}</span></div>` : ''}<div class="node glass" data-st data-node="${i}"><div class="ic">${ico(['server', 'cloud', 'phone'][i], 24)}</div><b>${b}</b><span>${sp}</span></div>`).join('');
  const privacy = `<section class="wrap sect privacy2" aria-labelledby="h-priv"><div class="sec-head narrow" data-privhead><span class="kick" data-rv>${ico('lock', 14)} ${t.privacy.kicker}</span><h2 id="h-priv" class="ser h2" data-rv>${br(t.privacy.title)}</h2><p class="p" data-rv>${t.privacy.sub}</p></div>
<div class="nodes2" data-nodes>${nodes}</div>
<div class="glass kit2" data-rv>${ico('key', 26)}<p><b>${t.privacy.kitTitle}</b> ${t.privacy.kit}</p></div></section>`;

  const carte = (c, gold, href) => `<div class="prix-wrap" data-rv><article class="prix-carte ${gold ? 'gold-tile' : 'glass'} fl" style="${flv()}"><div class="prix-tete"><h3 class="ser">${c.name}</h3><span class="pill${gold ? '' : ' glass'}">${c.badge}</span></div>
<p class="prix"><b class="ser">${c.price}</b> <span>${c.per}</span></p><ul>${c.items.map((x) => `<li>${ico('check', 15)}<span>${x}</span></li>`).join('')}</ul>
<a class="btn ${gold ? 'btn-ghost' : 'btn-gold'}" href="${href}"${href.startsWith('http') ? ' rel="noopener"' : ''}>${roll(c.cta)} ${ico('arrow', 18)}</a><small>${c.note}</small></article></div>`;
  const tarifs = `<section class="wrap sect" id="tarifs" data-tarifs aria-labelledby="h-tarifs"><div class="sec-head"><span class="kick" data-rv>${ico('spark', 14)} ${t.pricing.kicker}</span><h2 id="h-tarifs" class="ser h2" data-rv>${br(t.pricing.title)}</h2><p class="p" data-rv>${t.pricing.sub}</p></div><div class="tarifs2">${carte(t.pricing.cloud, true, APP_WEB)}${carte(t.pricing.free, false, PATHS.download[t.lang])}</div></section>`;

  const tile = (i, ic, g) => `<div class="tile-wrap" data-rv><div class="tile ${g ? 'gold-tile' : 'glass'} fl" style="${flv()}"><div class="ic">${ico(ic, 20)}</div><h3 class="ser">${t.why.tiles[i][0]}</h3><p>${t.why.tiles[i][1]}</p></div></div>`;
  const why = `<section class="wrap sect" data-why aria-labelledby="h-why"><div class="sec-head"><span class="kick" data-rv>${ico('spark', 14)} ${t.why.kicker}</span><h2 id="h-why" class="ser h2" data-rv>${br(t.why.title)}</h2></div>
<div class="bento2 b1">${tile(0, 'spark', true)}${tile(1, 'shield')}${tile(2, 'search')}</div><div class="bento2 b2">${tile(3, 'eyeoff')}${tile(4, 'laptop')}${tile(5, 'code')}</div></section>`;

  const code = [['git clone', GITHUB], ['cd', 'imiel'], ['cp', '.env.example .env'], ['docker compose', 'up -d'], ['#', t.code.comment]]
    .map(([a, b], i) => `<span class="ln">${i + 1}</span>  ${a === '#' ? `<span class="cm"># ${b}</span>` : `<span class="kw">${a}</span> ${b}`}`).join('\n');
  const codeS = `<section class="wrap sect code2" id="code" data-code aria-labelledby="h-code"><div class="code-text"><span class="kick" data-rv>${ico('code', 14)} ${t.code.kicker}</span><h2 id="h-code" class="ser h2" data-rv>${br(t.code.title)}</h2><p class="p" data-rv>${t.code.text}</p>
<div class="btns" data-rv><a class="btn btn-ghost" href="${GITHUB}" rel="noopener">${ico('github', 20)} ${roll(t.code.github)}</a><a class="btn btn-ghost" href="${GITHUB}#readme" rel="noopener">${roll(t.code.guide)}</a></div></div>
<div class="code-wrap" data-rv><div class="code-card fl" style="${flv()}"><div class="dots" aria-hidden="true"><i style="background:#ef5b4b"></i><i style="background:#f5b22a"></i><i style="background:#45c46b"></i></div><pre><code>${code}</code></pre></div></div></section>`;

  const faq = `<section class="wrap sect faq2" id="faq" data-faq aria-labelledby="h-faq"><div class="sec-head"><span class="kick" data-rv>FAQ</span><h2 id="h-faq" class="ser h2" data-rv>${br(t.faq.title)}</h2></div>
<div class="flist" data-flist>${t.faq.items.map(([q, a], i) => `<details class="glass${i === 0 ? ' shown' : ''}" data-rv${i === 0 ? ' open' : ''}><summary>${q}<span class="pm" aria-hidden="true">${ico('plus', 18)}</span></summary><div class="ans"><div><p>${a}</p></div></div></details>`).join('')}</div></section>`;
  const final = `<section class="wrap sect final2" data-final aria-labelledby="h-final"><img src="${IMG('logo.webp')}" width="64" height="64" alt="" data-final-logo><h2 id="h-final" class="ser" data-rv>${br(t.final.title)}</h2><div data-rv>${ctas(t)}</div></section>`;

  return `${head(t, 'home', {})}<body class="home">
${light}${nav(t, 'home')}
<main data-stage>
${hero}
${stats}
${services}
${apps}
${privacy}
${tarifs}
${why}
${codeS}
${faq}
${final}
</main>
${footer(t)}
${thread}
<script src="/assets/app.js?v=${JS_V}" defer></script>
</body></html>`;
}

// ---------- pages secondaires ----------
function simplePage(t, page, title, body, description) {
  return `${head(t, page, { title, description })}<body class="flat">
${light}${nav(t, page)}<main class="page">${body}</main>
${footer(t)}
<script src="/assets/app.js?v=${JS_V}" defer></script></body></html>`;
}

function download(t) {
  const d = t.dl;
  const card = (id, ic, [name, text, file], href, soon) => `<article class="dl-card glass" id="${id}" data-dl="${id}"><div class="ic">${ico(ic, 22)}</div><h2 class="ser">${name}</h2><p>${text}</p><small>${file}</small>
${soon ? `<a class="btn btn-ghost" aria-disabled="true">${d.soon}</a>` : `<a class="btn btn-gold" href="${href}" rel="noopener">${ico('arrow', 18)} ${d.get}</a>`}</article>`;
  const smart = (step) => `<div class="smart" aria-hidden="true"><h3>${d.smartTitle}</h3><p>${d.smartText}</p>
${step === 1 ? `<span class="more hl">${d.smartMore}</span><div class="bt"><span>${d.smartNo}</span></div>` : `<div class="meta">${d.smartApp}<br>${d.smartPub}</div><div class="bt"><span class="hl">${d.smartRun}</span><span>${d.smartNo}</span></div>`}</div>`;
  const body = `<h1 class="ser">${d.title}</h1><p class="sub">${d.sub}</p>
<div class="dl-grid">${card('mac', 'apple', d.mac, `${RELEASES}?platform=mac`)}${card('windows', 'win', d.windows, `${RELEASES}?platform=windows`)}${card('linux', 'linux', d.linux, `${RELEASES}?platform=linux`)}${card('iphone', 'phone', d.iphone, '', true)}${card('web', 'globe', d.web.slice(0, 3), APP_WEB)}</div>
<p class="dl-note">${d.releases}</p>
<section class="win glass" id="windows-premier-lancement"><h2 class="ser">${d.winTitle}</h2><p>${d.winText}</p>
<div class="win-steps"><div class="win-step"><b>1. ${d.winSteps[0]}</b>${smart(1)}</div><div class="win-step"><b>2. ${d.winSteps[1]}</b>${smart(2)}</div></div></section>
<article class="dl-card glass" style="margin-top:26px"><div class="ic">${ico('server', 22)}</div><h2 class="ser">${d.server[0]}</h2><p>${d.server[1]}</p><a class="btn btn-ghost" href="${GITHUB}#readme" rel="noopener">${ico('github', 18)} ${d.server[2]}</a></article>`;
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
  write(PATHS.terms[l], legalLike(t, 'terms', t.termsPage));
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

iMiel réunit six services dans une seule application : ${f.services.join(', ')}. Deux formules : iMiel Cloud (5,99 CHF par mois, 14 jours offerts sans carte bancaire), qui relie ordinateur, iPhone et web sans rien régler ; et la version libre (licence AGPL-3.0), gratuite, sur un seul ordinateur.

## En bref
- Applications : Mac, Windows, Linux et iPhone (avec widgets d'écran d'accueil et d'écran verrouillé).
- Applications : Mac, Windows, Linux, iPhone et web (app.getimiel.com).
- Le serveur d'iMiel Cloud relève les boîtes au moment où les appareils les demandent, transmet, puis oublie : il ne garde aucun mail. Il garde le compte, l'abonnement et les réglages (chiffrés) ; ils sont effacés 30 jours après l'arrêt de l'abonnement.
- L'assistant, les résumés et les traductions utilisent la clé d'IA de l'utilisateur ; sans clé, ils restent éteints.
- Gmail et Outlook se relient d'un clic (iMiel Cloud) ; les autres boîtes avec l'adresse et le mot de passe, réglages trouvés automatiquement.
- Le code est public : ${GITHUB}
- Langues : français, anglais, allemand, italien.

## Pages
- Accueil : ${SITE}/ (en : ${SITE}/en/, de : ${SITE}/de/, it : ${SITE}/it/)
- Télécharger : ${SITE}${PATHS.download.fr}
- Confidentialité : ${SITE}${PATHS.privacy.fr}
- Conditions de vente : ${SITE}${PATHS.terms.fr}
- Mentions légales : ${SITE}${PATHS.legal.fr}
- Contact : ${CONTACT}
`);
const count = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log(`vitrine fabriquee dans ${path.relative(process.cwd(), OUT) || OUT} : ${count(OUT)} fichiers, ${LANGS.length} langues`);
