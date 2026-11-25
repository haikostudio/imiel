/// <reference path="../pb_data/types.d.ts" />

// Indexes composites pour accelerer le listing et les compteurs sidebar.
//
// Avant : ~30s de chargement initial sur 37k mails. Causes :
//   1) sort `is_read, -date` sur filter `folder = X && is_draft = false`
//      => aucun index couvre la combinaison, SQLite scan + tri en memoire
//   2) 8 COUNT(*) en parallele depuis le sidebar (FolderNav useSidebarCountsSync)
//      => chacune fait un scan de la table messages (avec JOIN folders.type)
//
// Apres : index composites couvrant les requetes principales.
//
// Note : SQLite ne supporte pas DESC dans l'index avant 3.8, mais l'ordre des
// colonnes (date en derniere position) suffit pour que SQLite utilise l'index
// pour le tri (forward ou reverse scan).

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");

    const newIndexes = [
      // Listing principal d'un dossier (inbox/sent/trash/spam/archive/custom)
      // Couvre filter (account, folder, is_draft) + sort (is_read, date)
      "CREATE INDEX idx_msg_listing ON messages (account, folder, is_draft, is_read, date)",

      // Compteurs starred (par compte et global "all")
      "CREATE INDEX idx_msg_starred ON messages (account, is_starred, date)",

      // Vue "all_mail" et autres listes globales par compte avec filtre is_draft
      "CREATE INDEX idx_msg_account_draft_date ON messages (account, is_draft, is_sent, date)",
    ];

    for (const idx of newIndexes) {
      if (!messages.indexes.includes(idx)) {
        messages.indexes.push(idx);
      }
    }

    app.save(messages);
  },

  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const toRemove = new Set([
      "CREATE INDEX idx_msg_listing ON messages (account, folder, is_draft, is_read, date)",
      "CREATE INDEX idx_msg_starred ON messages (account, is_starred, date)",
      "CREATE INDEX idx_msg_account_draft_date ON messages (account, is_draft, is_sent, date)",
    ]);
    messages.indexes = messages.indexes.filter((i) => !toRemove.has(i));
    app.save(messages);
  }
);
