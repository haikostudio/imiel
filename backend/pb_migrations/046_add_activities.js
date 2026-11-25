/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const accounts = app.findCollectionByNameOrId("accounts");

    // --- activities : journal d'activite / centre de notifications. Le worker
    // (admin token) ecrit UNE entree a chaque evenement notable : nouveau mail
    // recu, mail envoye ("mes envois"), nouvelle fiche de suivi + changement de
    // statut, newsletter agregee, rappel d'agenda + echeance detectee.
    // DECOUPLE du push : l'entree est ecrite MEME si les notifications push
    // sont desactivees -> l'utilisateur garde un historique 30 jours de "ce qui
    // s'est passe, par qui et quand", la ou le push est ephemere.
    // createRule null (worker only, admin token) ; l'utilisateur lit ses
    // propres entrees, les marque lues (update) et peut les supprimer. ---
    const activities = new Collection({
      name: "activities",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: null,
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "account", type: "relation", collectionId: accounts.id, cascadeDelete: true, maxSelect: 1, required: false },
        {
          name: "type",
          type: "select",
          maxSelect: 1,
          required: true,
          values: [
            "new_email",
            "mail_sent",
            "newsletter",
            "tracking_new",
            "tracking_status",
            "calendar_reminder",
            "calendar_suggestion",
          ],
        },
        { name: "title", type: "text", max: 400, required: true },
        { name: "body", type: "text", max: 1000 },
        { name: "icon", type: "text", max: 500 },
        { name: "url", type: "text", max: 500 },
        { name: "source_collection", type: "text", max: 50 },
        { name: "source_id", type: "text", max: 255 },
        { name: "thread_id", type: "text", max: 255 },
        { name: "metadata", type: "json", maxSize: 20000 },
        { name: "is_read", type: "bool" },
        { name: "event_date", type: "date", required: true },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_activities_user_date ON activities (user, event_date)",
        "CREATE INDEX idx_activities_user_read ON activities (user, is_read)",
        "CREATE INDEX idx_activities_user_type ON activities (user, type)",
      ],
    });
    app.save(activities);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("activities"));
    } catch (_) {}
  }
);
