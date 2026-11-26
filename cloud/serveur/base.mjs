// Stockage du serveur de transfert : SQLite integre a Node (node:sqlite).
//
// Le serveur ne garde QUE :
//   - le compte (adresse, empreinte Argon2id du mot de passe) et son abonnement ;
//   - les appareils relies et leurs sessions (empreinte du jeton) ;
//   - les REGLAGES du compte (boites et leurs identifiants, signatures, regles,
//     etiquettes, apparence, cle d'IA...), chiffres au repos avec la cle du
//     serveur (voir secret.mjs) ;
//   - la FILE DE TRANSIT des donnees propres a iMiel (etiquettes posees, suivis,
//     notes) d'un appareil vers les autres, chiffree au repos, effacee des
//     reception et au plus tard apres 30 jours.
// AUCUN MAIL : ni sujet, ni corps, ni piece jointe, ni adresse de
// correspondant. Le courrier est lu chez le fournisseur au moment ou un
// appareil le demande, transmis, puis oublie.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export function ouvrirBase(fichier) {
  if (fichier !== ":memory:") fs.mkdirSync(path.dirname(fichier), { recursive: true });
  const db = new DatabaseSync(fichier);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS comptes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      confirme INTEGER NOT NULL DEFAULT 0,
      code_hash TEXT, code_expire INTEGER, code_essais INTEGER NOT NULL DEFAULT 0,
      mdp TEXT,
      cree INTEGER NOT NULL,
      -- abonnement : essai | actif | arrete
      abo_etat TEXT NOT NULL DEFAULT 'essai',
      essai_fin INTEGER,
      retard INTEGER NOT NULL DEFAULT 0,
      arrete_le INTEGER,
      rappel_essai INTEGER NOT NULL DEFAULT 0,
      rappel_purge INTEGER NOT NULL DEFAULT 0,
      stripe_client TEXT,
      stripe_abonnement TEXT
    );
    CREATE TABLE IF NOT EXISTS appareils (
      id TEXT PRIMARY KEY,
      compte TEXT NOT NULL REFERENCES comptes(id) ON DELETE CASCADE,
      nom TEXT, genre TEXT, jeton_apns TEXT,
      cree INTEGER NOT NULL, vu INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      jeton_hash TEXT PRIMARY KEY,
      compte TEXT NOT NULL REFERENCES comptes(id) ON DELETE CASCADE,
      appareil TEXT NOT NULL REFERENCES appareils(id) ON DELETE CASCADE,
      expire INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reglages (
      compte TEXT PRIMARY KEY REFERENCES comptes(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, bloc BLOB NOT NULL, maj INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compte TEXT NOT NULL REFERENCES comptes(id) ON DELETE CASCADE,
      emetteur TEXT NOT NULL, bloc BLOB NOT NULL, taille INTEGER NOT NULL,
      cree INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files_transit (
      appareil TEXT NOT NULL REFERENCES appareils(id) ON DELETE CASCADE,
      entree INTEGER NOT NULL REFERENCES transit(id) ON DELETE CASCADE,
      PRIMARY KEY (appareil, entree)
    );
    CREATE TABLE IF NOT EXISTS evenements_paiement (
      id TEXT PRIMARY KEY, recu INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transit_compte ON transit(compte);
    CREATE INDEX IF NOT EXISTS idx_appareils_compte ON appareils(compte);
  `);
  return db;
}

/** Efface les entrees de transit que plus aucun appareil n'attend. */
export function nettoyerTransit(db, compte) {
  db.prepare(
    "DELETE FROM transit WHERE compte = ? AND id NOT IN (SELECT entree FROM files_transit)"
  ).run(compte);
}

/** Garde maximale : ce qui n'est pas livre apres N jours est efface. */
export function purgerTransit(db, gardeJours, maintenant = Date.now()) {
  const limite = maintenant - gardeJours * 86_400_000;
  db.prepare("DELETE FROM transit WHERE cree < ?").run(limite);
  db.prepare("DELETE FROM sessions WHERE expire < ?").run(maintenant);
}
