/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    // --- ai_actions : historique des actions faites par l'assistant IA APRES
    // validation de l'utilisateur (carte Accepter). Ecrit par le client avec
    // l'auth de l'utilisateur. `created_refs` garde de quoi ANNULER une
    // creation ([{type: draft|event|contact|tracking, id, messageId?}]).
    // Seules les creations du jour sont annulables (regle cote UI). ---
    const actions = new Collection({
      name: "ai_actions",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id != '' && @request.body.user = @request.auth.id",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "kind", type: "text", max: 40, required: true },
        { name: "summary", type: "text", max: 500 },
        { name: "payload", type: "json", maxSize: 200000 },
        { name: "created_refs", type: "json", maxSize: 20000 },
        { name: "status", type: "select", values: ["done", "error", "undone"], maxSelect: 1 },
        { name: "error", type: "text", max: 2000 },
        { name: "edited", type: "bool" },
        { name: "undone_at", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX idx_ai_actions_user_created ON ai_actions (user, created)"],
    });
    app.save(actions);

    // Societe d'un contact (proposee par l'assistant, champ neutre).
    const contacts = app.findCollectionByNameOrId("contacts");
    if (!contacts.fields.getByName("company")) {
      contacts.fields.add(new Field({ name: "company", type: "text", max: 200 }));
    }
    app.save(contacts);
  },

  (app) => {
    const contacts = app.findCollectionByNameOrId("contacts");
    contacts.fields.removeByName("company");
    app.save(contacts);
    app.delete(app.findCollectionByNameOrId("ai_actions"));
  }
);
