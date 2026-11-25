/// <reference path="../pb_data/types.d.ts" />

// mail-send.js
// API endpoint to send emails via the mail-worker service.

var MAIL_WORKER_URL = $os.getenv("MAIL_WORKER_URL") || "http://localhost:4001";

// ---------------------------------------------------------------------------
// Helper: call the mail-worker /send endpoint
// ---------------------------------------------------------------------------
var callWorkerSend = function(accountId, messageId) {
  const res = $http.send({
    url: MAIL_WORKER_URL + "/send",
    method: "POST",
    body: JSON.stringify({
      accountId: accountId,
      messageId: messageId,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    timeout: 60,
  });

  if (res.statusCode >= 400) {
    throw new Error("Failed to send email: " + res.raw);
  }

  return res.json;
};

// ---------------------------------------------------------------------------
// Helper: create a draft message record in PB for sending
// ---------------------------------------------------------------------------
var createDraftForSend = function(app, accountId, data) {
  const messages = app.findCollectionByNameOrId("messages");
  const record = new Record(messages);
  record.set("account", accountId);
  record.set("from_address", data.from || {});
  record.set("to_addresses", data.to || []);
  record.set("cc_addresses", data.cc || []);
  record.set("bcc_addresses", data.bcc || []);
  record.set("subject", data.subject || "");
  record.set("text_body", data.text_body || "");
  record.set("html_body", data.html_body || "");
  record.set("in_reply_to", data.in_reply_to || "");
  record.set("references", data.references || []);
  record.set("is_draft", true);
  record.set("is_read", true);
  record.set("date", new Date().toISOString());

  if (data.thread_id) {
    record.set("thread_id", data.thread_id);
  }

  // Assign to sent folder if possible
  try {
    const sentFolders = app.findRecordsByFilter(
      "folders",
      'account = {:accountId} && type = "sent"',
      "",
      1,
      0,
      { accountId: accountId }
    );
    if (sentFolders.length > 0) {
      record.set("folder", sentFolders[0].id);
    }
  } catch (_) {}

  app.save(record);
  return record;
};

// ---------------------------------------------------------------------------
// API: send email
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/mail/send", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body;
  const accountId = body.account_id;
  let messageId = body.message_id;

  if (!accountId) {
    throw new BadRequestError("account_id is required");
  }

  // Verify account ownership
  const account = $app.findRecordById("accounts", accountId);
  if (account.get("user") !== authRecord.id) {
    throw new ForbiddenError("Not your account");
  }

  // If no existing message, create a draft first so the worker can read it
  if (!messageId) {
    const draft = createDraftForSend($app, accountId, {
      from: {
        name: account.get("display_name") || "",
        address: account.get("email"),
      },
      to: body.to || [],
      cc: body.cc || [],
      bcc: body.bcc || [],
      subject: body.subject || "",
      text_body: body.text_body || "",
      html_body: body.html_body || "",
      in_reply_to: body.in_reply_to || "",
      references: body.references || [],
    });
    messageId = draft.id;
  }

  // Call mail-worker to send
  const workerResult = callWorkerSend(accountId, messageId);

  // Update the message as sent
  try {
    const message = $app.findRecordById("messages", messageId);
    message.set("is_draft", false);
    message.set("is_sent", true);
    message.set("date", new Date().toISOString());

    if (workerResult && workerResult.messageId) {
      message.set("message_id", workerResult.messageId);
    }

    // Move to sent folder
    try {
      const sentFolders = $app.findRecordsByFilter(
        "folders",
        'account = {:accountId} && type = "sent"',
        "",
        1,
        0,
        { accountId: accountId }
      );
      if (sentFolders.length > 0) {
        message.set("folder", sentFolders[0].id);
      }
    } catch (_) {}

    $app.save(message);
  } catch (err) {
    console.log("Could not update message after send: " + err);
  }

  return e.json(200, {
    status: "sent",
    message_id: workerResult ? workerResult.messageId : "",
  });
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// API: reply to a message
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/mail/reply", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body;
  const originalMessageId = body.original_message_id;

  if (!originalMessageId) {
    throw new BadRequestError("original_message_id is required");
  }

  const originalMessage = $app.findRecordById("messages", originalMessageId);
  const accountId = originalMessage.get("account");

  // Verify ownership
  const account = $app.findRecordById("accounts", accountId);
  if (account.get("user") !== authRecord.id) {
    throw new ForbiddenError("Not your account");
  }

  // Build references chain
  const origRefs = originalMessage.get("references") || [];
  const origMsgId = originalMessage.get("message_id") || "";
  const newRefs = Array.from(origRefs);
  if (origMsgId && !newRefs.includes(origMsgId)) {
    newRefs.push(origMsgId);
  }

  // Create the reply as a draft in PB first
  const replySubject = body.subject || "Re: " + (originalMessage.get("subject") || "");
  const draft = createDraftForSend($app, accountId, {
    from: {
      name: account.get("display_name") || "",
      address: account.get("email"),
    },
    to: body.to || [],
    cc: body.cc || [],
    bcc: body.bcc || [],
    subject: replySubject,
    text_body: body.text_body || "",
    html_body: body.html_body || "",
    in_reply_to: origMsgId,
    references: newRefs,
    thread_id: originalMessage.get("thread_id") || "",
  });

  // Call mail-worker to send the draft
  const workerResult = callWorkerSend(accountId, draft.id);

  // Mark original as answered
  originalMessage.set("is_answered", true);
  $app.save(originalMessage);

  // Update the reply record as sent
  draft.set("is_draft", false);
  draft.set("is_sent", true);
  draft.set("draft_reply_to", originalMessageId);

  if (workerResult && workerResult.messageId) {
    draft.set("message_id", workerResult.messageId);
  }

  $app.save(draft);

  return e.json(200, {
    status: "sent",
    message_id: workerResult ? workerResult.messageId : "",
    reply_record_id: draft.id,
  });
}, $apis.requireAuth());
