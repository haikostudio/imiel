// Pont IMAP/SMTP du serveur de transfert : se connecte a la boite d'un abonne
// AU MOMENT ou un appareil en a besoin, lit chez le fournisseur, transmet,
// puis oublie. Rien n'est ecrit sur le disque : ni mail, ni piece jointe.
//
// Deux connexions au plus par boite :
//   - la connexion de TRAVAIL (synchro, historique, pieces jointes, gestes),
//     ouverte a la demande et fermee apres 90 s sans usage ;
//   - la connexion de VEILLE (IDLE sur la boite de reception), tenue tant que
//     le compte est en essai ou abonne : elle annonce un nouveau mail aux
//     appareils (et a l'iPhone par APNs) sans rien garder.
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { analyserMail, extrairePiece } from "./analyse.mjs";
import { idDossier, typeDossier, ORDRE_DOSSIERS } from "../commun/forme.mjs";

const SOURCE_MAX = 20 * 1024 * 1024; // au-dela, le mail arrive sans ses dernieres parties
const PREMIERS = { inbox: 150, sent: 60, autres: 30 };
const MAX_PAR_APPEL = 200;
const DRAPEAUX_RECENTS = 800;
const INACTIVITE_MS = 90_000;

function configImap(boite, accessToken) {
  const i = boite.imap || {};
  return {
    host: i.host,
    port: Number(i.port || 993),
    secure: (i.security || "ssl") === "ssl",
    doSTARTTLS: i.security === "starttls" ? true : undefined,
    auth: accessToken ? { user: i.username || boite.email, accessToken } : { user: i.username || boite.email, pass: i.password || "" },
    logger: false,
    emitLogs: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 5 * 60_000,
  };
}

function configSmtp(boite, accessToken) {
  const s = boite.smtp || {};
  const port = Number(s.port || 587);
  return {
    host: s.host,
    port,
    secure: (s.security || "starttls") === "ssl",
    requireTLS: s.security === "starttls",
    auth: accessToken
      ? { type: "OAuth2", user: s.username || boite.email, accessToken }
      : { user: s.username || boite.email, pass: s.password || "" },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  };
}

/** Message d'erreur lisible (jamais d'identifiant dedans). */
export function erreurLisible(e) {
  const m = String(e?.responseText || e?.response || e?.message || e || "");
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|535|LOGIN failed|Username and Password not accepted/i.test(m))
    return "Adresse ou mot de passe refuses par le fournisseur.";
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return "Serveur de la boite introuvable.";
  if (/ETIMEDOUT|timeout/i.test(m)) return "Le serveur de la boite ne repond pas.";
  if (/ECONNREFUSED/i.test(m)) return "Le serveur de la boite refuse la connexion.";
  if (/certificate|self signed|SSL|TLS/i.test(m)) return "Connexion securisee impossible avec le serveur de la boite.";
  return "La boite n'a pas pu etre jointe.";
}

export class BoiteImap {
  /**
   * @param {object} boite reglages de la boite (adresse, imap, smtp, auth)
   * @param {{ jetonAcces?: (boite) => Promise<string>, compte: string }} deps
   */
  constructor(boite, deps) {
    this.boite = boite;
    this.deps = deps;
    this.client = null;
    this.file = Promise.resolve();
    this.minuteur = null;
    this.veille = null;
  }

  async jeton() {
    return this.boite.auth === "oauth2" && this.deps.jetonAcces ? this.deps.jetonAcces(this.boite) : "";
  }

  async connecter() {
    if (this.client?.usable) return this.client;
    const c = new ImapFlow(configImap(this.boite, await this.jeton()));
    c.on("error", () => {});
    await c.connect();
    this.client = c;
    return c;
  }

