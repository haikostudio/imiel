// Outils des essais : un FOURNISSEUR de courrier factice (en memoire), un faux
// Stripe, et un petit client HTTP.
import nodemailer from "nodemailer";
import { analyserMail, extrairePiece } from "../serveur/analyse.mjs";
import { idDossier, typeDossier } from "../commun/forme.mjs";

export async function mailBrut({ de = "Alice <alice@example.com>", a = "moi@example.org", sujet, texte, piece }) {
  const info = await new Promise((resolve, reject) =>
    nodemailer
      .createTransport({ streamTransport: true, buffer: true, newline: "windows" })
      .sendMail(
        {
          from: de,
          to: a,
          subject: sujet,
          text: texte,
          html: `<p>${texte}</p>`,
          attachments: piece ? [{ filename: piece.nom, content: Buffer.from(piece.contenu) }] : [],
        },
        (e, i) => (e ? reject(e) : resolve(i))
      )
  );
  return info.message;
}

/** Fournisseur IMAP factice partage par toutes les boites ouvertes. */
export function fournisseurFactice() {
  const boites = new Map(); // email -> { motDePasse, dossiers: { chemin: { v, suivant, mails: [{uid, source, flags}] } } }
  const veilles = new Map(); // email -> [rappel]
  const envoyes = [];
  function boite(email, motDePasse = "bon-mot-de-passe") {
    if (!boites.has(email)) {
      boites.set(email, {
        motDePasse,
        dossiers: {
          INBOX: { v: 7, suivant: 1, mails: [], specialUse: "\\Inbox" },
          Sent: { v: 7, suivant: 1, mails: [], specialUse: "\\Sent" },
          Trash: { v: 7, suivant: 1, mails: [], specialUse: "\\Trash" },
        },
      });
    }
    return boites.get(email);
  }
  async function deposer(email, chemin, source, flags = []) {
    const d = boite(email).dossiers[chemin];
    const uid = d.suivant++;
    d.mails.push({ uid, source, flags: new Set(flags) });
    if (chemin === "INBOX") for (const r of veilles.get(email) || []) r({ uid, de: "Alice", sujet: "nouveau" });
    return uid;
  }

  function ouvrirBoite(b) {
    const fb = () => {
      const x = boites.get(b.email);
      if (!x || x.motDePasse !== (b.imap?.password || "")) throw new Error("AUTHENTICATIONFAILED");
      return x;
    };
    return {
      boite: b,
      async essayer() {
        try {
          fb();
        } catch {
          throw new Error("Adresse ou mot de passe refuses par le fournisseur.");
        }
        return { ok: true };
      },
      async fermer() {},
      async dossiers() {
        return Object.entries(fb().dossiers).map(([path, d]) => {
          const type = typeDossier({ path, name: path, specialUse: d.specialUse });
          return { id: idDossier(b.id, path), path, name: path, delimiter: "/", type, sort_order: 0 };
        });
      },
      async synchroDossier(chemin, curseur) {
        const d = fb().dossiers[chemin];
        const lire = (ms) => Promise.all(ms.map((m) => analyserMail(m.source, { boite: b.id, chemin, uidValidity: d.v, uid: m.uid, drapeaux: m.flags })));
        const remise = !curseur || Number(curseur.v) !== d.v;
        if (remise) {
          const pris = d.mails.slice(-150);
          return { v: d.v, remise, mails: await lire(pris), presents: [], drapeaux: [], min: pris[0]?.uid || 0, u: pris.at(-1)?.uid || 0, reste: false };
        }
        const nouveaux = d.mails.filter((m) => m.uid > curseur.u);
        const presents = d.mails.filter((m) => m.uid >= curseur.min && m.uid <= curseur.u);
        return {
          v: d.v,
          remise: false,
          mails: await lire(nouveaux),
          presents: presents.map((m) => m.uid),
          jusqua: curseur.u,
          drapeaux: presents.map((m) => ({ uid: m.uid, lu: m.flags.has("\\Seen"), favori: m.flags.has("\\Flagged"), repondu: false })),
          min: curseur.min,
          u: nouveaux.at(-1)?.uid || curseur.u,
          reste: false,
        };
      },
      async historique(chemin, avant, n) {
        const d = fb().dossiers[chemin];
        const ms = d.mails.filter((m) => m.uid < avant).slice(-n);
        return { v: d.v, mails: await Promise.all(ms.map((m) => analyserMail(m.source, { boite: b.id, chemin, uidValidity: d.v, uid: m.uid, drapeaux: m.flags }))), fini: true };
      },
      async piece(chemin, uid, index) {
        const m = fb().dossiers[chemin].mails.find((x) => x.uid === uid);
        return m ? extrairePiece(m.source, index) : null;
      },
      async drapeaux(chemin, uid, { lu, favori }) {
        const m = fb().dossiers[chemin].mails.find((x) => x.uid === uid);
        if (lu !== undefined) lu ? m.flags.add("\\Seen") : m.flags.delete("\\Seen");
        if (favori !== undefined) favori ? m.flags.add("\\Flagged") : m.flags.delete("\\Flagged");
        return { ok: true };
      },
      async deplacer(chemin, uid, vers) {
        const x = fb();
        const i = x.dossiers[chemin].mails.findIndex((m) => m.uid === uid);
        const [m] = x.dossiers[chemin].mails.splice(i, 1);
        const nouvelUid = x.dossiers[vers].suivant++;
        x.dossiers[vers].mails.push({ ...m, uid: nouvelUid });
        return { ok: true, nouvelUid };
      },
      async supprimer(chemin, uid) {
        const d = fb().dossiers[chemin];
        d.mails = d.mails.filter((m) => m.uid !== uid);
        return { ok: true };
      },
      async envoyer(mail, cheminEnvoyes) {
        fb();
        envoyes.push({ de: b.email, mail });
        if (cheminEnvoyes) await deposer(b.email, cheminEnvoyes, await mailBrut({ de: b.email, a: String(mail.to), sujet: mail.subject, texte: mail.text || "" }), ["\\Seen"]);
        return { ok: true, messageId: "<essai@example.org>" };
      },
      surveiller(rappel) {
        if (!veilles.has(b.email)) veilles.set(b.email, []);
        veilles.get(b.email).push(rappel);
        return { arreter() {} };
      },
    };
  }
  return { boite, deposer, ouvrirBoite, envoyes, boites };
}

