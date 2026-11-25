/// <reference path="../pb_data/types.d.ts" />

// mail-actions.pb.js
// Headless mail API: explicit draft CRUD, message listing/detail,
// message actions (read/star/answered/move/archive/trash/spam/inbox/priority),
// permanent delete, and account/folder discovery.
// All operations are PB-record based (same model as message-flags.pb.js):
// IMAP server is reconciled on the next sync.

var MAIL_WORKER_URL_ACTIONS = $os.getenv("MAIL_WORKER_URL") || "http://localhost:4001";

// ---------------------------------------------------------------------------
// Helper: Bayes learn fire-and-forget. Called when user moves a message
// to/from spam manually. Updates Rspamd Bayes and invalidates trust cache.
// "type" must be "spam" or "ham".
// ---------------------------------------------------------------------------
var bayesLearn = function(accountId, messageId, type) {
  try {
    $http.send({
      url: MAIL_WORKER_URL_ACTIONS + "/spam/learn",
      method: "POST",
      body: JSON.stringify({
        accountId: accountId,
        messageId: messageId,
        type: type,
      }),
      headers: { "Content-Type": "application/json" },
      timeout: 15,
    });
  } catch (err) {
    console.log("Bayes learn skipped: " + err);
  }
};

// Resolve a folder type by id (for "move" action). Returns "" if unknown.
var folderTypeById = function(app, folderId) {
  try {
    var f = app.findRecordById("folders", folderId);
    return f.get("type") || "";
  } catch (_) {
    return "";
  }
};

// ---------------------------------------------------------------------------
// Helper: verify a message belongs to the authenticated user, return record
// ---------------------------------------------------------------------------
var ownedMessage = function(app, messageId, userId) {
  var record = app.findRecordById("messages", messageId);
  var account = app.findRecordById("accounts", record.get("account"));
  if (account.get("user") !== userId) {
    throw new ForbiddenError("Not your message");
  }
  return record;
};

// ---------------------------------------------------------------------------
// Helper: verify account ownership, return account record
// ---------------------------------------------------------------------------
var ownedAccount = function(app, accountId, userId) {
  var account = app.findRecordById("accounts", accountId);
  if (account.get("user") !== userId) {
    throw new ForbiddenError("Not your account");
  }
  return account;
};

// ---------------------------------------------------------------------------
// Helper: resolve a folder record id for an account by folder type
// ---------------------------------------------------------------------------
var folderIdByType = function(app, accountId, type) {
  try {
    var folders = app.findRecordsByFilter(
      "folders",
      "account = {:accountId} && type = {:type}",
      "",
      1,
      0,
      { accountId: accountId, type: type }
    );
    if (folders.length > 0) {
      return folders[0].id;
    }
  } catch (_) {}
  return "";
};

// ---------------------------------------------------------------------------
// Helper: serialize a message record for API responses
// ---------------------------------------------------------------------------
var serializeMessage = function(record, full) {
  var out = {
    id: record.id,
    account: record.get("account"),
    folder: record.get("folder"),
    message_id: record.get("message_id"),
    thread_id: record.get("thread_id"),
    from: record.get("from_address"),
    to: record.get("to_addresses"),
    cc: record.get("cc_addresses"),
    subject: record.get("subject"),
    snippet: record.get("snippet") || (record.get("text_body") || "").substring(0, 200),
    date: record.get("date"),
    is_read: record.get("is_read"),
    is_starred: record.get("is_starred"),
    is_answered: record.get("is_answered"),
    is_draft: record.get("is_draft"),
    is_sent: record.get("is_sent"),
    has_attachments: record.get("has_attachments"),
    priority: record.get("priority"),
    labels: record.get("labels"),
  };
  if (full) {
    out.in_reply_to = record.get("in_reply_to");
    out.references = record.get("references");
    out.bcc = record.get("bcc_addresses");
    out.text_body = record.get("text_body");
    out.html_body = record.get("html_body");
    out.raw_headers = record.get("raw_headers");
    out.attachments = record.get("attachments");
    out.draft_reply_to = record.get("draft_reply_to");
    out.auto_saved_at = record.get("auto_saved_at");
  }
  return out;
};

