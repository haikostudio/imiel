/// <reference path="../pb_data/types.d.ts" />

// Index COUVRANT du listing (GET /api/mail/list).
//
// CONTEXTE : la table `messages` porte ~2,3 Go de corps inline (html_body /
// text_body, ~61 Ko/ligne en moyenne). Le driver SQLite pur-Go de PocketBase
// LIT le contenu complet de chaque ligne lors d'un fetch, MEME quand la requete
// ne SELECT pas les corps. Mesure : lister 50 mails "Envoyes" prend ~6 s a
// froid cote PB (la meme requete = ~1 ms en sqlite3 C). Le COUNT, lui, est deja
// index-only.
//
// SOLUTION : un index couvrant qui contient TOUTES les colonnes du listing
// (sans les corps). La requete de liste est alors servie integralement depuis
// l'index (~29 Mo), sans jamais lire les lignes volumineuses -> liste a froid
// ramenee de plusieurs secondes a <0,5 s. `mail-list.pb.js` force cet index via
// `INDEXED BY idx_msg_list_cover`.
//
// Colonnes (ordre) :
//   - (folder, is_draft, date) en tete : seek par dossier + tri par date.
//   - id : PK TEXTE de PocketBase (PAS le rowid) -> indispensable pour que
//     l'index soit reellement COUVRANT (sinon fetch de ligne pour lire id).
//   - puis toutes les autres colonnes projetees par le SELECT du listing.
//
// Migration ADDITIVE et sans risque : ne cree qu'un index (pas de downtime, pas
// de VACUUM). Reste complementaire de l'extraction durable des corps
// (message_bodies, migration 035 + fill/drop a venir).

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE INDEX `idx_msg_list_cover` ON `messages` " +
      "(`folder`, `is_draft`, `date`, `id`, `account`, `thread_id`, `message_id`, " +
      "`in_reply_to`, `references`, `from_address`, `to_addresses`, `cc_addresses`, " +
      "`subject`, `snippet`, `is_read`, `is_starred`, `is_answered`, `is_sent`, " +
      "`has_attachments`, `priority`, `uid`, `labels`, `spam_score`, `spam_action`)";
    if (!messages.indexes.includes(idx)) {
      messages.indexes.push(idx);
      app.save(messages);
    }
  },

  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE INDEX `idx_msg_list_cover` ON `messages` " +
      "(`folder`, `is_draft`, `date`, `id`, `account`, `thread_id`, `message_id`, " +
      "`in_reply_to`, `references`, `from_address`, `to_addresses`, `cc_addresses`, " +
      "`subject`, `snippet`, `is_read`, `is_starred`, `is_answered`, `is_sent`, " +
      "`has_attachments`, `priority`, `uid`, `labels`, `spam_score`, `spam_action`)";
    messages.indexes = messages.indexes.filter((i) => i !== idx);
    app.save(messages);
  }
);
