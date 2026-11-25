/// <reference path="../pb_data/types.d.ts" />

// Index composite (is_starred, date) pour la vue "Favoris" (view=starred).
//
// PROBLEME : la vue favoris (/api/mail/list?view=starred, tous comptes) :
//   SELECT ... FROM messages m JOIN accounts a ON m.account=a.id
//   WHERE a.user=? AND m.is_starred=TRUE ORDER BY m.date DESC LIMIT 20
// L'index existant idx_msg_starred est (account, is_starred, date) : prefixe
// par account. Pour la vue tous-comptes il est utilise en (account, is_starred)
// mais l'ordre date n'est PAS global (5 comptes) => USE TEMP B-TREE FOR ORDER
// BY sur les ~2500 mails favoris, dont chaque LIGNE complete (html_body +
// raw_headers inline, ~118 Ko) est lue pour le tri. Sur un VPS sous pression
// memoire => 7,4 s a froid.
//
// FIX : index (is_starred, date) sans prefixe account. Le planificateur attaque
// par messages (SEARCH m USING idx_msg_starred_date (is_starred=?)), parcourt
// les favoris DEJA en ordre date DESC global (pas de temp b-tree), joint
// accounts par rowid et ne lit la grosse ligne que pour les 20 resultats finaux.
// Meme classe de correction que idx_msg_read_date (migration 032).

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE INDEX `idx_msg_starred_date` ON `messages` (`is_starred`, `date`)";
    if (!messages.indexes.includes(idx)) {
      messages.indexes.push(idx);
    }
    app.save(messages);
  },

  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE INDEX `idx_msg_starred_date` ON `messages` (`is_starred`, `date`)";
    messages.indexes = messages.indexes.filter((i) => i !== idx);
    app.save(messages);
  }
);