  /** Gestes serialises sur la connexion de travail. */
  avec(fn) {
    const suite = this.file.then(async () => {
      clearTimeout(this.minuteur);
      try {
        const c = await this.connecter();
        return await fn(c);
      } finally {
        this.minuteur = setTimeout(() => this.fermerTravail(), INACTIVITE_MS);
        this.minuteur.unref?.();
      }
    });
    this.file = suite.catch(() => {});
    return suite;
  }

  async fermerTravail() {
    const c = this.client;
    this.client = null;
    if (c) await c.logout().catch(() => c.close());
  }

  async fermer() {
    clearTimeout(this.minuteur);
    this.veille?.arreter();
    this.veille = null;
    await this.fermerTravail();
  }

  async dossiers() {
    return this.avec(async (c) => {
      const liste = await c.list();
      return liste
        .filter((d) => !(d.flags && (d.flags.has("\\Noselect") || d.flags.has("\\NonExistent"))))
        .map((d) => {
          const type = typeDossier(d);
          return {
            id: idDossier(this.boite.id, d.path),
            path: d.path,
            name: type === "inbox" ? "Inbox" : d.name,
            delimiter: d.delimiter || "/",
            type,
            sort_order: ORDRE_DOSSIERS[type] ?? 10,
          };
        })
        .sort((a, b) => a.sort_order - b.sort_order || a.path.localeCompare(b.path));
    });
  }

  async lireMails(c, chemin, uidValidity, uids) {
    const mails = [];
    if (!uids.length) return mails;
    for await (const m of c.fetch(uids.join(","), { uid: true, flags: true, source: { maxLength: SOURCE_MAX } }, { uid: true })) {
      if (!m.source) continue;
      mails.push(
        await analyserMail(m.source, { boite: this.boite.id, chemin, uidValidity, uid: m.uid, drapeaux: m.flags || [] }).catch(() => null)
      );
    }
    return mails.filter(Boolean).sort((a, b) => a.uid - b.uid);
  }

  /**
   * Ce qui a change dans un dossier depuis le curseur de l'appareil
   * ({ v: UIDVALIDITY, u: plus grand UID recu, min: plus petit UID recu }).
   */
  async synchroDossier(chemin, curseur, { type = "custom" } = {}) {
    return this.avec(async (c) => {
      const verrou = await c.getMailboxLock(chemin, { readOnly: true });
      try {
        // Connexion deja ouverte : le dossier choisi garde la vue du moment ou
        // il a ete ouvert ; NOOP fait remonter les mails arrives depuis.
        await c.noop();
        const mb = c.mailbox;
        const v = Number(mb.uidValidity);
        const remise = !curseur || Number(curseur.v) !== v;
        if (!mb.exists) return { v, remise, mails: [], presents: [], drapeaux: [], min: 0, u: 0, reste: false, plusAncien: false };
        if (remise) {
          const tous = (await c.search({ all: true }, { uid: true })) || [];
          tous.sort((a, b) => a - b);
          const n = PREMIERS[type] ?? PREMIERS.autres;
          const pris = tous.slice(-n);
          const mails = await this.lireMails(c, chemin, v, pris);
          return { v, remise, mails, presents: [], drapeaux: [], min: pris[0] || 0, u: pris.at(-1) || 0, reste: false, plusAncien: tous.length > pris.length };
        }
        const u = Number(curseur.u || 0);
        const min = Number(curseur.min || 1);
        const nouveaux = ((await c.search({ uid: `${u + 1}:*` }, { uid: true })) || []).filter((x) => x > u).sort((a, b) => a - b);
        const pris = nouveaux.slice(0, MAX_PAR_APPEL);
        const mails = await this.lireMails(c, chemin, v, pris);
        // Etat de ce que l'appareil a deja : presents (les absents ont ete
        // supprimes ou deplaces ailleurs) et drapeaux des plus recents.
        const presents = u >= min ? ((await c.search({ uid: `${min}:${u}` }, { uid: true })) || []).sort((a, b) => a - b) : [];
        const recents = presents.slice(-DRAPEAUX_RECENTS);
        const drapeaux = [];
        if (recents.length) {
          for await (const m of c.fetch(recents.join(","), { uid: true, flags: true }, { uid: true })) {
            const f = m.flags || new Set();
            drapeaux.push({ uid: m.uid, lu: f.has("\\Seen"), favori: f.has("\\Flagged"), repondu: f.has("\\Answered") });
          }
        }
        return {
          v,
          remise: false,
          mails,
          // « presents » couvre la plage DEJA connue de l'appareil [min, jusqua] :
          // un mail plus recent (dans « mails ») n'est jamais compte disparu.
          presents,
          jusqua: u,
          drapeaux,
          min,
          u: pris.length ? pris.at(-1) : u,
          reste: nouveaux.length > pris.length,
          plusAncien: false,
        };
      } finally {
        verrou.release();
      }
    });
  }

