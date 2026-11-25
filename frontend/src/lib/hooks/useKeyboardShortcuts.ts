"use client";

import { useEffect } from "react";
import { useMailStore } from "@/lib/stores/mail-store";

interface ShortcutHandlers {
  onArchive?: () => void;
  onDelete?: () => void;
  onStar?: () => void;
  onNextMessage?: () => void;
  onPrevMessage?: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers = {}) {
  const { openSearch, closeCompose, closeSearch, minimizeCompose, composeInstances, searchOpen } =
    useMailStore();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // Cmd+K / Ctrl+K : recherche (fonctionne toujours)
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openSearch();
        return;
      }

      // Escape : minimiser/fermer le dernier panneau compose
      if (e.key === "Escape") {
        if (composeInstances.length > 0) {
          const lastInstance = composeInstances[composeInstances.length - 1];
          if (lastInstance.minimized) {
            closeCompose(lastInstance.id);
          } else {
            minimizeCompose(lastInstance.id);
          }
          return;
        }
        if (searchOpen) {
          closeSearch();
          return;
        }
        return;
      }

      // Les raccourcis suivants ne fonctionnent pas dans les champs de saisie
      if (isInput) return;

      switch (e.key) {
        case "e":
          e.preventDefault();
          handlers.onArchive?.();
          break;
        case "#":
          e.preventDefault();
          handlers.onDelete?.();
          break;
        case "s":
          e.preventDefault();
          handlers.onStar?.();
          break;
        case "j":
          e.preventDefault();
          handlers.onNextMessage?.();
          break;
        case "k":
          e.preventDefault();
          handlers.onPrevMessage?.();
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    openSearch,
    closeCompose,
    closeSearch,
    minimizeCompose,
    composeInstances,
    searchOpen,
    handlers,
  ]);
}
