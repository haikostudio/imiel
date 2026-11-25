/// <reference path="../pb_data/types.d.ts" />

// message-flags.js
// Toggle is_read / is_starred on messages.
// Tries PocketBase record API first (triggers realtime SSE for multi-device).
// Falls back to direct SQL if PB validation fails (stale relations, etc.).

routerAdd("PATCH", "/api/mail/message-flags/{id}", (e) => {
  var id = e.request.pathValue("id");
  var body = $apis.requestInfo(e).body;

  // Validate that only allowed fields are being updated
  var allowed = ["is_read", "is_starred"];
  var updates = {};
  var hasUpdates = false;

  for (var i = 0; i < allowed.length; i++) {
    var field = allowed[i];
    if (body[field] !== undefined && body[field] !== null) {
      updates[field] = !!body[field];
      hasUpdates = true;
    }
  }

  if (!hasUpdates) {
    return e.json(400, { error: "No valid fields to update" });
  }

  // Verify the message belongs to the authenticated user
  var userId = e.auth.id;
  var rows = arrayOf(new DynamicModel({ "cnt": 0 }));
  e.app.db().newQuery(
    "SELECT COUNT(*) as cnt FROM messages m " +
    "JOIN accounts a ON m.account = a.id " +
    "WHERE m.id = {:id} AND a.user = {:userId}"
  ).bind({ "id": id, "userId": userId }).all(rows);

  if (!rows.length || rows[0].cnt === 0) {
    return e.json(404, { error: "Message not found" });
  }

  // Try PocketBase record API first (triggers realtime events)
  var usedFallback = false;
  try {
    var record = e.app.findRecordById("messages", id);
    var keys = Object.keys(updates);
    for (var k = 0; k < keys.length; k++) {
      record.set(keys[k], updates[keys[k]]);
    }
    e.app.save(record);
  } catch (err) {
    // PB validation failed (likely stale relation) — fallback to SQL
    console.log("message-flags: PB save failed, using SQL fallback: " + err);
    usedFallback = true;

    var setClauses = [];
    var bindings = { "id": id };
    var keys2 = Object.keys(updates);
    for (var j = 0; j < keys2.length; j++) {
      setClauses.push(keys2[j] + " = {:v_" + keys2[j] + "}");
      bindings["v_" + keys2[j]] = updates[keys2[j]];
    }

    bindings["now"] = new Date().toISOString().replace("T", " ");
    e.app.db().newQuery(
      "UPDATE messages SET " + setClauses.join(", ") + ", updated = {:now} WHERE id = {:id}"
    ).bind(bindings).execute();

    // Update folder counters manually (PB hooks won't fire on SQL)
    if (updates["is_read"] !== undefined) {
      try {
        var msgRows = arrayOf(new DynamicModel({ "folder": "" }));
        e.app.db().newQuery(
          "SELECT folder FROM messages WHERE id = {:id}"
        ).bind({ "id": id }).all(msgRows);
        if (msgRows.length && msgRows[0].folder) {
          e.app.db().newQuery(
            "UPDATE folders SET " +
              "unread_count = (SELECT COUNT(*) FROM messages WHERE folder = {:fid} AND is_read = FALSE), " +
              "updated = {:now} " +
            "WHERE id = {:fid}"
          ).bind({
            "fid": msgRows[0].folder,
            "now": new Date().toISOString().replace("T", " "),
          }).execute();
        }
      } catch (counterErr) {
        console.log("message-flags: folder counter update failed: " + counterErr);
      }
    }
  }

  return e.json(200, { success: true, fallback: usedFallback });
}, $apis.requireAuth());
