#!/usr/bin/env node
// Controle de la vitrine dans un vrai navigateur (Chrome du systeme) :
//   node site/scripts/verifier-vitrine.mjs [dossier-captures]
// Pour chaque langue : grand ecran 1920, ordinateur 1440, tablette 768 et
// telephone 390, en clair et en sombre (tablette : clair).
// Telephone/tablette : le fil change de bord ENTRE les blocs (au moins 8 fois),
// le menu s'ouvre par-dessus la page sans rien pousser, icones de la barre >= 20 px. Aucune reponse >= 400 ni erreur, aucun debordement
// horizontal, demo visible des l'arrivee (1920x1080), menu colle en haut,
// l'avion avance et gonfle les bulles, le fil n'a aucun virage serre (rayon
// >= 100 px) et ne croise aucun texte, image ni carte, meme FAQ toute ouverte.
// Captures pleine page dans le dossier donne.
// (PLAYWRIGHT_CORE=/chemin/playwright-core/index.mjs si le module n'est pas installe)
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || '/tmp/vitrine-captures';
fs.mkdirSync(OUT, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const PORT = 4400 + Math.floor(Math.random() * 400);
const srv = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const BASE = `http://127.0.0.1:${PORT}`;
const b = await chromium.launch({ channel: 'chrome' });
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'OK ' : 'ECHEC'} ${m}`); if (!c) fails++; };
const home = ['/', '/en/', '/de/', '/it/'];
const others = ['/telecharger/', '/en/download/', '/confidentialite/', '/de/impressum/'];

// Attend que le trace du fil ne bouge plus (images chargees, FAQ ouverte).
async function settle(page) {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    const L = await page.evaluate(() => { const f = window.__imielFil(); return f && Math.round(f.L) + ':' + document.body.scrollHeight; });
    if (L === last) return;
    last = L;
  }
}

// Croisements entre le fil (echantillons tous les 4 px) et les boites de contenu.
// Les boites de texte se mesurent sur le TEXTE (pas le bloc pleine largeur).
async function crossings(page) {
  return page.evaluate(() => {
    const fil = window.__imielFil();
    const boxes = [];
    const add = (el, r) => { if (r.width > 0 && r.height > 0) boxes.push({ n: (el.className && el.className.baseVal === undefined ? el.className : el.tagName) || el.tagName, l: r.left + scrollX, t: r.top + scrollY, r: r.right + scrollX, b: r.bottom + scrollY }); };
    const vis = (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
    document.querySelectorAll('main h1, main h2, main h3, main .p, main .kick, main .note, main small, .statsbar .it, .carousel-cap').forEach((el) => {
      if (!vis(el)) return;
      const rg = document.createRange(); rg.selectNodeContents(el); add(el, rg.getBoundingClientRect());
    });
    document.querySelectorAll('main .btn, main .pill2, .shot, .laptop2 .lid, .phone2, .phone3, .flt, .rw .rwi, .statsbar, .kit2, .prix-carte, .tile, .code-card, .flist details, .st .bub' + (innerWidth < 1100 ? ', .node, .mst .bub' : '')).forEach((el) => {
      if (!vis(el)) return;
      if (el.classList.contains('bub') && getComputedStyle(el).opacity === '0') return;
      add(el, el.getBoundingClientRect());
    });
    const hits = {};
    for (let i = 0; i < fil.x.length; i += 2) {
      const x = fil.x[i], y = fil.y[i];
      for (const bx of boxes) if (x > bx.l + 2 && x < bx.r - 2 && y > bx.t + 2 && y < bx.b - 2) { const k = `${bx.n}@${Math.round(bx.t)}`; hits[k] = (hits[k] || 0) + 1; }
    }
    return { minR: Math.round(fil.minR), at: fil.at && fil.at.map(Math.round), hits: Object.keys(hits).map((k) => `${k} (${hits[k]})`) };
  });
}

for (const [w, h, mob, themes] of [[1920, 1080, false, ['light', 'dark']], [1440, 900, false, ['light', 'dark']], [768, 1024, false, ['light']], [390, 844, true, ['light', 'dark']]]) {
  for (const theme of themes) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mob, hasTouch: mob, colorScheme: theme, locale: 'fr-FR' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('imiel-lang', 'fr'); localStorage.setItem('imiel-theme', t); } catch (e) {} }, theme);
    for (const p of [...home, ...others]) {
      const isHome = home.includes(p);
      if (!isHome && (theme === 'dark' || w === 1440)) continue;
      const page = await ctx.newPage();
      const bad = [];
      page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
      page.on('pageerror', (e) => bad.push('JS ' + e.message));
      await page.goto(BASE + p, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      const tag = `${p.replace(/\//g, '_') || 'racine'}-${w}-${theme}`;
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      ok(over <= 0, `${tag} : pas de debordement horizontal (${over})`);
      if (isHome) {
        if (w === 1920) {
          const lid = await page.evaluate(() => document.querySelector('.laptop2 .lid').getBoundingClientRect().bottom);
          ok(lid <= 1080, `${tag} : la demo se voit en entier des l'arrivee (bas de l'ecran a ${Math.round(lid)} px)`);
        }
        const before = await page.evaluate(() => document.querySelector('[data-plane]').style.transform);
        await page.evaluate(() => scrollTo(0, document.body.scrollHeight * 0.45));
        await page.waitForTimeout(1600);
        const after = await page.evaluate(() => document.querySelector('[data-plane]').style.transform);
        ok(before && after && before !== after, `${tag} : l'avion avance au defilement`);
        const nav = await page.evaluate(() => Math.round(document.querySelector('.navin').getBoundingClientRect().top));
        ok(nav >= 0 && nav <= 20, `${tag} : le menu reste colle en haut (${nav} px)`);
        if (w < 1100) {
          const ic = await page.evaluate(() => ['.burger .m-open', '.langsel summary .ico'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().width)));
          ok(Math.min(...ic) >= 20, `${tag} : icones de la barre a leur taille (${ic.join(', ')} px)`);
          const at = () => page.evaluate(() => [document.querySelector('[data-stats]').offsetTop, document.querySelector('#services').offsetTop, Math.round(document.querySelector('.navin').getBoundingClientRect().height)].join(','));
          const before = await at();
          await page.click('[data-burger]');
          await page.waitForTimeout(250);
          const open = await page.evaluate(() => { const p = document.querySelector('[data-mpanel]'), r = p.getBoundingClientRect(); return !p.hidden && p.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 30)); });
          const after = await at();
          ok(open && before === after, `${tag} : le menu s'ouvre par-dessus la page sans la pousser (${before} / ${after})`);
          await page.keyboard.press('Escape');
          ok(await page.evaluate(() => document.querySelector('[data-mpanel]').hidden), `${tag} : le menu se ferme sur Echap`);
        }
        if (w >= 1100) {
          const on = await page.evaluate(() => document.querySelectorAll('.st.on').length);
          ok(on >= 6, `${tag} : les bulles se sont gonflees au passage de l'avion (${on})`);
        }
        // Mesure figee : apparitions et levitation coupees.
        await page.evaluate(() => { document.documentElement.classList.remove('anim'); dispatchEvent(new Event('resize')); });
        await settle(page);
        let c = await crossings(page);
        ok(c.minR >= 100, `${tag} : aucun virage serre (rayon minimal ${c.minR} px en ${c.at})`);
        ok(c.hits.length === 0, `${tag} : le fil ne croise aucun contenu ${c.hits.join(', ')}`);
        if (w < 1100) {
          const sw = await page.evaluate(() => { const f = window.__imielFil(), m = innerWidth / 2; let n = 0, s = 0; for (let i = 0; i < f.x.length; i += 4) { const k = f.x[i] < m ? -1 : 1; if (s && k !== s) n++; s = k; } return n; });
          ok(sw >= 8, `${tag} : le fil serpente d'un bord a l'autre (${sw} traversees)`);
        }
        if (theme === 'light') {
          await page.evaluate(() => document.querySelectorAll('.flist details:not(.shown) summary').forEach((s) => s.click()));
          await page.waitForTimeout(600);
          await settle(page);
          c = await crossings(page);
          ok(c.hits.length === 0 && c.minR >= 100, `${tag} : FAQ toute ouverte, fil toujours libre (rayon ${c.minR}) ${c.hits.join(', ')}`);
          const faq = await page.evaluate(() => { const l = [...document.querySelectorAll('.flist details')].pop().getBoundingClientRect().bottom; const f = document.querySelector('.final2').getBoundingClientRect().top; return Math.round(f - l); });
          ok(faq > 60, `${tag} : la FAQ ouverte pousse la suite (ecart ${faq} px)`);
        }
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(300);
        if (theme === 'light' || p === '/') await page.screenshot({ path: path.join(OUT, `${tag}.png`), fullPage: true });
      } else await page.screenshot({ path: path.join(OUT, `${tag}.png`), fullPage: true });
      ok(bad.length === 0, `${tag} : aucune erreur ${bad.join(' | ')}`);
      await page.close();
    }
    await ctx.close();
  }
}
await b.close();
srv.kill();
console.log(fails ? `${fails} echec(s)` : 'vitrine : tous les controles passent');
process.exit(fails ? 1 : 0);
