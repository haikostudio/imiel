"use client";

import { useCallback, useEffect, useState } from "react";
import pb, { contacts, getCurrentUserId, type Contact } from "@/lib/pocketbase";

export function useContacts() {
  const [items, setItems] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) return;
    try {
      const result = await contacts().getList(1, 2000, {
        filter: `user = "${userId}"`,
        sort: "name,email",
      });
      setItems(result.items);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const searchContacts = useCallback(
    async (query: string): Promise<Contact[]> => {
      const userId = getCurrentUserId();
      if (!userId || !query || query.length < 1) return [];
      try {
        const q = query.replace(/"/g, '\\"');
        const result = await contacts().getList(1, 20, {
          filter: `user = "${userId}" && (name ~ "${q}" || email ~ "${q}")`,
          sort: "-message_count",
        });
        return result.items;
      } catch {
        return [];
      }
    },
    []
  );

  const deleteContact = useCallback(async (id: string) => {
    try {
      await contacts().delete(id);
      setItems((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // silent
    }
  }, []);

  const updateContact = useCallback(
    async (id: string, data: Partial<Pick<Contact, "name" | "phone">>) => {
      try {
        const updated = await contacts().update(id, data);
        setItems((prev) =>
          prev.map((c) => (c.id === id ? updated : c))
        );
        return updated;
      } catch {
        return null;
      }
    },
    []
  );

  const backfill = useCallback(async () => {
    try {
      const data = await pb.send("/api/contacts/backfill", { method: "POST" });
      if (data.status === "backfilled") {
        await refresh();
      }
      return data;
    } catch {
      return null;
    }
  }, [refresh]);

  return { contacts: items, loading, refresh, searchContacts, deleteContact, updateContact, backfill };
}
