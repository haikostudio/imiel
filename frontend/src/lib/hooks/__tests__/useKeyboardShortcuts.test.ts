import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMailStore } from "@/lib/stores/mail-store";

import { useKeyboardShortcuts } from "../useKeyboardShortcuts";

beforeEach(() => {
  useMailStore.setState({
    composeInstances: [],
    searchOpen: false,
  });
});

function fireKey(
  key: string,
  opts: Partial<KeyboardEventInit> = {}
) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    ...opts,
  });
  window.dispatchEvent(event);
}

describe("useKeyboardShortcuts", () => {
  describe("recherche (Cmd+K)", () => {
    it("ouvre la recherche avec Cmd+K", () => {
      renderHook(() => useKeyboardShortcuts());

      fireKey("k", { metaKey: true });

      expect(useMailStore.getState().searchOpen).toBe(true);
    });

    it("ouvre la recherche avec Ctrl+K", () => {
      renderHook(() => useKeyboardShortcuts());

      fireKey("k", { ctrlKey: true });

      expect(useMailStore.getState().searchOpen).toBe(true);
    });
  });

  describe("Escape", () => {
    it("minimise le compositeur ouvert", () => {
      useMailStore.getState().openCompose("new");
      renderHook(() => useKeyboardShortcuts());

      fireKey("Escape");

      // Escape minimise d'abord
      expect(useMailStore.getState().composeInstances).toHaveLength(1);
      expect(useMailStore.getState().composeInstances[0].minimized).toBe(true);
    });

    it("ferme le compositeur minimise", () => {
      useMailStore.getState().openCompose("new");
      useMailStore.getState().minimizeCompose();
      renderHook(() => useKeyboardShortcuts());

      fireKey("Escape");

      expect(useMailStore.getState().composeInstances).toHaveLength(0);
    });

    it("ferme la recherche ouverte", () => {
      useMailStore.setState({ searchOpen: true });
      renderHook(() => useKeyboardShortcuts());

      fireKey("Escape");

      expect(useMailStore.getState().searchOpen).toBe(false);
    });

    it("ferme le compositeur en priorite sur la recherche", () => {
      useMailStore.getState().openCompose("new");
      useMailStore.setState({ searchOpen: true });
      renderHook(() => useKeyboardShortcuts());

      fireKey("Escape");

      // Le compose est minimise, la recherche reste ouverte
      expect(useMailStore.getState().composeInstances).toHaveLength(1);
      expect(useMailStore.getState().searchOpen).toBe(true);
    });
  });

  describe("actions sur les messages", () => {
    it("'e' appelle onArchive", () => {
      const onArchive = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onArchive }));

      fireKey("e");

      expect(onArchive).toHaveBeenCalled();
    });

    it("'#' appelle onDelete", () => {
      const onDelete = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onDelete }));

      fireKey("#");

      expect(onDelete).toHaveBeenCalled();
    });

    it("'s' appelle onStar", () => {
      const onStar = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onStar }));

      fireKey("s");

      expect(onStar).toHaveBeenCalled();
    });

    it("'j' appelle onNextMessage", () => {
      const onNextMessage = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onNextMessage }));

      fireKey("j");

      expect(onNextMessage).toHaveBeenCalled();
    });

    it("'k' (sans Ctrl/Cmd) appelle onPrevMessage", () => {
      const onPrevMessage = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onPrevMessage }));

      fireKey("k");

      expect(onPrevMessage).toHaveBeenCalled();
    });
  });

  describe("champs de saisie", () => {
    it("ignore les raccourcis (sauf Cmd+K/Escape) dans un input", () => {
      const onArchive = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onArchive }));

      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();

      const event = new KeyboardEvent("keydown", {
        key: "e",
        bubbles: true,
      });
      Object.defineProperty(event, "target", { value: input });
      window.dispatchEvent(event);

      expect(onArchive).not.toHaveBeenCalled();

      document.body.removeChild(input);
    });

    it("Cmd+K fonctionne meme dans un input", () => {
      renderHook(() => useKeyboardShortcuts());

      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();

      const event = new KeyboardEvent("keydown", {
        key: "k",
        metaKey: true,
        bubbles: true,
      });
      window.dispatchEvent(event);

      expect(useMailStore.getState().searchOpen).toBe(true);

      document.body.removeChild(input);
    });
  });

  describe("cleanup", () => {
    it("retire le listener au demontage", () => {
      const onArchive = vi.fn();
      const { unmount } = renderHook(() =>
        useKeyboardShortcuts({ onArchive })
      );

      unmount();

      fireKey("e");

      expect(onArchive).not.toHaveBeenCalled();
    });
  });
});
