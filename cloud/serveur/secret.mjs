// Secrets du serveur de transfert :
//   - mots de passe des comptes iMiel : Argon2id (libsodium crypto_pwhash_str) ;
//   - reglages et file de transit : chiffres AU REPOS avec la cle du serveur
//     (libsodium secretbox, XSalsa20-Poly1305). Le pont doit pouvoir lire les
//     identifiants des boites pour les relever : ce n'est PAS du chiffrement de
//     bout en bout, c'est une protection du disque et des sauvegardes.
// La cle vient de NUAGE_CLE_REGLAGES (64 caracteres hexadecimaux), jamais du
// depot. En mode essai seulement, une cle de passage est tiree au hasard.
import sodiumPkg from "libsodium-wrappers-sumo";

const sodium = sodiumPkg;
export const pret = sodium.ready;

export function cleDepuisHex(hex) {
  const h = String(hex || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(h)) return null;
  return Buffer.from(h, "hex");
}

export function cleAuHasard() {
  return Buffer.from(sodium.randombytes_buf(32));
}

/** Chiffre un objet JSON avec la cle du serveur : nonce (24) || boite. */
export function sceller(cle, objet) {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const clair = Buffer.from(JSON.stringify(objet), "utf8");
  const boite = sodium.crypto_secretbox_easy(clair, nonce, cle);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(boite)]);
}

export function ouvrir(cle, bloc) {
  const b = Buffer.from(bloc);
  const n = sodium.crypto_secretbox_NONCEBYTES;
  if (b.length <= n) throw new Error("bloc illisible");
  const clair = sodium.crypto_secretbox_open_easy(b.subarray(n), b.subarray(0, n), cle);
  return JSON.parse(Buffer.from(clair).toString("utf8"));
}

/** Empreinte Argon2id d'un mot de passe (sel et reglages inclus). */
export function hacherMotDePasse(mdp, { rapide = false } = {}) {
  return sodium.crypto_pwhash_str(
    String(mdp),
    rapide ? sodium.crypto_pwhash_OPSLIMIT_MIN : sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    rapide ? sodium.crypto_pwhash_MEMLIMIT_MIN : sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
  );
}

export function verifierMotDePasse(empreinte, mdp) {
  try {
    return sodium.crypto_pwhash_str_verify(String(empreinte), String(mdp));
  } catch {
    return false;
  }
}
