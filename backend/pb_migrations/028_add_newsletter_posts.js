/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const accounts = app.findCollectionByNameOrId("accounts");
    const messages = app.findCollectionByNameOrId("messages");

    // --- newsletter_posts : un post = une synthese IA (traduite dans la langue
    // de l'utilisateur) d'une newsletter recue. Alimente le flux "Newsletters"
    // facon RSS. Ecriture reservee au worker (admin token) : create/delete null,
    // l'utilisateur ne fait que lister/voir + PATCH is_read. ---
    const posts = new Collection({
      name: "newsletter_posts",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: null,
      updateRule: "@request.auth.id = user",
      deleteRule: null,
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "message", type: "relation", collectionId: messages.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "account", type: "relation", collectionId: accounts.id, cascadeDelete: true, maxSelect: 1, required: false },
        { name: "source_name", type: "text", max: 300 },
        { name: "source_address", type: "text", max: 300 },
        { name: "original_subject", type: "text", max: 500 },
        { name: "title", type: "text", max: 500 },
        { name: "summary", type: "text", max: 20000 },
        { name: "language", type: "text", max: 10 },
        { name: "message_date", type: "date" },
        { name: "thread_id", type: "text", max: 255 },
        { name: "status", type: "select", maxSelect: 1, values: ["pending", "done", "error"] },
        { name: "is_read", type: "bool" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_nlposts_user_date ON newsletter_posts (user, message_date)",
        "CREATE INDEX idx_nlposts_user_read ON newsletter_posts (user, is_read)",
        "CREATE UNIQUE INDEX idx_nlposts_message ON newsletter_posts (message)",
      ],
    });
    app.save(posts);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("newsletter_posts"));
    } catch (_) {}
  }
);
