// Forme commune d'un mail transmis par le serveur aux apps, et identifiants
// STABLES : un meme mail recoit le meme identifiant sur tous les appareils
// (ordinateur, iPhone, navigateur), ce qui permet aux donnees propres a iMiel
// (etiquettes, suivis) de voyager d'un appareil a l'autre en le designant.
//
// Identifiant d'une fiche iMiel (PocketBase) : 15 caracteres [a-z0-9].
import crypto from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function idStable(...parties) {
  const h = crypto.createHash("sha256").update(parties.map(String).join("\u0000")).digest();
  let out = "";
  for (let i = 0; i < 15; i++) out += ALPHABET[h[i] % ALPHABET.length];
  return out;
}

/** Boite (compte mail) -> identifiant de fiche « accounts ». */
export const idBoite = (compte, email) => idStable("boite", compte, String(email).toLowerCase());
/** Dossier -> identifiant de fiche « folders ». */
export const idDossier = (boite, chemin) => idStable("dossier", boite, chemin);
/** Mail -> identifiant de fiche « messages » (compte + dossier + UIDVALIDITY + UID). */
export const idMail = (boite, chemin, uidValidity, uid) => idStable("mail", boite, chemin, uidValidity, uid);
/** Piece jointe -> identifiant de fiche « attachments ». */
export const idPiece = (mail, index) => idStable("piece", mail, index);

/** Type iMiel d'un dossier IMAP (inbox, sent, drafts, trash, spam, archive, custom). */
export function typeDossier(d) {
  const su = String(d.specialUse || "").toLowerCase();
  if (su === "\\inbox" || String(d.path).toUpperCase() === "INBOX") return "inbox";
  if (su === "\\sent") return "sent";
  if (su === "\\drafts") return "drafts";
  if (su === "\\trash") return "trash";
  if (su === "\\junk") return "spam";
  if (su === "\\archive" || su === "\\all") return "archive";
  const n = String(d.name || d.path).toLowerCase();
  if (/^(sent|envoy|gesendet|inviat|sent items|sent messages)/.test(n)) return "sent";
  if (/^(draft|brouillon|entw|bozz)/.test(n)) return "drafts";
  if (/^(trash|corbeille|papierkorb|cestino|deleted)/.test(n)) return "trash";
  if (/^(spam|junk|courrier ind|ind[eé]sirable)/.test(n)) return "spam";
  if (/^(archive|archiv)/.test(n)) return "archive";
  return "custom";
}

export const ORDRE_DOSSIERS = { inbox: 0, sent: 1, drafts: 2, archive: 3, spam: 4, trash: 5, custom: 10 };
