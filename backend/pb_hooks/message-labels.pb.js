/// <reference path="../pb_data/types.d.ts" />

// message-labels.pb.js
// Maintient la table de jointure message_labels en miroir de messages.labels.
//
// La table est lue par /api/mail/label-counts (compteurs sidebar) ; sans cette
// synchro, les compteurs derivent. Le delete est gere par cascade FK quand un
// message ou un label est supprime, donc on ne s'occupe que de create/update.
//
// IMPORTANT (PocketBase 0.25 / JSVM) : les callbacks de hook s'executent dans
// un runtime ISOLE qui n'a PAS acces aux fonctions/variables definies au niveau
// top-level du fichier. Tout helper doit donc etre defini A L'INTERIEUR du
// handler (sinon ReferenceError au moment ou le hook se declenche, qui fait
// echouer le save du message -> 400 "Failed to update record").

// ---------------------------------------------------------------------------
// Hook : creation d'un message -> materialiser les labels s'il y en a.
// ---------------------------------------------------------------------------
onRecordAfterCreateSuccess(function (e) {
  // Normalise record.get("labels") : []string (relation multi), string JSON
  // (cast SQL), ou null/undefined.
  var coerceLabelIds = function (raw) {
    if (!raw) return [];
    if (typeof raw === "string") {
      try {
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) { return []; }
    }
    if (typeof raw === "object" && typeof raw.string === "function") {
      try {
        var p = JSON.parse(raw.string());
        return Array.isArray(p) ? p : [];
      } catch (_) { return []; }
    }
    if (raw.length === undefined) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      if (raw[i]) out.push(String(raw[i]));
    }
    return out;
  };

  var lookupUserId = function (app, accountId) {
    if (!accountId) return "";
    var rows = arrayOf(new DynamicModel({ "user": "" }));
    try {
      app.db().newQuery("SELECT user FROM accounts WHERE id = {:aid}")
        .bind({ "aid": accountId }).all(rows);
    } catch (err) {
      console.log("message-labels: lookup user failed: " + err);
      return "";
    }
    return rows.length ? rows[0].user : "";
  };

  var syncMessageLabels = function (app, messageId, accountId, labelIds) {
    if (!messageId) return;
    var userId = lookupUserId(app, accountId);
    if (!userId) return;
    try {
      app.db().newQuery("DELETE FROM message_labels WHERE message = {:mid}")
        .bind({ "mid": messageId }).execute();
    } catch (err) {
      console.log("message-labels: delete failed for " + messageId + ": " + err);
      return;
    }
    for (var i = 0; i < labelIds.length; i++) {
      var lid = labelIds[i];
      if (!lid) continue;
      try {
        app.db().newQuery(
          "INSERT INTO message_labels (id, user, message, label) " +
          "VALUES (lower(substr(hex(randomblob(16)), 1, 15)), {:uid}, {:mid}, {:lid}) " +
          "ON CONFLICT(message, label) DO NOTHING"
        ).bind({ "uid": userId, "mid": messageId, "lid": lid }).execute();
      } catch (err) {
        console.log("message-labels: insert failed for " + messageId + "/" + lid + ": " + err);
      }
    }
  };

  var rec = e.record;
  var labelIds = coerceLabelIds(rec.get("labels"));
  if (labelIds.length > 0) {
    syncMessageLabels(e.app, rec.id, rec.get("account"), labelIds);
  }

  // OBLIGATOIRE (PB 0.25) : continuer la chaine d'event pour que le broadcaster
  // realtime natif emette bien l'event SSE "messages" (cf hook update plus bas).
  e.next();
}, "messages");

// ---------------------------------------------------------------------------
// Hook : update d'un message -> resync uniquement si la liste de labels a
// change (on n'invalide pas a chaque toggle is_read / is_starred).
// ---------------------------------------------------------------------------
onRecordAfterUpdateSuccess(function (e) {
  var coerceLabelIds = function (raw) {
    if (!raw) return [];
    if (typeof raw === "string") {
      try {
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) { return []; }
    }
    if (typeof raw === "object" && typeof raw.string === "function") {
      try {
        var p = JSON.parse(raw.string());
        return Array.isArray(p) ? p : [];
      } catch (_) { return []; }
    }
    if (raw.length === undefined) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      if (raw[i]) out.push(String(raw[i]));
    }
    return out;
  };

  var arraysEqualUnordered = function (a, b) {
    if (a.length !== b.length) return false;
    var sa = a.slice().sort();
    var sb = b.slice().sort();
    for (var i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
  };

  var lookupUserId = function (app, accountId) {
    if (!accountId) return "";
    var rows = arrayOf(new DynamicModel({ "user": "" }));
    try {
      app.db().newQuery("SELECT user FROM accounts WHERE id = {:aid}")
        .bind({ "aid": accountId }).all(rows);
    } catch (err) {
      console.log("message-labels: lookup user failed: " + err);
      return "";
    }
    return rows.length ? rows[0].user : "";
  };

  var syncMessageLabels = function (app, messageId, accountId, labelIds) {
    if (!messageId) return;
    var userId = lookupUserId(app, accountId);
    if (!userId) return;
    try {
      app.db().newQuery("DELETE FROM message_labels WHERE message = {:mid}")
        .bind({ "mid": messageId }).execute();
    } catch (err) {
      console.log("message-labels: delete failed for " + messageId + ": " + err);
      return;
    }
    for (var i = 0; i < labelIds.length; i++) {
      var lid = labelIds[i];
      if (!lid) continue;
      try {
        app.db().newQuery(
          "INSERT INTO message_labels (id, user, message, label) " +
          "VALUES (lower(substr(hex(randomblob(16)), 1, 15)), {:uid}, {:mid}, {:lid}) " +
          "ON CONFLICT(message, label) DO NOTHING"
        ).bind({ "uid": userId, "mid": messageId, "lid": lid }).execute();
      } catch (err) {
        console.log("message-labels: insert failed for " + messageId + "/" + lid + ": " + err);
      }
    }
  };

  var rec = e.record;
  var original = rec.original();
  var oldLabels = coerceLabelIds(original.get("labels"));
  var newLabels = coerceLabelIds(rec.get("labels"));
  if (!arraysEqualUnordered(oldLabels, newLabels)) {
    syncMessageLabels(e.app, rec.id, rec.get("account"), newLabels);
  }

  // OBLIGATOIRE (PB 0.25) : sans e.next(), la chaine d'event s'arrete ici et le
  // broadcaster realtime natif ne s'execute jamais -> aucun event SSE "messages"
  // n'est emis (la liste/les conversations ne se rafraichissent pas en direct).
  e.next();
}, "messages");
