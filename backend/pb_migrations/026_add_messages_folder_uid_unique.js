/// <reference path="../pb_data/types.d.ts" />

// Index UNIQUE (folder, uid) pour empecher les doublons d'un meme mail IMAP.
// L'UID est unique et stable par mailbox IMAP (donc par folder app), c'est
// l'invariant naturel. La dedup applicative (Set existingUids charge en debut
// de sync) souffrait d'une course quand deux syncs du meme compte se
// chevauchaient (event IMAP IDLE `exists` + safety poll + sync manuelle) :
// les deux partaient du meme snapshot sans l'UID et inseraient le mail.
// Cet index rend la garantie atomique au niveau base : un insert gagne, la
// course perdante prend une violation de contrainte (geree cote worker).
//
// Partiel sur uid > 0 : les enregistrements sans UID reel (POP3, brouillons
// locaux, mails sans source) ne sont pas contraints.
//
// PREREQUIS : les doublons existants doivent etre nettoyes AVANT cette
// migration, sinon la creation de l'index unique echoue.

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE UNIQUE INDEX idx_msg_folder_uid_unique ON messages (folder, uid) WHERE uid > 0";
    if (!messages.indexes.includes(idx)) {
      messages.indexes.push(idx);
    }
    app.save(messages);
  },

  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE UNIQUE INDEX idx_msg_folder_uid_unique ON messages (folder, uid) WHERE uid > 0";
    messages.indexes = messages.indexes.filter((i) => i !== idx);
    app.save(messages);
  }
);
