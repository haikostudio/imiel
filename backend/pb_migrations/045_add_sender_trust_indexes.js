/// <reference path="../pb_data/types.d.ts" />

// Index COUVRANTS pour les compteurs sender-trust (mail-worker/sender-trust.ts,
// requetes SQL directes de sqlite-direct.ts).
//
// Probleme : ces compteurs font des LIKE '%email%' sur to/cc/from — non
// seekable — donc SQLite doit examiner beaucoup de lignes. Sans index couvrant,
// chaque ligne examinee est LUE ENTIEREMENT depuis la table messages (~2.3 Go,
// corps html inline sur les anciennes lignes) : 8-13 s a froid sur ce VPS sous
// pression memoire, et comme le worker fait ces requetes en better-sqlite3
// SYNCHRONE, l'event loop du worker gelait d'autant (un SELECT INBOX Gmail
// mesure a 40 s alors que Gmail repond en 0.5 s).
//
// Avec ces index couvrants, le scan reste un scan mais IL NE SORT PAS DE
// L'INDEX (quelques Mo au lieu de 2.3 Go) : ~10-100 ms.
//
// 1) (is_sent, account, to_addresses, cc_addresses) : compte "l'utilisateur a
//    deja ecrit a cette adresse" -> ne parcourt que la tranche is_sent=1
//    (~8k entrees), colonnes LIKE incluses dans l'index.
// 2) (account, from_address, folder) : compte "mails recus de cette adresse /
//    de ce domaine hors spam" -> parcourt les entrees du compte, from_address
//    et folder (pour le join folders.type) inclus dans l'index.

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idxSent =
      "CREATE INDEX `idx_msg_trust_sent` ON `messages` (`is_sent`, `account`, `to_addresses`, `cc_addresses`)";
    const idxFrom =
      "CREATE INDEX `idx_msg_trust_from` ON `messages` (`account`, `from_address`, `folder`)";
    if (!messages.indexes.includes(idxSent)) {
      messages.indexes.push(idxSent);
    }
    if (!messages.indexes.includes(idxFrom)) {
      messages.indexes.push(idxFrom);
    }
    app.save(messages);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.indexes = messages.indexes.filter(
      (idx) =>
        !idx.includes("idx_msg_trust_sent") &&
        !idx.includes("idx_msg_trust_from")
    );
    app.save(messages);
  }
);
