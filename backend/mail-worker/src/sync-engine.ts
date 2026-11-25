import { ImapFlow } from "imapflow";
import { buildImapConfig, syncAccount } from "./imap";
import { syncPop3Account } from "./pop3";
import {
  type PBAccount,
  getAccount,
  updateAccount,
  listAccountsDueForSync,
  getUserPauseFlags,
} from "./pocketbase";
import { recordSuccess, recordError, isDue, isInBackoff } from "./scheduler";
import { broadcastSyncEvent } from "./ws-hub";
import { syncAllCalendars } from "./calendar-sync";

// ---------------------------------------------------------------------------
// Shared per-account sync lock + status handling
// Used by the HTTP /sync endpoint, the IDLE notifier and the safety poll so
// they never run concurrently for the same account.
// ---------------------------------------------------------------------------

export const SYNC_TIMEOUT_MS = 10 * 60 * 1000;

const activeSyncs = new Map<string, number>();

export function isSyncing(accountId: string): boolean {
  const start = activeSyncs.get(accountId);
  return !!start && Date.now() - start < SYNC_TIMEOUT_MS;
}

export type SyncOutcome =
  | { ok: true; result: { folders?: number; newMessages: number } }
  | { ok: false; reason: "locked" }
  | { ok: false; reason: "paused" }
  | { ok: false; reason: "error"; message: string };

/**
 * Run a full sync for an account behind a lock, managing sync_status,
 * scheduler bookkeeping and OAuth invalid-grant deactivation.
 * The worker is the single source of truth for sync_status.
 */
export async function syncWithLock(accountId: string): Promise<SyncOutcome> {
  if (isSyncing(accountId)) {
    return { ok: false, reason: "locked" };
  }

  // Skip si l'utilisateur a mis la synchronisation en pause.
  let preAccount: PBAccount;
  try {
    preAccount = await getAccount(accountId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "error", message };
  }
  const flags = await getUserPauseFlags(preAccount.user);
  if (flags.sync_paused) {
    return { ok: false, reason: "paused" };
  }

  activeSyncs.set(accountId, Date.now());

  await updateAccount(accountId, {
    sync_status: "syncing",
    sync_error: "",
  }).catch(() => {});
  broadcastSyncEvent(accountId, "syncing");

  try {
    const account = preAccount;

    const result =
      account.protocol === "pop3"
        ? await syncPop3Account(accountId)
        : await syncAccount(accountId);

    recordSuccess(accountId);
    await updateAccount(accountId, {
      sync_status: "idle",
      last_synced_at: new Date().toISOString(),
    }).catch(() => {});
    broadcastSyncEvent(accountId, "idle", { newMessages: result.newMessages });

    return { ok: true, result };
  } catch (err) {
    recordError(accountId);
    const message = err instanceof Error ? err.message : String(err);
    const isInvalidGrant =
      err instanceof Error && err.name === "OAuthInvalidGrant";
    console.error(`Sync error for account ${accountId}: ${message}`);
    await updateAccount(accountId, {
      sync_status: "error",
      sync_error: message,
      ...(isInvalidGrant ? { is_active: false } : {}),
    }).catch(() => {});
    broadcastSyncEvent(accountId, "error", { error: message });
    return { ok: false, reason: "error", message };
  } finally {
    activeSyncs.delete(accountId);
  }
}

// ---------------------------------------------------------------------------
// Real-time IMAP IDLE notifier
// One persistent connection per active IMAP account, opened on INBOX.
// It only DETECTS new mail (the `exists` event); the actual fetch is
// delegated to syncWithLock so IDLE state is never mixed with heavy fetches.
// ---------------------------------------------------------------------------

interface IdleConn {
  client: ImapFlow;
  /** Signature des champs de CONNEXION du compte (voir connSignature). */
  connSignature: string;
  stopped: boolean;
  backoffMs: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  debounceTimer?: ReturnType<typeof setTimeout>;
  keepaliveTimer?: ReturnType<typeof setInterval>;
}

/**
 * Signature des seuls champs qui exigent de reconstruire la connexion IDLE
 * (credentials/serveur). PIEGE : ne JAMAIS comparer `account.updated` ici —
 * syncWithLock ecrit sync_status/last_synced_at a chaque sync, donc `updated`
 * change en permanence et le reconcile detruisait/reconstruisait TOUTES les
 * connexions IDLE toutes les 60s (mails rates pendant la fenetre morte +
 * syncs de rattrapage en boucle + "Synchronisation..." permanent dans l'UI).
 * oauth_access_token est volontairement exclu : il est rafraichi en routine
 * et la connexion IDLE deja etablie n'en depend pas.
 */
