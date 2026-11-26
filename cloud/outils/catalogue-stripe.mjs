#!/usr/bin/env node
// Catalogue Stripe d'iMiel Cloud : produit, prix (5,99 CHF/mois), point de
// reception et portail client. Idempotent. MODE TEST par defaut : refuse une
// cle reelle sans IMIEL_STRIPE_REEL=1 (feu vert de l'editeur).
//   NUAGE_STRIPE_CLE=sk_test_... node outils/catalogue-stripe.mjs [adresse publique du serveur]
// Les identifiants sont ecrits dans ./catalogue-stripe.json ; le secret du
// point de reception (rendu UNE fois par Stripe) dans ./whsec.txt (0600) : a
// ranger au coffre-fort, jamais dans le depot.
import fs from "node:fs";
const SK = String(process.env.NUAGE_STRIPE_CLE || "").trim();
if (!/^(sk|rk)_(test|live)_/.test(SK)) throw new Error("NUAGE_STRIPE_CLE manquante");
if (/_live_/.test(SK) && process.env.IMIEL_STRIPE_REEL !== "1") throw new Error("cle reelle refusee sans IMIEL_STRIPE_REEL=1");
const form = (o, pre = "", out = new URLSearchParams()) => { for (const [k, v] of Object.entries(o)) { const c = pre ? `${pre}[${k}]` : k; if (Array.isArray(v)) v.forEach((x, i) => typeof x === "object" ? form(x, `${c}[${i}]`, out) : out.append(`${c}[${i}]`, String(x))); else if (v && typeof v === "object") form(v, c, out); else out.append(c, String(v)); } return out; };
const api = async (m, p, b) => { const r = await fetch("https://api.stripe.com" + p, { method: m, headers: { Authorization: `Bearer ${SK}`, ...(b ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, body: b ? form(b).toString() : undefined }); const j = await r.json(); if (!r.ok) throw new Error(p + " " + JSON.stringify(j.error)); return j; };
const existants = await api("GET", "/v1/products?limit=100");
let produit = existants.data.find((x) => x.metadata?.app === "imiel");
if (!produit) produit = await api("POST", "/v1/products", { name: "iMiel Cloud", description: "Vos boites mail reliees entre ordinateur, iPhone et web. Aucun mail garde par le serveur.", metadata: { app: "imiel" } });
const prix = (await api("GET", `/v1/prices?product=${produit.id}&active=true`)).data.find((p) => p.unit_amount === 599 && p.currency === "chf") ||
  await api("POST", "/v1/prices", { product: produit.id, currency: "chf", unit_amount: 599, recurring: { interval: "month" }, nickname: "iMiel Cloud mensuel", lookup_key: "imiel_cloud_mensuel", metadata: { app: "imiel" } });
const evenements = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed", "customer.subscription.trial_will_end", "invoice.paid", "invoice.payment_failed"];
const url = `${(process.argv[2] || "https://sync.getimiel.com").replace(/\/+$/, "")}/v1/stripe/webhook`;
let wh = (await api("GET", "/v1/webhook_endpoints?limit=100")).data.find((w) => w.url === url);
let secret = null;
if (!wh) { wh = await api("POST", "/v1/webhook_endpoints", { url, enabled_events: evenements, description: "iMiel Cloud (serveur de transfert)", metadata: { app: "imiel" } }); secret = wh.secret; }
const portail = await api("POST", "/v1/billing_portal/configurations", {
  business_profile: { headline: "iMiel Cloud : gerer mon abonnement" },
  features: { customer_update: { enabled: true, allowed_updates: ["email", "name", "address"] }, invoice_history: { enabled: true }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: "at_period_end" } },
  default_return_url: "https://app.getimiel.com/#/settings?tab=abonnement",
  metadata: { app: "imiel" },
});
fs.writeFileSync("catalogue-stripe.json", JSON.stringify({ produit: produit.id, prix: prix.id, webhook: wh.id, portail: portail.id }, null, 2));
if (secret) fs.writeFileSync("whsec.txt", secret, { mode: 0o600 });
console.log(JSON.stringify({ produit: produit.id, prix: prix.id, montant: prix.unit_amount, devise: prix.currency, webhook: wh.id, secretRecu: !!secret, portail: portail.id }));