  /** Mails plus anciens que `avant` (UID), lus a la demande. */
  async historique(chemin, avant, n = 100) {
    return this.avec(async (c) => {
      const verrou = await c.getMailboxLock(chemin, { readOnly: true });
      try {
        const v = Number(c.mailbox.uidValidity);
        if (!c.mailbox.exists || Number(avant) <= 1) return { v, mails: [], fini: true };
        const uids = ((await c.search({ uid: `1:${Number(avant) - 1}` }, { uid: true })) || []).sort((a, b) => a - b);
        const pris = uids.slice(-Math.min(200, Math.max(1, Number(n) || 100)));
        const mails = await this.lireMails(c, chemin, v, pris);
        return { v, mails, fini: uids.length <= pris.length, min: pris[0] || 0 };
      } finally {
        verrou.release();
      }
    });
  }

  async piece(chemin, uid, index) {
    return this.avec(async (c) => {
      const verrou = await c.getMailboxLock(chemin, { readOnly: true });
      try {
        const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
        if (!m?.source) return null;
        return await extrairePiece(m.source, index);
      } finally {
        verrou.release();
      }
    });
  }

  async drapeaux(chemin, uid, { lu, favori, repondu }) {
    return this.avec(async (c) => {
      const verrou = await c.getMailboxLock(chemin);
      try {
        const poser = [];
        const retirer = [];
        if (lu !== undefined) (lu ? poser : retirer).push("\\Seen");
        if (favori !== undefined) (favori ? poser : retirer).push("\\Flagged");
        if (repondu !== undefined) (repondu ? poser : retirer).push("\\Answered");
        if (poser.length) await c.messageFlagsAdd(String(uid), poser, { uid: true });
        if (retirer.length) await c.messageFlagsRemove(String(uid), retirer, { uid: true });
        return { ok: true };
      } finally {
        verrou.release();
      }
    });
  }

  async deplacer(chemin, uid, vers) {
    return this.avec(async (c) => {
      const verrou = await c.getMailboxLock(chemin);
      try {
        const r = await c.messageMove(String(uid), vers, { uid: true });
        const nouvelUid = r?.uidMap?.get?.(Number(uid));
        return { ok: true, nouvelUid: nouvelUid || null };
      } finally {
        verrou.release();
      }
    });
  }

  async supprimer(chemin, uid) {
    return this.avec(async (c) => {
      const verrou = await c.getMailboxLock(chemin);
      try {
        await c.messageDelete(String(uid), { uid: true });
        return { ok: true };
      } finally {
        verrou.release();
      }
    });
  }

  async ajouter(chemin, brut, drapeaux = []) {
    return this.avec(async (c) => {
      const r = await c.append(chemin, brut, drapeaux);
      return { ok: true, uid: r?.uid || null };
    });
  }

