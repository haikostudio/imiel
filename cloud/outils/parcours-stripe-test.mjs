#!/usr/bin/env node
// Parcours Stripe REEL en MODE TEST (bac a sable) contre un serveur iMiel Cloud
// local : essai sans carte -> rappel J-3 -> pause a la fin -> carte de test
// sur la page Stripe -> actif -> portail -> resiliation. Le temps avance par
// une horloge de test Stripe ; les evenements sont relus par l'API et relayes,
// signes, au serveur local (aucune adresse publique necessaire).
//   NUAGE_STRIPE_CLE=sk_test_... NUAGE_STRIPE_PRIX=price_... NUAGE_STRIPE_SECRET_WEBHOOK=whsec_... \
//   PLAYWRIGHT=/chemin/vers/playwright/index.mjs node outils/parcours-stripe-test.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SK = String(process.env.NUAGE_STRIPE_CLE || "");
if (!SK.startsWith("sk_test_")) throw new Error("cle de TEST exigee (sk_test_...)");
const WH = String(process.env.NUAGE_STRIPE_SECRET_WEBHOOK || "");
const CAT = { prix: process.env.NUAGE_STRIPE_PRIX };
const form = (o, pre = "", out = new URLSearchParams()) => { for (const [k, v] of Object.entries(o)) { const c = pre ? `${pre}[${k}]` : k; if (v && typeof v === "object") form(v, c, out); else out.append(c, String(v)); } return out; };
const api = async (m, p, b) => { const r = await fetch("https://api.stripe.com" + p, { method: m, headers: { Authorization: `Bearer ${SK}`, ...(b ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, body: b ? form(b).toString() : undefined }); const j = await r.json(); if (!r.ok) throw new Error(p + " " + JSON.stringify(j.error)); return j; };
const t0 = Math.floor(Date.now() / 1000);
const horloge = await api("POST", "/v1/test_helpers/test_clocks", { frozen_time: t0, name: "iMiel essai" });
const attendreHorloge = async () => { for (let i = 0; i < 60; i++) { const h = await api("GET", `/v1/test_helpers/test_clocks/${horloge.id}`); if (h.status === "ready") return; await new Promise((r) => setTimeout(r, 2000)); } throw new Error("horloge bloquee"); };
const avancer = async (jours) => { await api("POST", `/v1/test_helpers/test_clocks/${horloge.id}/advance`, { frozen_time: t0 + jours * 86400 }); await attendreHorloge(); };

const env = { NUAGE_STRIPE_CLE: SK, NUAGE_STRIPE_PRIX: CAT.prix, NUAGE_STRIPE_SECRET_WEBHOOK: WH, NUAGE_APP_URL: "https://app.example.com", NUAGE_STRIPE_HORLOGE: horloge.id };
const { creerServeur } = await import(path.join(RACINE, "cloud/serveur/serveur.mjs"));
const { signer } = await import(path.join(RACINE, "cloud/serveur/abonnement.mjs"));
const srv = await creerServeur({ base: ":memory:", essai: true, journaliser: false, veille: false, env, mdpRapide: true });
await new Promise((r) => srv.serveur.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.serveur.address().port}`;
const appel = async (m, c, corps, jeton, entetes = {}) => { const r = await fetch(base + c, { method: m, headers: { "Content-Type": "application/json", ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}), ...entetes }, body: corps === undefined ? undefined : typeof corps === "string" ? corps : JSON.stringify(corps) }); return { statut: r.status, d: await r.json().catch(() => ({})) }; };
const vus = new Set();
async function relayer() {
  const ev = (await api("GET", `/v1/events?limit=100&created[gte]=${t0 - 60}`)).data.reverse();
  let n = 0;
  for (const e of ev) {
    if (vus.has(e.id)) continue;
    vus.add(e.id);
    const brut = JSON.stringify(e);
    const r = await appel("POST", "/v1/stripe/webhook", brut, null, { "Stripe-Signature": signer(brut, WH) });
    if (r.statut === 200) n++; else console.log("  refus webhook", e.type, r.statut, JSON.stringify(r.d).slice(0, 300));
  }
  return n;
}
const etape = (t) => console.log("•", t);
try {
  const i1 = await appel("POST", "/v1/inscription", { email: `essai-stripe-${t0}@example.org` });
  const i2 = (await appel("POST", "/v1/inscription/finir", { email: `essai-stripe-${t0}@example.org`, code: i1.d.code, motDePasse: "mot-de-passe-essai", appareil: { genre: "ordinateur" } })).d;
  const compte = srv.db.prepare("SELECT stripe_client, stripe_abonnement, abo_etat FROM comptes").get();
  const sub = await api("GET", `/v1/subscriptions/${compte.stripe_abonnement}`);
  etape(`inscription : essai Stripe ${sub.status}, fin d'essai dans ${Math.round((sub.trial_end - t0) / 86400)} j, sans carte = ${!sub.default_payment_method}, a la fin sans carte : ${sub.trial_settings?.end_behavior?.missing_payment_method}`);
  await relayer();
  await avancer(12);
  etape(`J+12 : ${await relayer()} evenements relayes ; rappel de fin d'essai envoye : ${srv.courriels.some((c) => /se termine bientot/.test(c.sujet))}`);
  await avancer(15);
  const subP = await api("GET", `/v1/subscriptions/${compte.stripe_abonnement}`);
  await relayer();
  etape(`J+15 : Stripe ${subP.status} ; iMiel ${(await appel("GET", "/v1/abonnement", undefined, i2.jeton)).d.etat}`);
  const pay = await appel("POST", "/v1/abonnement/payer", {}, i2.jeton);
  etape(`page de paiement Stripe : ${pay.d.url ? "ouverte" : pay.d.message}`);
  const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
  const nav = await chromium.launch({ channel: "chrome", headless: true });
  const p = await nav.newPage();
  await p.goto(pay.d.url, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(8000);
  await p.screenshot({ path: "/tmp/imiel-stripe-checkout0.png" });
  if (!(await p.$("#cardNumber:visible"))) {
    const carte = p.locator("[data-testid=card-accordion-item-button], button:has-text('Card'), label:has-text('Card')").first();
    if (await carte.count()) await carte.click().catch(() => {});
  }
  const champ = async (ph, v) => {
    for (const f of p.frames()) {
      const l = f.getByPlaceholder(ph).first();
      if (await l.count().catch(() => 0)) { await l.fill(v); return true; }
    }
    return false;
  };
  console.log("  champs :", await champ("Card number", "4242424242424242"), await champ("MM / YY", "1234"), await champ("Security code", "123"), await champ("First and last name", "Essai iMiel"));
  await p.screenshot({ path: "/tmp/imiel-stripe-checkout.png" });
  await p.screenshot({ path: "/tmp/imiel-stripe-checkout.png", fullPage: true });
  await p.mouse.wheel(0, 800);
  await p.waitForTimeout(1000);
  await p.screenshot({ path: "/tmp/imiel-stripe-checkout.png" });
  let clique = false;
  for (const f of p.frames()) {
    const b = f.getByRole("button", { name: "Save", exact: true }).first();
    if (await b.count().catch(() => 0)) { await b.click(); clique = true; break; }
  }
  if (!clique) { await p.mouse.click(640, 617); clique = "xy"; }
  console.log("  bouton :", clique);
  await p.waitForURL(/app\.example\.com/, { timeout: 60000 }).catch(async () => { await p.screenshot({ path: "/tmp/imiel-stripe-checkout2.png" }); });
  etape(`carte de test saisie, retour vers l'app : ${/app\.example\.com/.test(p.url())}`);
  await nav.close();
  await new Promise((r) => setTimeout(r, 4000));
  await relayer();
  await avancer(15.2); // Stripe preleve la facture de reprise une heure apres
  await relayer();
  const subA = await api("GET", `/v1/subscriptions/${compte.stripe_abonnement}`).catch(() => null);
  const apres = srv.db.prepare("SELECT stripe_abonnement FROM comptes").get();
  const subB = apres.stripe_abonnement !== compte.stripe_abonnement ? await api("GET", `/v1/subscriptions/${apres.stripe_abonnement}`) : subA;
  await new Promise((r) => setTimeout(r, 3000));
  await relayer();
  etape(`apres paiement : Stripe ${subB.status} (carte posee : ${!!subB.default_payment_method}) ; iMiel ${(await appel("GET", "/v1/abonnement", undefined, i2.jeton)).d.etat}`);
  const portail = await appel("POST", "/v1/abonnement/portail", {}, i2.jeton);
  etape(`portail client : ${portail.d.url ? "ouvert" : portail.d.message}`);
  await api("DELETE", `/v1/subscriptions/${subB.id}`);
  await new Promise((r) => setTimeout(r, 3000));
  await relayer();
  etape(`resiliation : iMiel ${(await appel("GET", "/v1/abonnement", undefined, i2.jeton)).d.etat}`);
} catch (e) {
  console.log("ECHEC", e.message);
} finally {
  await api("DELETE", `/v1/test_helpers/test_clocks/${horloge.id}`).catch(() => {});
  await srv.fermer();
}
process.exit(0);