/** Faux Stripe : enregistre les appels, rend des objets plausibles. */
export function stripeFactice() {
  const appels = [];
  const abonnements = new Map();
  let n = 0;
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    const corps = Object.fromEntries(new URLSearchParams(init.body || ""));
    appels.push({ methode: init.method || "GET", chemin: u.pathname, corps });
    const rep = (o) => ({ ok: true, status: 200, json: async () => o });
    const p = u.pathname;
    if (p === "/v1/customers" && init.method === "POST") return rep({ id: `cus_${++n}` });
    if (p.startsWith("/v1/customers/")) return rep({ id: p.split("/")[3] });
    if (p === "/v1/subscriptions" && init.method === "POST") {
      const s = {
        id: `sub_${++n}`,
        customer: corps.customer,
        status: corps.trial_period_days ? "trialing" : "active",
        trial_end: corps.trial_period_days ? Math.floor(Date.now() / 1000) + 14 * 86400 : null,
        metadata: { compte: corps["metadata[compte]"] },
      };
      abonnements.set(s.id, s);
      return rep(s);
    }
    const m = p.match(/^\/v1\/subscriptions\/([^/]+)(\/resume)?$/);
    if (m) {
      const s = abonnements.get(m[1]);
      if (init.method === "DELETE") s.status = "canceled";
      else if (m[2]) s.status = "active";
      else if (init.method === "POST" && corps.default_payment_method) s.default_payment_method = corps.default_payment_method;
      return rep(s);
    }
    if (p.startsWith("/v1/setup_intents/")) return rep({ id: p.split("/")[3], payment_method: "pm_carte" });
    if (p.startsWith("/v1/invoices/")) return rep({ id: p.split("/")[3], status: "paid" });
    if (p === "/v1/checkout/sessions") return rep({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" });
    if (p === "/v1/billing_portal/sessions") return rep({ url: "https://billing.stripe.test/p_1" });
    return { ok: false, status: 404, json: async () => ({ error: { message: "inconnu " + p } }) };
  };
  return { fetcher, appels, abonnements };
}

export function clientHttp(base) {
  return async function appel(methode, chemin, corps, jeton, entetes = {}) {
    const r = await fetch(base + chemin, {
      method: methode,
      headers: {
        ...(corps !== undefined && typeof corps !== "string" ? { "Content-Type": "application/json" } : {}),
        ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
        ...entetes,
      },
      body: corps === undefined ? undefined : typeof corps === "string" ? corps : JSON.stringify(corps),
    });
    const type = r.headers.get("content-type") || "";
    const donnees = type.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { statut: r.status, donnees, entetes: r.headers };
  };
}
