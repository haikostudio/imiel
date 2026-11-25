import { historyBackfillAccount, type HistoryProgress } from "./imap";
import { getAccount, getUserPauseFlags } from "./pocketbase";

export interface HistoryBackfillState {
  running: boolean;
  paused: boolean;
  total: number;
  done: number;
  inserted: number;
  phase: string;
  error: string | null;
}

const states = new Map<string, HistoryBackfillState>();

export function getHistoryBackfillStatus(
  accountId: string
): HistoryBackfillState {
  return (
    states.get(accountId) || {
      running: false,
      paused: false,
      total: 0,
      done: 0,
      inserted: 0,
      phase: "idle",
      error: null,
    }
  );
}

/** Demande l'arret cooperatif du rapatriement en cours (garde le progres). */
export function pauseHistoryBackfill(accountId: string): HistoryBackfillState {
  const s = states.get(accountId);
  if (s && s.running) s.paused = true;
  return getHistoryBackfillStatus(accountId);
}

/** Lance (en arriere-plan) le rapatriement complet de l'historique IMAP. */
export function startHistoryBackfill(accountId: string): HistoryBackfillState {
  const current = states.get(accountId);
  if (current && current.running) return current;

  const state: HistoryBackfillState = {
    running: true,
    paused: false,
    total: 0,
    done: 0,
    inserted: 0,
    phase: "starting",
    error: null,
  };
  states.set(accountId, state);

  void (async () => {
    // Charge l'user une fois pour combiner pause locale + pause user.sync_paused.
    let userId: string | null = null;
    try {
      const acc = await getAccount(accountId);
      userId = acc.user;
    } catch {
      // si l'account n'est pas lisible le backfill suivant va echouer aussi
    }

    const shouldStop = async (): Promise<boolean> => {
      if (state.paused) return true;
      if (!userId) return false;
      const flags = await getUserPauseFlags(userId);
      return flags.sync_paused;
    };

    try {
      const stopped = await historyBackfillAccount(
        accountId,
        (p: HistoryProgress) => {
          state.total = p.total;
          state.done = p.done;
          state.inserted = p.inserted;
          state.phase = p.phase;
        },
        shouldStop
      );
      if (stopped) state.paused = true;
    } catch (err) {
      state.error = (err as Error).message || "history backfill failed";
      console.error("[history] backfill failed:", err);
    } finally {
      state.running = false;
    }
  })();

  return state;
}
