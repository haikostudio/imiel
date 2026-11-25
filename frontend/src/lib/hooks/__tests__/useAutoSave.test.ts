import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMailStore } from "@/lib/stores/mail-store";

const mockGetCurrentUserId = vi.hoisted(() => vi.fn().mockReturnValue("user1"));
const mockMessagesCol = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ id: "draft1" }),
  update: vi.fn().mockResolvedValue({}),
}));
const mockFoldersCol = vi.hoisted(() => ({
  getFirstListItem: vi.fn().mockResolvedValue({ id: "drafts-folder" }),
}));

vi.mock("@/lib/pocketbase", () => ({
  default: {
    collection: () => mockFoldersCol,
  },
  messages: () => mockMessagesCol,
  getCurrentUserId: mockGetCurrentUserId,
  subscribeWithRetry: (fn: () => Promise<() => void>) => {
    fn().catch(() => {});
    return () => {};
  },
}));

import { useAutoSave } from "../useAutoSave";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  mockGetCurrentUserId.mockReturnValue("user1");
  mockMessagesCol.create.mockResolvedValue({ id: "draft1" });
  mockMessagesCol.update.mockResolvedValue({});
  mockFoldersCol.getFirstListItem.mockResolvedValue({ id: "drafts-folder" });
  useMailStore.setState({ activeAccountId: "acc1" });
});

afterEach(() => {
  vi.useRealTimers();
});

// Helper : avancer les timers et flusher les microtasks
async function flushTimers(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useAutoSave", () => {
  describe("etat initial", () => {
    it("demarre sans sauvegarde en cours", () => {
      const { result } = renderHook(() => useAutoSave());
      expect(result.current.saving).toBe(false);
      expect(result.current.lastSaved).toBeNull();
      expect(result.current.draftId).toBeNull();
    });
  });

  describe("saveDraft avec debounce", () => {
    it("premier appel sauvegarde immediatement", async () => {
      const { result } = renderHook(() => useAutoSave({ debounceMs: 500 }));

      await act(async () => {
        result.current.saveDraft({ subject: "Test" });
      });

      // Premier appel est immediat (pas de debounce)
      await flushTimers(50);
      expect(mockMessagesCol.create).toHaveBeenCalledTimes(1);
    });

    it("deuxieme appel utilise le debounce", async () => {
      const { result } = renderHook(() => useAutoSave({ debounceMs: 500 }));

      // Premier appel : immediat
      await act(async () => {
        result.current.saveDraft({ subject: "Premier" });
      });
      await flushTimers(50);
      expect(mockMessagesCol.create).toHaveBeenCalledTimes(1);

      // Deuxieme appel : debounce
      await act(async () => {
        result.current.saveDraft({ subject: "Deuxieme" });
      });

      await flushTimers(300);
      // Pas encore sauvegarde (debounce 500ms)
      expect(mockMessagesCol.update).not.toHaveBeenCalled();

      await flushTimers(250);
      // Maintenant sauvegarde
      expect(mockMessagesCol.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("creation de brouillon", () => {
    it("cree un nouveau brouillon si pas de draftId", async () => {
      const { result } = renderHook(() => useAutoSave({ debounceMs: 10 }));

      await act(async () => {
        result.current.saveDraft({
          subject: "Mon brouillon",
          to_addresses: [{ address: "bob@test.com" }],
        });
      });

      await flushTimers(50);

      expect(mockMessagesCol.create).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: "Mon brouillon",
          is_draft: true,
          account: "acc1",
        })
      );
    });

    it("met a jour le brouillon existant si draftId existe", async () => {
      const { result } = renderHook(() => useAutoSave({ debounceMs: 10 }));

      // Premier save: cree le brouillon
      await act(async () => {
        result.current.saveDraft({ subject: "V1" });
      });

      await flushTimers(50);

      expect(mockMessagesCol.create).toHaveBeenCalledTimes(1);

      // Deuxieme save: met a jour
      await act(async () => {
        result.current.saveDraft({ subject: "V2" });
      });

      await flushTimers(50);

      expect(mockMessagesCol.update).toHaveBeenCalledWith(
        "draft1",
        expect.objectContaining({ subject: "V2", is_draft: true })
      );
    });
  });

  describe("sauvegarde periodique", () => {
    it("sauvegarde les donnees en attente a l'intervalle", async () => {
      const { result } = renderHook(() =>
        useAutoSave({ debounceMs: 5000, intervalMs: 2000 })
      );

      // Premier appel : immediat
      await act(async () => {
        result.current.saveDraft({ subject: "Periodique" });
      });
      await flushTimers(50);
      expect(mockMessagesCol.create).toHaveBeenCalledTimes(1);

      // Deuxieme appel : en attente (debounce 5000ms)
      await act(async () => {
        result.current.saveDraft({ subject: "Periodique V2" });
      });

      expect(mockMessagesCol.update).not.toHaveBeenCalled();

      // L'intervalle periodique (2000ms) sauve les donnees en attente
      await flushTimers(2100);

      expect(mockMessagesCol.update).toHaveBeenCalled();
    });
  });

  describe("sans authentification", () => {
    it("ne sauvegarde pas sans userId", async () => {
      mockGetCurrentUserId.mockReturnValue(null);

      const { result } = renderHook(() => useAutoSave({ debounceMs: 10 }));

      await act(async () => {
        result.current.saveDraft({ subject: "Test" });
      });

      await flushTimers(50);

      expect(mockMessagesCol.create).not.toHaveBeenCalled();
    });

    it("ne sauvegarde pas sans compte actif", async () => {
      useMailStore.setState({ activeAccountId: "all" });

      const { result } = renderHook(() => useAutoSave({ debounceMs: 10 }));

      await act(async () => {
        result.current.saveDraft({ subject: "Test" });
      });

      await flushTimers(50);

      expect(mockMessagesCol.create).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("nettoie les timers au demontage", async () => {
      const { result, unmount } = renderHook(() =>
        useAutoSave({ debounceMs: 1000, intervalMs: 5000 })
      );

      // Premier appel : sauvegarde immediate
      await act(async () => {
        result.current.saveDraft({ subject: "Test" });
      });
      await flushTimers(50);
      expect(mockMessagesCol.create).toHaveBeenCalledTimes(1);

      // Deuxieme appel : en attente (debounce)
      await act(async () => {
        result.current.saveDraft({ subject: "Test V2" });
      });

      // Unmount devrait flusher les donnees en attente mais nettoyer les timers
      unmount();

      // Verifier que pas de sauvegarde supplementaire apres unmount via timers
      mockMessagesCol.update.mockClear();
      await flushTimers(10000);

      // Aucune sauvegarde supplementaire via les timers (ils sont nettoyes)
      expect(mockMessagesCol.update).not.toHaveBeenCalled();
    });
  });
});
