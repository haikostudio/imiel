/// <reference path="../pb_data/types.d.ts" />

// search-index.js
// Full-text search endpoint for messages.

// ---------------------------------------------------------------------------
// API: search messages
// ---------------------------------------------------------------------------
routerAdd("GET", "/api/mail/search", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const query = e.request.url.query();
  const q = query.get("q") || "";
  const accountId = query.get("account_id") || "";
  const folderId = query.get("folder_id") || "";
  const page = parseInt(query.get("page") || "1", 10);
  const perPage = Math.min(parseInt(query.get("per_page") || "50", 10), 100);

  if (!q || q.length < 2) {
    throw new BadRequestError("Query must be at least 2 characters");
  }

  // Build filter parts
  const filterParts = [];
  const filterParams = {};

  // User can only search their own accounts
  filterParts.push("account.user = {:userId}");
  filterParams.userId = authRecord.id;

  // Optional account filter
  if (accountId) {
    filterParts.push("account = {:accountId}");
    filterParams.accountId = accountId;
  }

  // Optional folder filter
  if (folderId) {
    filterParts.push("folder = {:folderId}");
    filterParams.folderId = folderId;
  }

  // Full-text search across subject, text_body, from_address, to_addresses
  // PocketBase uses SQLite FTS under the hood; we use LIKE for JSON fields
  const searchTerm = "%" + q + "%";
  filterParts.push(
    "(subject ~ {:searchTerm} || text_body ~ {:searchTerm})"
  );
  filterParams.searchTerm = q;

  const filter = filterParts.join(" && ");
  const offset = (page - 1) * perPage;

  let records;
  try {
    records = $app.findRecordsByFilter(
      "messages",
      filter,
      "-date",
      perPage,
      offset,
      filterParams
    );
  } catch (err) {
    console.log("Search error: " + err);
    records = [];
  }

  // Count total results (for pagination)
  let totalCount = 0;
  try {
    const countRecords = $app.findRecordsByFilter(
      "messages",
      filter,
      "",
      0,
      0,
      filterParams
    );
    totalCount = countRecords.length;
  } catch (_) {}

  // Map results
  const results = [];
  for (const record of records) {
    results.push({
      id: record.id,
      account: record.get("account"),
      folder: record.get("folder"),
      message_id: record.get("message_id"),
      thread_id: record.get("thread_id"),
      from: record.get("from_address"),
      to: record.get("to_addresses"),
      subject: record.get("subject"),
      snippet: record.get("snippet") || (record.get("text_body") || "").substring(0, 200),
      date: record.get("date"),
      is_read: record.get("is_read"),
      is_starred: record.get("is_starred"),
      has_attachments: record.get("has_attachments"),
      labels: record.get("labels"),
    });
  }

  return e.json(200, {
    items: results,
    page: page,
    per_page: perPage,
    total_items: totalCount,
    total_pages: Math.ceil(totalCount / perPage),
  });
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// API: search messages by address (from/to)
// ---------------------------------------------------------------------------
routerAdd("GET", "/api/mail/search-contacts", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const query = e.request.url.query();
  const q = query.get("q") || "";
  const limit = Math.min(parseInt(query.get("limit") || "20", 10), 50);

  if (!q || q.length < 2) {
    throw new BadRequestError("Query must be at least 2 characters");
  }

  // Search in from_address and to_addresses JSON fields
  // We use a raw SQL query for better JSON field searching
  const searchTerm = "%" + q.toLowerCase() + "%";

  let records;
  try {
    records = $app.findRecordsByFilter(
      "messages",
      "account.user = {:userId} && (from_address ~ {:q} || to_addresses ~ {:q})",
      "-date",
      200,
      0,
      { userId: authRecord.id, q: q }
    );
  } catch (_) {
    records = [];
  }

  // Extract unique contacts
  const contactMap = {};

  for (const record of records) {
    const fromAddr = record.get("from_address");
    if (fromAddr && fromAddr.address) {
      const key = fromAddr.address.toLowerCase();
      if (key.includes(q.toLowerCase()) || (fromAddr.name && fromAddr.name.toLowerCase().includes(q.toLowerCase()))) {
        if (!contactMap[key]) {
          contactMap[key] = {
            name: fromAddr.name || "",
            address: fromAddr.address,
            count: 0,
          };
        }
        contactMap[key].count++;
      }
    }

    const toAddrs = record.get("to_addresses") || [];
    for (const addr of toAddrs) {
      if (addr && addr.address) {
        const key = addr.address.toLowerCase();
        if (key.includes(q.toLowerCase()) || (addr.name && addr.name.toLowerCase().includes(q.toLowerCase()))) {
          if (!contactMap[key]) {
            contactMap[key] = {
              name: addr.name || "",
              address: addr.address,
              count: 0,
            };
          }
          contactMap[key].count++;
        }
      }
    }
  }

  // Sort by frequency and limit
  const contacts = Object.values(contactMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return e.json(200, { contacts: contacts });
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// API: get thread messages
// ---------------------------------------------------------------------------
routerAdd("GET", "/api/mail/thread/{threadId}", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const threadId = e.request.pathValue("threadId");
  if (!threadId) {
    throw new BadRequestError("threadId is required");
  }

  let records;
  try {
    records = $app.findRecordsByFilter(
      "messages",
      "thread_id = {:threadId} && account.user = {:userId}",
      "date",
      200,
      0,
      { threadId: threadId, userId: authRecord.id }
    );
  } catch (_) {
    records = [];
  }

  const messages = [];
  for (const record of records) {
    messages.push({
      id: record.id,
      account: record.get("account"),
      folder: record.get("folder"),
      message_id: record.get("message_id"),
      in_reply_to: record.get("in_reply_to"),
      from: record.get("from_address"),
      to: record.get("to_addresses"),
      cc: record.get("cc_addresses"),
      subject: record.get("subject"),
      text_body: record.get("text_body"),
      html_body: record.get("html_body"),
      date: record.get("date"),
      is_read: record.get("is_read"),
      is_starred: record.get("is_starred"),
      is_answered: record.get("is_answered"),
      has_attachments: record.get("has_attachments"),
      attachments: record.get("attachments"),
      labels: record.get("labels"),
    });
  }

  return e.json(200, {
    thread_id: threadId,
    message_count: messages.length,
    messages: messages,
  });
}, $apis.requireAuth());
