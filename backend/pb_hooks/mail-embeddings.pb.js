/// <reference path="../pb_data/types.d.ts" />

// mail-embeddings.pb.js
// Headless API for semantic memory: proxies the mail-worker embeddings
// endpoints with the authenticated user's id forced server-side (the client
// never passes userId, so it cannot spoof another user's mailbox).
//
//   POST /api/mail/search-semantic         vector search (metadata only)
//   POST /api/mail/search-context          vector search + message content
//   GET  /api/mail/embeddings/status       indexing status + backfill progress
//   POST /api/mail/embeddings/backfill     trigger background indexing

var MAIL_WORKER_URL_EMB = $os.getenv("MAIL_WORKER_URL") || "http://localhost:4001";

// ---------------------------------------------------------------------------
// Helper: verify account ownership (used when account_id is provided)
// ---------------------------------------------------------------------------
var ownedAccountEmb = function(app, accountId, userId) {
  var account = app.findRecordById("accounts", accountId);
  if (account.get("user") !== userId) {
    throw new ForbiddenError("Not your account");
  }
  return account;
};

// ---------------------------------------------------------------------------
// Helper: call the mail-worker
// ---------------------------------------------------------------------------
var callWorker = function(method, path, body) {
  var res = $http.send({
    url: MAIL_WORKER_URL_EMB + path,
    method: method,
    body: body === undefined ? "" : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    timeout: 60,
  });
  if (res.statusCode >= 400) {
    throw new Error("mail-worker " + res.statusCode + ": " + res.raw);
  }
  return res.json;
};

// ===========================================================================
// API: semantic search (metadata only)
// ===========================================================================
routerAdd("POST", "/api/mail/search-semantic", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body || {};
  const query = (body.query || "").toString().trim();
  if (query.length < 2) {
    throw new BadRequestError("query is required (min 2 chars)");
  }
  const limit = Number(body.limit) || 8;
  const accountId = body.account_id || "";
  if (accountId) {
    ownedAccountEmb($app, accountId, authRecord.id);
  }

  const payload = {
    userId: authRecord.id,
    query: query,
    limit: limit,
  };
  if (accountId) {
    payload.accountId = accountId;
  }

  try {
    const data = callWorker("POST", "/embeddings/search", payload);
    return e.json(200, data);
  } catch (err) {
    return e.json(502, { error: "embeddings search failed: " + err });
  }
}, $apis.requireAuth());

// ===========================================================================
// API: semantic search + message content (one-shot for an LLM agent)
// ===========================================================================
routerAdd("POST", "/api/mail/search-context", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body || {};
  const query = (body.query || "").toString().trim();
  if (query.length < 2) {
    throw new BadRequestError("query is required (min 2 chars)");
  }
  const limit = Number(body.limit) || 8;
  const accountId = body.account_id || "";
  if (accountId) {
    ownedAccountEmb($app, accountId, authRecord.id);
  }

  const payload = {
    userId: authRecord.id,
    query: query,
    limit: limit,
  };
  if (accountId) {
    payload.accountId = accountId;
  }

  try {
    const data = callWorker("POST", "/embeddings/context", payload);
    return e.json(200, data);
  } catch (err) {
    return e.json(502, { error: "embeddings context failed: " + err });
  }
}, $apis.requireAuth());

// ===========================================================================
// API: indexing status (progress, total/indexed counts)
// ===========================================================================
routerAdd("GET", "/api/mail/embeddings/status", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  try {
    const res = $http.send({
      url: MAIL_WORKER_URL_EMB + "/embeddings/status?userId=" + encodeURIComponent(authRecord.id),
      method: "GET",
      headers: { "Content-Type": "application/json" },
      timeout: 30,
    });
    if (res.statusCode >= 400) {
      return e.json(502, { error: "embeddings status failed: " + res.raw });
    }
    return e.json(200, res.json);
  } catch (err) {
    return e.json(502, { error: "embeddings status failed: " + err });
  }
}, $apis.requireAuth());

// ===========================================================================
// API: trigger background indexing for the authenticated user
// ===========================================================================
routerAdd("POST", "/api/mail/embeddings/backfill", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  try {
    const data = callWorker("POST", "/embeddings/backfill", { userId: authRecord.id });
    return e.json(200, data);
  } catch (err) {
    return e.json(502, { error: "embeddings backfill failed: " + err });
  }
}, $apis.requireAuth());

