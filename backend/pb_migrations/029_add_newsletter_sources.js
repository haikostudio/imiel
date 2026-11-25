/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    // --- newsletter_sources : adresses d'expediteurs explicitement designees
    // par l'utilisateur comme sources de newsletter a agreger dans le flux.
    // Seuls les mails provenant de ces adresses alimentent newsletter_posts.
    // Entierement gere depuis le frontend (SDK authentifie de l'utilisateur). ---
    const sources = new Collection({
      name: "newsletter_sources",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id = user",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "email", type: "text", max: 300, required: true },
        { name: "name", type: "text", max: 300 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_nlsources_user_email ON newsletter_sources (user, email)",
      ],
    });
    app.save(sources);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("newsletter_sources"));
    } catch (_) {}
  }
);
