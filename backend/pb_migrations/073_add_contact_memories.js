/// <reference path="../pb_data/types.d.ts" />

// Memoire des contacts : la fiche "qui est qui" que l'IA de reponse recoit
// comme information deja etablie (worker contact-memory.ts).
// - key = adresse principale de la personne, ou "me" pour la fiche de
//   l'utilisateur lui-meme (son role) ; UNIQUE (user, key).
// - Construite a la premiere reponse IA vers la personne, puis mise a jour avec
//   les seuls mails posterieurs a last_message_date.
// - Visible et corrigeable sur la fiche du contact : user_notes (note libre),
//   locked (champs corriges, l'IA ne les reecrit plus), dismissed (faits retires,
//   l'IA ne les remet plus). La correction de l'utilisateur prime toujours.
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const col = new Collection({
      name: "contact_memories",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id = user",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "key", type: "text", max: 255, required: true },
        { name: "name", type: "text", max: 200 },
        { name: "addresses", type: "json", maxSize: 20000 },
        { name: "role", type: "text", max: 500 },
        { name: "organization", type: "text", max: 300 },
        { name: "relation", type: "text", max: 500 },
        { name: "facts", type: "json", maxSize: 50000 },
        { name: "related", type: "json", maxSize: 50000 },
        { name: "user_notes", type: "text", max: 5000 },
        { name: "locked", type: "json", maxSize: 2000 },
        { name: "dismissed", type: "json", maxSize: 50000 },
        { name: "last_message_date", type: "text", max: 40 },
        { name: "analyzed_count", type: "number" },
        { name: "model", type: "text", max: 120 },
        { name: "built_at", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_contact_mem_user_key ON contact_memories (user, key)"],
    });
    app.save(col);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("contact_memories"));
    } catch (_) {}
  }
);
