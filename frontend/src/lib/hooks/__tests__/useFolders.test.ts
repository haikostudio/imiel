import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeFolder, createMockCollection } from "./test-helpers";
import { useMailStore } from "@/lib/stores/mail-store";

const mockFoldersCollection = createMockCollection();

vi.mock("@/lib/pocketbase", () => ({
  folders: () => mockFoldersCollection,
  subscribeWithRetry: (fn: () => Promise<() => void>) => {
    fn().catch(() => {});
    return () => {};
  },
}));

import { useFolders } from "../useFolders";

beforeEach(() => {
  vi.clearAllMocks();
  mockFoldersCollection.getFullList.mockResolvedValue([]);
  mockFoldersCollection.subscribe.mockResolvedValue(() => {});
  useMailStore.setState({ activeAccountId: "acc1" });
});

describe("useFolders", () => {
  describe("chargement initial", () => {
    it("charge les dossiers au montage", async () => {
      const inbox = makeFolder({ id: "f1", name: "Inbox", type: "inbox", sort_order: 0 });
      const sent = makeFolder({ id: "f2", name: "Sent", type: "sent", sort_order: 1 });
      mockFoldersCollection.getFullList.mockResolvedValue([inbox, sent]);

      const { result } = renderHook(() => useFolders());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.folders).toHaveLength(2);
    });

    it("filtre par account actif", async () => {
      renderHook(() => useFolders());

      await waitFor(() => {
        expect(mockFoldersCollection.getFullList).toHaveBeenCalledWith(
          expect.objectContaining({
            filter: 'account = "acc1"',
            sort: "sort_order,name",
          })
        );
      });
    });

    it("ne filtre pas quand 'all'", async () => {
      useMailStore.setState({ activeAccountId: "all" });

      renderHook(() => useFolders());

      await waitFor(() => {
        expect(mockFoldersCollection.getFullList).toHaveBeenCalledWith(
          expect.objectContaining({
            filter: "",
          })
        );
      });
    });

    it("retourne vide sans account actif", async () => {
      useMailStore.setState({ activeAccountId: null });

      const { result } = renderHook(() => useFolders());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.folders).toHaveLength(0);
      expect(mockFoldersCollection.getFullList).not.toHaveBeenCalled();
    });

    it("gere les erreurs silencieusement", async () => {
      mockFoldersCollection.getFullList.mockRejectedValue(new Error("fail"));

      const { result } = renderHook(() => useFolders());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.folders).toHaveLength(0);
    });
  });

  describe("souscription temps reel", () => {
    it("ajoute un dossier sur evenement create", async () => {
      mockFoldersCollection.getFullList.mockResolvedValue([]);

      let subscribeCallback: (e: { action: string; record: unknown }) => void =
        () => {};
      mockFoldersCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useFolders());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      act(() => {
        subscribeCallback({
          action: "create",
          record: makeFolder({ id: "f-new", account: "acc1", sort_order: 5 }),
        });
      });

      expect(result.current.folders).toHaveLength(1);
    });

    it("met a jour un dossier sur evenement update", async () => {
      const folder = makeFolder({ id: "f1", unread_count: 5 });
      mockFoldersCollection.getFullList.mockResolvedValue([folder]);

      let subscribeCallback: (e: { action: string; record: unknown }) => void =
        () => {};
      mockFoldersCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useFolders());

      await waitFor(() => {
        expect(result.current.folders).toHaveLength(1);
      });

      act(() => {
        subscribeCallback({
          action: "update",
          record: makeFolder({ id: "f1", unread_count: 3, account: "acc1" }),
        });
      });

      expect(result.current.folders[0].unread_count).toBe(3);
    });

    it("supprime un dossier sur evenement delete", async () => {
      const folder = makeFolder({ id: "f1" });
      mockFoldersCollection.getFullList.mockResolvedValue([folder]);

      let subscribeCallback: (e: { action: string; record: unknown }) => void =
        () => {};
      mockFoldersCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useFolders());

      await waitFor(() => {
        expect(result.current.folders).toHaveLength(1);
      });

      act(() => {
        subscribeCallback({
          action: "delete",
          record: makeFolder({ id: "f1", account: "acc1" }),
        });
      });

      expect(result.current.folders).toHaveLength(0);
    });

    it("ignore les evenements d'autres comptes", async () => {
      mockFoldersCollection.getFullList.mockResolvedValue([]);

      let subscribeCallback: (e: { action: string; record: unknown }) => void =
        () => {};
      mockFoldersCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useFolders());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      act(() => {
        subscribeCallback({
          action: "create",
          record: makeFolder({ id: "f-other", account: "other-acc" }),
        });
      });

      expect(result.current.folders).toHaveLength(0);
    });
  });
});
