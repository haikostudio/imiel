/// <reference path="../pb_data/types.d.ts" />

// Collection message_labels : table de jointure (message, label) qui materialise
// les labels stockes en JSON array dans messages.labels.
//
// Pourquoi : compter les messages par label en partant de messages.labels
// (LIKE '%"<id>"%' ou json_each) scannait la table entiere a chaque requete
// (40k+ lignes, >5s sur SQLite). Avec cette table + un index (user, label),
// le COUNT par label devient O(rows_du_label) au lieu de O(messages_du_user).
//
// La table est maintenue par le hook backend/pb_hooks/message-labels.pb.js
// (sync sur create/update du message ; delete cascade naturel par FK).

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const messages = app.findCollectionByNameOrId("messages");
    const labels = app.findCollectionByNameOrId("labels");

    const coll = new Collection({
      name: "message_labels",
      type: "base",
      // Pas d'acces direct via PB SDK : les compteurs passent par l'API
      // custom /api/mail/label-counts qui filtre par user.
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "message", type: "relation", collectionId: messages.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "label", type: "relation", collectionId: labels.id, cascadeDelete: true, maxSelect: 1, required: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_message_labels_uniq ON message_labels (message, label)",
        "CREATE INDEX idx_message_labels_user_label ON message_labels (user, label)",
        "CREATE INDEX idx_message_labels_message ON message_labels (message)",
      ],
    });
    app.save(coll);

    // Backfill : on materialise les couples (message, label) existants en une
    // seule passe SQL. ON CONFLICT DO NOTHING : protege contre une collision
    // improbable de l'ID aleatoire ou un doublon (message, label).
    try {
      app.db().newQuery(
        "INSERT INTO message_labels (id, user, message, label) " +
        "SELECT lower(substr(hex(randomblob(16)), 1, 15)) AS id, " +
        "       a.user AS user, " +
        "       m.id AS message, " +
        "       je.value AS label " +
        "FROM messages m " +
        "JOIN accounts a ON a.id = m.account " +
        "JOIN json_each(m.labels) je " +
        "WHERE m.labels IS NOT NULL " +
        "  AND m.labels != '' " +
        "  AND m.labels != '[]' " +
        "  AND je.value IN (SELECT id FROM labels) " +
        "ON CONFLICT(message, label) DO NOTHING"
      ).execute();
    } catch (e) {
      console.log("022_add_message_labels backfill failed: " + e);
    }
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("message_labels"));
    } catch (_) {}
  }
);
