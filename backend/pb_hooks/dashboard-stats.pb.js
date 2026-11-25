/// <reference path="../pb_data/types.d.ts" />

// dashboard-stats.pb.js
// Compteurs du tableau de bord en SQL-direct. Le record-API PB calculait
// totalItems via un COUNT qui applique l'access rule (@request.auth.id =
// account.user) PAR LIGNE sur ~36k mails -> TIMEOUT 30s -> dashboard bloque
// sur le skeleton de chargement. Ici l'ownership est applique en UN seul JOIN
// accounts->users dans le WHERE (meme pattern que mail-list.pb.js /
// sidebar-counts.pb.js) : ~0.3s.
//
// Les listes (needsReply/waitingReply, 20 lignes) et l'activite 7j restent
// cote client (volumes bornes), avec skipTotal pour eviter le COUNT couteux.
//
// GET /api/mail/dashboard-stats                 -> tous les comptes du user
// GET /api/mail/dashboard-stats?account_id=xxx  -> un compte specifique

routerAdd("GET", "/api/mail/dashboard-stats", (e) => {
  var authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }
  var userId = authRecord.id;

  var query = e.request.url.query();
  var accountId = query.get("account_id") || "";

  if (accountId && accountId !== "all") {
    try {
      var acct = $app.findRecordById("accounts", accountId);
      if (acct.get("user") !== userId) {
        throw new ForbiddenError("Not your account");
      }
    } catch (err) {
      return e.json(404, { error: "Account not found" });
    }
  }

  var accountClause = "";
  var bindings = { "userId": userId };
  if (accountId && accountId !== "all") {
    accountClause = "AND m.account = {:accountId} ";
    bindings.accountId = accountId;
  }

  // Deux compteurs en UN seul scan (SUM CASE). Filtres identiques a l'ancien
  // dashboard (record-API) : non lus + (lus && non repondus && non brouillon).
  var sql =
    "SELECT " +
    " COALESCE(SUM(CASE WHEN m.is_read = FALSE THEN 1 ELSE 0 END), 0) AS unreadCount, " +
    " COALESCE(SUM(CASE WHEN m.is_read = TRUE AND m.is_answered = FALSE AND m.is_draft = FALSE THEN 1 ELSE 0 END), 0) AS unansweredCount " +
    "FROM messages m " +
    "JOIN accounts a ON m.account = a.id " +
    "WHERE a.user = {:userId} " +
    accountClause;

  var rows = arrayOf(new DynamicModel({
    "unreadCount": 0,
    "unansweredCount": 0,
  }));

  try {
    $app.db().newQuery(sql).bind(bindings).all(rows);
  } catch (err) {
    console.log("dashboard-stats: SQL error: " + err);
    return e.json(500, { error: "Query failed" });
  }

  var r = rows.length ? rows[0] : null;
  return e.json(200, {
    unreadCount: r ? r.unreadCount : 0,
    unansweredCount: r ? r.unansweredCount : 0,
  });
}, $apis.requireAuth());
