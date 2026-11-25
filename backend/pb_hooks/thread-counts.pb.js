/// <reference path="../pb_data/types.d.ts" />

// thread-counts.pb.js
// Compteurs de messages par thread_id (badge "N conversations" cross-dossier),
// en SQL direct (bypass des access rules per-row).
//
// AVANT : useThreads.fetchCrossFolderCounts faisait des
// GET /api/collections/messages/records?filter=(thread_id="..." || ...) via
// l'API record PB, qui applique l'access rule `@request.auth.id = account.user`
// PAR LIGNE (JOIN users) -> 0,3-0,6 s par lot de 30 thread_ids, plusieurs lots
// par ouverture de dossier (conversation view) -> lenteur visible sur Envoyes,
// Spam, etc.
//
// ICI : un seul COUNT(DISTINCT message normalise) par thread_id, ownership en un
// JOIN accounts -> users dans le WHERE, index idx_msg_thread. ~5-20 ms.
//
// GET /api/mail/thread-counts?thread_ids=a,b,c   (max 300)
//   -> { counts: { "<thread_id>": <n>, ... } }
// n = nombre de messages distincts du thread (tous dossiers), is_draft exclus,
// dedup par message_id normalise (sinon par id) pour coller a la logique front.

routerAdd("GET", "/api/mail/thread-counts", (e) => {
  var authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }
  var userId = authRecord.id;

  var q = e.request.url.query();
  var raw = q.get("thread_ids") || "";
  var ids = raw.split(",").filter(function (s) { return s.length > 0; });
  if (ids.length === 0) {
    return e.json(200, { counts: {} });
  }
  if (ids.length > 300) {
    ids = ids.slice(0, 300);
  }

  var bindings = { "userId": userId };
  var placeholders = [];
  for (var i = 0; i < ids.length; i++) {
    var key = "tid_" + i;
    placeholders.push("{:" + key + "}");
    bindings[key] = ids[i];
  }

  // Dedup aligne sur le front : message_id sans <> ni casse ; fallback id.
  var sql =
    "SELECT m.thread_id AS thread_id, " +
    "  COUNT(DISTINCT CASE " +
    "    WHEN m.message_id IS NULL OR m.message_id = '' THEN m.id " +
    "    ELSE lower(trim(replace(replace(m.message_id, '<', ''), '>', ''))) " +
    "  END) AS cnt " +
    "FROM messages m " +
    "JOIN accounts a ON m.account = a.id " +
    "WHERE a.user = {:userId} " +
    "  AND m.is_draft = FALSE " +
    "  AND m.thread_id IN (" + placeholders.join(",") + ") " +
    "GROUP BY m.thread_id";

  var rows = arrayOf(new DynamicModel({ "thread_id": "", "cnt": 0 }));
  try {
    $app.db().newQuery(sql).bind(bindings).all(rows);
  } catch (err) {
    console.log("thread-counts error: " + err);
    return e.json(500, { error: "thread_counts_failed", detail: "" + err });
  }

  var counts = {};
  for (var j = 0; j < rows.length; j++) {
    counts[rows[j].thread_id] = rows[j].cnt;
  }

  return e.json(200, { counts: counts });
}, $apis.requireAuth());
