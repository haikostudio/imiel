"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { trackingEvents, type TrackingEvent } from "@/lib/pocketbase";

/**
 * Timeline d'une fiche de suivi : evenements (tracking_events) tries du plus
 * RECENT au plus ancien (dernier en haut), pour un fil conducteur vertical.
 *
 * TEMPS REEL : abonnement PocketBase sur tracking_events (le hub WS du worker
 * ne relaie pas cette collection). Un message rattache par le worker (mail
 * entrant, reponse envoyee depuis l'app) apparait sans action ni
 * "Reconstruire". Rechargement DOUX (pas de "Chargement..." qui fait clignoter
 * la timeline), regroupe sur 400 ms (un rattachement ecrit plusieurs events).
 */
export function useTrackingEvents(itemId: string | null) {
  const [events, setEvents] = useState<TrackingEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const loadedForRef = useRef<string | null>(null);

  const fetchEvents = useCallback(async () => {
    if (!itemId) {
      setEvents([]);
      loadedForRef.current = null;
      return;
    }
    // Premier chargement de CETTE fiche seulement : les rechargements suivants
    // (temps reel, apres reconstruction) gardent la timeline affichee.
    const soft = loadedForRef.current === itemId;
    if (!soft) setLoading(true);
    try {
      const res = await trackingEvents().getFullList({
        filter: `item = "${itemId}"`,
        sort: "-date",
        requestKey: `tracking-events-${itemId}`,
      });
      setEvents(res);
      loadedForRef.current = itemId;
    } catch {
      if (!soft) setEvents([]);
    } finally {
      if (!soft) setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    if (!itemId) return;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    trackingEvents()
      .subscribe("*", (e) => {
        if (e.record?.item !== itemId) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void fetchEvents(), 400);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unsub = fn;
      })
      .catch(() => {
        /* SSE indisponible : la timeline se recharge a l'ouverture */
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (unsub) unsub();
    };
  }, [itemId, fetchEvents]);

  return { events, loading, refresh: fetchEvents };
}