// ---------------------------------------------------------------------------
// Helper: apply draft body fields onto a record
// ---------------------------------------------------------------------------
var applyDraftFields = function(record, body) {
  if (body.to !== undefined) record.set("to_addresses", body.to || []);
  if (body.cc !== undefined) record.set("cc_addresses", body.cc || []);
  if (body.bcc !== undefined) record.set("bcc_addresses", body.bcc || []);
  if (body.subject !== undefined) record.set("subject", body.subject || "");
  if (body.text_body !== undefined) record.set("text_body", body.text_body || "");
  if (body.html_body !== undefined) record.set("html_body", body.html_body || "");
  if (body.in_reply_to !== undefined) record.set("in_reply_to", body.in_reply_to || "");
  if (body.references !== undefined) record.set("references", body.references || []);
  if (body.draft_reply_to !== undefined) record.set("draft_reply_to", body.draft_reply_to || "");
  if (body.priority !== undefined) record.set("priority", body.priority || "normal");
};

// ===========================================================================
// API: create a draft (explicit, always creates a new record)
// ===========================================================================
routerAdd("POST", "/api/mail/draft", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body;
  const accountId = body.account_id;
  if (!accountId) {
    throw new BadRequestError("account_id is required");
  }

  const account = ownedAccount($app, accountId, authRecord.id);

  const collection = $app.findCollectionByNameOrId("messages");
  const record = new Record(collection);
  record.set("account", accountId);
  record.set("is_draft", true);
  record.set("is_read", true);

  applyDraftFields(record, body);

  record.set("from_address", {
    name: account.get("display_name") || "",
    address: account.get("email"),
  });

  const now = new Date().toISOString();
  record.set("auto_saved_at", now);
  record.set("date", now);

  const draftsFolder = folderIdByType($app, accountId, "drafts");
  if (draftsFolder) {
    record.set("folder", draftsFolder);
  }

  try {
    $app.save(record);
  } catch (saveErr) {
    // PB 0.25: after-create hooks may throw but the record still persists.
    if (!record.id) {
      throw saveErr;
    }
    console.log("mail-actions: draft save threw but persisted (" + record.id + "): " + saveErr);
  }

  return e.json(200, {
    status: "created",
    draft_id: record.id,
    draft: serializeMessage(record, true),
  });
}, $apis.requireAuth());

// ===========================================================================
// API: get a single draft (full content)
// ===========================================================================
routerAdd("GET", "/api/mail/draft/{draftId}", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const draftId = e.request.pathValue("draftId");
  if (!draftId) {
    throw new BadRequestError("draftId is required");
  }

  let record;
  try {
    record = ownedMessage($app, draftId, authRecord.id);
  } catch (err) {
    return e.json(404, { error: "Draft not found" });
  }

  if (!record.get("is_draft")) {
    throw new BadRequestError("Message is not a draft");
  }

  return e.json(200, { draft: serializeMessage(record, true) });
}, $apis.requireAuth());

// ===========================================================================
// API: update a draft (explicit partial update)
// ===========================================================================
routerAdd("PATCH", "/api/mail/draft/{draftId}", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const draftId = e.request.pathValue("draftId");
  if (!draftId) {
    throw new BadRequestError("draftId is required");
  }

  const body = e.requestInfo().body;

  let record;
  try {
    record = ownedMessage($app, draftId, authRecord.id);
  } catch (err) {
    return e.json(404, { error: "Draft not found" });
  }

  if (!record.get("is_draft")) {
    throw new BadRequestError("Message is not a draft");
  }

  applyDraftFields(record, body);

  const now = new Date().toISOString();
  record.set("auto_saved_at", now);
  record.set("date", now);

  $app.save(record);

  return e.json(200, {
    status: "updated",
    draft_id: record.id,
    draft: serializeMessage(record, true),
  });
}, $apis.requireAuth());

