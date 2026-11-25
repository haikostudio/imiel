"use client";

import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import { users, getCurrentUserId } from "@/lib/pocketbase";

interface PanelSizes {
  sidebarWidth: number;
  folderNavSize: number;
  mailListSize: number;
}

interface PanelSizesState extends PanelSizes {
  loaded: boolean;
  load: (sizes: Partial<PanelSizes>) => void;
}

const DEFAULTS: PanelSizes = {
  sidebarWidth: 18,
  folderNavSize: 65,
  mailListSize: 35,
};

const STORAGE_KEY = "panel-sizes";

export const usePanelSizesStore = create<PanelSizesState>((set) => ({
  ...DEFAULTS,
  loaded: false,
  load: (sizes) => set((state) => {
    // Eviter de creer un nouveau state si rien n'a change (previent les boucles infinies)
    const changed = !state.loaded || Object.entries(sizes).some(
      ([key, value]) => (state as unknown as Record<string, unknown>)[key] !== value
    );
    if (!changed) return state;
    return { ...state, ...sizes, loaded: true };
  }),
}));

/** Debounce pour eviter de spammer PocketBase pendant le resize */
function useDebouncedSave() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback((sizes: Partial<PanelSizes>) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      // Persister en localStorage immediatement
      const current = usePanelSizesStore.getState();
      const merged = { ...DEFAULTS, sidebarWidth: current.sidebarWidth, folderNavSize: current.folderNavSize, mailListSize: current.mailListSize, ...sizes };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));

      // Persister dans PocketBase (best-effort)
      const userId = getCurrentUserId();
      if (userId) {
        try {
          await users().update(userId, {
            sidebar_width: merged.sidebarWidth,
            folder_nav_size: merged.folderNavSize,
            mail_list_size: merged.mailListSize,
          });
        } catch {
          // Silently fail - localStorage is our fallback
        }
      }
    }, 500);
  }, []);
}

export function usePanelSizes() {
  const store = usePanelSizesStore();
  const debouncedSave = useDebouncedSave();

  // Chargement initial depuis localStorage puis PocketBase
  useEffect(() => {
    if (store.loaded) return;

    // 1. localStorage en premier (instantane)
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Partial<PanelSizes>;
        usePanelSizesStore.getState().load(parsed);
      } catch {
        usePanelSizesStore.getState().load({});
      }
    }

    // 2. PocketBase en arriere-plan
    const userId = getCurrentUserId();
    if (userId) {
      users().getOne(userId).then((result) => {
        const record = result as Record<string, unknown>;
        const sizes: Partial<PanelSizes> = {};
        if (typeof record.sidebar_width === "number") sizes.sidebarWidth = record.sidebar_width;
        if (typeof record.folder_nav_size === "number") sizes.folderNavSize = record.folder_nav_size;
        if (typeof record.mail_list_size === "number") sizes.mailListSize = record.mail_list_size;
        if (Object.keys(sizes).length > 0) {
          usePanelSizesStore.getState().load(sizes);
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
            ...DEFAULTS,
            ...sizes,
          }));
        } else if (!saved) {
          usePanelSizesStore.getState().load({});
        }
      }).catch(() => {
        if (!saved) usePanelSizesStore.getState().load({});
      });
    } else if (!saved) {
      usePanelSizesStore.getState().load({});
    }
  }, [store.loaded]);

  const updateSize = useCallback((key: keyof PanelSizes, value: number) => {
    usePanelSizesStore.getState().load({ [key]: value });
    debouncedSave({ [key]: value });
  }, [debouncedSave]);

  return {
    sizes: store,
    updateSize,
  };
}
