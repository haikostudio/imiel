/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    // --- ai_chat_messages : conversation de l'assistant IA, UNE par
    // utilisateur, partagee entre ses appareils (abonnement temps reel PB).
    // Ecrit par le client avec l'auth de l'utilisateur. `client_id` est
    // l'identifiant pose par l'appareil qui a cree le message : UNIQUE par
    // utilisateur, il rend la reprise de l'ancien historique local et les
    // ecritures rejouees idempotentes. Les pieces jointes ne gardent que
    // nom/type/taille/miniature, jamais le binaire. `at` (ms) ordonne. ---
    const chat = new Collection({
      name: "ai_chat_messages",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id != '' && @request.body.user = @request.auth.id",
      updateRule: "@request.auth.id = user && (@request.body.user:isset = false || @request.body.user = @request.auth.id)",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "client_id", type: "text", max: 80, required: true },
        { name: "role", type: "select", values: ["user", "assistant"], maxSelect: 1, required: true },
        { name: "content", type: "text", max: 100000 },
        { name: "at", type: "number", onlyInt: true },
        { name: "meta", type: "json", maxSize: 50000 },
        { name: "actions", type: "json", maxSize: 400000 },
        { name: "attachments", type: "json", maxSize: 200000 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_ai_chat_user_client ON ai_chat_messages (user, client_id)",
        "CREATE INDEX idx_ai_chat_user_at ON ai_chat_messages (user, at)",
      ],
    });
    app.save(chat);
  },

  (app) => {
    app.delete(app.findCollectionByNameOrId("ai_chat_messages"));
  }
);
