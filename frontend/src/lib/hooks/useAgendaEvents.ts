"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import pb, { calendarEvents, getCurrentUserId, type CalendarEvent } from "@/lib/pocketbase";

export interface EventInput {
  /** Agendas coches : une copie par agenda (copies liees, migration 078). */
  groups: string[];
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  all_day?: boolean;
  reminders?: number[];
}

/**
 * Appel au mail-worker via le rewrite `/worker/*` de l'app courante (fetch
 * RELATIF). On ne passe PAS par `pb.send` : celui-ci cible la base URL de
 * PocketBase, qui en prod est un hote distinct (mail-db) sans route `/worker`.
 * Le fetch relatif tape l'origine de la page, ou le rewrite Next proxifie le worker.
 */
export async function workerRequest<T = unknown>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<{ ok: boolean; status: number; data: T | null }> {
  // Session obligatoire cote worker : l'utilisateur vient du jeton, jamais du corps.
  const headers: Record<string, string> = { Authorization: pb.authStore.token };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method: init?.method || "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as T | null;
  return { ok: res.ok, status: res.status, data };
}

/**
 * Charge les events d'un user couvrant la fenetre [rangeStart, rangeEnd] et
 * expose les mutations. Les ecritures passent par le mail-worker (`/worker/...`)
 * pour propager vers Google Calendar quand le groupe est Google-backed.
 */
export function useAgendaEvents(rangeStart: Date, rangeEnd: Date) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const startIso = rangeStart.toISOString();
  const endIso = rangeEnd.toISOString();

  const refresh = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) {
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // Overlap : start < rangeEnd && end > rangeStart.
      const result = await calendarEvents().getList(1, 2000, {
        // Invitations refusees / annulees : retirees de l'agenda.
        filter: `user = "${userId}" && status != "cancelled" && start < "${endIso}" && end > "${startIso}"`,
        sort: "start",
      });
      setEvents(result.items);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [startIso, endIso]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-sync : la sync Google -> events locaux tourne cote worker (cron 2 min).
  // Cote UI on veut voir ces changements sans action manuelle. On combine :
  //  - realtime PocketBase (SSE) : refresh instantane quand un event est
  //    cree/modifie/supprime (y compris par le pull worker),
  //  - un poll de secours (60s) si le SSE n'est pas etabli (proxys, veille).
  // `refreshRef` evite de re-souscrire a chaque changement de fenetre de dates.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const userId = getCurrentUserId();
    if (!userId) return;

    let unsub: (() => void) | undefined;
    let cancelled = false;
    calendarEvents()
      .subscribe("*", (e) => {
        if (e.record?.user === userId) refreshRef.current();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unsub = fn;
      })
      .catch(() => {
        // SSE indisponible : le poll de secours prend le relais.
      });

    const poll = setInterval(() => refreshRef.current(), 60_000);

    return () => {
      cancelled = true;
      if (unsub) unsub();
      clearInterval(poll);
    };
  }, []);

  const createEvent = useCallback(
    async (input: EventInput): Promise<CalendarEvent | null> => {
      const userId = getCurrentUserId();
      if (!userId) return null;
      try {
        const { data } = await workerRequest<{ event: CalendarEvent }>("/worker/calendar/event", {
          method: "POST",
          body: { userId, ...input },
        });
        await refresh();
        return data?.event ?? null;
      } catch {
        return null;
      }
    },
    [refresh]
  );

  const updateEvent = useCallback(
    async (id: string, input: Partial<EventInput>): Promise<CalendarEvent | null> => {
      try {
        const { data } = await workerRequest<{ event: CalendarEvent }>(`/worker/calendar/event/${id}`, {
          method: "PATCH",
          body: input,
        });
        await refresh();
        return data?.event ?? null;
      } catch {
        return null;
      }
    },
    [refresh]
  );

  const deleteEvent = useCallback(async (id: string) => {
    try {
      // Toutes les copies partent (meme copy_key) : on les retire aussi de l'ecran.
      await workerRequest(`/worker/calendar/event/${id}`, { method: "DELETE" });
      setEvents((prev) => {
        const key = prev.find((e) => e.id === id)?.copy_key;
        return prev.filter((e) => e.id !== id && (!key || e.copy_key !== key));
      });
    } catch {
      // silent
    }
  }, []);

  const syncAccount = useCallback(
    async (accountId: string) => {
      setSyncing(true);
      try {
        const { data } = await workerRequest<{ success?: boolean; error?: string; needsReconnect?: boolean }>(
          `/worker/calendar/sync/${accountId}`,
          { method: "POST" }
        );
        await refresh();
        return data ?? {};
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        setSyncing(false);
      }
    },
    [refresh]
  );

  return { events, loading, syncing, refresh, createEvent, updateEvent, deleteEvent, syncAccount };
}