// ===========================================================================
// API: list messages with filters
// GET /api/mail/messages?account_id=&folder_id=&folder_type=&is_read=&is_starred=
//   &is_draft=&has_attachments=&q=&page=&per_page=
// ===========================================================================
routerAdd("GET", "/api/mail/messages", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const query = e.request.url.query();
  const accountId = query.get("account_id") || "";
  const folderId = query.get("folder_id") || "";
  const folderType = query.get("folder_type") || "";
  const q = query.get("q") || "";
  const page = Math.max(parseInt(query.get("page") || "1", 10), 1);
  const perPage = Math.min(Math.max(parseInt(query.get("per_page") || "50", 10), 1), 200);

  const filterParts = ["account.user = {:userId}"];
  const filterParams = { userId: authRecord.id };

  if (accountId) {
    ownedAccount($app, accountId, authRecord.id);
    filterParts.push("account = {:accountId}");
    filterParams.accountId = accountId;
  }

  let resolvedFolderId = folderId;
  if (!resolvedFolderId && folderType && accountId) {
    resolvedFolderId = folderIdByType($app, accountId, folderType);
  }
  if (resolvedFolderId) {
    filterParts.push("folder = {:folderId}");
    filterParams.folderId = resolvedFolderId;
  }

  const boolFilters = ["is_read", "is_starred", "is_answered", "is_draft", "is_sent", "has_attachments"];
  for (let i = 0; i < boolFilters.length; i++) {
    const f = boolFilters[i];
    const v = query.get(f);
    if (v === "true" || v === "false") {
      filterParts.push(f + " = " + v);
    }
  }

  if (q && q.length >= 2) {
    filterParts.push("(subject ~ {:q} || text_body ~ {:q})");
    filterParams.q = q;
  }

  const filter = filterParts.join(" && ");
  const offset = (page - 1) * perPage;

  let records = [];
  try {
    records = $app.findRecordsByFilter("messages", filter, "-date", perPage, offset, filterParams);
  } catch (err) {
    console.log("mail-actions: list error: " + err);
  }

  let totalCount = 0;
  try {
    const all = $app.findRecordsByFilter("messages", filter, "", 0, 0, filterParams);
    totalCount = all.length;
  } catch (_) {}

  const items = [];
  for (let j = 0; j < records.length; j++) {
    items.push(serializeMessage(records[j], false));
  }

  return e.json(200, {
    items: items,
    page: page,
    per_page: perPage,
    total_items: totalCount,
    total_pages: Math.ceil(totalCount / perPage),
  });
}, $apis.requireAuth());

// ===========================================================================
// API: get a single message (full content)
// ===========================================================================
routerAdd("GET", "/api/mail/message/{id}", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const id = e.request.pathValue("id");
  if (!id) {
    throw new BadRequestError("id is required");
  }

  let record;
  try {
    record = ownedMessage($app, id, authRecord.id);
  } catch (err) {
    if (String(err).indexOf("Not your message") !== -1) {
      throw err;
    }
    return e.json(404, { error: "Message not found" });
  }

  return e.json(200, { message: serializeMessage(record, true) });
}, $apis.requireAuth());

