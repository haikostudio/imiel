import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordSuccess,
  recordError,
  isDue,
  getSyncState,
  getAllSyncStates,
} from "../scheduler";
import type { PBAccount } from "../pocketbase";

function makeAccount(overrides: Partial<PBAccount> = {}): PBAccount {
  return {
    id: "acc1",
    check_interval: 5, // minutes (cf. schema PB : 1-1440 minutes)
    last_synced_at: "",
    protocol: "imap",
    is_active: true,
    ...overrides,
  } as PBAccount;
}

describe("scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    // Reset internal state en enregistrant puis en verifiant
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("recordSuccess", () => {
    it("enregistre un succes et reset les erreurs", () => {
      recordError("acc1");
      recordSuccess("acc1");
      const state = getSyncState("acc1");
      expect(state?.consecutiveErrors).toBe(0);
    });
  });

  describe("recordError", () => {
    it("incremente les erreurs consecutives", () => {
      recordSuccess("acc2"); // reset
      recordError("acc2");
      expect(getSyncState("acc2")?.consecutiveErrors).toBe(1);
      recordError("acc2");
      expect(getSyncState("acc2")?.consecutiveErrors).toBe(2);
    });

    it("calcule un nextCheck avec backoff exponentiel", () => {
      recordSuccess("acc3"); // reset
      recordError("acc3");
      const state = getSyncState("acc3");
      const now = Date.now();
      // Premiere erreur : backoff = 30s * 2^0 = 30s
      expect(state?.nextCheck).toBe(now + 30_000);
    });

    it("plafonne le backoff a 30 minutes", () => {
      recordSuccess("acc4"); // reset
      for (let i = 0; i < 20; i++) {
        recordError("acc4");
      }
      const state = getSyncState("acc4");
      const now = Date.now();
      // Max backoff = 30 * 60 * 1000 = 1_800_000
      expect(state!.nextCheck).toBeLessThanOrEqual(now + 1_800_000);
    });
  });

  describe("isDue", () => {
    it("retourne true pour un compte jamais synchronise", () => {
      const account = makeAccount({ id: "new-acc" });
      expect(isDue(account)).toBe(true);
    });

    it("retourne false si le dernier sync est recent", () => {
      recordSuccess("recent-acc");
      const account = makeAccount({ id: "recent-acc", check_interval: 5 });
      expect(isDue(account)).toBe(false);
    });

    it("retourne true si l'intervalle est depasse", () => {
      recordSuccess("old-acc");
      // Avancer de 6 minutes (> check_interval 5 min)
      vi.advanceTimersByTime(6 * 60 * 1000);
      const account = makeAccount({ id: "old-acc", check_interval: 5 });
      expect(isDue(account)).toBe(true);
    });

    it("retourne false pendant un backoff", () => {
      recordError("backoff-acc");
      const account = makeAccount({ id: "backoff-acc" });
      expect(isDue(account)).toBe(false);
    });

    it("retourne true apres le backoff", () => {
      recordError("backoff-done-acc");
      // Avancer au-dela du backoff (30s) + interval (5min)
      vi.advanceTimersByTime(6 * 60 * 1000);
      const account = makeAccount({ id: "backoff-done-acc", check_interval: 5 });
      expect(isDue(account)).toBe(true);
    });

    it("respecte l'intervalle minimum de 1 minute", () => {
      recordSuccess("min-acc");
      vi.advanceTimersByTime(30_000); // 30s
      // check_interval 1 min = plancher applique (MIN_INTERVAL_MS = 60s)
      const account = makeAccount({ id: "min-acc", check_interval: 1 });
      expect(isDue(account)).toBe(false);

      vi.advanceTimersByTime(31_000); // +31s = total 61s > 60s min
      expect(isDue(account)).toBe(true);
    });

    it("utilise last_synced_at de PocketBase si pas de state local", () => {
      // 10 minutes ago
      const lastSync = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const account = makeAccount({
        id: "pb-sync-acc",
        last_synced_at: lastSync,
        check_interval: 5, // minutes
      });
      expect(isDue(account)).toBe(true);
    });
  });

  describe("getAllSyncStates", () => {
    it("retourne tous les etats de sync", () => {
      recordSuccess("state-a");
      recordSuccess("state-b");
      const states = getAllSyncStates();
      expect(states["state-a"]).toBeDefined();
      expect(states["state-b"]).toBeDefined();
    });
  });
});