// ===========================================================================
// API (worker-only): list message ids needing embedding
//
// Le worker (token superuser) appelle cet endpoint pour cibler directement
// les mails non-indexes via LEFT JOIN + e.id IS NULL. Avant, on paginait
// `messages` par date desc et on sautait en memoire les ids deja indexes,
// ce qui faisait stagner l'UI pendant que le worker moulinait dans la zone
// deja indexee (en tete = mails les plus recents = ceux deja faits).
//
// GET /api/mail/embeddings/unembedded
//   user_id     (required)
//   account_id  (optional - sinon tous les comptes du user)
//   before      (optional - curseur date, ISO ; renvoie les date < before)
//   limit       (optional, default 500, max 1000)
// ===========================================================================
routerAdd("GET", "/api/mail/embeddings/unembedded", (e) => {
  const authRecord = e.auth;
  if (!authRecord || !authRecord.isSuperuser()) {
    throw new ForbiddenError("Superuser auth required");
  }

  const q = e.request.url.query();
  const userId = q.get("user_id") || "";
  if (!userId) {
    return e.json(400, { error: "user_id is required" });
  }
  const accountId = q.get("account_id") || "";
  const before = q.get("before") || "";
  let limit = parseInt(q.get("limit") || "500", 10) || 500;
  if (limit < 1) limit = 1;
  if (limit > 1000) limit = 1000;

  const whereParts = ["a.user = {:userId}", "m.is_draft = FALSE", "e.id IS NULL"];
  const bindings = { userId: userId };
  if (accountId) {
    whereParts.push("m.account = {:accountId}");
    bindings.accountId = accountId;
  }
  if (before) {
    whereParts.push("m.date < {:before}");
    bindings.before = before;
  }

  const sql =
    "SELECT m.id AS id, m.date AS date " +
    "FROM messages m " +
    "JOIN accounts a ON m.account = a.id " +
    "LEFT JOIN mail_embeddings e ON e.message = m.id " +
    "WHERE " + whereParts.join(" AND ") +
    " ORDER BY m.date DESC " +
    "LIMIT " + limit;

  const rows = arrayOf(new DynamicModel({ id: "", date: "" }));
  try {
    $app.db().newQuery(sql).bind(bindings).all(rows);
  } catch (err) {
    return e.json(500, { error: "unembedded list failed: " + err });
  }

  const ids = [];
  for (let i = 0; i < rows.length; i++) ids.push(rows[i].id);
  const lastDate = rows.length > 0 ? rows[rows.length - 1].date : null;

  return e.json(200, {
    ids: ids,
    lastDate: lastDate,
    hasMore: rows.length === limit,
  });
}, $apis.requireAuth("_superusers"));

// ===========================================================================
// API (worker-only): count messages needing embedding
//
// Denominateur du backfill (state.total). Calcule une seule fois au demarrage.
//
// GET /api/mail/embeddings/unembedded-count?user_id=X
// ===========================================================================
routerAdd("GET", "/api/mail/embeddings/unembedded-count", (e) => {
  const authRecord = e.auth;
  if (!authRecord || !authRecord.isSuperuser()) {
    throw new ForbiddenError("Superuser auth required");
  }

  const q = e.request.url.query();
  const userId = q.get("user_id") || "";
  if (!userId) {
    return e.json(400, { error: "user_id is required" });
  }

  const sql =
    "SELECT COUNT(*) AS cnt " +
    "FROM messages m " +
    "JOIN accounts a ON m.account = a.id " +
    "LEFT JOIN mail_embeddings e ON e.message = m.id " +
    "WHERE a.user = {:userId} AND m.is_draft = FALSE AND e.id IS NULL";

  const rows = arrayOf(new DynamicModel({ cnt: 0 }));
  try {
    $app.db().newQuery(sql).bind({ userId: userId }).all(rows);
  } catch (err) {
    return e.json(500, { error: "unembedded count failed: " + err });
  }

  const count = rows.length ? rows[0].cnt : 0;
  return e.json(200, { count: count });
}, $apis.requireAuth("_superusers"));
