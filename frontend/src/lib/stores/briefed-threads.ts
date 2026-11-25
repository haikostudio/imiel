"use client";

import { create } from "zustand";
import { threadBriefs } from "@/lib/pocketbase";

/**
 * Ensemble des thread_id qui ont une note IA (thread_briefs), partage par la
 * liste des mails (icone de note violette) et la conversation. UNE requete pour
 * toute la liste (jamais une par ligne) ; mise a jour locale apres une
 * generation (`add`) et abonnement temps reel PocketBase (le hub WS du worker
 * ne relaie pas cette collection).
 */
type BriefedThreadsState = {
  ids: Set<string>;
  loaded: boolean;
  loading: boolean;
  ensureLoaded: () => void;
  refresh: () => Promise<void>;
  add: (threadId: string) => void;
  remove: (threadId: string) => void;
};

let subscribed = false;

export const useBriefedThreads = create<BriefedThreadsState>((set, get) => ({
  ids: new Set<string>(),
  loaded: false,
  loading: false,

  ensureLoaded: () => {
    const s = get();
    if (s.loaded || s.loading) return;
    void s.refresh();
    if (!subscribed) {
      subscribed = true;
      threadBriefs()
        .subscribe("*", (e) => {
          const id = (e.record as { thread_id?: string }).thread_id;
          if (!id) return;
          if (e.action === "delete") get().remove(id);
          else get().add(id);
        })
        .catch(() => {
          subscribed = false;
        });
    }
  },

  refresh: async () => {
    set({ loading: true });
    try {
      const items = await threadBriefs().getFullList({
        fields: "thread_id",
        requestKey: "briefed-threads",
      });
      const ids = new Set<string>();
      for (const it of items) if (it.thread_id) ids.add(it.thread_id);
      set({ ids, loaded: true, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  add: (threadId) => {
    if (!threadId || get().ids.has(threadId)) return;
    const ids = new Set(get().ids);
    ids.add(threadId);
    set({ ids });
  },

  remove: (threadId) => {
    if (!get().ids.has(threadId)) return;
    const ids = new Set(get().ids);
    ids.delete(threadId);
    set({ ids });
  },
}));
