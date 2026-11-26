#!/usr/bin/env node
// iMiel Cloud : serveur de TRANSFERT entre les apps d'un abonne (ordinateur,
// iPhone, navigateur). Il relie chaque boite AU PASSAGE : il se connecte chez
// le fournisseur quand une app le demande (ou quand un mail arrive), transmet
// aux apps, puis oublie. Il ne garde AUCUN mail.
//
// Ce qu'il garde (voir base.mjs) : le compte, l'abonnement, les appareils et
// les reglages (boites, signatures, regles...) chiffres au repos ; et, en
// transit seulement, les donnees propres a iMiel echangees d'appareil a
// appareil (effacees a la reception, 30 jours au plus).
//
// Auto-hebergeable (AGPL-3.0). Reglages par variables d'environnement : voir
// README.md. Journaux : methode, route, statut, duree. JAMAIS d'adresse, de
// sujet, de contenu ni de secret.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { ouvrirBase, nettoyerTransit, purgerTransit } from "./base.mjs";
import * as secret from "./secret.mjs";
import { ouvrirBoite as ouvrirBoiteImap, erreurLisible } from "./boites.mjs";
import { detecter as detecterReglages } from "./detection.mjs";
import * as oauth from "./oauth.mjs";
import * as abo from "./abonnement.mjs";
import { envoyerApns, apnsConfigure } from "./apns.mjs";
import { idBoite } from "../commun/forme.mjs";

export const LIMITES = {
  entreeTransit: 256 * 1024,
  entreesParEnvoi: 200,
  reglages: 2 * 1024 * 1024,
  envoi: 30 * 1024 * 1024, // un mail envoye, pieces jointes comprises
};
const SESSION_JOURS = 90;
const CHAMPS_BOITE_MODIFIABLES = ["label", "display_name", "color", "signature", "sort_order"];

class ErreurHttp extends Error {
  constructor(statut, message, plus = {}) {
    super(message);
    this.statut = statut;
    this.plus = plus;
  }
}

const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");
const id = () => crypto.randomBytes(12).toString("base64url");
export const normaliserEmail = (e) => String(e || "").trim().toLowerCase();
const emailValide = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

