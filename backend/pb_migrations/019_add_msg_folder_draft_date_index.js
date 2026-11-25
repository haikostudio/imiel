/// <reference path="../pb_data/types.d.ts" />

// Index supplementaire pour couvrir le listing cross-account par folder.type.
// Quand activeAccountId === "all", le filtre est `folder.type = "X"` ce qui
// scan folders WHERE type=X, puis pour chaque folder.id il faut un index
// (folder, is_draft, date) pour ordonner par date sans tri en memoire.
//
// Garde dans une migration separee pour qu'elle s'execute meme si la 018
// a deja tourne en prod.

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx = "CREATE INDEX idx_msg_folder_draft_date ON messages (folder, is_draft, date)";
    if (!messages.indexes.includes(idx)) {
      messages.indexes.push(idx);
    }
    app.save(messages);
  },

  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx = "CREATE INDEX idx_msg_folder_draft_date ON messages (folder, is_draft, date)";
    messages.indexes = messages.indexes.filter((i) => i !== idx);
    app.save(messages);
  }
);
