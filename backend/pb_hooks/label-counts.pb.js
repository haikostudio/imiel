/// <reference path="../pb_data/types.d.ts" />

// label-counts.pb.js
// Compteurs unread/total par label pour la sidebar (LabelsNav).
//
// Implementation : agregation sur la table de jointure message_labels
// (migration 022). Le hook backend/pb_hooks/message-labels.pb.js la maintient
// en miroir de messages.labels, et l'index (user, label) rend le COUNT
// proportionnel au nombre de messages portant le label (typiquement <1000)
// au lieu de scanner toute la table messages.
//
// GET /api/mail/label-counts
//   account_id : id du compte (ou "all" / omis pour tous les comptes)
//
// Reponse : { items: [{ id, name, color, is_secondary, total, unread }, ...] }

routerAdd("GET", "/api/mail/label-counts", (e) => {
  var authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }
  var userId = authRecord.id;
  var q = e.request.url.query();
  var accountId = q.get("account_id") || "";
  var filterAccount = accountId && accountId !== "all";

  // 1. Recuperer tous les labels du user (pour inclure ceux a zero dans la reponse).
  var labels = arrayOf(new DynamicModel({
    "id": "", "name": "", "color": "", "is_secondary": false,
  }));
  try {
    $app.db()
      .newQuery(
        "SELECT id, name, COALESCE(color, '') AS color, " +
        "CAST(COALESCE(is_secondary, 0) AS INTEGER) AS is_secondary " +
        "FROM labels WHERE user = {:userId} ORDER BY name"
      )
      .bind({ "userId": userId })
      .all(labels);
  } catch (err) {
    console.log("label-counts: labels lookup error: " + err);
    return e.json(500, { error: "labels_lookup_failed" });
  }

  // 2. Agreger les compteurs depuis message_labels.
  var countSql =
    "SELECT ml.label AS label_id, " +
    "       COUNT(*) AS total, " +
    "       SUM(CASE WHEN m.is_read = 0 THEN 1 ELSE 0 END) AS unread " +
    "FROM message_labels ml " +
    "JOIN messages m ON m.id = ml.message " +
    "WHERE ml.user = {:userId} ";
  var bindings = { "userId": userId };
  if (filterAccount) {
    countSql += "AND m.account = {:accountId} ";
    bindings.accountId = accountId;
  }
  countSql += "GROUP BY ml.label";

  var counts = arrayOf(new DynamicModel({ "label_id": "", "total": 0, "unread": 0 }));
  try {
    $app.db().newQuery(countSql).bind(bindings).all(counts);
  } catch (err) {
    console.log("label-counts: count query error: " + err);
    // On continue avec un map vide -> tous les labels retournes a 0.
  }

  var countsMap = {};
  for (var i = 0; i < counts.length; i++) {
    countsMap[counts[i].label_id] = {
      total: counts[i].total | 0,
      unread: counts[i].unread | 0,
    };
  }

  var items = [];
  for (var j = 0; j < labels.length; j++) {
    var lbl = labels[j];
    var c = countsMap[lbl.id] || { total: 0, unread: 0 };
    items.push({
      id: lbl.id,
      name: lbl.name,
      color: lbl.color,
      is_secondary: !!lbl.is_secondary,
      total: c.total,
      unread: c.unread,
    });
  }

  return e.json(200, { items: items });
}, $apis.requireAuth());
