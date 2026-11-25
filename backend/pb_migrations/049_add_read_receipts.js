/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const accounts = app.findCollectionByNameOrId("accounts");
    const messages = app.findCollectionByNameOrId("messages");

    // --- read_receipts : suivi de lecture des mails ENVOYES. Le worker injecte
    // un pixel de tracking (1x1) dans le HTML au moment de l'envoi SMTP ; chaque
    // chargement du pixel par le destinataire = un evenement "opened". Un
    // evenement "sent" est ecrit a l'acceptation SMTP. L'UI derive la timeline :
    // Envoye -> Lu (1ere ouverture) -> Relu (suivantes).
    // createRule null (worker only, admin token) ; l'utilisateur lit ses propres
    // evenements (drawer "Suivi de lecture" dans la conversation). ---
    const receipts = new Collection({
      name: "read_receipts",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: null,
      updateRule: null,
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "account", type: "relation", collectionId: accounts.id, cascadeDelete: true, maxSelect: 1, required: false },
        { name: "message", type: "relation", collectionId: messages.id, cascadeDelete: true, maxSelect: 1, required: true },
        {
          name: "kind",
          type: "select",
          maxSelect: 1,
          required: true,
          values: ["sent", "opened"],
        },
        { name: "date", type: "date", required: true },
        { name: "user_agent", type: "text", max: 1000 },
        { name: "ip", type: "text", max: 100 },
        // Libelle client derive du user-agent ("Gmail", "Apple Mail", ...)
        { name: "client", type: "text", max: 100 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_read_receipts_message_date ON read_receipts (message, date)",
        "CREATE INDEX idx_read_receipts_user_date ON read_receipts (user, date)",
      ],
    });
    app.save(receipts);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("read_receipts"));
    } catch (_) {}
  }
);
