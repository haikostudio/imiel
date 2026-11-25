/// <reference path="../pb_data/types.d.ts" />

// folder-counters.js
// Recalculates folder unread_count and total_count when a message's folder changes.
//
// IMPORTANT (PocketBase 0.25 / JSVM) : les callbacks de hook s'executent dans
// un runtime ISOLE sans acces au scope top-level du fichier. Le helper
// updateFolderCounts doit donc etre defini A L'INTERIEUR de chaque handler,
// sinon ReferenceError au declenchement -> le create/update/delete du message
// echoue (400) alors que le record est deja persiste.

// ---------------------------------------------------------------------------
// Hook: after message update, check if folder or is_read changed
// ---------------------------------------------------------------------------
onRecordAfterUpdateSuccess((e) => {
  var updateFolderCounts = function (app, folderId) {
    if (!folderId) return;
    try {
      app.db().newQuery(
        "UPDATE folders SET " +
          "total_count = (SELECT COUNT(*) FROM messages WHERE folder = {:fid}), " +
          "unread_count = (SELECT COUNT(*) FROM messages WHERE folder = {:fid} AND is_read = FALSE), " +
          "updated = {:now} " +
        "WHERE id = {:fid}"
      ).bind({
        "fid": folderId,
        "now": new Date().toISOString().replace("T", " "),
      }).execute();
    } catch (err) {
      console.log("folder-counters: failed to update folder " + folderId + ": " + err);
    }
  };

  const record = e.record;
  const original = record.original();
  const oldFolderId = original.get("folder");
  const newFolderId = record.get("folder");
  const oldIsRead = original.get("is_read");
  const newIsRead = record.get("is_read");

  if (oldFolderId !== newFolderId) {
    updateFolderCounts(e.app, oldFolderId);
    updateFolderCounts(e.app, newFolderId);
  } else if (oldIsRead !== newIsRead) {
    updateFolderCounts(e.app, newFolderId);
  }

  // OBLIGATOIRE (PB 0.25) : sans e.next(), la chaine s'arrete et le broadcaster
  // realtime natif n'emet jamais l'event SSE "messages".
  e.next();
}, "messages");

// ---------------------------------------------------------------------------
// Hook: after message create, update the target folder count
// ---------------------------------------------------------------------------
onRecordAfterCreateSuccess((e) => {
  var updateFolderCounts = function (app, folderId) {
    if (!folderId) return;
    try {
      app.db().newQuery(
        "UPDATE folders SET " +
          "total_count = (SELECT COUNT(*) FROM messages WHERE folder = {:fid}), " +
          "unread_count = (SELECT COUNT(*) FROM messages WHERE folder = {:fid} AND is_read = FALSE), " +
          "updated = {:now} " +
        "WHERE id = {:fid}"
      ).bind({
        "fid": folderId,
        "now": new Date().toISOString().replace("T", " "),
      }).execute();
    } catch (err) {
      console.log("folder-counters: failed to update folder " + folderId + ": " + err);
    }
  };

  updateFolderCounts(e.app, e.record.get("folder"));

  // OBLIGATOIRE (PB 0.25) : continuer la chaine pour le broadcaster realtime.
  e.next();
}, "messages");

// ---------------------------------------------------------------------------
// Hook: after message delete, update the source folder count
// ---------------------------------------------------------------------------
onRecordAfterDeleteSuccess((e) => {
  var updateFolderCounts = function (app, folderId) {
    if (!folderId) return;
    try {
      app.db().newQuery(
        "UPDATE folders SET " +
          "total_count = (SELECT COUNT(*) FROM messages WHERE folder = {:fid}), " +
          "unread_count = (SELECT COUNT(*) FROM messages WHERE folder = {:fid} AND is_read = FALSE), " +
          "updated = {:now} " +
        "WHERE id = {:fid}"
      ).bind({
        "fid": folderId,
        "now": new Date().toISOString().replace("T", " "),
      }).execute();
    } catch (err) {
      console.log("folder-counters: failed to update folder " + folderId + ": " + err);
    }
  };

  updateFolderCounts(e.app, e.record.get("folder"));

  // OBLIGATOIRE (PB 0.25) : continuer la chaine pour le broadcaster realtime.
  e.next();
}, "messages");
