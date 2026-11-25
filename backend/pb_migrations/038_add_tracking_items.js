/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const accounts = app.findCollectionByNameOrId("accounts");
    const messages = app.findCollectionByNameOrId("messages");
    const attachments = app.findCollectionByNameOrId("attachments");

    // --- tracking_items : une "fiche" de suivi (commande, livraison, devis,
    // rendez-vous, candidature, support, administratif...). Le LLM determine le
    // TYPE et les CHAMPS (schema dynamique dans `fields`). Ecriture reservee au
    // worker (admin token) : create null, l'utilisateur lit / met a jour (statut,
    // is_read, archived...) / supprime ses propres fiches. ---
    const items = new Collection({
      name: "tracking_items",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: null,
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "account", type: "relation", collectionId: accounts.id, cascadeDelete: true, maxSelect: 1, required: false },
        { name: "type", type: "text", max: 60 },
        { name: "title", type: "text", max: 500 },
        { name: "status", type: "select", maxSelect: 1, values: ["active", "waiting", "done", "cancelled"] },
        { name: "closure_suggested", type: "bool" },
        { name: "status_label", type: "text", max: 200 },
        { name: "fields", type: "json", maxSize: 20000 },
        { name: "image_attachment", type: "relation", collectionId: attachments.id, cascadeDelete: false, maxSelect: 1, required: false },
        { name: "merchant", type: "text", max: 200 },
        { name: "sender_domain", type: "text", max: 200 },
        { name: "thread_id", type: "text", max: 255 },
        { name: "first_message", type: "relation", collectionId: messages.id, cascadeDelete: false, maxSelect: 1, required: false },
        { name: "last_message_id", type: "text", max: 255 },
        { name: "last_message_date", type: "date" },
        { name: "event_count", type: "number" },
        { name: "pinned", type: "bool" },
        { name: "archived", type: "bool" },
        { name: "is_read", type: "bool" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_tracking_items_user_status ON tracking_items (user, status)",
        "CREATE INDEX idx_tracking_items_user_date ON tracking_items (user, last_message_date)",
        "CREATE INDEX idx_tracking_items_user_domain ON tracking_items (user, sender_domain)",
        "CREATE INDEX idx_tracking_items_user_thread ON tracking_items (user, thread_id)",
      ],
    });
    app.save(items);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("tracking_items"));
    } catch (_) {}
  }
);
