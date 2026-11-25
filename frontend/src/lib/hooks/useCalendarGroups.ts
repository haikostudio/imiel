"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { calendarGroups, getCurrentUserId, type CalendarGroup } from "@/lib/pocketbase";
import { t as tStatic } from "@/lib/i18n";
import { workerRequest } from "@/lib/hooks/useAgendaEvents";

/**
 * Cree tout de suite chez Google un agenda ajoute dans iMiel (synchronisation
 * complete). Sans compte Google relie, le worker ne fait rien. Best effort : la
 * synchro periodique rattrape un echec.
 */
function publishGroupsToGoogle(): void {
  void workerRequest("/worker/calendar/groups/publish", { method: "POST", body: {} }).catch(() => undefined);
}

export function useCalendarGroups() {
  const [groups, setGroups] = useState<CalendarGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) return;
    try {
      const result = await calendarGroups().getList(1, 200, {
        filter: `user = "${userId}"`,
        sort: "name",
      });
      setGroups(result.items);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createGroup = useCallback(
    async (data: { name: string; color: string }) => {
      const userId = getCurrentUserId();
      if (!userId) return null;
      try {
        const created = await calendarGroups().create({
          user: userId,
          name: data.name,
          color: data.color,
          is_visible: true,
        });
        setGroups((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        toast.success(tStatic("calendar.groupCreated"));
        publishGroupsToGoogle();
        return created;
      } catch {
        toast.error(tStatic("message.actionFailed"));
        return null;
      }
    },
    []
  );

  const updateGroup = useCallback(
    async (id: string, data: Partial<Pick<CalendarGroup, "name" | "color" | "is_visible">>) => {
      try {
        const updated = await calendarGroups().update(id, data);
        setGroups((prev) => prev.map((g) => (g.id === id ? updated : g)));
        // Pas de toast pour un simple toggle de visibilite (feedback deja visuel)
        if (!Object.keys(data).every((k) => k === "is_visible")) {
          toast.success(tStatic("calendar.groupUpdated"));
        }
        return updated;
      } catch {
        toast.error(tStatic("message.actionFailed"));
        return null;
      }
    },
    []
  );

  // Supprime partout : chez Google (agenda du compte) ou retire de la liste
  // (agenda partage), puis dans iMiel avec ses evenements. Confirmation faite
  // par l'appelant (nombre d'evenements + effet).
  const deleteGroup = useCallback(async (id: string) => {
    try {
      const { ok, data } = await workerRequest<{ error?: string }>(`/worker/calendar/group/${id}`, {
        method: "DELETE",
      });
      if (!ok) throw new Error(data?.error || "delete failed");
      setGroups((prev) => prev.filter((g) => g.id !== id));
      toast.success(tStatic("calendar.groupDeleted"));
      return true;
    } catch {
      toast.error(tStatic("message.actionFailed"));
      return false;
    }
  }, []);

  // Un seul agenda par defaut : on decoche l'ancien puis on coche le nouveau.
  const setDefaultGroup = useCallback(
    async (id: string) => {
      const previous = groups.filter((g) => g.is_default && g.id !== id);
      setGroups((prev) => prev.map((g) => ({ ...g, is_default: g.id === id })));
      try {
        for (const g of previous) await calendarGroups().update(g.id, { is_default: false });
        await calendarGroups().update(id, { is_default: true });
        toast.success(tStatic("calendar.groupUpdated"));
      } catch {
        toast.error(tStatic("message.actionFailed"));
        await refresh();
      }
    },
    [groups, refresh]
  );

  const toggleVisibility = useCallback(
    async (id: string) => {
      const group = groups.find((g) => g.id === id);
      if (!group) return;
      await updateGroup(id, { is_visible: !group.is_visible });
    },
    [groups, updateGroup]
  );

  return { groups, loading, refresh, createGroup, updateGroup, deleteGroup, toggleVisibility, setDefaultGroup };
}
