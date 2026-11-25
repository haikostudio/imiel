/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const accounts = app.findCollectionByNameOrId("accounts");
    const messages = app.findCollectionByNameOrId("messages");

    const embeddings = new Collection({
      name: "mail_embeddings",
      type: "base",
      // Lecture limitee au proprietaire ; ecriture reservee au superuser
      // (l'indexation passe par le mail-worker avec un token admin).
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "message", type: "relation", collectionId: messages.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "account", type: "relation", collectionId: accounts.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "vector", type: "json", maxSize: 200000 },
        { name: "model", type: "text", max: 100 },
        { name: "content_hash", type: "text", max: 80 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_mail_embeddings_message ON mail_embeddings (message)",
        "CREATE INDEX idx_mail_embeddings_user ON mail_embeddings (user)",
        "CREATE INDEX idx_mail_embeddings_account ON mail_embeddings (account)",
      ],
    });
    app.save(embeddings);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("mail_embeddings"));
    } catch (_) {}
  }
);
