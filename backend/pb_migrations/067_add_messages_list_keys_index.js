/// <reference path="../pb_data/types.d.ts" />

// Index ETROIT des cles de liste (idx_msg_list_keys).
//
// GET /api/mail/list ne trie plus la boite entiere et ne lit plus aucune ligne
// de `messages` (corps inline ~61 Ko, colonnes utiles rangees APRES html_body) :
//   - le COUNT et les filtres (non lus, favoris, PJ, label, expediteurs
//     bloques...) sont servis par CET index (~7 Mo pour 38 700 mails, contre
//     31 Mo pour le couvrant idx_msg_list_cover et 2,4 Go pour la table) ;
//   - une sous-requete par dossier suit (folder, is_draft, date, id) et s'arrete
//     a LIMIT, sans tri global ;
//   - les colonnes d'affichage ne sont lues que pour les lignes de la page, par
//     un seek (folder, is_draft, date, id) dans idx_msg_list_cover.
//
// Mesure a travers PocketBase sur une copie de la base reelle (38 726 mails) :
// "Tous les messages" 1109 ms -> 40 ms a chaud, 7555 ms -> 145 ms a froid ;
// un label 21 404 ms -> 50 ms ; memes lignes et memes totaux sur 53 vues.
//
// Toute colonne FILTREE par mail-list.pb.js (provenance "k") doit etre ICI ;
// toute colonne PROJETEE doit etre dans idx_msg_list_cover (migration 048).
// Creation additive ; elle lit toute la table une fois au demarrage de PB.

var KEYS_IDX =
  "CREATE INDEX `idx_msg_list_keys` ON `messages` " +
  "(`folder`, `is_draft`, `date`, `id`, `account`, `is_read`, `is_starred`, " +
  "`is_sent`, `has_attachments`, `is_answered`, `priority`, `labels`, " +
  "`from_address`)";

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    if (!messages.indexes.includes(KEYS_IDX)) messages.indexes.push(KEYS_IDX);
    app.save(messages);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.indexes = messages.indexes.filter((i) => i !== KEYS_IDX);
    app.save(messages);
  }
);
