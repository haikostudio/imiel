// Abonnement iMiel Cloud : 5,99 CHF par mois, 14 jours offerts SANS carte.
//
// Etats d'un compte (colonne comptes.abo_etat) :
//   essai  : 14 jours depuis l'inscription, aucune carte demandee ;
//   actif  : paiement en place (Stripe) ;
//   arrete : essai fini sans carte, resiliation ou impaye. Le pont s'arrete
//            pour ce compte, les apps le savent ; les reglages gardes par le
//            serveur sont EFFACES 30 jours plus tard, apres un rappel 7 jours
//            avant.
//
// Stripe (mode test tant que le feu vert n'est pas donne) : l'essai est un
// abonnement Stripe sans moyen de paiement, qui se met en PAUSE a la fin de
// l'essai s'il n'y a toujours pas de carte
// (trial_settings.end_behavior.missing_payment_method = pause). Le paiement
// passe par Stripe Checkout (mode « setup » : la carte est enregistree puis
// posee sur l'abonnement, qui reprend) ; le portail client Stripe gere carte,
// factures et resiliation.
//
// Variables : NUAGE_STRIPE_CLE (sk_test_...), NUAGE_STRIPE_PRIX (price_...),
//   NUAGE_STRIPE_SECRET_WEBHOOK (whsec_...), NUAGE_APP_URL (retour apres paiement).
import crypto from "node:crypto";

export const JOUR = 86_400_000;
export const ESSAI_JOURS = 14;
export const PURGE_JOURS = 30;
export const RAPPEL_PURGE_JOURS = 7;
export const PRIX_AFFICHE = "5,99 CHF / mois";

export function configStripe(env = process.env) {
  return {
    cle: env.NUAGE_STRIPE_CLE || "",
    prix: env.NUAGE_STRIPE_PRIX || "",
    secretWebhook: env.NUAGE_STRIPE_SECRET_WEBHOOK || "",
    appUrl: (env.NUAGE_APP_URL || "").replace(/\/+$/, ""),
    api: env.NUAGE_STRIPE_API || "https://api.stripe.com",
    // Essais seulement : horloge de test Stripe pour avancer le temps (refusee
    // avec une cle reelle).
    horloge: String(env.NUAGE_STRIPE_CLE || "").startsWith("sk_test_") ? env.NUAGE_STRIPE_HORLOGE || "" : "",
  };
}
export const stripePret = (c) => !!(c.cle && c.prix);

/** Corps x-www-form-urlencoded a la mode Stripe (objets imbriques a[b][c]). */
export function formulaire(obj, prefixe = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const cle = prefixe ? `${prefixe}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? formulaire(x, `${cle}[${i}]`, out) : out.append(`${cle}[${i}]`, String(x))));
    else if (typeof v === "object") formulaire(v, cle, out);
    else out.append(cle, String(v));
  }
  return out;
}

export function clientStripe(c, fetcher = fetch) {
  async function appel(methode, chemin, corps) {
    const r = await fetcher(`${c.api}${chemin}`, {
      method: methode,
      headers: {
        Authorization: `Bearer ${c.cle}`,
        ...(corps ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        "Stripe-Version": "2025-03-31.basil",
      },
      body: corps ? formulaire(corps).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Stripe : ${j.error?.message || r.status}`);
    return j;
  }
  return {
    appel,
    creerClient: (email, compte) =>
      appel("POST", "/v1/customers", { email, metadata: { compte }, ...(c.horloge && String(c.cle).startsWith("sk_test_") ? { test_clock: c.horloge } : {}) }),
    creerEssai: (client, compte) =>
      appel("POST", "/v1/subscriptions", {
        customer: client,
        items: [{ price: c.prix }],
        trial_period_days: ESSAI_JOURS,
        trial_settings: { end_behavior: { missing_payment_method: "pause" } },
        payment_settings: { save_default_payment_method: "on_subscription" },
        metadata: { compte },
      }),
    creerAbonnement: (client, compte, moyen) =>
      appel("POST", "/v1/subscriptions", {
        customer: client,
        items: [{ price: c.prix }],
        default_payment_method: moyen,
        metadata: { compte },
      }),
    lireAbonnement: (id) => appel("GET", `/v1/subscriptions/${id}`),
    poserMoyen: (abonnement, moyen) => appel("POST", `/v1/subscriptions/${abonnement}`, { default_payment_method: moyen }),
    reprendre: (abonnement) => appel("POST", `/v1/subscriptions/${abonnement}/resume`, { billing_cycle_anchor: "now" }),
    resilier: (abonnement) => appel("DELETE", `/v1/subscriptions/${abonnement}`),
    lireSetup: (id) => appel("GET", `/v1/setup_intents/${id}`),
    sessionPaiement: (client, compte, abonnement) =>
      appel("POST", "/v1/checkout/sessions", {
        mode: "setup",
        customer: client,
        currency: "chf",
        payment_method_types: ["card"],
        success_url: `${c.appUrl}/#/settings?tab=abonnement&paiement=ok`,
        cancel_url: `${c.appUrl}/#/settings?tab=abonnement&paiement=annule`,
        metadata: { compte, abonnement: abonnement || "" },
        setup_intent_data: { metadata: { compte, abonnement: abonnement || "" } },
      }),
    portail: (client) => appel("POST", "/v1/billing_portal/sessions", { customer: client, return_url: `${c.appUrl}/#/settings?tab=abonnement` }),
  };
}

/** Verification de l'en-tete Stripe-Signature (t=...,v1=...), tolerance 5 min. */
export function verifierSignature(corpsBrut, entete, secret, maintenant = Date.now()) {
  const parties = Object.fromEntries(
    String(entete || "")
      .split(",")
      .map((p) => p.split("=").map((x) => x.trim()))
      .filter((p) => p.length === 2)
  );
  const signatures = String(entete || "")
    .split(",")
    .filter((p) => p.trim().startsWith("v1="))
    .map((p) => p.trim().slice(3));
  const t = Number(parties.t);
  if (!t || !signatures.length || !secret) return false;
  if (Math.abs(maintenant / 1000 - t) > 300) return false;
  const attendu = crypto.createHmac("sha256", secret).update(`${t}.${corpsBrut}`).digest("hex");
  return signatures.some((s) => s.length === attendu.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(attendu)));
}

/** Signe un corps comme Stripe (essais). */
export function signer(corpsBrut, secret, maintenant = Date.now()) {
  const t = Math.floor(maintenant / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${corpsBrut}`).digest("hex")}`;
}

/** Etat iMiel d'un abonnement Stripe. */
export function etatDepuisStripe(statut) {
  switch (statut) {
    case "trialing":
      return { etat: "essai", retard: 0 };
    case "active":
      return { etat: "actif", retard: 0 };
    case "past_due":
      return { etat: "actif", retard: 1 };
    default: // paused, canceled, unpaid, incomplete, incomplete_expired
      return { etat: "arrete", retard: 0 };
  }
}

/** Resume affiche par les apps. */
export function resume(c, maintenant = Date.now()) {
  const joursEssai = c.abo_etat === "essai" && c.essai_fin ? Math.max(0, Math.ceil((c.essai_fin - maintenant) / JOUR)) : null;
  return {
    etat: c.abo_etat,
    prix: PRIX_AFFICHE,
    essaiFin: c.essai_fin || null,
    joursEssai,
    paiementEnPlace: c.abo_etat === "actif",
    retard: !!c.retard,
    arreteLe: c.arrete_le || null,
    purgeLe: c.arrete_le ? c.arrete_le + PURGE_JOURS * JOUR : null,
  };
}
