// Essais du serveur de transfert iMiel Cloud.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { creerServeur } from "../serveur/serveur.mjs";
import { signer } from "../serveur/abonnement.mjs";
import { fournisseurFactice, stripeFactice, mailBrut, clientHttp } from "./outils.mjs";

const JOUR = 86_400_000;
let horloge = Date.now();
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "imiel-cloud-"));
const fournisseur = fournisseurFactice();
const faux = stripeFactice();
let srv, base, appel;

before(async () => {
  srv = await creerServeur({
    base: path.join(dossier, "cloud.db"),
    essai: true,
    journaliser: false,
    veille: true,
    mdpRapide: true,
    maintenant: () => horloge,
    ouvrirBoite: fournisseur.ouvrirBoite,
    detecter: async (email) => ({ fournisseur: "autre", nom: "Exemple", methode: "mot-de-passe", imap: { host: "imap.example.org", port: 993, security: "ssl" }, smtp: { host: "smtp.example.org", port: 587, security: "starttls" }, identifiant: email }),
    apns: { envoyer: async (jeton, corps) => apnsRecus.push({ jeton, corps }) },
  });
  await new Promise((r) => srv.serveur.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.serveur.address().port}`;
  appel = clientHttp(base);
});
after(async () => {
  await srv.fermer();
  fs.rmSync(dossier, { recursive: true, force: true });
});
const apnsRecus = [];

async function nouveauCompte(email, genre = "ordinateur") {
  const r1 = await appel("POST", "/v1/inscription", { email });
  assert.equal(r1.statut, 200);
  const r2 = await appel("POST", "/v1/inscription/finir", { email, code: r1.donnees.code, motDePasse: "un-mot-de-passe-solide", appareil: { nom: "Essai", genre } });
  assert.equal(r2.statut, 200, JSON.stringify(r2.donnees));
  return r2.donnees;
}

/** Tout le contenu du dossier du serveur (base, journal WAL...), en octets. */
function toutLeDisque() {
  return fs
    .readdirSync(dossier)
    .map((f) => fs.readFileSync(path.join(dossier, f)))
    .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
}

let A, A2, B;

test("inscription par code, connexion par mot de passe, refus d'un mauvais mot de passe", async () => {
  A = await nouveauCompte("alice@example.org");
  assert.ok(A.jeton);
  assert.equal(A.abonnement.etat, "essai");
  assert.equal(A.abonnement.joursEssai, 14);
  const mauvais = await appel("POST", "/v1/connexion", { email: "alice@example.org", motDePasse: "faux-mot-de-passe" });
  assert.equal(mauvais.statut, 401);
  const inconnu = await appel("POST", "/v1/connexion", { email: "personne@example.org", motDePasse: "faux-mot-de-passe" });
  assert.equal(inconnu.statut, 401);
  assert.equal(inconnu.donnees.message, mauvais.donnees.message, "meme reponse : on ne revele pas quelles adresses ont un compte");
  const bon = await appel("POST", "/v1/connexion", { email: "alice@example.org", motDePasse: "un-mot-de-passe-solide", appareil: { nom: "iPhone", genre: "iphone" } });
  assert.equal(bon.statut, 200);
  A2 = bon.donnees;
  const compte = await appel("GET", "/v1/compte", undefined, A.jeton);
  assert.equal(compte.donnees.appareils.length, 2);
  B = await nouveauCompte("bob@example.org");
});

test("ajout d'une boite : essai avant d'enregistrer, aucun mot de passe rendu ni lisible sur le disque", async () => {
  fournisseur.boite("alice@example.org", "mdp-boite-tres-secret");
  const refus = await appel("POST", "/v1/boites", { email: "alice@example.org", motDePasse: "pas-le-bon" }, A.jeton);
  assert.equal(refus.statut, 400);
  assert.match(refus.donnees.message, /refuses/);
  assert.equal((await appel("GET", "/v1/reglages", undefined, A.jeton)).donnees.reglages.boites.length, 0, "rien d'enregistre apres un refus");

  const ok = await appel("POST", "/v1/boites", { email: "alice@example.org", motDePasse: "mdp-boite-tres-secret" }, A.jeton);
  assert.equal(ok.statut, 200, JSON.stringify(ok.donnees));
  assert.equal(ok.donnees.boite.email, "alice@example.org");
  assert.equal(ok.donnees.boite.imap.password, undefined);
  const r = await appel("GET", "/v1/reglages", undefined, A2.jeton);
  assert.equal(r.donnees.reglages.boites.length, 1);
  assert.ok(!JSON.stringify(r.donnees).includes("mdp-boite-tres-secret"));

  await appel("PUT", "/v1/reglages", { version: r.donnees.version, utilisateur: { openrouter_api_key: "sk-or-cle-tres-secrete", theme: "dark" } }, A.jeton);
  const disque = toutLeDisque();
  for (const s of ["mdp-boite-tres-secret", "sk-or-cle-tres-secrete", "alice@example.org\",\"label"]) {
    assert.equal(disque.includes(Buffer.from(s)), false, `${s} ne doit pas etre lisible sur le disque`);
  }
  // L'iPhone ne peut pas reprendre les identifiants ; l'ordinateur oui (version gratuite).
  assert.equal((await appel("GET", "/v1/reglages?identifiants=1", undefined, A2.jeton)).statut, 403);
  const id = await appel("GET", "/v1/reglages?identifiants=1", undefined, A.jeton);
  assert.equal(id.donnees.reglages.boites[0].imap.password, "mdp-boite-tres-secret");
});

test("AUCUN mail garde : N mails releves et transmis, puis fouille de la base et du disque", async () => {
  const N = 12;
  for (let i = 0; i < N; i++) {
    await fournisseur.deposer(
      "alice@example.org",
      "INBOX",
      await mailBrut({ sujet: `Sujet-unique-${i}`, texte: `Corps-tres-prive-${i}`, piece: i === 0 ? { nom: "facture-secrete.pdf", contenu: "contenu-de-piece-jointe" } : null })
    );
  }
  const boite = (await appel("GET", "/v1/reglages", undefined, A.jeton)).donnees.reglages.boites[0];
  const s1 = await appel("POST", "/v1/synchro", { boite: boite.id, dossiers: {} }, A.jeton);
  assert.equal(s1.statut, 200, JSON.stringify(s1.donnees));
  const inbox = s1.donnees.resultats.INBOX;
  assert.equal(inbox.mails.length, N);
  assert.equal(inbox.mails[0].subject, "Sujet-unique-0");
  assert.match(inbox.mails[0].text_body, /Corps-tres-prive-0/);
  assert.equal(inbox.mails[0].pieces[0].filename, "facture-secrete.pdf");
  assert.equal(inbox.mails[0].pieces[0].contenu, undefined, "la piece jointe ne voyage pas avec le mail");
  // Meme mail = meme identifiant sur deux appareils.
  const s2 = await appel("POST", "/v1/synchro", { boite: boite.id, dossiers: {} }, A2.jeton);
  assert.equal(s2.donnees.resultats.INBOX.mails[3].id, inbox.mails[3].id);
  // Piece jointe lue a la demande.
  const p = await appel("GET", `/v1/pieces?boite=${boite.id}&dossier=INBOX&uid=${inbox.mails[0].uid}&index=0`, undefined, A.jeton);
  assert.equal(p.statut, 200);
  assert.equal(p.donnees.toString(), "contenu-de-piece-jointe");
  // Increment : rien de neuf, puis un mail de plus.
  const curseur = { v: inbox.v, u: inbox.u, min: inbox.min };
  const s3 = await appel("POST", "/v1/synchro", { boite: boite.id, dossiers: { INBOX: curseur } }, A.jeton);
  assert.equal(s3.donnees.resultats.INBOX.mails.length, 0);
  assert.equal(s3.donnees.resultats.INBOX.presents.length, N);

  const disque = toutLeDisque();
  for (let i = 0; i < N; i++) {
    assert.equal(disque.includes(Buffer.from(`Sujet-unique-${i}`)), false, "aucun sujet sur le disque");
    assert.equal(disque.includes(Buffer.from(`Corps-tres-prive-${i}`)), false, "aucun corps sur le disque");
  }
  assert.equal(disque.includes(Buffer.from("facture-secrete")), false, "aucun nom de piece jointe");
  assert.equal(disque.includes(Buffer.from("contenu-de-piece-jointe")), false, "aucun contenu de piece jointe");
  assert.equal(disque.includes(Buffer.from("alice@example.com")), false, "aucun correspondant");
  // Et aucun fichier ecrit a cote de la base.
  assert.deepEqual(fs.readdirSync(dossier).filter((f) => !/^cloud\.db(-wal|-shm)?$/.test(f)), []);
});

test("gestes (lu, deplacer) appliques chez le fournisseur et annonces aux autres appareils ; envoi", async () => {
  const boite = (await appel("GET", "/v1/reglages", undefined, A.jeton)).donnees.reglages.boites[0];
  const ws = new WebSocket(`${base.replace("http", "ws")}/v1/flux?jeton=${A2.jeton}`);
  const recus = [];
  ws.on("message", (m) => recus.push(JSON.parse(String(m))));
  await new Promise((r) => ws.on("open", r));
  const r = await appel("POST", "/v1/actions", { actions: [{ id: 1, type: "drapeaux", boite: boite.id, dossier: "INBOX", uid: 2, lu: true }, { id: 2, type: "deplacer", boite: boite.id, dossier: "INBOX", uid: 3, vers: "Trash" }] }, A.jeton);
  assert.ok(r.donnees.resultats.every((x) => x.ok), JSON.stringify(r.donnees));
  const fb = fournisseur.boites.get("alice@example.org");
  assert.ok(fb.dossiers.INBOX.mails.find((m) => m.uid === 2).flags.has("\\Seen"));
  assert.equal(fb.dossiers.Trash.mails.length, 1);
  const env = await appel("POST", "/v1/envoyer", { boite: boite.id, mail: { to: ["carole@example.com"], subject: "Bonjour", text: "Envoye du web" } }, A2.jeton);
  assert.equal(env.statut, 200, JSON.stringify(env.donnees));
  assert.equal(fournisseur.envoyes.length, 1);
  assert.equal(fb.dossiers.Sent.mails.length, 1, "copie posee dans Envoyes");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(recus.some((m) => m.t === "bonjour"));
  assert.ok(recus.some((m) => m.t === "changement" && m.dossier === "Trash"), JSON.stringify(recus));
  // Nouveau mail : annonce en direct + notification iPhone (expediteur + sujet).
  await appel("PUT", "/v1/appareils/moi", { apns: "a1b2c3d4" }, A2.jeton);
  await fournisseur.deposer("alice@example.org", "INBOX", await mailBrut({ sujet: "Direct", texte: "x" }));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(recus.some((m) => m.t === "changement" && m.dossier === "INBOX"));
  assert.equal(apnsRecus.at(-1).jeton, "a1b2c3d4");
  assert.equal(apnsRecus.at(-1).corps.aps.alert.title, "Alice");
  ws.close();
});

test("isolation entre deux abonnes : le jeton de B n'atteint jamais le compte de A", async () => {
  const boiteA = (await appel("GET", "/v1/reglages", undefined, A.jeton)).donnees.reglages.boites[0];
  assert.equal((await appel("POST", "/v1/synchro", { boite: boiteA.id }, B.jeton)).statut, 404);
  assert.equal((await appel("POST", "/v1/historique", { boite: boiteA.id, dossier: "INBOX", avant: 99 }, B.jeton)).statut, 404);
  assert.equal((await appel("GET", `/v1/pieces?boite=${boiteA.id}&dossier=INBOX&uid=1&index=0`, undefined, B.jeton)).statut, 404);
  assert.equal((await appel("POST", "/v1/envoyer", { boite: boiteA.id, mail: { to: ["x@example.com"] } }, B.jeton)).statut, 404);
  assert.equal((await appel("POST", "/v1/actions", { actions: [{ type: "supprimer", boite: boiteA.id, dossier: "INBOX", uid: 1 }] }, B.jeton)).donnees.resultats[0].ok, false);
  assert.equal((await appel("DELETE", `/v1/boites/${boiteA.id}`, undefined, B.jeton)).statut, 404);
  assert.equal((await appel("DELETE", `/v1/appareils/${A2.appareilId}`, undefined, B.jeton)).donnees.ok, false);
  assert.equal((await appel("GET", "/v1/reglages", undefined, B.jeton)).donnees.reglages.boites.length, 0);
  assert.equal((await appel("GET", "/v1/reglages", undefined, B.jeton)).donnees.reglages.utilisateur.openrouter_api_key, undefined);
  const t = await appel("POST", "/v1/transit", { entrees: [{ col: "labels", id: "x" }], pour: A2.appareilId }, B.jeton);
  assert.equal(t.donnees.acceptees, 0, "B ne peut rien deposer pour un appareil de A");
  assert.equal((await appel("GET", "/v1/synchro", undefined, "jeton-invente")).statut, 404);
  assert.equal((await appel("GET", "/v1/compte", undefined, "jeton-invente")).statut, 401);
});

test("file de transit : livree, effacee a la reception, 30 jours au plus", async () => {
  const r = await appel("POST", "/v1/transit", { entrees: [{ col: "labels", action: "maj", fiche: { id: "abc", name: "Etiquette-privee" } }] }, A.jeton);
  assert.equal(r.donnees.acceptees, 1);
  assert.equal(toutLeDisque().includes(Buffer.from("Etiquette-privee")), false, "chiffree au repos");
  const l = await appel("GET", "/v1/transit", undefined, A2.jeton);
  assert.equal(l.donnees.entrees[0].donnees.fiche.name, "Etiquette-privee");
  await appel("POST", "/v1/transit/accuse", { ids: [l.donnees.entrees[0].id] }, A2.jeton);
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM transit").get().n, 0);
  await appel("POST", "/v1/transit", { entrees: [{ col: "labels", id: "vieux" }] }, A.jeton);
  horloge += 31 * JOUR;
  await srv.entretien();
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM transit").get().n, 0);
  horloge -= 31 * JOUR;
});

test("fin d'essai sans carte : pause, ordinateur en version gratuite, rappel a J+23, reglages effaces a J+30", async () => {
  const C = await nouveauCompte("carole@example.org");
  fournisseur.boite("carole@example.org", "mdp-carole");
  await appel("POST", "/v1/boites", { email: "carole@example.org", motDePasse: "mdp-carole" }, C.jeton);
  const boite = (await appel("GET", "/v1/reglages", undefined, C.jeton)).donnees.reglages.boites[0];
  const depart = horloge;
  horloge = depart + 12 * JOUR;
  await srv.entretien();
  assert.ok(srv.courriels.some((c) => c.email === "carole@example.org" && /se termine bientot/.test(c.sujet)), "rappel 3 jours avant");
  horloge = depart + 15 * JOUR;
  await srv.entretien();
  const ab = (await appel("GET", "/v1/abonnement", undefined, C.jeton)).donnees;
  assert.equal(ab.etat, "arrete");
  const bloque = await appel("POST", "/v1/synchro", { boite: boite.id }, C.jeton);
  assert.equal(bloque.statut, 402);
  assert.equal(bloque.donnees.erreur, "abonnement");
  // L'ordinateur reprend ses identifiants pour continuer en version gratuite.
  const id = await appel("GET", "/v1/reglages?identifiants=1", undefined, C.jeton);
  assert.equal(id.donnees.reglages.boites[0].imap.password, "mdp-carole");
  horloge = depart + 15 * JOUR + 24 * JOUR;
  await srv.entretien();
  assert.ok(srv.courriels.some((c) => c.email === "carole@example.org" && /effaces dans 7 jours/.test(c.sujet)));
  assert.equal(srv.lireReglages(Object.values(srv.db.prepare("SELECT id FROM comptes WHERE email='carole@example.org'").get())[0]).r.boites.length, 1);
  horloge = depart + 15 * JOUR + 31 * JOUR;
  await srv.entretien();
  const apres = await appel("GET", "/v1/reglages", undefined, C.jeton);
  assert.equal(apres.donnees.reglages.boites.length, 0, "reglages effaces a J+30");
  horloge = depart;
});

test("suppression du compte : tout part (appareils, sessions, reglages, transit)", async () => {
  const D = await nouveauCompte("denis@example.org");
  const mauvais = await appel("DELETE", "/v1/compte", { confirmation: "autre@example.org" }, D.jeton);
  assert.equal(mauvais.statut, 400);
  const ok = await appel("DELETE", "/v1/compte", { confirmation: "denis@example.org" }, D.jeton);
  assert.equal(ok.statut, 200);
  assert.equal((await appel("GET", "/v1/compte", undefined, D.jeton)).statut, 401);
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM comptes WHERE email='denis@example.org'").get().n, 0);
});

test("mot de passe oublie : code par courriel, nouvelles sessions seulement", async () => {
  const r = await appel("POST", "/v1/mot-de-passe/oubli", { email: "bob@example.org" });
  const n = await appel("POST", "/v1/mot-de-passe/nouveau", { email: "bob@example.org", code: r.donnees.code, motDePasse: "nouveau-mot-de-passe" });
  assert.equal(n.statut, 200);
  assert.equal((await appel("GET", "/v1/compte", undefined, B.jeton)).statut, 401, "les anciennes sessions tombent");
  assert.equal((await appel("POST", "/v1/connexion", { email: "bob@example.org", motDePasse: "nouveau-mot-de-passe" })).statut, 200);
});

test("Stripe (mode test, simule) : essai sans carte qui se met en pause, paiement, resiliation", async () => {
  const dossierS = fs.mkdtempSync(path.join(os.tmpdir(), "imiel-stripe-"));
  const s = await creerServeur({
    base: path.join(dossierS, "s.db"),
    essai: true,
    journaliser: false,
    veille: false,
    mdpRapide: true,
    fetch: faux.fetcher,
    stripe: { cle: "sk_test_essai", prix: "price_essai", secretWebhook: "whsec_essai", appUrl: "https://app.example.com" },
    ouvrirBoite: fournisseur.ouvrirBoite,
  });
  await new Promise((r) => s.serveur.listen(0, "127.0.0.1", r));
  const ap = clientHttp(`http://127.0.0.1:${s.serveur.address().port}`);
  try {
    const r1 = await ap("POST", "/v1/inscription", { email: "eve@example.org" });
    const r2 = await ap("POST", "/v1/inscription/finir", { email: "eve@example.org", code: r1.donnees.code, motDePasse: "mot-de-passe-eve", appareil: { genre: "web" } });
    assert.equal(r2.donnees.abonnement.etat, "essai");
    const creation = faux.appels.find((a) => a.chemin === "/v1/subscriptions" && a.methode === "POST");
    assert.equal(creation.corps.trial_period_days, "14");
    assert.equal(creation.corps["trial_settings[end_behavior][missing_payment_method]"], "pause");
    assert.equal(creation.corps["default_payment_method"], undefined, "aucune carte demandee");
    const [sub] = [...faux.abonnements.values()];

    const webhook = async (ev, sig) => {
      const brut = JSON.stringify(ev);
      return ap("POST", "/v1/stripe/webhook", brut, null, { "Stripe-Signature": sig ?? signer(brut, "whsec_essai"), "Content-Type": "application/json" });
    };
    assert.equal((await webhook({ id: "evt_0", type: "invoice.paid", data: { object: { customer: sub.customer } } }, "t=1,v1=00")).statut, 400, "signature fausse refusee");

    await webhook({ id: "evt_1", type: "customer.subscription.trial_will_end", data: { object: { ...sub } } });
    assert.ok(s.courriels.some((c) => /se termine bientot/.test(c.sujet)));
    sub.status = "paused"; // fin de l'essai sans carte, cote Stripe
    await webhook({ id: "evt_2", type: "customer.subscription.paused", data: { object: { ...sub } } });
    assert.equal((await ap("GET", "/v1/abonnement", undefined, r2.donnees.jeton)).donnees.etat, "arrete");

    const pay = await ap("POST", "/v1/abonnement/payer", {}, r2.donnees.jeton);
    assert.equal(pay.donnees.url, "https://checkout.stripe.test/cs_1");
    assert.equal(faux.appels.find((a) => a.chemin === "/v1/checkout/sessions").corps.mode, "setup");
    await webhook({ id: "evt_3", type: "checkout.session.completed", data: { object: { mode: "setup", setup_intent: "seti_1", customer: sub.customer, metadata: { compte: sub.metadata.compte } } } });
    assert.equal(sub.status, "active", "carte posee, abonnement repris");
    assert.equal((await ap("GET", "/v1/abonnement", undefined, r2.donnees.jeton)).donnees.etat, "actif");
    const deja = await webhook({ id: "evt_3", type: "checkout.session.completed", data: { object: {} } });
    assert.equal(deja.donnees.deja, true, "un evenement rejoue n'est applique qu'une fois");

    await webhook({ id: "evt_4", type: "invoice.payment_failed", data: { object: { customer: sub.customer } } });
    assert.equal((await ap("GET", "/v1/abonnement", undefined, r2.donnees.jeton)).donnees.retard, true);
    await webhook({ id: "evt_5", type: "customer.subscription.deleted", data: { object: { ...sub, status: "canceled" } } });
    assert.equal((await ap("GET", "/v1/abonnement", undefined, r2.donnees.jeton)).donnees.etat, "arrete");
    assert.equal((await ap("POST", "/v1/abonnement/portail", {}, r2.donnees.jeton)).donnees.url, "https://billing.stripe.test/p_1");
  } finally {
    await s.fermer();
    fs.rmSync(dossierS, { recursive: true, force: true });
  }
});

test("mises a jour : manifeste servi seulement s'il est plus recent", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "imiel-maj-"));
  fs.writeFileSync(path.join(d, "linux-x86_64.json"), JSON.stringify({ version: "1.4.0", platforms: {} }));
  const s = await creerServeur({ base: ":memory:", essai: true, journaliser: false, veille: false, misesAJour: d });
  await new Promise((r) => s.serveur.listen(0, "127.0.0.1", r));
  const ap = clientHttp(`http://127.0.0.1:${s.serveur.address().port}`);
  assert.equal((await ap("GET", "/v1/mises-a-jour/linux/x86_64/1.3.9")).donnees.version, "1.4.0");
  assert.equal((await ap("GET", "/v1/mises-a-jour/linux/x86_64/1.4.0")).statut, 204);
  await s.fermer();
  fs.rmSync(d, { recursive: true, force: true });
});

test("le serveur refuse de demarrer sans cle des reglages hors mode essai", async () => {
  await assert.rejects(() => creerServeur({ base: ":memory:", essai: false, journaliser: false, env: {} }), /NUAGE_CLE_REGLAGES/);
});
