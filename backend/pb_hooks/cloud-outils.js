// Outils des routes iMiel Cloud de la base locale (cloud.pb.js), charges par
// require() dans chaque gestionnaire.
module.exports = {
  ID_RE: /^[a-z0-9]{15}$/,
  boitePossedee: function (app, id, userId) {
    var a = app.findRecordById("accounts", id);
    if (a.get("user") !== userId) throw new ForbiddenError("Boite d'un autre utilisateur.");
    return a;
  },
  trouver: function (app, col, id) {
    try {
      return app.findRecordById(col, id);
    } catch (_) {
      return null;
    }
  },
  // Donnees propres a iMiel qui voyagent d'appareil a appareil, et champ qui
  // les rattache a l'utilisateur.
  FICHES: {
    labels: "user",
    filter_rules: "user",
    newsletter_sources: "user",
    thread_labels: "user",
    tracking_items: "user",
    tracking_events: "user",
    contacts: "user",
    calendar_groups: "user",
    calendar_events: "user",
    alert_topics: "user",
    importance_rules: "user",
  },
};