function connSignature(a: PBAccount): string {
  return JSON.stringify([
    a.is_active,
    a.protocol,
    a.email,
    a.imap_host,
    a.imap_port,
    a.imap_security,
    a.imap_username,
    a.imap_password,
    a.auth_type,
    a.oauth_provider,
    a.oauth_refresh_token,
  ]);
}

const idleConns = new Map<string, IdleConn>();

const IDLE_BACKOFF_BASE_MS = 5_000;
const IDLE_BACKOFF_MAX_MS = 5 * 60_000;
const IDLE_DEBOUNCE_MS = 1_500;
// NOOP keepalive : detecte les sockets IDLE mortes en half-open (Gmail/NAT
// coupent sans envoyer de FIN/RST -> aucun event `close`, donc aucune
// reconnexion sans ce ping actif).
const IDLE_KEEPALIVE_MS = 60_000;
// Force imapflow a casser/relancer IDLE periodiquement (backstop au keepalive).
const IDLE_MAX_IDLE_MS = 5 * 60_000;

/**
 * True si la connexion IDLE du compte est etablie et utilisable (pas arretee,
 * pas en attente de reconnexion). Utilise par le safety poll pour decider s'il
 * doit prendre le relais du temps reel.
 */
function isIdleHealthy(accountId: string): boolean {
  const conn = idleConns.get(accountId);
  if (!conn || conn.stopped || conn.reconnectTimer) return false;
  return !!conn.client && conn.client.usable === true;
}

function stopKeepalive(conn: IdleConn): void {
  if (conn.keepaliveTimer) {
    clearInterval(conn.keepaliveTimer);
    conn.keepaliveTimer = undefined;
  }
}

function startKeepalive(accountId: string): void {
  const conn = idleConns.get(accountId);
  if (!conn) return;
  stopKeepalive(conn);
  conn.keepaliveTimer = setInterval(() => {
    const c = idleConns.get(accountId);
    if (!c || c.stopped || !c.client) return;
    // NOOP casse l'IDLE, le relance, et echoue si la socket est morte :
    // on force alors la fermeture pour declencher la reconnexion.
    c.client.noop().catch(() => {
      try {
        c.client.close();
      } catch {
        /* ignore */
      }
    });
  }, IDLE_KEEPALIVE_MS);
}

function scheduleReconnect(accountId: string): void {
  const conn = idleConns.get(accountId);
  if (!conn || conn.stopped) return;
  if (conn.reconnectTimer) return;

  const delay = conn.backoffMs;
  conn.backoffMs = Math.min(conn.backoffMs * 2, IDLE_BACKOFF_MAX_MS);
  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = undefined;
    if (conn.stopped) return;
    void connectIdle(accountId);
  }, delay);
}

function triggerIdleSync(accountId: string): void {
  const conn = idleConns.get(accountId);
  if (!conn) return;
  if (conn.debounceTimer) clearTimeout(conn.debounceTimer);
  conn.debounceTimer = setTimeout(() => {
    conn.debounceTimer = undefined;
    syncWithLock(accountId).catch((err) => {
      console.error(`IDLE-triggered sync failed for ${accountId}:`, err);
    });
  }, IDLE_DEBOUNCE_MS);
}

async function connectIdle(accountId: string): Promise<void> {
  const conn = idleConns.get(accountId);
  if (!conn || conn.stopped) return;

  // Arrete le keepalive d'une eventuelle connexion precedente avant d'en
  // construire une nouvelle.
  stopKeepalive(conn);

  let account: PBAccount;
  try {
    account = await getAccount(accountId);
  } catch (err) {
    console.error(`IDLE: cannot load account ${accountId}:`, err);
    scheduleReconnect(accountId);
    return;
  }

  if (!account.is_active || account.protocol !== "imap") {
    stopIdle(accountId);
    return;
  }

  let config;
  try {
    config = await buildImapConfig(account);
  } catch (err) {
    console.error(`IDLE: cannot build config for ${accountId}:`, err);
    scheduleReconnect(accountId);
    return;
  }

  const client = new ImapFlow({
    ...config,
    logger: false,
    maxIdleTime: IDLE_MAX_IDLE_MS,
  });
  conn.client = client;
  conn.connSignature = connSignature(account);

  client.on("error", () => {
    /* handled via close */
  });

  client.on("close", () => {
    stopKeepalive(conn);
    if (conn.stopped) return;
    scheduleReconnect(accountId);
  });

  client.on("exists", () => {
    triggerIdleSync(accountId);
  });

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");
    conn.backoffMs = IDLE_BACKOFF_BASE_MS;
    startKeepalive(accountId);
    console.log(`[IDLE] watching ${account.email} (${accountId})`);
    // Catch up on anything that arrived while we were disconnected.
    triggerIdleSync(accountId);
  } catch (err) {
    console.error(`IDLE: connect failed for ${account.email}:`, err);
    await client.logout().catch(() => {});
    scheduleReconnect(accountId);
  }
}

