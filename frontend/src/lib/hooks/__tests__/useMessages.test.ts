import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeMessage, createMockCollection } from "./test-helpers";
import { useMailStore } from "@/lib/stores/mail-store";

const mockMessagesCollection = createMockCollection();
const mockFoldersCollection = createMockCollection();

vi.mock("@/lib/pocketbase", () => ({
  default: {
    collection: () => mockFoldersCollection,
  },
  messages: () => mockMessagesCollection,
  getCurrentUserId: vi.fn().mockReturnValue("user1"),
  subscribeWithRetry: (fn: () => Promise<() => void>) => {
    fn().catch(() => {});
    return () => {};
  },
}));

import { useMessages } from "../useMessages";

beforeEach(() => {
  vi.clearAllMocks();
  mockMessagesCollection.getList.mockResolvedValue({
    items: [],
    totalPages: 0,
    totalItems: 0,
  });
  mockMessagesCollection.subscribe.mockResolvedValue(() => {});
  useMailStore.setState({
    activeAccountId: "acc1",
    activeFolderIds: ["folder1"],
  });
});

describe("useMessages", () => {
  describe("chargement initial", () => {
    it("charge les messages au montage", async () => {
      const msg = makeMessage({ id: "msg1" });
      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg],
        totalPages: 1,
        totalItems: 1,
      });

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe("msg1");
    });

    it("construit le filtre avec account et folder", async () => {
      renderHook(() => useMessages());

      await waitFor(() => {
        expect(mockMessagesCollection.getList).toHaveBeenCalledWith(
          1,
          100,
          expect.objectContaining({
            filter: 'folder = "folder1" && account = "acc1" && is_draft = false',
            sort: "-date",
          })
        );
      });
    });

    it("n'inclut pas le filtre account quand 'all'", async () => {
      useMailStore.setState({ activeAccountId: "all" });

      renderHook(() => useMessages());

      await waitFor(() => {
        expect(mockMessagesCollection.getList).toHaveBeenCalledWith(
          1,
          100,
          expect.objectContaining({
            filter: 'folder = "folder1" && is_draft = false',
          })
        );
      });
    });

    it("gere les erreurs silencieusement", async () => {
      mockMessagesCollection.getList.mockRejectedValue(new Error("fail"));

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.messages).toHaveLength(0);
    });
  });

  describe("pagination", () => {
    it("indique hasMore quand il y a plus de pages", async () => {
      mockMessagesCollection.getList.mockResolvedValue({
        items: Array.from({ length: 100 }, (_, i) =>
          makeMessage({ id: `msg${i}` })
        ),
        totalPages: 3,
        totalItems: 150,
      });

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.hasMoreBottom).toBe(true);
      });
    });

    it("loadMore charge la page suivante", async () => {
      mockMessagesCollection.getList
        .mockResolvedValueOnce({
          items: [makeMessage({ id: "msg1" })],
          totalPages: 2,
          totalItems: 2,
        })
        .mockResolvedValueOnce({
          items: [makeMessage({ id: "msg2" })],
          totalPages: 2,
          totalItems: 2,
        });

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.hasMoreBottom).toBe(true);
      });

      await act(async () => {
        await result.current.loadMoreBottom();
      });

      expect(mockMessagesCollection.getList).toHaveBeenCalledTimes(2);
      expect(result.current.messages).toHaveLength(2);
    });

    it("loadMore ne fait rien si pas de page suivante", async () => {
      mockMessagesCollection.getList.mockResolvedValue({
        items: [makeMessage()],
        totalPages: 1,
        totalItems: 1,
      });

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.hasMoreBottom).toBe(false);
      });

      await act(async () => {
        await result.current.loadMoreBottom();
      });

      expect(mockMessagesCollection.getList).toHaveBeenCalledTimes(1);
    });
  });

  describe("actions", () => {
    it("markAsRead met a jour is_read", async () => {
      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.markAsRead("msg1");
      });

      expect(mockMessagesCollection.update).toHaveBeenCalledWith("msg1", {
        is_read: true,
      });
    });

    it("markAsRead peut mettre is_read a false", async () => {
      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.markAsRead("msg1", false);
      });

      expect(mockMessagesCollection.update).toHaveBeenCalledWith("msg1", {
        is_read: false,
      });
    });

    it("markAsStarred toggle l'etoile", async () => {
      mockMessagesCollection.getList.mockResolvedValue({
        items: [makeMessage({ id: "msg1", is_starred: false })],
        totalPages: 1,
        totalItems: 1,
      });

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(1);
      });

      await act(async () => {
        await result.current.markAsStarred("msg1");
      });

      expect(mockMessagesCollection.update).toHaveBeenCalledWith("msg1", {
        is_starred: true,
      });
    });

    it("markAsStarred accepte une valeur explicite", async () => {
      mockMessagesCollection.getList.mockResolvedValue({
        items: [makeMessage({ id: "msg1", is_starred: true })],
        totalPages: 1,
        totalItems: 1,
      });

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(1);
      });

      await act(async () => {
        await result.current.markAsStarred("msg1", false);
      });

      expect(mockMessagesCollection.update).toHaveBeenCalledWith("msg1", {
        is_starred: false,
      });
    });

    it("moveToTrash deplace le message vers la corbeille", async () => {
      const msg = makeMessage({ id: "msg1", account: "acc1" });
      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg],
        totalPages: 1,
        totalItems: 1,
      });

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      mockFoldersCollection.getFirstListItem.mockResolvedValue({ id: "trash-folder-id" });

      await act(async () => {
        await result.current.moveToTrash("msg1");
      });

      expect(mockMessagesCollection.update).toHaveBeenCalledWith("msg1", { folder: "trash-folder-id" });
    });

    it("archiveMessage deplace vers le dossier archive", async () => {
      mockMessagesCollection.getList.mockResolvedValue({
        items: [makeMessage({ id: "msg1", account: "acc1" })],
        totalPages: 1,
        totalItems: 1,
      });

      mockFoldersCollection.getFirstListItem.mockResolvedValue({
        id: "archive-folder",
      });

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(1);
      });

      await act(async () => {
        await result.current.archiveMessage("msg1");
      });

      expect(mockMessagesCollection.update).toHaveBeenCalledWith("msg1", {
        folder: "archive-folder",
      });
    });
  });

  describe("souscription temps reel", () => {
    it("ajoute un message sur evenement create", async () => {
      mockMessagesCollection.getList.mockResolvedValue({
        items: [],
        totalPages: 0,
        totalItems: 0,
      });

      let subscribeCallback: (e: { action: string; record: unknown }) => void =
        () => {};
      mockMessagesCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const newMsg = makeMessage({
        id: "msg-new",
        folder: "folder1",
        account: "acc1",
      });
      act(() => {
        subscribeCallback({ action: "create", record: newMsg });
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe("msg-new");
    });

    it("ignore les messages d'autres dossiers", async () => {
      mockMessagesCollection.getList.mockResolvedValue({
        items: [],
        totalPages: 0,
        totalItems: 0,
      });

      let subscribeCallback: (e: { action: string; record: unknown }) => void =
        () => {};
      mockMessagesCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      act(() => {
        subscribeCallback({
          action: "create",
          record: makeMessage({ folder: "other-folder", account: "acc1" }),
        });
      });

      expect(result.current.messages).toHaveLength(0);
    });

    it("met a jour un message existant sur update", async () => {
      const msg = makeMessage({ id: "msg1", is_read: false });
      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg],
        totalPages: 1,
        totalItems: 1,
      });

      let subscribeCallback: (e: { action: string; record: unknown }) => void =
        () => {};
      mockMessagesCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(1);
      });

      act(() => {
        subscribeCallback({
          action: "update",
          record: makeMessage({
            id: "msg1",
            is_read: true,
            folder: "folder1",
            account: "acc1",
          }),
        });
      });

      expect(result.current.messages[0].is_read).toBe(true);
    });

    it("supprime un message sur delete", async () => {
      const msg = makeMessage({ id: "msg1" });
      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg],
        totalPages: 1,
        totalItems: 1,
      });

      let subscribeCallback: (e: { action: string; record: unknown }) => void =
        () => {};
      mockMessagesCollection.subscribe.mockImplementation(
        (_topic: string, cb: typeof subscribeCallback) => {
          subscribeCallback = cb;
          return Promise.resolve(() => {});
        }
      );

      const { result } = renderHook(() => useMessages());

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(1);
      });

      act(() => {
        subscribeCallback({
          action: "delete",
          record: makeMessage({ id: "msg1", folder: "folder1", account: "acc1" }),
        });
      });

      expect(result.current.messages).toHaveLength(0);
    });
  });
});
