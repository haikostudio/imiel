import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeAccount, createMockCollection } from "./test-helpers";
import { useMailStore } from "@/lib/stores/mail-store";

const mockAccountsCollection = createMockCollection();

vi.mock("@/lib/pocketbase", () => ({
  accounts: () => mockAccountsCollection,
  getCurrentUserId: vi.fn().mockReturnValue("user1"),
  subscribeWithRetry: (fn: () => Promise<() => void>) => {
    fn().catch(() => {});
    return () => {};
  },
}));

import { useActiveAccount } from "../useActiveAccount";

const STORAGE_KEY = "imiel:activeAccountId";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockAccountsCollection.getFullList.mockResolvedValue([]);
  mockAccountsCollection.subscribe.mockResolvedValue(() => {});
  useMailStore.setState({ activeAccountId: null });
});

describe("useActiveAccount", () => {
  describe("restauration depuis localStorage", () => {
    it("restaure le compte depuis localStorage", async () => {
      const acc = makeAccount({ id: "acc1" });
      mockAccountsCollection.getFullList.mockResolvedValue([acc]);
      localStorage.setItem(STORAGE_KEY, "acc1");

      const { result } = renderHook(() => useActiveAccount());

      await waitFor(() => {
        expect(result.current.activeAccountId).toBe("acc1");
      });
    });

    it("restaure 'all' depuis localStorage", async () => {
      const acc = makeAccount({ id: "acc1" });
      mockAccountsCollection.getFullList.mockResolvedValue([acc]);
      localStorage.setItem(STORAGE_KEY, "all");

      const { result } = renderHook(() => useActiveAccount());

      await waitFor(() => {
        expect(result.current.activeAccountId).toBe("all");
      });
    });

    it("selectionne le premier compte si rien en localStorage", async () => {
      const acc1 = makeAccount({ id: "acc1", label: "Perso" });
      const acc2 = makeAccount({ id: "acc2", label: "Pro" });
      mockAccountsCollection.getFullList.mockResolvedValue([acc1, acc2]);

      const { result } = renderHook(() => useActiveAccount());

      await waitFor(() => {
        expect(result.current.activeAccountId).toBe("acc1");
      });
    });

    it("ignore un ID invalide en localStorage", async () => {
      const acc = makeAccount({ id: "acc1" });
      mockAccountsCollection.getFullList.mockResolvedValue([acc]);
      localStorage.setItem(STORAGE_KEY, "nonexistent");

      const { result } = renderHook(() => useActiveAccount());

      await waitFor(() => {
        expect(result.current.activeAccountId).toBe("acc1");
      });
    });
  });

  describe("persistence dans localStorage", () => {
    it("sauvegarde le choix dans localStorage", async () => {
      const acc = makeAccount({ id: "acc1" });
      mockAccountsCollection.getFullList.mockResolvedValue([acc]);

      const { result } = renderHook(() => useActiveAccount());

      await waitFor(() => {
        expect(result.current.activeAccountId).not.toBeNull();
      });

      act(() => {
        result.current.setActiveAccount("acc1");
      });

      expect(localStorage.getItem(STORAGE_KEY)).toBe("acc1");
    });
  });

  describe("activeAccount", () => {
    it("retourne l'objet Account pour un ID valide", async () => {
      const acc = makeAccount({ id: "acc1", label: "Perso" });
      mockAccountsCollection.getFullList.mockResolvedValue([acc]);

      useMailStore.setState({ activeAccountId: "acc1" });

      const { result } = renderHook(() => useActiveAccount());

      await waitFor(() => {
        expect(result.current.activeAccount).not.toBeNull();
      });

      expect(result.current.activeAccount?.label).toBe("Perso");
    });

    it("retourne null pour 'all'", async () => {
      const acc = makeAccount({ id: "acc1" });
      mockAccountsCollection.getFullList.mockResolvedValue([acc]);
      useMailStore.setState({ activeAccountId: "all" });

      const { result } = renderHook(() => useActiveAccount());

      await waitFor(() => {
        expect(result.current.activeAccountId).toBe("all");
      });

      expect(result.current.activeAccount).toBeNull();
    });

    it("retourne null si aucun compte actif", async () => {
      mockAccountsCollection.getFullList.mockResolvedValue([]);
      useMailStore.setState({ activeAccountId: null });

      const { result } = renderHook(() => useActiveAccount());

      expect(result.current.activeAccount).toBeNull();
    });
  });

  describe("setActiveAccount", () => {
    it("change le compte actif via le store", async () => {
      const acc1 = makeAccount({ id: "acc1" });
      const acc2 = makeAccount({ id: "acc2" });
      mockAccountsCollection.getFullList.mockResolvedValue([acc1, acc2]);

      const { result } = renderHook(() => useActiveAccount());

      await waitFor(() => {
        expect(result.current.activeAccountId).not.toBeNull();
      });

      act(() => {
        result.current.setActiveAccount("acc2");
      });

      expect(result.current.activeAccountId).toBe("acc2");
    });
  });
});
