/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const items = app.findCollectionByNameOrId("tracking_items");
    const messages = app.findCollectionByNameOrId("messages");

    // --- tracking_events : la timeline d'une fiche de suivi. Un evenement par
    // mise a jour (creation, nouveau mail lie, changement de statut manuel...).
    // Ecriture worker + actions utilisateur (status_change/manual). ---
    const events = new Collection({
      name: "tracking_events",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id = user",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "item", type: "relation", collectionId: items.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "message", type: "relation", collectionId: messages.id, cascadeDelete: true, maxSelect: 1, required: false },
        { name: "date", type: "date" },
        { name: "kind", type: "select", maxSelect: 1, values: ["created", "update", "status_change", "manual"] },
        { name: "author", type: "text", max: 300 },
        { name: "label", type: "text", max: 300 },
        { name: "detail", type: "text", max: 5000 },
        { name: "changed_fields", type: "json", maxSize: 10000 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_tracking_events_item_date ON tracking_events (item, date)",
        // Unique PARTIEL : idempotence des evenements lies a un mail (1 evenement
        // par mail). Les evenements manuels (message vide) ne sont PAS contraints
        // -> on peut en avoir plusieurs (changements de statut, notes).
        "CREATE UNIQUE INDEX idx_tracking_events_item_msg ON tracking_events (item, message) WHERE message != ''",
      ],
    });
    app.save(events);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("tracking_events"));
    } catch (_) {}
  }
);
