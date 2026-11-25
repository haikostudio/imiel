/// <reference path="../pb_data/types.d.ts" />

// thread-labels.pb.js
// Override explicite des labels au niveau d'une conversation (thread).
//
// Endpoints :
//   GET    /api/mail/thread/{threadId}/labels
//   POST   /api/mail/thread/{threadId}/label/{labelId}   body: { mode }
//   DELETE /api/mail/thread/{threadId}/label/{labelId}

// Helpers inlines dans chaque handler (les `var` top-level dans pb_hooks ne
// sont pas toujours visibles depuis les closures de routerAdd selon la
// version de Goja - on duplique plutot que de chasser le scoping).

// ---------------------------------------------------------------------------
// GET /api/mail/thread/{threadId}/labels
// ---------------------------------------------------------------------------
routerAdd("GET", "/api/mail/thread/{threadId}/labels", (e) => {
  var authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }
  var threadId = e.request.pathValue("threadId");
  if (!threadId) {
    throw new BadRequestError("threadId is required");
  }

  // Charger les ids+labels des messages du thread (filtre cross-account via user)
  var rows = arrayOf(new DynamicModel({ "id": "", "labels": "" }));
  try {
    $app.db().newQuery(
      "SELECT m.id, CAST(m.labels AS TEXT) AS labels FROM messages m " +
      "JOIN accounts a ON m.account = a.id " +
      "WHERE m.thread_id = {:tid} AND a.user = {:uid}"
    ).bind({ tid: threadId, uid: authRecord.id }).all(rows);
  } catch (err) {
    console.log("thread-labels GET: SQL error: " + err);
    return e.json(500, { error: "query_failed" });
  }

  var labelSet = {};
  for (var i = 0; i < rows.length; i++) {
    var raw = rows[i].labels;
    if (!raw) continue;
    var ids = [];
    try {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.length) ids = parsed;
    } catch (_) { /* string non-JSON */ }
    for (var j = 0; j < ids.length; j++) {
      if (ids[j]) labelSet[ids[j]] = true;
    }
  }
  var labelIds = Object.keys(labelSet);

  // Charger les overrides
  var overrideOut = [];
  try {
    var overrides = $app.findRecordsByFilter(
      "thread_labels",
      "user = {:uid} && thread_id = {:tid}",
      "",
      200,
      0,
      { uid: authRecord.id, tid: threadId }
    );
    for (var k = 0; k < overrides.length; k++) {
      overrideOut.push({
        label: overrides[k].get("label"),
        mode: overrides[k].get("mode"),
      });
    }
  } catch (err) {
    // Collection peut ne pas exister encore (migration pas jouee)
    console.log("thread-labels GET: overrides lookup error: " + err);
  }

  return e.json(200, {
    thread_id: threadId,
    labels: labelIds,
    overrides: overrideOut,
  });
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// POST /api/mail/thread/{threadId}/label/{labelId}  body: { mode }
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/mail/thread/{threadId}/label/{labelId}", (e) => {
  var authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }
  var threadId = e.request.pathValue("threadId");
  var labelId = e.request.pathValue("labelId");
  if (!threadId || !labelId) {
    throw new BadRequestError("threadId and labelId are required");
  }
  var body = e.requestInfo().body || {};
  var mode = body.mode;
  if (mode !== "included" && mode !== "excluded") {
    throw new BadRequestError("mode must be 'included' or 'excluded'");
  }

  // 1. Verifier que le label appartient au user
  var labelRec;
  try {
    labelRec = $app.findRecordById("labels", labelId);
  } catch (_) {
    throw new BadRequestError("Label not found");
  }
  if (labelRec.get("user") !== authRecord.id) {
    throw new ForbiddenError("Label not owned by user");
  }

  // 2. Upsert override dans thread_labels
  var existing = null;
  try {
    var existingArr = $app.findRecordsByFilter(
      "thread_labels",
      "user = {:uid} && thread_id = {:tid} && label = {:lid}",
      "",
      1,
      0,
      { uid: authRecord.id, tid: threadId, lid: labelId }
    );
    if (existingArr.length > 0) existing = existingArr[0];
  } catch (_) {}

  if (existing) {
    if (existing.get("mode") !== mode) {
      existing.set("mode", mode);
      $app.save(existing);
    }
  } else {
    var coll = $app.findCollectionByNameOrId("thread_labels");
    var rec = new Record(coll);
    rec.set("user", authRecord.id);
    rec.set("thread_id", threadId);
    rec.set("label", labelId);
    rec.set("mode", mode);
    $app.save(rec);
  }

  // 3. Appliquer sur tous les messages du thread
  var msgRows = arrayOf(new DynamicModel({ "id": "", "labels": "" }));
  try {
    $app.db().newQuery(
      "SELECT m.id, CAST(m.labels AS TEXT) AS labels FROM messages m " +
      "JOIN accounts a ON m.account = a.id " +
      "WHERE m.thread_id = {:tid} AND a.user = {:uid}"
    ).bind({ tid: threadId, uid: authRecord.id }).all(msgRows);
  } catch (err) {
    console.log("thread-labels POST: load messages error: " + err);
    return e.json(500, { error: "load_messages_failed" });
  }

  var changed = 0;
  for (var i = 0; i < msgRows.length; i++) {
    var raw = msgRows[i].labels;
    var current = [];
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.length) current = parsed;
      } catch (_) {}
    }
    var has = false;
    for (var j = 0; j < current.length; j++) {
      if (current[j] === labelId) { has = true; break; }
    }
    var next = null;
    if (mode === "included" && !has) {
      next = current.concat([labelId]);
    } else if (mode === "excluded" && has) {
      next = [];
      for (var k = 0; k < current.length; k++) {
        if (current[k] !== labelId) next.push(current[k]);
      }
    }
    if (next === null) continue;
    try {
      var msgRec = $app.findRecordById("messages", msgRows[i].id);
      msgRec.set("labels", next);
      $app.save(msgRec);
      changed++;
    } catch (err) {
      console.log("thread-labels POST: PB save failed for " + msgRows[i].id + ", fallback SQL: " + err);
      try {
        $app.db().newQuery(
          "UPDATE messages SET labels = {:val}, updated = {:now} WHERE id = {:id}"
        ).bind({
          val: JSON.stringify(next),
          now: new Date().toISOString().replace("T", " "),
          id: msgRows[i].id,
        }).execute();
        // Le SQL brut ne declenche pas le hook onRecordAfterUpdateSuccess
        // qui maintient message_labels (lue par /api/mail/label-counts).
        // On synchronise manuellement la table de jointure ici, sinon les
        // compteurs sidebar derivent.
        try {
          $app.db().newQuery(
            "DELETE FROM message_labels WHERE message = {:mid}"
          ).bind({ mid: msgRows[i].id }).execute();
          for (var li = 0; li < next.length; li++) {
            var lid = next[li];
            if (!lid) continue;
            $app.db().newQuery(
              "INSERT INTO message_labels (id, user, message, label) " +
              "VALUES (lower(substr(hex(randomblob(16)), 1, 15)), {:uid}, {:mid}, {:lid}) " +
              "ON CONFLICT(message, label) DO NOTHING"
            ).bind({
              uid: authRecord.id,
              mid: msgRows[i].id,
              lid: lid,
            }).execute();
          }
        } catch (e3) {
          console.log("thread-labels POST: message_labels sync failed for " + msgRows[i].id + ": " + e3);
        }
        changed++;
      } catch (e2) {
        console.log("thread-labels POST: SQL fallback failed for " + msgRows[i].id + ": " + e2);
      }
    }
  }

  return e.json(200, {
    status: "ok",
    mode: mode,
    applied: { messages_updated: changed, total_messages: msgRows.length },
  });
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// DELETE /api/mail/thread/{threadId}/label/{labelId}
// Retire l'override (les labels actuels sur les messages restent inchanges).
// ---------------------------------------------------------------------------
routerAdd("DELETE", "/api/mail/thread/{threadId}/label/{labelId}", (e) => {
  var authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }
  var threadId = e.request.pathValue("threadId");
  var labelId = e.request.pathValue("labelId");
  if (!threadId || !labelId) {
    throw new BadRequestError("threadId and labelId are required");
  }

  var existing = null;
  try {
    var existingArr = $app.findRecordsByFilter(
      "thread_labels",
      "user = {:uid} && thread_id = {:tid} && label = {:lid}",
      "",
      1,
      0,
      { uid: authRecord.id, tid: threadId, lid: labelId }
    );
    if (existingArr.length > 0) existing = existingArr[0];
  } catch (_) {}

  if (!existing) {
    return e.json(200, { status: "deleted", already_deleted: true });
  }
  $app.delete(existing);
  return e.json(200, { status: "deleted" });
}, $apis.requireAuth());
