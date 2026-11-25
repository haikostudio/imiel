import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockGetCurrentUserId = vi.hoisted(() => vi.fn().mockReturnValue("user1"));
const mockPushTokens = vi.hoisted(() => ({
  getFirstListItem: vi.fn(),
  create: vi.fn().mockResolvedValue({ id: "token1" }),
  delete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pocketbase", () => ({
  pushTokens: () => mockPushTokens,
  getCurrentUserId: mockGetCurrentUserId,
}));

import { useNotifications } from "../useNotifications";

const mockUnsubscribe = vi.fn().mockResolvedValue(true);
const mockSubscribe = vi.fn().mockResolvedValue({
  toJSON: () => ({
    endpoint: "https://push.example.com/test",
    keys: { p256dh: "key1", auth: "key2" },
  }),
});
const mockGetSubscription = vi.fn().mockResolvedValue({
  endpoint: "https://push.example.com/test",
  unsubscribe: mockUnsubscribe,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUserId.mockReturnValue("user1");
  mockPushTokens.getFirstListItem.mockRejectedValue(new Error("Not found"));

  // Notification API
  Object.defineProperty(window, "Notification", {
    writable: true,
    configurable: true,
    value: {
      permission: "default",
      requestPermission: vi.fn().mockResolvedValue("granted"),
    },
  });

  // ServiceWorker
  Object.defineProperty(navigator, "serviceWorker", {
    writable: true,
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: {
          subscribe: mockSubscribe,
          getSubscription: mockGetSubscription,
        },
      }),
    },
  });
});

describe("useNotifications", () => {
  describe("etat initial", () => {
    it("retourne la permission courante", () => {
      const { result } = renderHook(() => useNotifications());
      expect(result.current.permission).toBe("default");
    });
  });

  describe("subscribe", () => {
    it("demande la permission de notifications", async () => {
      const { result } = renderHook(() => useNotifications());

      await act(async () => {
        await result.current.subscribe();
      });

      expect(window.Notification.requestPermission).toHaveBeenCalled();
    });

    it("enregistre le token push apres permission granted", async () => {
      const { result } = renderHook(() => useNotifications());

      await act(async () => {
        await result.current.subscribe();
      });

      expect(mockPushTokens.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user: "user1",
          endpoint: "https://push.example.com/test",
          p256dh: "key1",
          auth_key: "key2",
          is_active: true,
        })
      );
    });

    it("ne cree pas de doublon si le token existe deja", async () => {
      mockPushTokens.getFirstListItem.mockResolvedValue({ id: "existing-token" });

      const { result } = renderHook(() => useNotifications());

      await act(async () => {
        await result.current.subscribe();
      });

      expect(mockPushTokens.create).not.toHaveBeenCalled();
    });

    it("ne fait rien si permission refusee", async () => {
      (window.Notification.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue("denied");

      const { result } = renderHook(() => useNotifications());

      await act(async () => {
        await result.current.subscribe();
      });

      expect(result.current.permission).toBe("denied");
      expect(mockPushTokens.create).not.toHaveBeenCalled();
    });

    it("ne fait rien sans userId", async () => {
      mockGetCurrentUserId.mockReturnValue(null);

      const { result } = renderHook(() => useNotifications());

      await act(async () => {
        await result.current.subscribe();
      });

      expect(window.Notification.requestPermission).not.toHaveBeenCalled();
    });
  });

  describe("unsubscribe", () => {
    it("desinscrit des notifications push", async () => {
      mockPushTokens.getFirstListItem.mockResolvedValue({ id: "token1" });

      const { result } = renderHook(() => useNotifications());

      await act(async () => {
        await result.current.unsubscribe();
      });

      expect(mockUnsubscribe).toHaveBeenCalled();
      expect(mockPushTokens.delete).toHaveBeenCalledWith("token1");
    });

    it("ne fait rien sans userId", async () => {
      mockGetCurrentUserId.mockReturnValue(null);

      const { result } = renderHook(() => useNotifications());

      await act(async () => {
        await result.current.unsubscribe();
      });

      expect(mockPushTokens.delete).not.toHaveBeenCalled();
    });
  });
});
