/// <reference path="../pb_data/types.d.ts" />

// Resynchronise message_labels avec messages.labels.
// La migration 022 a cree la table, mais certaines donnees existantes peuvent
// avoir ete modifiees avant que le hook miroir soit actif partout. Les vues par
// label lisent maintenant message_labels directement, donc la table doit etre
// complete.

migrate(
  (app) => {
    try {
      app.db().newQuery(
        "DELETE FROM message_labels " +
        "WHERE NOT EXISTS ( " +
        "  SELECT 1 " +
        "  FROM messages m " +
        "  JOIN accounts a ON a.id = m.account " +
        "  JOIN json_each(m.labels) je " +
        "  WHERE m.id = message_labels.message " +
        "    AND a.user = message_labels.user " +
        "    AND je.value = message_labels.label " +
        ")"
      ).execute();
    } catch (e) {
      console.log("031_resync_message_labels delete stale failed: " + e);
    }

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
      console.log("031_resync_message_labels insert missing failed: " + e);
    }
  },

  () => {
    // Donnees derivees : pas de rollback utile.
  }
);
