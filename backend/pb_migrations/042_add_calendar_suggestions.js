/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const items = app.findCollectionByNameOrId("tracking_items");
    const events = app.findCollectionByNameOrId("calendar_events");

    // --- calendar_suggestions : une PROPOSITION d'echeance/livraison/RDV
    // detectee par l'IA dans une fiche de suivi, EN ATTENTE de la decision de
    // l'utilisateur (ajouter a l'agenda / refuser). On ne cree JAMAIS l'event
    // automatiquement : le worker (admin token) ecrit la proposition (create
    // null), l'utilisateur la lit et le worker la passe a accepted/refused via
    // ses routes (/tracking/dates/:id/accept|refuse). `dedup_key` =
    // `tracking:<itemId>:<kind>` : une date qui glisse MET A JOUR la proposition
    // au lieu d'en empiler une nouvelle ; un refus reste un refus. ---
    const suggestions = new Collection({
      name: "calendar_suggestions",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: null,
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "item", type: "relation", collectionId: items.id, cascadeDelete: true, maxSelect: 1, required: false },
        { name: "dedup_key", type: "text", max: 255, required: true },
        { name: "kind", type: "text", max: 40 },
        { name: "label", type: "text", max: 200 },
        { name: "title", type: "text", max: 300 },
        { name: "fiche_title", type: "text", max: 500 },
        { name: "start", type: "date", required: true },
        { name: "end", type: "date" },
        { name: "all_day", type: "bool" },
        { name: "status", type: "select", maxSelect: 1, required: true, values: ["pending", "accepted", "refused"] },
        { name: "event", type: "relation", collectionId: events.id, cascadeDelete: false, maxSelect: 1, required: false },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_calsugg_user_key ON calendar_suggestions (user, dedup_key)",
        "CREATE INDEX idx_calsugg_user_status ON calendar_suggestions (user, status)",
        "CREATE INDEX idx_calsugg_item ON calendar_suggestions (item)",
      ],
    });
    app.save(suggestions);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("calendar_suggestions"));
    } catch (_) {}
  }
);
