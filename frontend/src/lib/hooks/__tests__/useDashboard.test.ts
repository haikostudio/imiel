import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { makeMessage } from "./test-helpers";
import { useMailStore } from "@/lib/stores/mail-store";

const mockGetCurrentUserId = vi.hoisted(() => vi.fn().mockReturnValue("user1"));
const mockMessagesCol = vi.hoisted(() => ({
  getFullList: vi.fn().mockResolvedValue([]),
  getList: vi.fn().mockResolvedValue({ items: [], totalPages: 0, totalItems: 0 }),
}));

vi.mock("@/lib/pocketbase", () => ({
  messages: () => mockMessagesCol,
  getCurrentUserId: mockGetCurrentUserId,
}));

import { useDashboard } from "../useDashboard";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUserId.mockReturnValue("user1");
  mockMessagesCol.getFullList.mockResolvedValue([]);
  mockMessagesCol.getList.mockResolvedValue({
    items: [],
    totalPages: 0,
    totalItems: 0,
  });
  useMailStore.setState({ activeAccountId: "acc1" });
});

describe("useDashboard", () => {
  describe("etat initial", () => {
    it("demarre en chargement", () => {
      const { result } = renderHook(() => useDashboard());
      expect(result.current.loading).toBe(true);
    });

    it("a des stats a zero par defaut", () => {
      const { result } = renderHook(() => useDashboard());
      expect(result.current.stats.unreadCount).toBe(0);
      expect(result.current.stats.sentCount7d).toBe(0);
    });
  });

  describe("chargement des donnees", () => {
    it("charge et calcule les stats", async () => {
      const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

      mockMessagesCol.getFullList.mockResolvedValue([
        makeMessage({ id: "msg1", date: recentDate, is_sent: true }),
        makeMessage({ id: "msg2", date: recentDate, is_sent: false }),
      ]);

      mockMessagesCol.getList
        .mockResolvedValueOnce({ items: [], totalPages: 0, totalItems: 3 })
        .mockResolvedValueOnce({ items: [makeMessage()], totalPages: 1, totalItems: 5 })
        .mockResolvedValueOnce({ items: [], totalPages: 0, totalItems: 0 });

      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.stats.unreadCount).toBe(3);
      expect(result.current.stats.sentCount7d).toBe(1);
    });

    it("calcule les top contacts", async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

      mockMessagesCol.getFullList.mockResolvedValue([
        makeMessage({ id: "msg1", date: recentDate, from_address: { name: "Alice", address: "alice@test.com" } }),
        makeMessage({ id: "msg2", date: recentDate, from_address: { name: "Alice", address: "alice@test.com" } }),
        makeMessage({ id: "msg3", date: recentDate, from_address: { name: "Bob", address: "bob@test.com" } }),
      ]);

      mockMessagesCol.getList.mockResolvedValue({ items: [], totalPages: 0, totalItems: 0 });

      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.topContacts).toHaveLength(2);
      expect(result.current.topContacts[0].email).toBe("alice@test.com");
      expect(result.current.topContacts[0].count).toBe(2);
    });

    it("genere les donnees d'activite sur 7 jours", async () => {
      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.activityData).toHaveLength(7);
      expect(result.current.activityData[0]).toHaveProperty("date");
      expect(result.current.activityData[0]).toHaveProperty("received");
      expect(result.current.activityData[0]).toHaveProperty("sent");
    });
  });

  describe("needsReply", () => {
    it("charge les messages necessitant une reponse", async () => {
      const msg = makeMessage({ id: "msg-needs-reply", is_read: true, is_answered: false });

      mockMessagesCol.getList
        .mockResolvedValueOnce({ items: [], totalPages: 0, totalItems: 0 })
        .mockResolvedValueOnce({ items: [msg], totalPages: 1, totalItems: 1 })
        .mockResolvedValueOnce({ items: [], totalPages: 0, totalItems: 0 });

      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.needsReply).toHaveLength(1);
      expect(result.current.stats.unansweredCount).toBe(1);
    });
  });

  describe("waitingReply", () => {
    it("charge les messages en attente de reponse", async () => {
      const msg = makeMessage({
        id: "msg-waiting",
        is_answered: false,
        date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      });

      mockMessagesCol.getList
        .mockResolvedValueOnce({ items: [], totalPages: 0, totalItems: 0 })
        .mockResolvedValueOnce({ items: [], totalPages: 0, totalItems: 0 })
        .mockResolvedValueOnce({ items: [msg], totalPages: 1, totalItems: 1 });

      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.waitingReply).toHaveLength(1);
    });
  });

  describe("sans authentification", () => {
    it("ne charge pas sans userId", async () => {
      mockGetCurrentUserId.mockReturnValue(null);

      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockMessagesCol.getFullList).not.toHaveBeenCalled();
    });
  });

  describe("filtre par compte", () => {
    it("inclut le filtre account dans la requete", async () => {
      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const call = mockMessagesCol.getFullList.mock.calls[0];
      expect(call[0].filter).toContain('account = "acc1"');
    });

    it("pas de filtre account quand 'all'", async () => {
      useMailStore.setState({ activeAccountId: "all" });

      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const call = mockMessagesCol.getFullList.mock.calls[0];
      expect(call[0].filter).not.toContain("account");
    });
  });

  describe("gestion erreurs", () => {
    it("gere les erreurs silencieusement", async () => {
      mockMessagesCol.getFullList.mockRejectedValue(new Error("fail"));

      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.topContacts).toHaveLength(0);
    });
  });
});
