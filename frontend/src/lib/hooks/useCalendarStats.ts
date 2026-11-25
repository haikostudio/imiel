"use client";

import { useCallback, useEffect, useState } from "react";
import { calendarEvents, getCurrentUserId } from "@/lib/pocketbase";

export interface CalendarStats {
  total: number;
  google: number;
  email: number;
  local: number;
  byGroup: Record<string, number>;
}

const EMPTY: CalendarStats = { total: 0, google: 0, email: 0, local: 0, byGroup: {} };

async function countEvents(filter: string): Promise<number> {
  const result = await calendarEvents().getList(1, 1, { filter, fields: "id" });
  return result.totalItems;
}

/** Statistiques d'evenements (totaux, par source, par groupe) pour les reglages. */
export function useCalendarStats(groupIds: string[]) {
  const [stats, setStats] = useState<CalendarStats>(EMPTY);
  const [loading, setLoading] = useState(true);

  const key = groupIds.join(",");

  const refresh = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) return;
    setLoading(true);
    try {
      const base = `user = "${userId}"`;
      const [total, google, email, local] = await Promise.all([
        countEvents(base),
        countEvents(`${base} && source = "google"`),
        countEvents(`${base} && source = "email"`),
        countEvents(`${base} && source = "local"`),
      ]);
      const ids = key ? key.split(",") : [];
      const counts = await Promise.all(ids.map((gid) => countEvents(`${base} && group = "${gid}"`)));
      const byGroup: Record<string, number> = {};
      ids.forEach((gid, i) => { byGroup[gid] = counts[i]; });
      setStats({ total, google, email, local, byGroup });
    } catch {
      setStats(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { stats, loading, refresh };
}
