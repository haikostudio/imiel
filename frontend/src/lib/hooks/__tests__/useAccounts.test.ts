import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeAccount } from "./test-helpers";

const mockGetCurrentUserId = vi.hoisted(() => vi.fn().mockReturnValue("user1"));
const mockCollection = vi.hoisted(() => ({
  getFullList: vi.fn().mockResolvedValue([]),
  getList: vi.fn().mockResolvedValue({ items: [], totalPages: 0, totalItems: 0 }),
  create: vi.fn().mockResolvedValue({ id: "new1" }),
  update: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@/lib/pocketbase", () => ({
  accounts: () => mockCollection,
  getCurrentUserId: mockGetCurrentUserId,
  subscribeWithRetry: (fn: () => Promise<() => void>) => {
    fn().catch(() => {});
    return () => {};
  },
}));

import { useAccounts } from "../useAccounts";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUserId.mockReturnValue("user1");
  mockCollection.getFullList.mockResolvedValue([]);
  mockCollection.subscribe.mockResolvedValue(() => {});
});

describe("useAccounts", () => {
  describe("chargement initial", () => {
    it("charge les comptes au montage", async () => {
      const acc1 = makeAccount({ id: "acc1", label: "Perso" });
      const acc2 = makeAccount({ id: "acc2", label: "Pro" });
      mockCollection.getFullList.mockResolvedValue([acc1, acc2]);

      const { result } = renderHook(() => useAccounts());

      expect(result.current.loading).toBe(true);

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.accounts).toHaveLength(2);
      expect(result.current.error).toBeNull();
    });

    it("gere les erreurs de chargement", async () => {
      mockCollection.getFullList.mockRejectedValue(new Error("Network error"));

      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBe("Network error");
      expect(result.current.accounts).toHaveLength(0);
    });

    it("ne charge pas sans userId", async () => {
      mockGetCurrentUserId.mockReturnValue(null);

      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockCollection.getFullList).not.toHaveBeenCalled();
    });

    it("souscrit aux changements temps reel", async () => {
      renderHook(() => useAccounts());

      await waitFor(() => {
        expect(mockCollection.subscribe).toHaveBeenCalledWith(
          "*",
          expect.any(Function)
        );
      });
    });
  });

  describe("souscription temps reel", () => {
    it("ajoute un compte sur evenement create", async () => {
      const existingAcc = makeAccount({ id: "acc1", label: "Perso" });
      mockCollection.getFullList.mockResolvedValue([existingAcc]);

      let subscribeCallback: (e: { action: string; record: unknown }) => void = () => {};
      mockCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.accounts).toHaveLength(1);
      });

      const newAcc = makeAccount({ id: "acc2", label: "Pro", user: "user1" });
      act(() => {
        subscribeCallback({ action: "create", record: newAcc });
      });

      expect(result.current.accounts).toHaveLength(2);
    });

    it("met a jour un compte sur evenement update", async () => {
      const acc = makeAccount({ id: "acc1", label: "Perso" });
      mockCollection.getFullList.mockResolvedValue([acc]);

      let subscribeCallback: (e: { action: string; record: unknown }) => void = () => {};
      mockCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.accounts).toHaveLength(1);
      });

      act(() => {
        subscribeCallback({
          action: "update",
          record: makeAccount({ id: "acc1", label: "Personnel", user: "user1" }),
        });
      });

      expect(result.current.accounts[0].label).toBe("Personnel");
    });

    it("supprime un compte sur evenement delete", async () => {
      const acc = makeAccount({ id: "acc1", label: "Perso" });
      mockCollection.getFullList.mockResolvedValue([acc]);

      let subscribeCallback: (e: { action: string; record: unknown }) => void = () => {};
      mockCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.accounts).toHaveLength(1);
      });

      act(() => {
        subscribeCallback({ action: "delete", record: { id: "acc1", user: "user1" } });
      });

      expect(result.current.accounts).toHaveLength(0);
    });

    it("ignore les evenements d'autres utilisateurs", async () => {
      let subscribeCallback: (e: { action: string; record: unknown }) => void = () => {};
      mockCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      act(() => {
        subscribeCallback({
          action: "create",
          record: makeAccount({ id: "acc9", user: "user999" }),
        });
      });

      expect(result.current.accounts).toHaveLength(0);
    });
  });

  describe("createAccount", () => {
    it("cree un compte avec le userId courant", async () => {
      mockCollection.create.mockResolvedValue(makeAccount({ id: "new1" }));

      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.createAccount({ label: "Nouveau", email: "new@test.com" });
      });

      expect(mockCollection.create).toHaveBeenCalledWith(
        expect.objectContaining({ label: "Nouveau", email: "new@test.com", user: "user1" })
      );
    });

    it("throw si non authentifie", async () => {
      mockGetCurrentUserId.mockReturnValue(null);

      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await expect(
        result.current.createAccount({ label: "Test" })
      ).rejects.toThrow("Non authentifié");
    });
  });

  describe("updateAccount", () => {
    it("met a jour un compte existant", async () => {
      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.updateAccount("acc1", { label: "Updated" });
      });

      expect(mockCollection.update).toHaveBeenCalledWith("acc1", { label: "Updated" });
    });
  });

  describe("deleteAccount", () => {
    it("supprime un compte", async () => {
      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.deleteAccount("acc1");
      });

      expect(mockCollection.delete).toHaveBeenCalledWith("acc1");
    });
  });
});