function startIdle(accountId: string, signature: string): void {
  if (idleConns.has(accountId)) return;
  idleConns.set(accountId, {
    client: null as unknown as ImapFlow,
    connSignature: signature,
    stopped: false,
    backoffMs: IDLE_BACKOFF_BASE_MS,
  });
  void connectIdle(accountId);
}

function stopIdle(accountId: string): void {
  const conn = idleConns.get(accountId);
  if (!conn) return;
  conn.stopped = true;
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  if (conn.debounceTimer) clearTimeout(conn.debounceTimer);
  stopKeepalive(conn);
  idleConns.delete(accountId);
  if (conn.client) {
    conn.client.logout().catch(() => {
      conn.client.close();
    });
  }
  console.log(`[IDLE] stopped watching ${accountId}`);
}

// ---------------------------------------------------------------------------
// Reconcile loop: keep IDLE connections in sync with active accounts.
// ---------------------------------------------------------------------------

async function reconcile(): Promise<void> {
  let accounts: PBAccount[];
  try {
    accounts = await listAccountsDueForSync();
  } catch (err) {
    console.error("Reconcile: cannot list accounts:", err);
    return;
  }

  // Filtre les comptes dont l'utilisateur a mis la synchronisation en pause.
  const userIds = [...new Set(accounts.map((a) => a.user))];
  const pauseByUser = new Map<string, boolean>();
  await Promise.all(
    userIds.map(async (uid) => {
      const flags = await getUserPauseFlags(uid);
      pauseByUser.set(uid, flags.sync_paused);
    })
  );

  const activeImap = accounts.filter(
    (a) => a.is_active && a.protocol === "imap" && !pauseByUser.get(a.user)
  );
  const wanted = new Set(activeImap.map((a) => a.id));

  // Stop IDLE for accounts no longer active/imap.
  for (const id of [...idleConns.keys()]) {
    if (!wanted.has(id)) stopIdle(id);
  }

  for (const account of activeImap) {
    const existing = idleConns.get(account.id);
    const signature = connSignature(account);
    if (!existing) {
      // New account: start IDLE + immediate first sync.
      startIdle(account.id, signature);
      syncWithLock(account.id).catch(() => {});
    } else if (existing.connSignature !== signature) {
      // Credentials/settings changed: rebuild the IDLE connection.
      stopIdle(account.id);
      startIdle(account.id, signature);
    }
  }
}

// ---------------------------------------------------------------------------
// Safety poll: backstop for POP3, dropped IDLE, or missed `exists` events.
// ---------------------------------------------------------------------------

async function safetyPoll(): Promise<void> {
  let accounts: PBAccount[];
  try {
    accounts = await listAccountsDueForSync();
  } catch (err) {
    console.error("Safety poll: cannot list accounts:", err);
    return;
  }

  for (const account of accounts) {
    if (!account.is_active) continue;
    if (isSyncing(account.id)) continue;

    // Compte IMAP dont la connexion IDLE temps reel est tombee : on prend le
    // relais a chaque tick (60s) sans attendre check_interval, pour que les
    // nouveaux mails ne restent pas bloques plusieurs minutes. On respecte
    // tout de meme le backoff d'erreur pour ne pas marteler un serveur en
    // panne.
    const isImap = account.protocol !== "pop3";
    if (isImap && !isIdleHealthy(account.id)) {
      if (isInBackoff(account)) continue;
      await syncWithLock(account.id);
      continue;
    }

    if (!isDue(account)) continue;
    await syncWithLock(account.id);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let started = false;

export function startSyncEngine(): void {
  if (started) return;
  started = true;

  void reconcile();
  setInterval(() => void reconcile(), 60_000);
  setTimeout(() => {
    void safetyPoll();
    setInterval(() => void safetyPoll(), 60_000);
  }, 30_000);

  // Google Calendar poll : 1er passage apres 45s, puis toutes les 5 min.
  setTimeout(() => {
    void syncAllCalendars();
    setInterval(() => void syncAllCalendars(), 5 * 60_000);
  }, 45_000);

  console.log("[SyncEngine] started (IDLE realtime + 60s safety poll + 5min calendar poll)");
}

export function getEngineStatus(): {
  idleAccounts: string[];
  idleHealthy: string[];
  activeSyncs: number;
} {
  const ids = [...idleConns.keys()];
  return {
    idleAccounts: ids,
    idleHealthy: ids.filter(isIdleHealthy),
    activeSyncs: [...activeSyncs.values()].filter(
      (t) => Date.now() - t < SYNC_TIMEOUT_MS
    ).length,
  };
}