  /** Essai de connexion (ajout d'une boite) : IMAP puis SMTP. */
  async essayer() {
    const c = new ImapFlow(configImap(this.boite, await this.jeton()));
    c.on("error", () => {});
    try {
      await c.connect();
      await c.logout();
    } catch (e) {
      throw new Error(erreurLisible(e));
    }
    const t = nodemailer.createTransport(configSmtp(this.boite, await this.jeton()));
    try {
      await t.verify();
    } catch (e) {
      throw new Error("Envoi : " + erreurLisible(e));
    } finally {
      t.close();
    }
    return { ok: true };
  }

  /**
   * Envoie un mail (SMTP du fournisseur) puis en pose une copie dans
   * « Envoyes » (sauf Gmail et Microsoft, qui la posent eux-memes).
   */
  async envoyer(mail, cheminEnvoyes) {
    const de = { name: this.boite.display_name || undefined, address: this.boite.email };
    const options = {
      from: de,
      to: mail.to,
      cc: mail.cc,
      bcc: mail.bcc,
      subject: mail.subject || "",
      text: mail.text || undefined,
      html: mail.html || undefined,
      inReplyTo: mail.inReplyTo || undefined,
      references: mail.references || undefined,
      priority: mail.priority || undefined,
      attachments: (mail.pieces || []).map((p) => ({
        filename: p.nom,
        contentType: p.type,
        content: Buffer.from(String(p.base64 || ""), "base64"),
        ...(p.cid ? { cid: p.cid } : {}),
      })),
    };
    const brut = await new Promise((resolve, reject) =>
      nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" }).sendMail(options, (e, info) =>
        e ? reject(e) : resolve(info)
      )
    );
    const t = nodemailer.createTransport(configSmtp(this.boite, await this.jeton()));
    try {
      await t.sendMail({ envelope: brut.envelope, raw: brut.message });
    } catch (e) {
      throw new Error(erreurLisible(e));
    } finally {
      t.close();
    }
    const auto = ["google", "microsoft"].includes(this.boite.oauth_provider || this.boite.fournisseur);
    if (cheminEnvoyes && !auto) await this.ajouter(cheminEnvoyes, brut.message, ["\\Seen"]).catch(() => null);
    return { ok: true, messageId: brut.messageId };
  }

  /** Veille sur la boite de reception : `rappel({ uid, de, sujet })` a chaque nouveau mail. */
  surveiller(rappel, { relancer = true } = {}) {
    if (this.veille) return this.veille;
    let arrete = false;
    let client = null;
    let essais = 0;
    let dernier = 0;
    const etat = {
      arreter: () => {
        arrete = true;
        client?.logout().catch(() => client?.close());
      },
    };
    const lancer = async () => {
      if (arrete) return;
      try {
        client = new ImapFlow({ ...configImap(this.boite, await this.jeton()), socketTimeout: 30 * 60_000 });
        client.on("error", () => {});
        await client.connect();
        await client.mailboxOpen("INBOX", { readOnly: true });
        dernier = Number(client.mailbox.uidNext || 1) - 1;
        essais = 0;
        client.on("exists", async () => {
          try {
            const nouveaux = [];
            for await (const m of client.fetch(`${dernier + 1}:*`, { uid: true, envelope: true }, { uid: true })) {
              if (m.uid > dernier) nouveaux.push(m);
            }
            for (const m of nouveaux) {
              dernier = Math.max(dernier, m.uid);
              const de = m.envelope?.from?.[0];
              rappel({ uid: m.uid, de: de?.name || de?.address || "", sujet: m.envelope?.subject || "" });
            }
          } catch {
            /* la prochaine synchro rattrapera */
          }
        });
        client.on("close", () => {
          if (!arrete && relancer) setTimeout(lancer, Math.min(300_000, 5_000 * 2 ** essais++)).unref?.();
        });
      } catch {
        if (!arrete && relancer) setTimeout(lancer, Math.min(300_000, 5_000 * 2 ** essais++)).unref?.();
      }
    };
    void lancer();
    this.veille = etat;
    return etat;
  }
}

export function ouvrirBoite(boite, deps) {
  return new BoiteImap(boite, deps);
}
