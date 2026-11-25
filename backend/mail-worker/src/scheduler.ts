import { listAccountsDueForSync, type PBAccount } from "./pocketbase";

interface AccountSyncState {
  lastAttempt: number;
  consecutiveErrors: number;
  nextCheck: number;
}

const syncStates = new Map<string, AccountSyncState>();

const MIN_INTERVAL_MS = 60_000; // 1 minute minimum
const MAX_BACKOFF_MS = 30 * 60_000; // 30 minutes max backoff
const BASE_BACKOFF_MS = 30_000; // 30 seconds base backoff

/**
 * Calculate backoff delay based on consecutive error count.
 * Uses exponential backoff: base * 2^errors, capped at MAX_BACKOFF_MS.
 */
function calculateBackoff(consecutiveErrors: number): number {
  if (consecutiveErrors === 0) return 0;
  const delay = BASE_BACKOFF_MS * Math.pow(2, consecutiveErrors - 1);
  return Math.min(delay, MAX_BACKOFF_MS);
}

/**
 * Record a successful sync for an account.
 */
export function recordSuccess(accountId: string): void {
  syncStates.set(accountId, {
    lastAttempt: Date.now(),
    consecutiveErrors: 0,
    nextCheck: 0, // Will be calculated on next isDue check
  });
}

/**
 * Record a failed sync for an account.
 */
export function recordError(accountId: string): void {
  const state = syncStates.get(accountId);
  const errors = (state?.consecutiveErrors || 0) + 1;
  const backoff = calculateBackoff(errors);

  syncStates.set(accountId, {
    lastAttempt: Date.now(),
    consecutiveErrors: errors,
    nextCheck: Date.now() + backoff,
  });

  console.log(
    `Account ${accountId}: error #${errors}, next retry in ${Math.round(backoff / 1000)}s`
  );
}

/**
 * True if the account is currently in error backoff (a retry is scheduled in
 * the future). Used by the safety poll to honour backoff even when it bypasses
 * the normal check_interval (e.g. for IMAP accounts whose IDLE link is down).
 */
export function isInBackoff(account: PBAccount): boolean {
  const state = syncStates.get(account.id);
  return !!(state?.nextCheck && Date.now() < state.nextCheck);
}

/**
 * Check if an account is due for a sync check.
 */
export function isDue(account: PBAccount): boolean {
  const state = syncStates.get(account.id);
  const now = Date.now();

  // If we have a scheduled next check due to backoff
  if (state?.nextCheck && now < state.nextCheck) {
    return false;
  }

  // Check interval from account settings (in minutes), with minimum
  const intervalMs = Math.max(
    (account.check_interval || 5) * 60_000,
    MIN_INTERVAL_MS
  );

  // If never synced or no state tracked
  if (!state?.lastAttempt) {
    // Also check PocketBase's last_sync field
    if (account.last_synced_at) {
      const lastSync = new Date(account.last_synced_at).getTime();
      return now - lastSync >= intervalMs;
    }
    return true;
  }

  return now - state.lastAttempt >= intervalMs;
}

/**
 * Get accounts that are due for a sync check.
 */
export async function getAccountsDueForSync(): Promise<PBAccount[]> {
  const accounts = await listAccountsDueForSync();
  return accounts.filter(isDue);
}

/**
 * Get sync state info for an account (for debugging/health checks).
 */
export function getSyncState(
  accountId: string
): AccountSyncState | undefined {
  return syncStates.get(accountId);
}

/**
 * Get all sync states (for health check endpoint).
 */
export function getAllSyncStates(): Record<string, AccountSyncState> {
  const result: Record<string, AccountSyncState> = {};
  for (const [id, state] of syncStates) {
    result[id] = state;
  }
  return result;
}