// ===========================================================================
// API: perform an action on a message
// POST /api/mail/message/{id}/action
// body.action: read | unread | star | unstar | answered | unanswered
//   | archive | trash | spam | inbox | move | priority
// body.folder_id (for move) / body.priority (for priority)
// ===========================================================================
routerAdd("POST", "/api/mail/message/{id}/action", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const id = e.request.pathValue("id");
  if (!id) {
    throw new BadRequestError("id is required");
  }

  const body = e.requestInfo().body;
  const action = body.action;
  if (!action) {
    throw new BadRequestError("action is required");
  }

  let record;
  try {
    record = ownedMessage($app, id, authRecord.id);
  } catch (err) {
    if (String(err).indexOf("Not your message") !== -1) {
      throw err;
    }
    return e.json(404, { error: "Message not found" });
  }

  const accountId = record.get("account");

  switch (action) {
    case "read":
      record.set("is_read", true);
      break;
    case "unread":
      record.set("is_read", false);
      break;
    case "star":
      record.set("is_starred", true);
      break;
    case "unstar":
      record.set("is_starred", false);
      break;
    case "answered":
      record.set("is_answered", true);
      break;
    case "unanswered":
      record.set("is_answered", false);
      break;
    case "priority": {
      const p = body.priority;
      if (p !== "low" && p !== "normal" && p !== "high") {
        throw new BadRequestError("priority must be low, normal or high");
      }
      record.set("priority", p);
      break;
    }
    case "archive":
    case "trash":
    case "spam":
    case "inbox": {
      const targetFolder = folderIdByType($app, accountId, action);
      if (!targetFolder) {
        return e.json(400, { error: "No '" + action + "' folder for this account" });
      }
      record.set("folder", targetFolder);
      break;
    }
    case "move": {
      const folderId = body.folder_id;
      if (!folderId) {
        throw new BadRequestError("folder_id is required for move");
      }
      const folder = $app.findRecordById("folders", folderId);
      if (folder.get("account") !== accountId) {
        throw new BadRequestError("Folder does not belong to this message's account");
      }
      record.set("folder", folderId);
      break;
    }
    default:
      throw new BadRequestError("Unknown action: " + action);
  }

  $app.save(record);

  // Apprentissage Bayes : l'utilisateur vient de corriger manuellement le
  // routage spam <-> inbox. On enseigne Rspamd pour personnaliser le filtre.
  // - action "spam"           -> learn spam
  // - action "inbox"          -> learn ham
  // - action "move" vers spam -> learn spam
  // - action "move" vers inbox-> learn ham
  var learnType = "";
  if (action === "spam") {
    learnType = "spam";
  } else if (action === "inbox") {
    learnType = "ham";
  } else if (action === "move") {
    var moveTargetType = folderTypeById($app, body.folder_id);
    if (moveTargetType === "spam") learnType = "spam";
    else if (moveTargetType === "inbox") learnType = "ham";
  }
  if (learnType) {
    bayesLearn(accountId, id, learnType);
  }

  return e.json(200, {
    status: "ok",
    action: action,
    message: serializeMessage(record, false),
  });
}, $apis.requireAuth());

// ===========================================================================
// API: permanently delete a message
// ===========================================================================
routerAdd("DELETE", "/api/mail/message/{id}", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const id = e.request.pathValue("id");
  if (!id) {
    throw new BadRequestError("id is required");
  }

  let record;
  try {
    record = ownedMessage($app, id, authRecord.id);
  } catch (err) {
    if (String(err).indexOf("Not your message") !== -1) {
      throw err;
    }
    return e.json(200, { status: "deleted", already_deleted: true });
  }

  $app.delete(record);

  return e.json(200, { status: "deleted" });
}, $apis.requireAuth());

// ===========================================================================
// API: list the authenticated user's accounts (discovery)
// ===========================================================================
routerAdd("GET", "/api/mail/accounts", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  let records = [];
  try {
    records = $app.findRecordsByFilter(
      "accounts",
      "user = {:userId}",
      "label",
      200,
      0,
      { userId: authRecord.id }
    );
  } catch (_) {}

  const items = [];
  for (let i = 0; i < records.length; i++) {
    const a = records[i];
    items.push({
      id: a.id,
      label: a.get("label"),
      email: a.get("email"),
      display_name: a.get("display_name"),
      protocol: a.get("protocol"),
      sync_status: a.get("sync_status"),
      last_synced_at: a.get("last_synced_at"),
      is_active: a.get("is_active"),
      color: a.get("color"),
    });
  }

  return e.json(200, { accounts: items });
}, $apis.requireAuth());

// ===========================================================================
// API: list folders for an account (discovery)
// GET /api/mail/folders?account_id=
// ===========================================================================
routerAdd("GET", "/api/mail/folders", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const query = e.request.url.query();
  const accountId = query.get("account_id") || "";
  if (!accountId) {
    throw new BadRequestError("account_id is required");
  }

  ownedAccount($app, accountId, authRecord.id);

  let records = [];
  try {
    records = $app.findRecordsByFilter(
      "folders",
      "account = {:accountId}",
      "sort_order",
      500,
      0,
      { accountId: accountId }
    );
  } catch (_) {}

  const items = [];
  for (let i = 0; i < records.length; i++) {
    const f = records[i];
    items.push({
      id: f.id,
      name: f.get("name"),
      path: f.get("path"),
      type: f.get("type"),
      unread_count: f.get("unread_count"),
      total_count: f.get("total_count"),
      sort_order: f.get("sort_order"),
    });
  }

  return e.json(200, { folders: items });
}, $apis.requireAuth());
