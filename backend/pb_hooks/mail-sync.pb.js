/// <reference path="../pb_data/types.d.ts" />

// mail-sync.js
// Handles initial sync on account creation and periodic sync via cron.

var MAIL_WORKER_URL = $os.getenv("MAIL_WORKER_URL") || "http://localhost:4001";

// ---------------------------------------------------------------------------
// Helper: call the mail-worker sync endpoint
// ---------------------------------------------------------------------------
var triggerSync = function(accountId) {
  const res = $http.send({
    url: MAIL_WORKER_URL + "/sync/" + accountId,
    method: "POST",
    body: JSON.stringify({}),
    headers: {
      "Content-Type": "application/json",
    },
    timeout: 300,
  });

  if (res.statusCode >= 400) {
    throw new Error(
      "mail-worker error " + res.statusCode + ": " + res.raw
    );
  }

  return res.json;
};

// ---------------------------------------------------------------------------
// Helper: update account sync status
// ---------------------------------------------------------------------------
var setSyncStatus = function(app, accountId, status, error) {
  const record = app.findRecordById("accounts", accountId);
  record.set("sync_status", status);
  record.set("sync_error", error || "");
  if (status === "idle") {
    record.set("last_synced_at", new Date().toISOString());
  }
  app.save(record);
};

// ---------------------------------------------------------------------------
// Hook: after account creation, trigger initial sync
// ---------------------------------------------------------------------------
onRecordAfterCreateSuccess((e) => {
  // PocketBase 0.25 : les hooks *Success s'executent dans un runtime isole
  // sans acces au scope top-level (triggerSync / MAIL_WORKER_URL). On redefinit
  // le helper ICI, sinon ReferenceError (avale par le try/catch -> la sync
  // initiale ne part jamais ; le cron finit par rattraper sous 60s).
  const WORKER_URL = $os.getenv("MAIL_WORKER_URL") || "http://localhost:4001";
  var triggerSync = function (accountId) {
    const res = $http.send({
      url: WORKER_URL + "/sync/" + accountId,
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
      timeout: 300,
    });
    if (res.statusCode >= 400) {
      throw new Error("mail-worker error " + res.statusCode + ": " + res.raw);
    }
    return res.json;
  };

  const account = e.record;

  // Mark as initial sync
  account.set("sync_status", "initial");
  account.set("is_active", true);
  if (!account.get("check_interval")) {
    account.set("check_interval", 5);
  }
  $app.save(account);

  // Trigger initial sync (worker manages sync_status)
  try {
    triggerSync(account.id);
  } catch (err) {
    console.log("Initial sync failed for account " + account.id + ": " + err);
  }

  // OBLIGATOIRE (PB 0.25) : continuer la chaine pour le broadcaster realtime.
  e.next();
}, "accounts");

// ---------------------------------------------------------------------------
// Cron: check accounts that need syncing (every minute)
// ---------------------------------------------------------------------------
cronAdd("mail_sync_check", "* * * * *", () => {
  // Reset stale syncs (stuck for > 10 minutes)
  try {
    var cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace("T", " ");
    var staleAccounts = $app.findRecordsByFilter(
      "accounts",
      "is_active = true && sync_status = 'syncing' && updated < '" + cutoff + "'",
      "",
      100,
      0
    );
    for (var s = 0; s < staleAccounts.length; s++) {
      console.log("Resetting stale sync for account " + staleAccounts[s].id);
      setSyncStatus($app, staleAccounts[s].id, "idle", "");
    }
  } catch (err) {
    // No stale accounts or query error — ignore
  }

  var accounts;
  try {
    accounts = $app.findRecordsByFilter(
      "accounts",
      "is_active = true && sync_status != 'syncing' && sync_status != 'initial'",
      "-last_synced_at",
      500,
      0
    );
  } catch (err) {
    console.log("No accounts to sync or query error: " + err);
    return;
  }

  var now = new Date();

  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    var interval = account.get("check_interval") || 5;
    var lastSynced = account.get("last_synced_at");

    // Skip if synced recently
    if (lastSynced) {
      var lastSyncDate = new Date(lastSynced);
      var diffMinutes = (now - lastSyncDate) / 60000;
      if (diffMinutes < interval) {
        continue;
      }
    }

    // Trigger sync (worker manages sync_status)
    var accountId = account.id;
    try {
      triggerSync(accountId);
    } catch (err) {
      console.log("Sync failed for account " + accountId + ": " + err);
    }
  }
});

// ---------------------------------------------------------------------------
// API: manual sync trigger
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/mail/sync", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body;
  const accountId = body.account_id;

  if (!accountId) {
    throw new BadRequestError("account_id is required");
  }

  const account = $app.findRecordById("accounts", accountId);
  if (account.get("user") !== authRecord.id) {
    throw new ForbiddenError("Not your account");
  }

  if (account.get("sync_status") === "syncing") {
    return e.json(200, { status: "already_syncing" });
  }

  // Trigger sync (worker manages sync_status)
  try {
    triggerSync(accountId);
  } catch (err) {
    console.log("Manual sync failed for account " + accountId + ": " + err);
  }

  return e.json(200, { status: "sync_started" });
}, $apis.requireAuth());
