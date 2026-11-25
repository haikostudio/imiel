import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { makeMessage, createMockCollection } from "./test-helpers";
import { useMailStore } from "@/lib/stores/mail-store";

const mockMessagesCollection = createMockCollection();

vi.mock("@/lib/pocketbase", () => ({
  messages: () => mockMessagesCollection,
  subscribeWithRetry: (fn: () => Promise<() => void>) => {
    fn().catch(() => {});
    return () => {};
  },
}));

import { useThreads } from "../useThreads";

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

describe("useThreads", () => {
  describe("chargement", () => {
    it("charge et groupe les messages par thread", async () => {
      const msg1 = makeMessage({
        id: "msg1",
        thread_id: "t1",
        subject: "Sujet A",
        date: "2025-06-15T10:00:00Z",
        is_read: false,
      });
      const msg2 = makeMessage({
        id: "msg2",
        thread_id: "t1",
        subject: "Re: Sujet A",
        date: "2025-06-15T11:00:00Z",
        is_read: true,
        from_address: { name: "Bob", address: "bob@test.com" },
      });
      const msg3 = makeMessage({
        id: "msg3",
        thread_id: "t2",
        subject: "Autre sujet",
        date: "2025-06-15T12:00:00Z",
        message_id: "<msg3@test.com>",
      });

      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg1, msg2, msg3],
        totalPages: 1,
        totalItems: 3,
      });

      const { result } = renderHook(() => useThreads());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.threads).toHaveLength(2);
    });

    it("trie les threads par date du dernier message (plus recent en premier)", async () => {
      const msg1 = makeMessage({
        id: "msg1",
        message_id: "<msg1@test.com>",
        thread_id: "t1",
        subject: "Sujet A",
        date: "2025-06-14T10:00:00Z",
      });
      const msg2 = makeMessage({
        id: "msg2",
        message_id: "<msg2@test.com>",
        thread_id: "t2",
        subject: "Sujet B",
        date: "2025-06-15T10:00:00Z",
      });

      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg1, msg2],
        totalPages: 1,
        totalItems: 2,
      });

      const { result } = renderHook(() => useThreads());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.threads[0].id).toBe("t2");
      expect(result.current.threads[1].id).toBe("t1");
    });

    it("calcule les participants uniques", async () => {
      const msg1 = makeMessage({
        id: "msg1",
        thread_id: "t1",
        from_address: { name: "Alice", address: "alice@test.com" },
        to_addresses: [{ name: "Bob", address: "bob@test.com" }],
      });
      const msg2 = makeMessage({
        id: "msg2",
        thread_id: "t1",
        from_address: { name: "Bob", address: "bob@test.com" },
        to_addresses: [{ name: "Alice", address: "alice@test.com" }],
        date: "2025-06-15T11:00:00Z",
      });

      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg1, msg2],
        totalPages: 1,
        totalItems: 2,
      });

      const { result } = renderHook(() => useThreads());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.threads[0].participants).toContain("alice@test.com");
      expect(result.current.threads[0].participants).toContain("bob@test.com");
      expect(result.current.threads[0].participants).toHaveLength(2);
    });

    it("calcule unreadCount", async () => {
      const msg1 = makeMessage({
        id: "msg1",
        message_id: "<msg1@test.com>",
        thread_id: "t1",
        is_read: false,
      });
      const msg2 = makeMessage({
        id: "msg2",
        message_id: "<msg2@test.com>",
        thread_id: "t1",
        is_read: true,
        date: "2025-06-15T11:00:00Z",
      });
      const msg3 = makeMessage({
        id: "msg3",
        message_id: "<msg3@test.com>",
        thread_id: "t1",
        is_read: false,
        date: "2025-06-15T12:00:00Z",
      });

      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg1, msg2, msg3],
        totalPages: 1,
        totalItems: 3,
      });

      const { result } = renderHook(() => useThreads());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.threads[0].unreadCount).toBe(2);
    });

    it("detecte hasAttachments", async () => {
      const msg1 = makeMessage({
        id: "msg1",
        message_id: "<msg1@test.com>",
        thread_id: "t1",
        has_attachments: false,
      });
      const msg2 = makeMessage({
        id: "msg2",
        message_id: "<msg2@test.com>",
        thread_id: "t1",
        has_attachments: true,
        date: "2025-06-15T11:00:00Z",
      });

      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg1, msg2],
        totalPages: 1,
        totalItems: 2,
      });

      const { result } = renderHook(() => useThreads());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.threads[0].hasAttachments).toBe(true);
    });

    it("detecte isStarred", async () => {
      const msg1 = makeMessage({
        id: "msg1",
        message_id: "<msg1@test.com>",
        thread_id: "t1",
        is_starred: false,
      });
      const msg2 = makeMessage({
        id: "msg2",
        message_id: "<msg2@test.com>",
        thread_id: "t1",
        is_starred: true,
        date: "2025-06-15T11:00:00Z",
      });

      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg1, msg2],
        totalPages: 1,
        totalItems: 2,
      });

      const { result } = renderHook(() => useThreads());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.threads[0].isStarred).toBe(true);
    });

    it("nettoie le sujet (retire Re: Fwd: etc.)", async () => {
      const msg = makeMessage({
        id: "msg1",
        thread_id: "t1",
        subject: "Re: Fwd: Mon sujet",
      });

      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg],
        totalPages: 1,
        totalItems: 1,
      });

      const { result } = renderHook(() => useThreads());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.threads[0].subject).not.toContain("Re:");
    });
  });

  describe("getThread", () => {
    it("retourne un thread par ID", async () => {
      const msg = makeMessage({ id: "msg1", thread_id: "t1" });
      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg],
        totalPages: 1,
        totalItems: 1,
      });

      const { result } = renderHook(() => useThreads());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const thread = result.current.getThread("t1");
      expect(thread).toBeDefined();
      expect(thread?.id).toBe("t1");
    });

    it("retourne undefined pour un ID inexistant", async () => {
      const { result } = renderHook(() => useThreads());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.getThread("nonexistent")).toBeUndefined();
    });
  });

  describe("gestion erreurs", () => {
    it("retourne un tableau vide en cas d'erreur", async () => {
      mockMessagesCollection.getList.mockRejectedValue(
        new Error("Network error")
      );

      const { result } = renderHook(() => useThreads());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.threads).toHaveLength(0);
    });
  });

  describe("filtre", () => {
    it("filtre par account et folder", async () => {
      renderHook(() => useThreads());

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

    it("pas de filtre account quand 'all'", async () => {
      useMailStore.setState({ activeAccountId: "all" });

      renderHook(() => useThreads());

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
  });
});
