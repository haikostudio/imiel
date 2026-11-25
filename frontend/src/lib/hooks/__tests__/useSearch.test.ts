import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeMessage, createMockCollection } from "./test-helpers";
import { useMailStore } from "@/lib/stores/mail-store";

const mockMessagesCollection = createMockCollection();

vi.mock("@/lib/pocketbase", () => ({
  messages: () => mockMessagesCollection,
  subscribeWithRetry: (fn: () => Promise<() => void>) => {
    fn().catch(() => {});
    return () => {};
  },
  // null force le fallback PB LIKE (les tests valident ce comportement).
  // La branche hybride est testee separement avec un mock fetch dedie.
  getCurrentUserId: () => null,
}));

import { useSearch } from "../useSearch";

beforeEach(() => {
  vi.clearAllMocks();
  mockMessagesCollection.getList.mockResolvedValue({
    items: [],
    totalPages: 0,
    totalItems: 0,
  });
  useMailStore.setState({ activeAccountId: "acc1" });
});

describe("useSearch", () => {
  describe("etat initial", () => {
    it("demarre sans resultats et pas en chargement", () => {
      const { result } = renderHook(() => useSearch());
      expect(result.current.results).toHaveLength(0);
      expect(result.current.loading).toBe(false);
    });
  });

  describe("recherche texte libre", () => {
    it("recherche avec texte libre", async () => {
      const msg = makeMessage({ id: "msg1", subject: "Facture" });
      mockMessagesCollection.getList.mockResolvedValue({
        items: [msg],
        totalPages: 1,
        totalItems: 1,
      });

      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("facture");
      });

      expect(result.current.results).toHaveLength(1);
      expect(mockMessagesCollection.getList).toHaveBeenCalledWith(
        1,
        300,
        expect.objectContaining({
          filter: expect.stringContaining('subject ~ "facture"'),
          sort: "-date",
        })
      );
    });

    it("retourne vide pour une query vide", async () => {
      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("");
      });

      expect(result.current.results).toHaveLength(0);
      expect(mockMessagesCollection.getList).not.toHaveBeenCalled();
    });

    it("retourne vide pour une query avec espaces", async () => {
      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("   ");
      });

      expect(result.current.results).toHaveLength(0);
    });
  });

  describe("filtres avances", () => {
    it("parse from:", async () => {
      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("from:alice@test.com");
      });

      expect(mockMessagesCollection.getList).toHaveBeenCalledWith(
        1,
        300,
        expect.objectContaining({
          filter: expect.stringContaining('from_address ~ "alice@test.com"'),
        })
      );
    });

    it("parse to:", async () => {
      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("to:bob@test.com");
      });

      expect(mockMessagesCollection.getList).toHaveBeenCalledWith(
        1,
        300,
        expect.objectContaining({
          filter: expect.stringContaining('to_addresses ~ "bob@test.com"'),
        })
      );
    });

    it("parse subject:", async () => {
      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("subject:facture");
      });

      expect(mockMessagesCollection.getList).toHaveBeenCalledWith(
        1,
        300,
        expect.objectContaining({
          filter: expect.stringContaining('subject ~ "facture"'),
        })
      );
    });

    it("parse has:attachment", async () => {
      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("has:attachment");
      });

      expect(mockMessagesCollection.getList).toHaveBeenCalledWith(
        1,
        300,
        expect.objectContaining({
          filter: expect.stringContaining("has_attachments = true"),
        })
      );
    });

    it("parse is:unread", async () => {
      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("is:unread");
      });

      expect(mockMessagesCollection.getList).toHaveBeenCalledWith(
        1,
        300,
        expect.objectContaining({
          filter: expect.stringContaining("is_read = false"),
        })
      );
    });

    it("parse is:starred", async () => {
      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("is:starred");
      });

      expect(mockMessagesCollection.getList).toHaveBeenCalledWith(
        1,
        300,
        expect.objectContaining({
          filter: expect.stringContaining("is_starred = true"),
        })
      );
    });

    it("parse after: et before:", async () => {
      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("after:2024-01-01 before:2024-12-31");
      });

      const filter = mockMessagesCollection.getList.mock.calls[0][2].filter;
      expect(filter).toContain('date >= "2024-01-01"');
      expect(filter).toContain('date <= "2024-12-31"');
    });

    it("combine filtres et texte libre", async () => {
      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("from:alice@test.com facture urgente");
      });

      const filter = mockMessagesCollection.getList.mock.calls[0][2].filter;
      expect(filter).toContain('from_address ~ "alice@test.com"');
      expect(filter).toContain('subject ~ "facture urgente"');
    });
  });

  describe("filtre par compte", () => {
    it("inclut le filtre account actif", async () => {
      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("test");
      });

      expect(mockMessagesCollection.getList).toHaveBeenCalledWith(
        1,
        300,
        expect.objectContaining({
          filter: expect.stringContaining('account = "acc1"'),
        })
      );
    });

    it("pas de filtre account quand 'all'", async () => {
      useMailStore.setState({ activeAccountId: "all" });

      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("test");
      });

      const filter = mockMessagesCollection.getList.mock.calls[0][2].filter;
      expect(filter).not.toContain("account");
    });
  });

  describe("gestion erreurs", () => {
    it("retourne vide en cas d'erreur", async () => {
      mockMessagesCollection.getList.mockRejectedValue(new Error("fail"));

      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("test");
      });

      expect(result.current.results).toHaveLength(0);
      expect(result.current.loading).toBe(false);
    });
  });

  describe("etat de chargement", () => {
    it("loading revient a false apres la recherche", async () => {
      mockMessagesCollection.getList.mockResolvedValue({
        items: [makeMessage()],
        totalPages: 1,
        totalItems: 1,
      });

      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search("test");
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.results).toHaveLength(1);
    });
  });
});
