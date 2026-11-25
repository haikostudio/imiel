/// <reference path="../pb_data/types.d.ts" />

// sidebar-counts.pb.js
// Renvoie les 8 compteurs du sidebar en aggregant la table folders
// (unread_count/total_count sont maintenus par folder-counters.pb.js).
// Pour starred et allMail : COUNT(*) direct sur messages avec indexes.
// Total ~5-50ms (vs 3s+ quand on scannait messages pour chaque compteur).
//
// GET /api/mail/sidebar-counts                  -> tous les comptes du user
// GET /api/mail/sidebar-counts?account_id=xxx   -> un compte specifique

routerAdd("GET", "/api/mail/sidebar-counts", (e) => {
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
    accountClause = "AND f.account = {:accountId} ";
    bindings.accountId = accountId;
  }

  // 1) Aggregation par type via la table folders (compteurs deja maintenus
  //    par folder-counters.pb.js). On inclut inbox ici : on utilise les
  //    compteurs pre-calcules au lieu de scanner messages avec NOT LIKE sur
  //    les labels secondaires (qui prenait 6s sur 37k mails).
  //    Le compteur sidebar peut etre legerement plus grand que la liste
  //    visible (qui exclut les secondaires) - c'est un trade-off acceptable
  //    pour passer de 6s a <50ms.
  var sqlFolders =
    "SELECT " +
    "  COALESCE(SUM(CASE WHEN f.type = 'inbox' THEN f.unread_count ELSE 0 END), 0) AS inboxUnread, " +
    "  COALESCE(SUM(CASE WHEN f.type = 'inbox' THEN f.total_count ELSE 0 END), 0) AS inboxTotal, " +
    "  COALESCE(SUM(CASE WHEN f.type = 'sent' THEN f.total_count ELSE 0 END), 0) AS sent, " +
    "  COALESCE(SUM(CASE WHEN f.type = 'trash' THEN f.total_count ELSE 0 END), 0) AS trash, " +
    "  COALESCE(SUM(CASE WHEN f.type = 'spam' THEN f.total_count ELSE 0 END), 0) AS spam, " +
    "  COALESCE(SUM(CASE WHEN f.type NOT IN ('trash', 'spam', 'drafts') THEN f.total_count ELSE 0 END), 0) AS allMail " +
    "FROM folders f " +
    "JOIN accounts a ON f.account = a.id " +
    "WHERE a.user = {:userId} " +
    accountClause;

  var folderRows = arrayOf(new DynamicModel({
    "inboxUnread": 0,
    "inboxTotal": 0,
    "sent": 0,
    "trash": 0,
    "spam": 0,
    "allMail": 0,
  }));

  try {
    $app.db().newQuery(sqlFolders).bind(bindings).all(folderRows);
  } catch (err) {
    console.log("sidebar-counts: folders SQL error: " + err);
    return e.json(500, { error: "Query failed" });
  }

  // 2) Starred : pas de colonne pre-calculee, COUNT direct (rapide avec
  //    l'index idx_msg_starred (account, is_starred, date))
  var starredAccountClause = "";
  if (accountId && accountId !== "all") {
    starredAccountClause = "AND m.account = {:accountId} ";
  }
  var sqlStarred =
    "SELECT COUNT(*) AS starred " +
    "FROM messages m " +
    "JOIN accounts a ON m.account = a.id " +
    "WHERE a.user = {:userId} AND m.is_starred = TRUE " +
    starredAccountClause;

  var starredRows = arrayOf(new DynamicModel({ "starred": 0 }));
  var starred = 0;
  try {
    $app.db().newQuery(sqlStarred).bind(bindings).all(starredRows);
    starred = starredRows.length ? starredRows[0].starred : 0;
  } catch (err) {
    console.log("sidebar-counts: starred SQL error: " + err);
  }

  // 3) Drafts : COUNT direct sur messages joint au folder type='drafts'.
  //    On evite folders.total_count qui peut se desynchroniser (hooks
  //    folder-counters silencieux en cas d'erreur, drafts crees sans
  //    folder, etc.). Aligne avec ce que /api/mail/list affiche.
  var draftsAccountClause = "";
  if (accountId && accountId !== "all") {
    draftsAccountClause = "AND m.account = {:accountId} ";
  }
  var sqlDrafts =
    "SELECT COUNT(*) AS drafts " +
    "FROM messages m " +
    "JOIN accounts a ON m.account = a.id " +
    "JOIN folders f ON m.folder = f.id " +
    "WHERE a.user = {:userId} AND f.type = 'drafts' " +
    draftsAccountClause;

  var draftsRows = arrayOf(new DynamicModel({ "drafts": 0 }));
  var drafts = 0;
  try {
    $app.db().newQuery(sqlDrafts).bind(bindings).all(draftsRows);
    drafts = draftsRows.length ? draftsRows[0].drafts : 0;
  } catch (err) {
    console.log("sidebar-counts: drafts SQL error: " + err);
  }

  // 4) Unread : COUNT direct des mails non lus, tous dossiers sauf
  //    spam/trash/drafts. Cale exactement sur la vue /api/mail/list?view=unread
  //    (le compteur folders.unread_count derive et sous-estimait le total).
  var unreadAccountClause = "";
  if (accountId && accountId !== "all") {
    unreadAccountClause = "AND m.account = {:accountId} ";
  }
  var sqlUnread =
    "SELECT COUNT(*) AS unread " +
    "FROM messages m " +
    "JOIN accounts a ON m.account = a.id " +
    "JOIN folders f ON m.folder = f.id " +
    "WHERE a.user = {:userId} AND m.is_read = FALSE " +
    "AND f.type NOT IN ('spam', 'trash', 'drafts') " +
    unreadAccountClause;

  var unreadRows = arrayOf(new DynamicModel({ "unread": 0 }));
  var unread = 0;
  try {
    $app.db().newQuery(sqlUnread).bind(bindings).all(unreadRows);
    unread = unreadRows.length ? unreadRows[0].unread : 0;
  } catch (err) {
    console.log("sidebar-counts: unread SQL error: " + err);
  }

  // 4b) Non lus des 30 derniers jours (badge de "Tous les messages") : meme
  //     perimetre que #4, borne par date (index (is_read, date), migr. 032).
  //     Format de date ESPACE, compare en chaine par SQLite.
  var cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ");
  var sqlUnread30 =
    "SELECT COUNT(*) AS unread30 " +
    "FROM messages m " +
    "JOIN accounts a ON m.account = a.id " +
    "JOIN folders f ON m.folder = f.id " +
    "WHERE a.user = {:userId} AND m.is_read = FALSE AND m.date >= {:cutoff30} " +
    "AND f.type NOT IN ('spam', 'trash', 'drafts') " +
    unreadAccountClause;
  var unread30Rows = arrayOf(new DynamicModel({ "unread30": 0 }));
  var allMailUnread30 = 0;
  try {
    bindings.cutoff30 = cutoff30;
    $app.db().newQuery(sqlUnread30).bind(bindings).all(unread30Rows);
    allMailUnread30 = unread30Rows.length ? unread30Rows[0].unread30 : 0;
  } catch (err) {
    console.log("sidebar-counts: unread30 SQL error: " + err);
  }

  // 5) Inbox : compteurs pris du SQL aggrege #1 (folders.unread_count /
  //    total_count, maintenus par folder-counters.pb.js).

  var r = folderRows.length ? folderRows[0] : null;
  return e.json(200, {
    inboxUnread: r ? r.inboxUnread : 0,
    inboxTotal: r ? r.inboxTotal : 0,
    starred: starred,
    unread: unread,
    sent: r ? r.sent : 0,
    drafts: drafts,
    trash: r ? r.trash : 0,
    allMail: r ? r.allMail : 0,
    allMailUnread30: allMailUnread30,
    spam: r ? r.spam : 0,
  });
}, $apis.requireAuth());
