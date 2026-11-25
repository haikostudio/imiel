#!/usr/bin/env node
// Controle de la vitrine dans un vrai navigateur (Chrome du systeme) :
//   node site/scripts/verifier-vitrine.mjs [dossier-captures]
// Pour chaque langue : ordinateur 1440 (sombre + clair) et telephone 390, aucune
// reponse >= 400, aucun debordement horizontal, l'avion bouge au defilement,
// le fil ne porte aucun flou. Captures pleine page dans le dossier donne.
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
const pages = ['/', '/en/', '/de/', '/it/', '/telecharger/', '/en/download/', '/confidentialite/', '/de/impressum/'];
for (const [w, h, mob, themes] of [[1440, 900, false, ['dark', 'light']], [390, 844, true, ['dark']]]) {
  for (const theme of themes) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mob, hasTouch: mob, colorScheme: theme, locale: 'fr-FR' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('imiel-lang', 'fr'); localStorage.setItem('imiel-theme', t); } catch (e) {} }, theme);
    for (const p of pages) {
      const page = await ctx.newPage();
      const bad = [];
      page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
      page.on('pageerror', (e) => bad.push('JS ' + e.message));
      await page.goto(BASE + p, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const tag = `${p.replace(/\//g, '_') || 'racine'}-${w}-${theme}`;
      ok(bad.length === 0, `${tag} : aucune erreur ${bad.join(' | ')}`);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      ok(over <= 0, `${tag} : pas de debordement horizontal (${over})`);
      if (p.match(/^\/(en\/|de\/|it\/)?$/)) {
        const before = await page.evaluate(() => document.querySelector('[data-plane]').style.transform);
        await page.evaluate(() => scrollTo(0, document.body.scrollHeight * 0.45));
        await page.waitForTimeout(400);
        const after = await page.evaluate(() => document.querySelector('[data-plane]').style.transform);
        ok(before && after && before !== after, `${tag} : l'avion avance au defilement`);
        const blur = await page.evaluate(() => [...document.querySelectorAll('.thread path')].some((e) => e.getAttribute('filter')));
        ok(!blur, `${tag} : aucun flou sur le fil`);
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(300);
        if (p === '/' || !mob) await page.screenshot({ path: path.join(OUT, `${tag}.png`), fullPage: true });
      } else if (!mob && theme === 'dark') await page.screenshot({ path: path.join(OUT, `${tag}.png`), fullPage: true });
      await page.close();
    }
    await ctx.close();
  }
}
await b.close();
srv.kill();
console.log(fails ? `${fails} echec(s)` : 'vitrine : tous les controles passent');
process.exit(fails ? 1 : 0);
