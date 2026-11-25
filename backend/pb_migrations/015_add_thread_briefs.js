/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    const briefs = new Collection({
      name: "thread_briefs",
      type: "base",
      // Notes IA privees : CRUD reserve au proprietaire (ecriture depuis le
      // frontend via le SDK authentifie de l'utilisateur).
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id = user",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "thread_id", type: "text", max: 255, required: true },
        { name: "content", type: "text", max: 20000 },
        { name: "message_count", type: "number" },
        { name: "last_message_id", type: "text", max: 255 },
        { name: "last_message_date", type: "text", max: 40 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_thread_briefs_user_thread ON thread_briefs (user, thread_id)",
        "CREATE INDEX idx_thread_briefs_user ON thread_briefs (user)",
      ],
    });
    app.save(briefs);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("thread_briefs"));
    } catch (_) {}
  }
);
