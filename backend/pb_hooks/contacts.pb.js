/// <reference path="../pb_data/types.d.ts" />

// contacts.pb.js
// Auto-populate contacts from messages and provide backfill API.

// ---------------------------------------------------------------------------
// Hook: after message creation, extract contacts
// ---------------------------------------------------------------------------
onRecordAfterCreateSuccess(function (e) {
  // OBLIGATOIRE (PB 0.25) : e.next() EN PREMIER. Ce handler peut sortir en
  // avance (return) si le message n'a pas de compte ; appeler e.next() en tete
  // garantit que le broadcaster realtime natif s'execute sur tous les chemins.
  e.next();

  var message = e.record;
  var accountId = message.get("account");
  if (!accountId) return;

  var parseJson = function (val) {
    if (!val) return null;
    if (typeof val === "string") {
      try { return JSON.parse(val); } catch (_) { return null; }
    }
    if (typeof val === "object" && typeof val.string === "function") {
      try { return JSON.parse(val.string()); } catch (_) { return null; }
    }
    return val;
  };

  var upsert = function (app, uid, name, email, date) {
    if (!email || !email.includes("@")) return;
    var emailLower = email.toLowerCase().trim();
    var contactName = (name || "").trim();
    var existing;
    try {
      var recs = app.findRecordsByFilter("contacts", "user = {:userId} && email = {:email}", "", 1, 0, { userId: uid, email: emailLower });
      if (recs.length > 0) existing = recs[0];
    } catch (_) {}
    if (existing) {
      existing.set("message_count", (existing.get("message_count") || 0) + 1);
      if (contactName && !existing.get("name")) existing.set("name", contactName);
      var ed = existing.get("last_contact_date");
      if (date && (!ed || date > ed)) existing.set("last_contact_date", date);
      app.save(existing);
    } else {
      var col = app.findCollectionByNameOrId("contacts");
      var rec = new Record(col);
      rec.set("user", uid);
      rec.set("name", contactName);
      rec.set("email", emailLower);
      rec.set("last_contact_date", date || new Date().toISOString());
      rec.set("message_count", 1);
      app.save(rec);
    }
  };

  try {
    var account = e.app.findRecordById("accounts", accountId);
    var userId = account.get("user");
    var date = message.get("date") || new Date().toISOString();

    var fromAddr = parseJson(message.get("from_address"));
    if (fromAddr && fromAddr.address) {
      upsert(e.app, userId, fromAddr.name || "", fromAddr.address, date);
    }

    var toAddrs = parseJson(message.get("to_addresses")) || [];
    for (var i = 0; i < toAddrs.length; i++) {
      if (toAddrs[i] && toAddrs[i].address) {
        upsert(e.app, userId, toAddrs[i].name || "", toAddrs[i].address, date);
      }
    }

    var ccAddrs = parseJson(message.get("cc_addresses")) || [];
    for (var j = 0; j < ccAddrs.length; j++) {
      if (ccAddrs[j] && ccAddrs[j].address) {
        upsert(e.app, userId, ccAddrs[j].name || "", ccAddrs[j].address, date);
      }
    }
  } catch (err) {
    console.log("Contact extraction error: " + err);
  }
}, "messages");

// ---------------------------------------------------------------------------
// API: backfill contacts from existing messages
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/contacts/backfill", function (e) {
  var authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  var userId = authRecord.id;

  var parseJson = function (val) {
    if (!val) return null;
    if (typeof val === "string") {
      try { return JSON.parse(val); } catch (_) { return null; }
    }
    if (typeof val === "object" && typeof val.string === "function") {
      try { return JSON.parse(val.string()); } catch (_) { return null; }
    }
    return val;
  };

  var doUpsert = function (app, uid, name, email, date) {
    if (!email || !email.includes("@")) return;
    var emailLower = email.toLowerCase().trim();
    var contactName = (name || "").trim();

    var existing;
    try {
      var records = app.findRecordsByFilter(
        "contacts",
        "user = {:userId} && email = {:email}",
        "",
        1,
        0,
        { userId: uid, email: emailLower }
      );
      if (records.length > 0) {
        existing = records[0];
      }
    } catch (_) {}

    if (existing) {
      var count = (existing.get("message_count") || 0) + 1;
      existing.set("message_count", count);
      if (contactName && !existing.get("name")) {
        existing.set("name", contactName);
      }
      var existingDate = existing.get("last_contact_date");
      if (date && (!existingDate || date > existingDate)) {
        existing.set("last_contact_date", date);
      }
      app.save(existing);
    } else {
      var collection = app.findCollectionByNameOrId("contacts");
      var record = new Record(collection);
      record.set("user", uid);
      record.set("name", contactName);
      record.set("email", emailLower);
      record.set("last_contact_date", date || new Date().toISOString());
      record.set("message_count", 1);
      app.save(record);
    }
  };

  var doExtract = function (app, uid, message) {
    var date = message.get("date") || new Date().toISOString();

    var fromAddr = parseJson(message.get("from_address"));
    if (fromAddr && fromAddr.address) {
      doUpsert(app, uid, fromAddr.name || "", fromAddr.address, date);
    }

    var toAddrs = parseJson(message.get("to_addresses")) || [];
    for (var i = 0; i < toAddrs.length; i++) {
      if (toAddrs[i] && toAddrs[i].address) {
        doUpsert(app, uid, toAddrs[i].name || "", toAddrs[i].address, date);
      }
    }

    var ccAddrs = parseJson(message.get("cc_addresses")) || [];
    for (var j = 0; j < ccAddrs.length; j++) {
      if (ccAddrs[j] && ccAddrs[j].address) {
        doUpsert(app, uid, ccAddrs[j].name || "", ccAddrs[j].address, date);
      }
    }
  };

  // Get all user accounts
  var accounts;
  try {
    accounts = $app.findRecordsByFilter(
      "accounts",
      "user = {:userId}",
      "",
      100,
      0,
      { userId: userId }
    );
  } catch (_) {
    accounts = [];
  }

  var contactCount = 0;
  for (var a = 0; a < accounts.length; a++) {
    var accountId = accounts[a].id;
    var page = 0;
    var perPage = 500;

    while (true) {
      var messages;
      try {
        messages = $app.findRecordsByFilter(
          "messages",
          "account = {:accountId}",
          "-date",
          perPage,
          page * perPage,
          { accountId: accountId }
        );
      } catch (_) {
        messages = [];
      }

      if (messages.length === 0) break;

      for (var m = 0; m < messages.length; m++) {
        doExtract($app, userId, messages[m]);
        contactCount++;
      }

      if (messages.length < perPage) break;
      page++;
    }
  }

  return e.json(200, { status: "backfilled", messages_processed: contactCount });
}, $apis.requireAuth());