export async function creerServeur(options = {}) {
  await secret.pret;
  const env = options.env || process.env;
  const essai = options.essai ?? env.NUAGE_MODE_ESSAI === "1";
  let cleReglages = secret.cleDepuisHex(options.cleReglages ?? env.NUAGE_CLE_REGLAGES);
  if (!cleReglages) {
    if (!essai) throw new Error("NUAGE_CLE_REGLAGES manquante (64 caracteres hexadecimaux) : le serveur refuse de demarrer.");
    cleReglages = secret.cleAuHasard();
  }
  const cfg = {
    base: options.base ?? env.NUAGE_BASE ?? path.join(process.cwd(), "donnees", "nuage.db"),
    gardeJours: Number(options.gardeJours ?? env.NUAGE_GARDE_JOURS ?? 30),
    essai,
    smtp: options.smtp ?? env.NUAGE_SMTP ?? "",
    expediteur: options.expediteur ?? env.NUAGE_EXPEDITEUR ?? "",
    misesAJour: options.misesAJour ?? env.NUAGE_MISES_A_JOUR ?? "",
    secret: options.secret ?? env.NUAGE_SECRET ?? crypto.randomBytes(32).toString("hex"),
    journaliser: options.journaliser ?? true,
    veille: options.veille ?? env.NUAGE_VEILLE !== "0",
    mdpRapide: options.mdpRapide ?? false,
    maintenant: options.maintenant ?? (() => Date.now()),
    stripe: { ...abo.configStripe(env), ...(options.stripe || {}) },
    oauth: { ...oauth.configOauth(env), ...(options.oauth || {}) },
    fetch: options.fetch ?? fetch,
    apns: options.apns,
  };
  const maintenant = () => cfg.maintenant();
  const db = ouvrirBase(cfg.base);
  const stripe = abo.stripePret(cfg.stripe) ? abo.clientStripe(cfg.stripe, cfg.fetch) : null;
  const ouvrirBoite = options.ouvrirBoite ?? ouvrirBoiteImap;
  const detecter = options.detecter ?? ((email) => detecterReglages(email, { fetch: cfg.fetch }));
  const courriels = []; // mode essai : les courriels partis (jamais en service)
  const limites = new Map();

  const note = (m) => cfg.journaliser && console.log(`[cloud] ${m}`);

  // --- outils --------------------------------------------------------------
  function limiter(req, cle, max = 20) {
    const ip = req.socket.remoteAddress || "?";
    const k = `${ip}|${cle}`;
    const now = Date.now();
    const e = limites.get(k);
    if (!e || e.fin < now) return void limites.set(k, { n: 1, fin: now + 60_000 });
    if (++e.n > max) throw new ErreurHttp(429, "Trop d'essais, reessayez dans une minute.");
  }

  async function corpsBrut(req, max) {
    const morceaux = [];
    let t = 0;
    for await (const c of req) {
      t += c.length;
      if (t > max) throw new ErreurHttp(413, "Envoi trop volumineux.");
      morceaux.push(c);
    }
    return Buffer.concat(morceaux);
  }

  async function corps(req, max = 64 * 1024) {
    const b = await corpsBrut(req, max);
    if (!b.length) return {};
    try {
      return JSON.parse(b.toString("utf8"));
    } catch {
      throw new ErreurHttp(400, "Corps JSON invalide.");
    }
  }

  function sessionDepuisJeton(jeton) {
    if (!jeton) return null;
    const s = db.prepare("SELECT compte, appareil, expire FROM sessions WHERE jeton_hash = ?").get(sha256(jeton));
    if (!s || s.expire < maintenant()) return null;
    return s;
  }

  function session(req) {
    const h = req.headers.authorization || "";
    const jeton = h.startsWith("Bearer ") ? h.slice(7) : "";
    const s = sessionDepuisJeton(jeton);
    if (!s) throw new ErreurHttp(401, "Connexion requise.");
    db.prepare("UPDATE sessions SET expire = ? WHERE jeton_hash = ?").run(maintenant() + SESSION_JOURS * abo.JOUR, sha256(jeton));
    db.prepare("UPDATE appareils SET vu = ? WHERE id = ?").run(maintenant(), s.appareil);
    return s;
  }

  function nouvelleSession(compte, appareil) {
    const jeton = crypto.randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO sessions (jeton_hash, compte, appareil, expire) VALUES (?,?,?,?)").run(
      sha256(jeton),
      compte,
      appareil,
      maintenant() + SESSION_JOURS * abo.JOUR
    );
    return jeton;
  }

  function nouvelAppareil(compte, a = {}) {
    const i = id();
    const genre = ["ordinateur", "iphone", "web", "extension"].includes(a.genre) ? a.genre : "ordinateur";
    db.prepare("INSERT INTO appareils (id, compte, nom, genre, cree, vu) VALUES (?,?,?,?,?,?)").run(
      i,
      compte,
      String(a.nom || "").slice(0, 120) || null,
      genre,
      maintenant(),
      maintenant()
    );
    return i;
  }

  const lireCompte = (compte) => db.prepare("SELECT * FROM comptes WHERE id = ?").get(compte);

  async function envoyerCourriel(email, sujet, texte) {
    if (options.envoyerCourriel) return options.envoyerCourriel(email, sujet, texte);
    if (cfg.essai) return void courriels.push({ email, sujet, texte });
    if (!cfg.smtp) throw new ErreurHttp(503, "Envoi de courriel non configure sur ce serveur.");
    const { default: nodemailer } = await import("nodemailer");
    const t = nodemailer.createTransport(cfg.smtp);
    try {
      await t.sendMail({ from: cfg.expediteur || undefined, to: email, subject: sujet, text: texte });
    } finally {
      t.close();
    }
  }

  // --- reglages (chiffres au repos) ------------------------------------------
  function lireReglages(compte) {
    const l = db.prepare("SELECT version, bloc FROM reglages WHERE compte = ?").get(compte);
    if (!l) return { version: 0, r: { boites: [], utilisateur: {}, collections: {} } };
    const r = secret.ouvrir(cleReglages, l.bloc);
    return { version: Number(l.version), r: { boites: [], utilisateur: {}, collections: {}, ...r } };
  }

  function ecrireReglages(compte, r, versionAttendue) {
    const actuel = db.prepare("SELECT version FROM reglages WHERE compte = ?").get(compte);
    const v = actuel ? Number(actuel.version) : 0;
    if (versionAttendue !== undefined && Number(versionAttendue) !== v) {
      throw new ErreurHttp(409, "Les reglages ont change sur un autre appareil.", { version: v, reglages: publics(lireReglages(compte).r) });
    }
    const bloc = secret.sceller(cleReglages, r);
    if (bloc.length > LIMITES.reglages) throw new ErreurHttp(413, "Reglages trop volumineux.");
    db.prepare(
      "INSERT INTO reglages (compte, version, bloc, maj) VALUES (?,?,?,?) ON CONFLICT(compte) DO UPDATE SET version = excluded.version, bloc = excluded.bloc, maj = excluded.maj"
    ).run(compte, v + 1, bloc, maintenant());
    diffuser(compte, { t: "reglages", version: v + 1 });
    return v + 1;
  }

  /** Boite telle que la voient les apps : sans mot de passe ni jeton. */
  function boitePublique(b) {
    return {
      id: b.id,
      email: b.email,
      label: b.label || b.email,
      display_name: b.display_name || "",
      color: b.color || "",
      signature: b.signature || "",
      sort_order: b.sort_order ?? 0,
      fournisseur: b.fournisseur || "autre",
      auth: b.auth || "password",
      oauth_provider: b.oauth_provider || "",
      imap: { host: b.imap?.host, port: b.imap?.port, security: b.imap?.security },
      smtp: { host: b.smtp?.host, port: b.smtp?.port, security: b.smtp?.security },
      a_reconnecter: !!b.a_reconnecter,
      cree: b.cree || null,
    };
  }
  const publics = (r) => ({ ...r, boites: (r.boites || []).map(boitePublique) });

  function trouverBoite(compte, idB) {
    const { r } = lireReglages(compte);
    const b = (r.boites || []).find((x) => x.id === String(idB || ""));
    if (!b) throw new ErreurHttp(404, "Boite introuvable sur ce compte.");
    return b;
  }

  // --- le pont : boites ouvertes au passage ----------------------------------
  const pont = new Map(); // compte -> Map(boite -> BoiteImap)
  const jetonAcces = oauth.gestionnaireJetons(cfg.oauth, {
    fetcher: cfg.fetch,
    surRefus: (b) => marquerAReconnecter(b.compte, b.id),
  });

  function marquerAReconnecter(compte, idB) {
    try {
      const { version, r } = lireReglages(compte);
      const b = r.boites.find((x) => x.id === idB);
      if (!b || b.a_reconnecter) return;
      b.a_reconnecter = true;
      ecrireReglages(compte, r, version);
    } catch {
      /* rien */
    }
  }

  function boiteOuverte(compte, b) {
    let m = pont.get(compte);
    if (!m) pont.set(compte, (m = new Map()));
    let o = m.get(b.id);
    const empreinte = sha256(JSON.stringify([b.imap, b.smtp, b.oauth?.refresh_token || ""]));
    if (o && o.empreinte !== empreinte) {
      void o.fermer();
      o = null;
    }
    if (!o) {
      o = ouvrirBoite({ ...b, compte }, { compte, jetonAcces });
      o.empreinte = empreinte;
      m.set(b.id, o);
    } else {
      o.boite = { ...b, compte };
    }
    return o;
  }

  function actif(c) {
    return c && (c.abo_etat === "essai" || c.abo_etat === "actif");
  }

  function exigerActif(compte) {
    const c = lireCompte(compte);
    if (!actif(c)) throw new ErreurHttp(402, "Votre abonnement iMiel Cloud est arrete.", { erreur: "abonnement", abonnement: abo.resume(c, maintenant()) });
    return c;
  }

  async function arreterPont(compte) {
    const m = pont.get(compte);
    pont.delete(compte);
    if (m) await Promise.all([...m.values()].map((o) => o.fermer().catch(() => {})));
  }

  /** Veille sur la boite de reception de chaque boite d'un compte actif. */
  function demarrerVeille(compte) {
    if (!cfg.veille) return;
    if (!actif(lireCompte(compte))) return;
    const { r } = lireReglages(compte);
    for (const b of r.boites || []) {
      if (b.a_reconnecter) continue;
      const o = boiteOuverte(compte, b);
      o.surveiller((nouveau) => void nouveauMail(compte, b, nouveau));
    }
  }

  async function nouveauMail(compte, b, { de, sujet }) {
    diffuser(compte, { t: "changement", boite: b.id, dossier: "INBOX" });
    const iphones = db.prepare("SELECT jeton_apns FROM appareils WHERE compte = ? AND jeton_apns IS NOT NULL").all(compte);
    if (!iphones.length || !apnsConfigure(cfg.apns)) return;
    for (const a of iphones) {
      await envoyerApns(cfg.apns, a.jeton_apns, { titre: de, texte: sujet, regroupement: b.id, donnees: { boite: b.id } }).catch(() => {});
    }
  }

  // --- temps reel : WebSocket par appareil -----------------------------------
  const prises = new Map(); // compte -> Set(ws)
  function diffuser(compte, msg, sauf) {
    const s = prises.get(compte);
    if (!s) return;
    const t = JSON.stringify(msg);
    for (const ws of s) if (ws !== sauf && ws.appareil !== sauf && ws.readyState === 1) ws.send(t);
  }

  // --- abonnement -------------------------------------------------------------
  async function changerEtat(compte, nouveau, { essaiFin, retard } = {}) {
    const c = lireCompte(compte);
    if (!c) return;
    const avant = c.abo_etat;
    const arreteLe = nouveau === "arrete" ? c.arrete_le || maintenant() : null;
    db.prepare(
      "UPDATE comptes SET abo_etat = ?, essai_fin = COALESCE(?, essai_fin), retard = ?, arrete_le = ?, rappel_purge = CASE WHEN ? IS NULL THEN 0 ELSE rappel_purge END WHERE id = ?"
    ).run(nouveau, essaiFin ?? null, retard ? 1 : 0, arreteLe, arreteLe, compte);
    const apres = lireCompte(compte);
    diffuser(compte, { t: "abonnement", abonnement: abo.resume(apres, maintenant()) });
    if (avant !== nouveau) {
      note(`abonnement ${avant} -> ${nouveau}`);
      if (nouveau === "arrete") await arreterPont(compte);
      else if (avant === "arrete") demarrerVeille(compte);
    }
  }

  async function demarrerEssai(compte, email) {
    const fin = maintenant() + abo.ESSAI_JOURS * abo.JOUR;
    db.prepare("UPDATE comptes SET abo_etat = 'essai', essai_fin = ? WHERE id = ?").run(fin, compte);
    if (!stripe) return;
    try {
      const client = await stripe.creerClient(email, compte);
      const s = await stripe.creerEssai(client.id, compte);
      db.prepare("UPDATE comptes SET stripe_client = ?, stripe_abonnement = ?, essai_fin = ? WHERE id = ?").run(
        client.id,
        s.id,
        s.trial_end ? s.trial_end * 1000 : fin,
        compte
      );
    } catch (e) {
      note(`essai Stripe non cree : ${e.message}`);
    }
  }

  async function clientStripeDe(c) {
    if (c.stripe_client) return c.stripe_client;
    const client = await stripe.creerClient(c.email, c.id);
    db.prepare("UPDATE comptes SET stripe_client = ? WHERE id = ?").run(client.id, c.id);
    return client.id;
  }

  const compteDeStripe = (obj) => {
    const parMeta = obj?.metadata?.compte;
    if (parMeta && lireCompte(parMeta)) return parMeta;
    const client = typeof obj?.customer === "string" ? obj.customer : obj?.customer?.id;
    return client ? db.prepare("SELECT id FROM comptes WHERE stripe_client = ?").get(client)?.id : null;
  };

  async function appliquerAbonnement(compte, s) {
    const { etat, retard } = abo.etatDepuisStripe(s.status);
    db.prepare("UPDATE comptes SET stripe_abonnement = ? WHERE id = ?").run(s.id, compte);
    await changerEtat(compte, etat, { retard, essaiFin: s.trial_end ? s.trial_end * 1000 : undefined });
  }

  async function evenementStripe(ev) {
    const o = ev.data?.object || {};
    const compte = compteDeStripe(o);
    if (!compte) return;
    const c = lireCompte(compte);
    switch (ev.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.resumed":
      case "customer.subscription.paused":
        if (c.stripe_abonnement && o.id !== c.stripe_abonnement && ["canceled", "incomplete_expired"].includes(o.status)) return;
        return appliquerAbonnement(compte, o);
      case "customer.subscription.deleted":
        if (c.stripe_abonnement && o.id !== c.stripe_abonnement) return;
        return changerEtat(compte, "arrete");
      case "customer.subscription.trial_will_end":
        if (!c.rappel_essai) {
          db.prepare("UPDATE comptes SET rappel_essai = 1 WHERE id = ?").run(compte);
          await envoyerCourriel(c.email, "Votre essai iMiel Cloud se termine bientot", texteRappelEssai(o.trial_end ? o.trial_end * 1000 : c.essai_fin));
        }
        return;
      case "invoice.paid":
        return changerEtat(compte, "actif", { retard: 0 });
      case "invoice.payment_failed":
        db.prepare("UPDATE comptes SET retard = 1 WHERE id = ?").run(compte);
        diffuser(compte, { t: "abonnement", abonnement: abo.resume(lireCompte(compte), maintenant()) });
        await envoyerCourriel(
          c.email,
          "Paiement iMiel Cloud refuse",
          "Bonjour,\n\nLe paiement de votre abonnement iMiel Cloud n'a pas abouti. Vous pouvez mettre a jour votre carte depuis iMiel : Reglages > Abonnement > Gerer l'abonnement.\n\nL'equipe iMiel"
        );
        return;
      case "checkout.session.completed": {
        if (o.mode !== "setup" || !o.setup_intent) return;
        const si = await stripe.lireSetup(typeof o.setup_intent === "string" ? o.setup_intent : o.setup_intent.id);
        const moyen = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
        if (!moyen) return;
        await stripe.appel("POST", `/v1/customers/${c.stripe_client}`, { invoice_settings: { default_payment_method: moyen } });
        let s = c.stripe_abonnement ? await stripe.lireAbonnement(c.stripe_abonnement).catch(() => null) : null;
        if (!s || ["canceled", "incomplete_expired"].includes(s.status)) {
          s = await stripe.creerAbonnement(c.stripe_client, compte, moyen);
        } else {
          s = await stripe.poserMoyen(s.id, moyen);
          if (s.status === "paused") {
            // La reprise cree une facture qui doit etre reglee avant que
            // l'abonnement ne redevienne actif (Stripe ne la preleve pas seul).
            s = await stripe.reprendre(s.id);
            const facture = typeof s.latest_invoice === "string" ? await stripe.appel("GET", `/v1/invoices/${s.latest_invoice}`) : s.latest_invoice;
            if (facture?.status === "draft") await stripe.appel("POST", `/v1/invoices/${facture.id}/finalize`, {});
            if (facture && ["draft", "open"].includes(facture.status)) await stripe.appel("POST", `/v1/invoices/${facture.id}/pay`, { payment_method: moyen });
            s = await stripe.lireAbonnement(s.id);
          }
        }
        return appliquerAbonnement(compte, s);
      }
      default:
        return;
    }
  }

  const texteRappelEssai = (fin) =>
    `Bonjour,\n\nVotre essai gratuit d'iMiel Cloud se termine le ${new Date(fin).toLocaleDateString("fr-CH")}.\n` +
    `Pour continuer (${abo.PRIX_AFFICHE}), ajoutez une carte depuis iMiel sur votre ordinateur ou sur le web : Reglages > Abonnement.\n` +
    `Sans carte, votre compte se met en pause : votre ordinateur peut continuer avec la version gratuite, et vos reglages sont gardes 30 jours.\n\nL'equipe iMiel`;

  /** Entretien horaire : fin d'essai sans Stripe, rappels, purge a J+30, transit. */
  async function entretien() {
    const t = maintenant();
    for (const c of db.prepare("SELECT * FROM comptes WHERE confirme = 1").all()) {
      if (c.abo_etat === "essai" && !c.stripe_abonnement && c.essai_fin) {
        if (c.essai_fin - t < 3 * abo.JOUR && c.essai_fin > t && !c.rappel_essai) {
          db.prepare("UPDATE comptes SET rappel_essai = 1 WHERE id = ?").run(c.id);
          await envoyerCourriel(c.email, "Votre essai iMiel Cloud se termine bientot", texteRappelEssai(c.essai_fin)).catch(() => {});
        }
        if (c.essai_fin <= t) await changerEtat(c.id, "arrete");
      }
      const d = lireCompte(c.id);
      if (d.abo_etat === "arrete" && d.arrete_le) {
        const purge = d.arrete_le + abo.PURGE_JOURS * abo.JOUR;
        if (t >= purge - abo.RAPPEL_PURGE_JOURS * abo.JOUR && t < purge && !d.rappel_purge) {
          db.prepare("UPDATE comptes SET rappel_purge = 1 WHERE id = ?").run(c.id);
          await envoyerCourriel(
            d.email,
            "Vos reglages iMiel Cloud seront effaces dans 7 jours",
            `Bonjour,\n\nVotre abonnement iMiel Cloud est arrete depuis le ${new Date(d.arrete_le).toLocaleDateString("fr-CH")}. Le ${new Date(purge).toLocaleDateString("fr-CH")}, les reglages gardes par le serveur (boites reliees, signatures, regles) seront effaces.\nPour les garder, reprenez l'abonnement depuis iMiel : Reglages > Abonnement.\nVos mails, eux, restent chez votre fournisseur et sur vos appareils.\n\nL'equipe iMiel`
          ).catch(() => {});
        }
        if (t >= purge) {
          db.prepare("DELETE FROM reglages WHERE compte = ?").run(c.id);
          db.prepare("DELETE FROM transit WHERE compte = ?").run(c.id);
          note("reglages d'un compte arrete effaces (J+30)");
        }
      }
    }
    purgerTransit(db, cfg.gardeJours, t);
  }

  // --- routes -----------------------------------------------------------------
  const routes = [];
  const route = (methode, motif, fn) =>
    routes.push({ methode, motif, re: new RegExp("^" + motif.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn });

  route("GET", "/sante", () => ({ ok: true }));

  // Inscription : adresse confirmee par un code envoye par courriel.
  route("POST", "/v1/inscription", async (req) => {
    limiter(req, "inscription", 10);
    const { email } = await corps(req, 4096);
    const mail = normaliserEmail(email);
    if (!emailValide(mail)) throw new ErreurHttp(400, "Adresse e-mail invalide.");
    const existe = db.prepare("SELECT id, confirme FROM comptes WHERE email = ?").get(mail);
    if (existe?.confirme) {
      await envoyerCourriel(mail, "Votre compte iMiel existe deja", "Bonjour,\n\nUn compte iMiel Cloud existe deja avec cette adresse : connectez-vous avec votre mot de passe, ou choisissez « Mot de passe oublie ».\n\nL'equipe iMiel").catch(() => {});
      return { ok: true };
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const expire = maintenant() + 15 * 60_000;
    if (existe) {
      db.prepare("UPDATE comptes SET code_hash = ?, code_expire = ?, code_essais = 0 WHERE id = ?").run(sha256(code + mail), expire, existe.id);
    } else {
      db.prepare("INSERT INTO comptes (id, email, code_hash, code_expire, cree) VALUES (?,?,?,?,?)").run(id(), mail, sha256(code + mail), expire, maintenant());
    }
    await envoyerCourriel(
      mail,
      `Votre code iMiel : ${code}`,
      `Bonjour,\n\nVoici le code pour confirmer votre compte iMiel Cloud : ${code}\nIl est valable 15 minutes.\n\nSi vous n'avez rien demande, ignorez ce message.`
    );
    return { ok: true, ...(cfg.essai ? { code } : {}) };
  });

  function verifierCode(c, mail, code) {
    if (!c || c.code_essais >= 5 || !c.code_expire || c.code_expire < maintenant()) throw new ErreurHttp(400, "Code invalide ou expire.");
    if (sha256(String(code || "") + mail) !== c.code_hash) {
      db.prepare("UPDATE comptes SET code_essais = code_essais + 1 WHERE id = ?").run(c.id);
      throw new ErreurHttp(400, "Code invalide ou expire.");
    }
  }

  function exigerMotDePasse(m) {
    if (String(m || "").length < 8) throw new ErreurHttp(400, "Le mot de passe doit faire au moins 8 caracteres.");
  }

  route("POST", "/v1/inscription/finir", async (req) => {
    limiter(req, "inscription-finir", 20);
    const b = await corps(req);
    const mail = normaliserEmail(b.email);
    const c = db.prepare("SELECT * FROM comptes WHERE email = ?").get(mail);
    if (!c || c.confirme) throw new ErreurHttp(400, "Code invalide ou expire.");
    verifierCode(c, mail, b.code);
    exigerMotDePasse(b.motDePasse);
    db.prepare("UPDATE comptes SET confirme = 1, code_hash = NULL, code_expire = NULL, mdp = ? WHERE id = ?").run(
      secret.hacherMotDePasse(b.motDePasse, { rapide: cfg.mdpRapide }),
      c.id
    );
    await demarrerEssai(c.id, mail);
    const appareil = nouvelAppareil(c.id, b.appareil);
    return { jeton: nouvelleSession(c.id, appareil), appareilId: appareil, abonnement: abo.resume(lireCompte(c.id), maintenant()) };
  });

  route("POST", "/v1/connexion", async (req) => {
    limiter(req, "connexion", 20);
    const b = await corps(req);
    const mail = normaliserEmail(b.email);
    const c = db.prepare("SELECT id, mdp FROM comptes WHERE email = ? AND confirme = 1").get(mail);
    // Meme duree de calcul et meme reponse si l'adresse n'existe pas.
    const ok = c ? secret.verifierMotDePasse(c.mdp, b.motDePasse) : (secret.verifierMotDePasse(FAUX, String(b.motDePasse || "")), false);
    if (!ok) throw new ErreurHttp(401, "Adresse ou mot de passe incorrects.");
    const appareil = nouvelAppareil(c.id, b.appareil);
    return { jeton: nouvelleSession(c.id, appareil), appareilId: appareil, abonnement: abo.resume(lireCompte(c.id), maintenant()) };
  });
  const FAUX = secret.hacherMotDePasse(crypto.randomBytes(16).toString("hex"), { rapide: cfg.mdpRapide });

  route("POST", "/v1/mot-de-passe/oubli", async (req) => {
    limiter(req, "oubli", 5);
    const mail = normaliserEmail((await corps(req, 4096)).email);
    const c = db.prepare("SELECT id FROM comptes WHERE email = ? AND confirme = 1").get(mail);
    if (!c) return { ok: true };
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    db.prepare("UPDATE comptes SET code_hash = ?, code_expire = ?, code_essais = 0 WHERE id = ?").run(sha256(code + mail), maintenant() + 15 * 60_000, c.id);
    await envoyerCourriel(mail, `Votre code iMiel : ${code}`, `Bonjour,\n\nVoici le code pour choisir un nouveau mot de passe iMiel Cloud : ${code}\nIl est valable 15 minutes.\n\nSi vous n'avez rien demande, ignorez ce message.`);
    return { ok: true, ...(cfg.essai ? { code } : {}) };
  });

  route("POST", "/v1/mot-de-passe/nouveau", async (req) => {
    limiter(req, "oubli-fin", 10);
    const b = await corps(req);
    const mail = normaliserEmail(b.email);
    const c = db.prepare("SELECT * FROM comptes WHERE email = ? AND confirme = 1").get(mail);
    verifierCode(c, mail, b.code);
    exigerMotDePasse(b.motDePasse);
    db.prepare("UPDATE comptes SET mdp = ?, code_hash = NULL, code_expire = NULL WHERE id = ?").run(secret.hacherMotDePasse(b.motDePasse, { rapide: cfg.mdpRapide }), c.id);
    db.prepare("DELETE FROM sessions WHERE compte = ?").run(c.id); // toutes les sessions tombent
    return { ok: true };
  });

  route("POST", "/v1/deconnexion", (req) => {
    const s = session(req);
    db.prepare("DELETE FROM appareils WHERE id = ? AND compte = ?").run(s.appareil, s.compte);
    return { ok: true };
  });

  function appareilsDe(s) {
    return db
      .prepare("SELECT id, nom, genre, cree, vu, jeton_apns IS NOT NULL AS notifie FROM appareils WHERE compte = ? ORDER BY cree")
      .all(s.compte)
      .map((a) => ({ id: a.id, nom: a.nom || "", genre: a.genre, cree: a.cree, vu: a.vu, notifie: !!a.notifie, moi: a.id === s.appareil }));
  }

  route("GET", "/v1/compte", (req) => {
    const s = session(req);
    const c = lireCompte(s.compte);
    return { email: c.email, cree: c.cree, abonnement: abo.resume(c, maintenant()), appareils: appareilsDe(s) };
  });

  route("DELETE", "/v1/compte", async (req) => {
    const s = session(req);
    const b = await corps(req, 4096);
    const c = lireCompte(s.compte);
    if (normaliserEmail(b.confirmation) !== c.email) throw new ErreurHttp(400, "Recopiez l'adresse du compte pour confirmer la suppression.");
    if (stripe && c.stripe_abonnement) await stripe.resilier(c.stripe_abonnement).catch(() => {});
    await arreterPont(s.compte);
    diffuser(s.compte, { t: "compte-supprime" });
    db.prepare("DELETE FROM comptes WHERE id = ?").run(s.compte);
    return { ok: true };
  });

  route("GET", "/v1/appareils", (req) => ({ appareils: appareilsDe(session(req)) }));

  route("PUT", "/v1/appareils/moi", async (req) => {
    const s = session(req);
    const b = await corps(req, 16 * 1024);
    if (b.apns !== undefined) db.prepare("UPDATE appareils SET jeton_apns = ? WHERE id = ?").run(String(b.apns || "").replace(/[^0-9a-fA-F]/g, "").slice(0, 200) || null, s.appareil);
    if (b.nom !== undefined) db.prepare("UPDATE appareils SET nom = ? WHERE id = ?").run(String(b.nom).slice(0, 120), s.appareil);
    return { ok: true };
  });

  route("DELETE", "/v1/appareils/:id", (req, p) => {
    const s = session(req);
    const r = db.prepare("DELETE FROM appareils WHERE id = ? AND compte = ?").run(p.id, s.compte);
    for (const ws of prises.get(s.compte) || []) if (ws.appareil === p.id) ws.close(4001, "appareil retire");
    nettoyerTransit(db, s.compte);
    return { ok: r.changes > 0 };
  });

  // --- abonnement ---
  route("GET", "/v1/abonnement", (req) => abo.resume(lireCompte(session(req).compte), maintenant()));

  route("POST", "/v1/abonnement/payer", async (req) => {
    const s = session(req);
    if (!stripe) throw new ErreurHttp(503, "Le paiement n'est pas encore ouvert sur ce serveur.");
    const c = lireCompte(s.compte);
    const client = await clientStripeDe(c);
    const sess = await stripe.sessionPaiement(client, c.id, c.stripe_abonnement);
    return { url: sess.url };
  });

  route("POST", "/v1/abonnement/portail", async (req) => {
    const s = session(req);
    if (!stripe) throw new ErreurHttp(503, "Le paiement n'est pas encore ouvert sur ce serveur.");
    const c = lireCompte(s.compte);
    return { url: (await stripe.portail(await clientStripeDe(c))).url };
  });

  route("POST", "/v1/stripe/webhook", async (req) => {
    const brut = (await corpsBrut(req, 512 * 1024)).toString("utf8");
    if (!abo.verifierSignature(brut, req.headers["stripe-signature"], cfg.stripe.secretWebhook, maintenant())) {
      throw new ErreurHttp(400, "Signature invalide.");
    }
    const ev = JSON.parse(brut);
    if (db.prepare("SELECT 1 FROM evenements_paiement WHERE id = ?").get(String(ev.id))) return { ok: true, deja: true };
    await evenementStripe(ev);
    db.prepare("INSERT OR IGNORE INTO evenements_paiement (id, recu) VALUES (?,?)").run(String(ev.id), maintenant());
    return { ok: true };
  });

  // --- reglages ---
  route("GET", "/v1/reglages", (req, _p, url) => {
    const s = session(req);
    const { version, r } = lireReglages(s.compte);
    // Avec les identifiants : seulement pour passer l'ordinateur en version
    // gratuite (il relevera lui-meme avec les memes reglages).
    if (url.searchParams.get("identifiants") === "1") {
      const a = db.prepare("SELECT genre FROM appareils WHERE id = ?").get(s.appareil);
      if (a?.genre !== "ordinateur") throw new ErreurHttp(403, "Seul un ordinateur peut reprendre les identifiants des boites.");
      return {
        version,
        reglages: {
          ...r,
          boites: r.boites.map((b) => ({
            ...boitePublique(b),
            imap: b.imap,
            smtp: b.smtp,
            // Jeton du client OAuth DU SERVEUR : inutilisable ailleurs.
            reconnecter_ailleurs: b.auth === "oauth2",
          })),
        },
      };
    }
    return { version, reglages: publics(r) };
  });

  route("PUT", "/v1/reglages", async (req) => {
    const s = session(req);
    const b = await corps(req, LIMITES.reglages);
    const { version, r } = lireReglages(s.compte);
    if (b.version !== undefined && Number(b.version) !== version) {
      throw new ErreurHttp(409, "Les reglages ont change sur un autre appareil.", { version, reglages: publics(r) });
    }
    if (b.utilisateur && typeof b.utilisateur === "object") r.utilisateur = { ...r.utilisateur, ...b.utilisateur };
    if (b.collections && typeof b.collections === "object") {
      for (const [k, v] of Object.entries(b.collections)) if (Array.isArray(v) && /^[a-z_]{1,40}$/.test(k)) r.collections[k] = v.slice(0, 2000);
    }
    for (const m of Array.isArray(b.boites) ? b.boites : []) {
      const x = r.boites.find((y) => y.id === m.id);
      if (!x) continue;
      for (const k of CHAMPS_BOITE_MODIFIABLES) if (m[k] !== undefined) x[k] = m[k];
    }
    return { version: ecrireReglages(s.compte, r, version) };
  });

  // --- boites ---
  route("GET", "/v1/detection", async (req, _p, url) => {
    session(req);
    limiter(req, "detection", 30);
    try {
      return await detecter(url.searchParams.get("email") || "");
    } catch (e) {
      throw new ErreurHttp(400, e.message);
    }
  });

  route("POST", "/v1/boites", async (req) => {
    const s = session(req);
    exigerActif(s.compte);
    limiter(req, "boites", 15);
    const b = await corps(req);
    const email = normaliserEmail(b.email);
    if (!emailValide(email)) throw new ErreurHttp(400, "Adresse e-mail invalide.");
    let d = b.imap && b.smtp ? { fournisseur: "autre", nom: email.split("@")[1], methode: "mot-de-passe", imap: b.imap, smtp: b.smtp } : await detecter(email).catch((e) => {
      throw new ErreurHttp(400, e.message);
    });
    if (d.methode === "oauth-google" || d.methode === "oauth-microsoft") {
      throw new ErreurHttp(409, `Cette boite se relie avec « Se connecter avec ${d.methode === "oauth-google" ? "Google" : "Microsoft"} ».`, { methode: d.methode });
    }
    if (d.methode === "non-pris-en-charge") throw new ErreurHttp(400, `${d.nom} ne permet pas aux applications de messagerie de relever la boite.`);
    if (!b.motDePasse) throw new ErreurHttp(400, "Indiquez le mot de passe de la boite.");
    const boite = {
      id: idBoite(s.compte, email),
      email,
      label: b.label || email,
      display_name: b.display_name || "",
      fournisseur: d.fournisseur,
      auth: "password",
      imap: { ...d.imap, username: b.identifiant || email, password: String(b.motDePasse) },
      smtp: { ...d.smtp, username: b.identifiant || email, password: String(b.motDePasse) },
      cree: maintenant(),
    };
    const essaiBoite = ouvrirBoite({ ...boite, compte: s.compte }, { compte: s.compte, jetonAcces });
    try {
      await essaiBoite.essayer();
    } catch (e) {
      throw new ErreurHttp(400, e.message || erreurLisible(e), { reglages: { imap: d.imap, smtp: d.smtp, source: d.source } });
    } finally {
      await essaiBoite.fermer?.();
    }
    return { boite: boitePublique(enregistrerBoite(s.compte, boite)) };
  });

  function enregistrerBoite(compte, boite) {
    const { version, r } = lireReglages(compte);
    const i = r.boites.findIndex((x) => x.id === boite.id);
    if (i >= 0) r.boites[i] = { ...r.boites[i], ...boite, a_reconnecter: false };
    else r.boites.push(boite);
    ecrireReglages(compte, r, version);
    demarrerVeille(compte);
    return boite;
  }

  route("PATCH", "/v1/boites/:id", async (req, p) => {
    const s = session(req);
    const b = await corps(req);
    const { version, r } = lireReglages(s.compte);
    const x = r.boites.find((y) => y.id === p.id);
    if (!x) throw new ErreurHttp(404, "Boite introuvable sur ce compte.");
    for (const k of CHAMPS_BOITE_MODIFIABLES) if (b[k] !== undefined) x[k] = b[k];
    if (b.motDePasse && x.auth === "password") {
      const essaiBoite = ouvrirBoite({ ...x, imap: { ...x.imap, password: b.motDePasse }, smtp: { ...x.smtp, password: b.motDePasse }, compte: s.compte }, { compte: s.compte, jetonAcces });
      try {
        await essaiBoite.essayer();
      } catch (e) {
        throw new ErreurHttp(400, e.message);
      } finally {
        await essaiBoite.fermer?.();
      }
      x.imap.password = b.motDePasse;
      x.smtp.password = b.motDePasse;
      x.a_reconnecter = false;
    }
    ecrireReglages(s.compte, r, version);
    return { boite: boitePublique(x) };
  });

  route("DELETE", "/v1/boites/:id", async (req, p) => {
    const s = session(req);
    const { version, r } = lireReglages(s.compte);
    const avant = r.boites.length;
    r.boites = r.boites.filter((x) => x.id !== p.id);
    if (r.boites.length === avant) throw new ErreurHttp(404, "Boite introuvable sur ce compte.");
    ecrireReglages(s.compte, r, version);
    const o = pont.get(s.compte)?.get(p.id);
    pont.get(s.compte)?.delete(p.id);
    await o?.fermer().catch(() => {});
    return { ok: true };
  });

  route("POST", "/v1/boites/oauth/:fournisseur", async (req, p) => {
    const s = session(req);
    exigerActif(s.compte);
    const f = p.fournisseur;
    if (!oauth.FOURNISSEURS[f]) throw new ErreurHttp(404, "Fournisseur inconnu.");
    if (!oauth.oauthPret(cfg.oauth, f)) throw new ErreurHttp(503, `La connexion ${oauth.FOURNISSEURS[f].nom} n'est pas encore ouverte sur ce serveur.`);
    const b = await corps(req, 4096);
    const etat = oauth.signerEtat(cfg.secret, { compte: s.compte, appareil: s.appareil, f });
    return { url: oauth.adresseAutorisation(cfg.oauth, f, etat, normaliserEmail(b.indice)) };
  });

  route("GET", "/v1/oauth/:fournisseur/retour", async (_req, p, url) => {
    const page = (titre, texte) => ({
      html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titre}</title><body style="font:16px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#fbf7ef;color:#2b2112"><main style="max-width:420px;text-align:center;padding:24px"><h1 style="font-size:22px">${titre}</h1><p>${texte}</p></main>`,
    });
    const etat = oauth.lireEtat(cfg.secret, url.searchParams.get("state"));
    if (!etat || etat.f !== p.fournisseur || !lireCompte(etat.compte)) return page("Lien expire", "Recommencez depuis iMiel.");
    if (url.searchParams.get("error")) return page("Connexion annulee", "Aucune boite n'a ete reliee. Vous pouvez fermer cette page.");
    try {
      const b = await oauth.finirConnexion(cfg.oauth, p.fournisseur, url.searchParams.get("code"), cfg.fetch);
      enregistrerBoite(etat.compte, { ...b, id: idBoite(etat.compte, b.email), label: b.email, cree: maintenant() });
      return page("Boite reliee", `${b.email} est reliee a iMiel. Vous pouvez fermer cette page et revenir dans l'app.`);
    } catch (e) {
      return page("Connexion impossible", String(e.message || "Le fournisseur a refuse la connexion.").replace(/[<>&]/g, ""));
    }
  });

  // --- courrier : lu chez le fournisseur, transmis, oublie ---
  route("POST", "/v1/synchro", async (req) => {
    const s = session(req);
    exigerActif(s.compte);
    const b = await corps(req, 512 * 1024);
    const boite = trouverBoite(s.compte, b.boite);
    if (boite.a_reconnecter) throw new ErreurHttp(409, "Cette boite doit etre reconnectee.", { erreur: "a-reconnecter" });
    const o = boiteOuverte(s.compte, boite);
    try {
      const dossiers = await o.dossiers();
      const voulus = b.dossiers && typeof b.dossiers === "object" ? b.dossiers : {};
      const resultats = {};
      for (const d of dossiers) {
        const curseur = voulus[d.path] || null;
        if (b.seulement && !b.seulement.includes(d.path)) continue;
        resultats[d.path] = await o.synchroDossier(d.path, curseur, { type: d.type });
      }
      return { boite: boite.id, dossiers, resultats };
    } catch (e) {
      if (e instanceof ErreurHttp) throw e;
      throw new ErreurHttp(502, erreurLisible(e));
    }
  });

  route("POST", "/v1/historique", async (req) => {
    const s = session(req);
    exigerActif(s.compte);
    const b = await corps(req, 16 * 1024);
    const o = boiteOuverte(s.compte, trouverBoite(s.compte, b.boite));
    try {
      return await o.historique(String(b.dossier), Number(b.avant), Number(b.n || 100));
    } catch (e) {
      throw new ErreurHttp(502, erreurLisible(e));
    }
  });

  route("GET", "/v1/pieces", async (req, _p, url) => {
    const s = session(req);
    exigerActif(s.compte);
    const q = url.searchParams;
    const o = boiteOuverte(s.compte, trouverBoite(s.compte, q.get("boite")));
    let piece;
    try {
      piece = await o.piece(String(q.get("dossier")), Number(q.get("uid")), Number(q.get("index")));
    } catch (e) {
      throw new ErreurHttp(502, erreurLisible(e));
    }
    if (!piece) throw new ErreurHttp(404, "Piece jointe introuvable chez le fournisseur.");
    return { brut: piece.contenu, type: piece.type, nom: piece.nom };
  });

  route("POST", "/v1/actions", async (req) => {
    const s = session(req);
    exigerActif(s.compte);
    const b = await corps(req, 256 * 1024);
    const resultats = [];
    const touches = new Set();
    for (const a of (Array.isArray(b.actions) ? b.actions : []).slice(0, 200)) {
      try {
        const o = boiteOuverte(s.compte, trouverBoite(s.compte, a.boite));
        let r;
        if (a.type === "drapeaux") r = await o.drapeaux(String(a.dossier), Number(a.uid), { lu: a.lu, favori: a.favori, repondu: a.repondu });
        else if (a.type === "deplacer") r = await o.deplacer(String(a.dossier), Number(a.uid), String(a.vers));
        else if (a.type === "supprimer") r = await o.supprimer(String(a.dossier), Number(a.uid));
        else throw new Error("geste inconnu");
        touches.add(`${a.boite}|${a.dossier}`);
        if (a.vers) touches.add(`${a.boite}|${a.vers}`);
        resultats.push({ id: a.id ?? null, ok: true, ...r });
      } catch (e) {
        resultats.push({ id: a.id ?? null, ok: false, erreur: e instanceof ErreurHttp ? e.message : erreurLisible(e) });
      }
    }
    for (const t of touches) {
      const [boite, dossier] = t.split("|");
      diffuser(s.compte, { t: "changement", boite, dossier }, s.appareil);
    }
    return { resultats };
  });

  route("POST", "/v1/envoyer", async (req) => {
    const s = session(req);
    exigerActif(s.compte);
    limiter(req, "envoyer", 60);
    const b = await corps(req, LIMITES.envoi * 1.4);
    const boite = trouverBoite(s.compte, b.boite);
    const o = boiteOuverte(s.compte, boite);
    const m = b.mail || {};
    if (!m.to?.length && !m.cc?.length && !m.bcc?.length) throw new ErreurHttp(400, "Aucun destinataire.");
    try {
      let envoyes = b.dossierEnvoyes;
      if (!envoyes) envoyes = (await o.dossiers()).find((d) => d.type === "sent")?.path;
      const r = await o.envoyer(m, envoyes);
      diffuser(s.compte, { t: "changement", boite: boite.id, dossier: envoyes || "" });
      return r;
    } catch (e) {
      throw new ErreurHttp(502, e.message || erreurLisible(e));
    }
  });

  // --- transit : donnees propres a iMiel, d'appareil a appareil ---
  route("POST", "/v1/transit", async (req) => {
    const s = session(req);
    exigerActif(s.compte);
    const b = await corps(req, LIMITES.entreeTransit * LIMITES.entreesParEnvoi);
    const entrees = (Array.isArray(b.entrees) ? b.entrees : []).slice(0, LIMITES.entreesParEnvoi);
    const dest = b.pour
      ? db.prepare("SELECT id FROM appareils WHERE id = ? AND compte = ?").all(String(b.pour), s.compte)
      : db.prepare("SELECT id FROM appareils WHERE compte = ? AND id != ?").all(s.compte, s.appareil);
    if (!dest.length || !entrees.length) return { acceptees: 0 };
    db.exec("BEGIN");
    try {
      for (const e of entrees) {
        const bloc = secret.sceller(cleReglages, e);
        if (bloc.length > LIMITES.entreeTransit) throw new ErreurHttp(413, "Entree trop volumineuse.");
        const r = db.prepare("INSERT INTO transit (compte, emetteur, bloc, taille, cree) VALUES (?,?,?,?,?)").run(s.compte, s.appareil, bloc, bloc.length, maintenant());
        for (const a of dest) db.prepare("INSERT INTO files_transit (appareil, entree) VALUES (?,?)").run(a.id, r.lastInsertRowid);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    diffuser(s.compte, { t: "transit" }, s.appareil);
    return { acceptees: entrees.length };
  });

  route("GET", "/v1/transit", (req, _p, url) => {
    const s = session(req);
    const limite = Math.min(500, Math.max(1, Number(url.searchParams.get("limite") || 200)));
    const lignes = db
      .prepare("SELECT t.id, t.emetteur, t.bloc, t.cree FROM files_transit f JOIN transit t ON t.id = f.entree WHERE f.appareil = ? ORDER BY t.id LIMIT ?")
      .all(s.appareil, limite);
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM files_transit WHERE appareil = ?").get(s.appareil).n);
    return {
      entrees: lignes.map((l) => ({ id: Number(l.id), de: l.emetteur, cree: l.cree, donnees: secret.ouvrir(cleReglages, l.bloc) })),
      reste: total - lignes.length,
    };
  });

  route("POST", "/v1/transit/accuse", async (req) => {
    const s = session(req);
    const b = await corps(req, 256 * 1024);
    const del = db.prepare("DELETE FROM files_transit WHERE appareil = ? AND entree = ?");
    db.exec("BEGIN");
    for (const i of (Array.isArray(b.ids) ? b.ids : []).slice(0, 5000).map(Number).filter(Number.isFinite)) del.run(s.appareil, i);
    db.exec("COMMIT");
    nettoyerTransit(db, s.compte);
    return { ok: true };
  });

  // --- mises a jour de l'app d'ordinateur (manifestes signes a la fabrication) ---
  route("GET", "/v1/mises-a-jour/:cible/:arch/:version", (_req, p) => {
    if (!cfg.misesAJour) return { statut: 204 };
    const nom = `${p.cible}-${p.arch}.json`.replace(/[^a-z0-9_.-]/gi, "");
    const f = path.join(cfg.misesAJour, nom);
    if (!fs.existsSync(f)) return { statut: 204 };
    const m = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!plusRecente(m.version, p.version)) return { statut: 204 };
    return m;
  });

  // --- serveur HTTP + WebSocket -------------------------------------------------
  const serveur = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, "http://cloud");
    let statut = 200;
    let motif = "?";
    try {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      if (req.method === "OPTIONS") {
        statut = 204;
        return res.writeHead(204).end();
      }
      const r = routes.find((x) => x.methode === req.method && x.re.test(url.pathname));
      if (!r) throw new ErreurHttp(404, "Introuvable.");
      motif = r.motif;
      const params = url.pathname.match(r.re).groups || {};
      const out = await r.fn(req, params, url);
      if (out?.brut) {
        res.writeHead(200, {
          "Content-Type": out.type || "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(out.nom || "fichier")}`,
        });
        return res.end(out.brut);
      }
      if (out?.html) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(out.html);
      }
      if (out?.statut === 204) {
        statut = 204;
        return res.writeHead(204).end();
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out ?? {}));
    } catch (err) {
      statut = err instanceof ErreurHttp ? err.statut : 500;
      if (!(err instanceof ErreurHttp) && cfg.journaliser) console.error(`[cloud] erreur interne sur ${motif} : ${err.message}`);
      const msg = err instanceof ErreurHttp ? err.message : "Erreur interne du serveur iMiel.";
      if (!res.headersSent) res.writeHead(statut, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ message: msg, ...(err.plus || {}) }));
    } finally {
      if (cfg.journaliser) console.log(`[cloud] ${req.method} ${motif} ${statut} ${Date.now() - t0}ms`);
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  serveur.on("upgrade", (req, socket, tete) => {
    const url = new URL(req.url, "http://cloud");
    const s = url.pathname === "/v1/flux" ? sessionDepuisJeton(url.searchParams.get("jeton") || "") : null;
    if (!s) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, tete, (ws) => {
      ws.appareil = s.appareil;
      let set = prises.get(s.compte);
      if (!set) prises.set(s.compte, (set = new Set()));
      set.add(ws);
      ws.vivant = true;
      ws.on("pong", () => (ws.vivant = true));
      ws.on("message", (m) => {
        if (String(m) === "ping") ws.send("pong");
      });
      ws.on("close", () => set.delete(ws));
      ws.send(JSON.stringify({ t: "bonjour", abonnement: abo.resume(lireCompte(s.compte), maintenant()) }));
      if (cfg.journaliser) console.log("[cloud] WS /v1/flux ouvert");
    });
  });
  const battement = setInterval(() => {
    for (const set of prises.values())
      for (const ws of set) {
        if (!ws.vivant) ws.terminate();
        else {
          ws.vivant = false;
          ws.ping();
        }
      }
  }, 30_000);
  battement.unref();

  const minuteur = setInterval(() => void entretien().catch((e) => note(`entretien : ${e.message}`)), 3600_000);
  minuteur.unref();
  await entretien();
  for (const c of db.prepare("SELECT id FROM comptes WHERE confirme = 1 AND abo_etat IN ('essai','actif')").all()) demarrerVeille(c.id);

  return {
    serveur,
    db,
    cfg,
    courriels,
    entretien,
    pont,
    lireReglages,
    fermer: () =>
      new Promise((r) => {
        clearInterval(minuteur);
        clearInterval(battement);
        for (const set of prises.values()) for (const ws of set) ws.terminate();
        Promise.all([...pont.keys()].map(arreterPont)).finally(() => {
          serveur.close(() => {
            db.close();
            r();
          });
          serveur.closeAllConnections?.();
        });
      }),
  };
}

export function plusRecente(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Lancement direct : node serveur/serveur.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { serveur, cfg } = await creerServeur();
  const port = Number(process.env.NUAGE_PORT || 8787);
  const hote = process.env.NUAGE_HOTE || "127.0.0.1";
  if (cfg.essai) console.warn("[cloud] MODE ESSAI : codes rendus dans les reponses, cle des reglages au hasard. Jamais en service.");
  serveur.listen(port, hote, () => console.log(`[cloud] pret sur http://${hote}:${port}`));
}
