/// <reference path="../pb_data/types.d.ts" />

// Collection thread_labels : override explicite du rattachement d'un label
// a une conversation (thread).
// - mode "included" : le label est colle a tous les messages du thread, et
//   les futurs messages du thread heriteront du label (l'IA ne peut pas
//   l'enlever).
// - mode "excluded" : le label est retire de tous les messages du thread, et
//   l'IA ne peut plus le coller sur les futurs messages de ce thread.
// Ces overrides sont la decision explicite de l'utilisateur depuis la vue
// conversation et priment sur la categorisation IA.

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const labels = app.findCollectionByNameOrId("labels");

    const coll = new Collection({
      name: "thread_labels",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id = user",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "thread_id", type: "text", max: 255, required: true },
        { name: "label", type: "relation", collectionId: labels.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "mode", type: "select", required: true, maxSelect: 1, values: ["included", "excluded"] },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_thread_labels_uniq ON thread_labels (user, thread_id, label)",
        "CREATE INDEX idx_thread_labels_user_thread ON thread_labels (user, thread_id)",
      ],
    });
    app.save(coll);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("thread_labels"));
    } catch (_) {}
  }
);
