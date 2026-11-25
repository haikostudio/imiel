import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted() pour que les variables soient accessibles dans vi.mock()
const { mockAuthWithPassword, mockClear, mockGetURL, mockCollectionFn, mockSend } =
  vi.hoisted(() => ({
    mockAuthWithPassword: vi.fn(),
    mockClear: vi.fn(),
    mockGetURL: vi.fn(),
    mockCollectionFn: vi.fn(),
    mockSend: vi.fn(),
  }));

vi.mock("pocketbase", () => {
  return {
    default: class MockPocketBase {
      authStore = {
        isValid: true,
        record: { id: "user1" },
        clear: mockClear,
      };
      collection = mockCollectionFn.mockReturnValue({
        authWithPassword: mockAuthWithPassword,
      });
      autoCancellation = vi.fn();
      send = mockSend;
      files = {
        getURL: mockGetURL,
      };
      realtime = { onDisconnect: null };
    },
    RecordModel: class {},
  };
});

// Mock fetch pour sendMessage
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

import pb, {
  login,
  logout,
  isAuthenticated,
  getCurrentUserId,
  getFileUrl,
  sendMessage,
  accounts,
  folders,
  messages,
  labels,
  pushTokens,
  users,
} from "../pocketbase";

beforeEach(() => {
  vi.clearAllMocks();
  (pb.authStore as { isValid: boolean }).isValid = true;
  (pb.authStore as { record: unknown }).record = { id: "user1" };
});

describe("pocketbase", () => {
  describe("client singleton", () => {
    it("exporte un client PocketBase", () => {
      expect(pb).toBeDefined();
      expect(pb.authStore).toBeDefined();
    });
  });

  describe("login", () => {
    it("appelle authWithPassword", async () => {
      mockAuthWithPassword.mockResolvedValue({ record: { id: "user1" } });

      await login("test@test.com", "password123");

      expect(mockCollectionFn).toHaveBeenCalledWith("users");
      expect(mockAuthWithPassword).toHaveBeenCalledWith(
        "test@test.com",
        "password123"
      );
    });
  });

  describe("logout", () => {
    it("vide l'authStore", async () => {
      await logout();
      expect(mockClear).toHaveBeenCalled();
    });
  });

  describe("isAuthenticated", () => {
    it("retourne true si authStore est valide", () => {
      (pb.authStore as { isValid: boolean }).isValid = true;
      expect(isAuthenticated()).toBe(true);
    });

    it("retourne false si authStore est invalide", () => {
      (pb.authStore as { isValid: boolean }).isValid = false;
      expect(isAuthenticated()).toBe(false);
    });
  });

  describe("getCurrentUserId", () => {
    it("retourne l'ID de l'utilisateur connecte", () => {
      expect(getCurrentUserId()).toBe("user1");
    });

    it("retourne null sans utilisateur", () => {
      (pb.authStore as { record: unknown }).record = null;
      expect(getCurrentUserId()).toBeNull();
    });
  });

  describe("getFileUrl", () => {
    it("appelle pb.files.getURL avec les bons params", () => {
      const record = { id: "rec1", collectionId: "col1" } as never;
      mockGetURL.mockReturnValue("https://example.com/file.pdf");

      const url = getFileUrl(record, "file.pdf");

      expect(mockGetURL).toHaveBeenCalledWith(record, "file.pdf", {
        thumb: undefined,
      });
      expect(url).toBe("https://example.com/file.pdf");
    });

    it("passe le param thumb", () => {
      const record = { id: "rec1" } as never;
      getFileUrl(record, "photo.jpg", "100x100");

      expect(mockGetURL).toHaveBeenCalledWith(record, "photo.jpg", {
        thumb: "100x100",
      });
    });
  });

  describe("collection helpers", () => {
    it("accounts() retourne la collection accounts", () => {
      accounts();
      expect(mockCollectionFn).toHaveBeenCalledWith("accounts");
    });

    it("folders() retourne la collection folders", () => {
      folders();
      expect(mockCollectionFn).toHaveBeenCalledWith("folders");
    });

    it("messages() retourne la collection messages", () => {
      messages();
      expect(mockCollectionFn).toHaveBeenCalledWith("messages");
    });

    it("labels() retourne la collection labels", () => {
      labels();
      expect(mockCollectionFn).toHaveBeenCalledWith("labels");
    });

    it("pushTokens() retourne la collection push_tokens", () => {
      pushTokens();
      expect(mockCollectionFn).toHaveBeenCalledWith("push_tokens");
    });

    it("users() retourne la collection users", () => {
      users();
      expect(mockCollectionFn).toHaveBeenCalledWith("users");
    });
  });

  describe("sendMessage", () => {
    it("envoie un message via /worker/send", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ success: true, messageId: "sent1" })),
      });

      const result = await sendMessage("acc1", "msg1");

      expect(mockFetch).toHaveBeenCalledWith(
        "/worker/send",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ accountId: "acc1", messageId: "msg1" }),
        })
      );
      expect(result.status).toBe("sent");
    });

    it("throw en cas d'erreur du worker", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(JSON.stringify({ error: "SMTP connection failed" })),
      });

      await expect(sendMessage("acc1", "msg1")).rejects.toThrow(
        "SMTP connection failed"
      );
    });

    it("throw avec message generique si pas d'erreur specifique", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(JSON.stringify({})),
      });

      await expect(sendMessage("acc1", "msg1")).rejects.toThrow(
        "Erreur lors de l'envoi"
      );
    });

    it("throw si reponse non-JSON", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.resolve("Bad Gateway"),
      });

      await expect(sendMessage("acc1", "msg1")).rejects.toThrow(
        "Erreur serveur (502)"
      );
    });
  });
});
