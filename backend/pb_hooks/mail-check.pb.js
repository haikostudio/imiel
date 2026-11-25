/// <reference path="../pb_data/types.d.ts" />

// mail-check.js
// API endpoint to test IMAP/SMTP connection via mail-worker.

var MAIL_WORKER_URL = $os.getenv("MAIL_WORKER_URL") || "http://localhost:4001";

// ---------------------------------------------------------------------------
// Helper: call the mail-worker /test-connection endpoint
// ---------------------------------------------------------------------------
var testConnection = function(type, host, port, email, password) {
  const res = $http.send({
    url: MAIL_WORKER_URL + "/test-connection",
    method: "POST",
    body: JSON.stringify({
      type: type,
      host: host,
      port: port,
      email: email,
      password: password,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    timeout: 30,
  });

  return res;
};

// ---------------------------------------------------------------------------
// API: test IMAP connection
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/mail/check-imap", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body;

  if (!body.imap_host || !body.imap_port || !body.imap_username || !body.imap_password) {
    throw new BadRequestError(
      "imap_host, imap_port, imap_username, and imap_password are required"
    );
  }

  const res = testConnection(
    "imap",
    body.imap_host,
    body.imap_port,
    body.imap_username,
    body.imap_password
  );

  if (res.statusCode >= 400) {
    return e.json(200, {
      success: false,
      error: "Connection failed: " + res.raw,
    });
  }

  return e.json(200, {
    success: true,
    details: res.json,
  });
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// API: test SMTP connection
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/mail/check-smtp", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body;

  if (!body.smtp_host || !body.smtp_port || !body.smtp_username || !body.smtp_password) {
    throw new BadRequestError(
      "smtp_host, smtp_port, smtp_username, and smtp_password are required"
    );
  }

  const res = testConnection(
    "smtp",
    body.smtp_host,
    body.smtp_port,
    body.smtp_username,
    body.smtp_password
  );

  if (res.statusCode >= 400) {
    return e.json(200, {
      success: false,
      error: "Connection failed: " + res.raw,
    });
  }

  return e.json(200, {
    success: true,
    details: res.json,
  });
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// API: test both IMAP and SMTP at once
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/mail/check-connection", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body;

  const results = {
    imap: { success: false, error: "" },
    smtp: { success: false, error: "" },
  };

  // Test IMAP
  if (body.imap_host) {
    try {
      const imapRes = testConnection(
        "imap",
        body.imap_host,
        body.imap_port,
        body.imap_username,
        body.imap_password
      );

      if (imapRes.statusCode < 400) {
        results.imap.success = true;
        results.imap.details = imapRes.json;
      } else {
        results.imap.error = imapRes.raw;
      }
    } catch (err) {
      results.imap.error = String(err);
    }
  }

  // Test SMTP
  if (body.smtp_host) {
    try {
      const smtpRes = testConnection(
        "smtp",
        body.smtp_host,
        body.smtp_port,
        body.smtp_username,
        body.smtp_password
      );

      if (smtpRes.statusCode < 400) {
        results.smtp.success = true;
        results.smtp.details = smtpRes.json;
      } else {
        results.smtp.error = smtpRes.raw;
      }
    } catch (err) {
      results.smtp.error = String(err);
    }
  }

  return e.json(200, results);
}, $apis.requireAuth());
