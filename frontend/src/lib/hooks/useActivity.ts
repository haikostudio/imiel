"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { activities, getCurrentUserId, type Activity } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";

/**
 * Centre de notifications / journal d'activite. Deux mecanismes distincts :
 *
 *  1. BADGE (pastille "nouveautes") : modele "vu depuis" (last-seen), PAS de
 *     is_read par ligne. Le compteur = nombre d'activites plus recentes que
 *     `lastSeen` (hors "mes envois"). Ouvrir la cloche OU la page pose
 *     lastSeen = maintenant -> le badge retombe a zero, comme un centre de
 *     notifications standard (et sans marteler PocketBase de milliers d'updates
 *     is_read sur un flux mail a fort volume). Persiste dans localStorage.
 *
 *  2. LISTE (useActivityFeed) : pagination classique triee -event_date, fenetre
 *     30 jours, filtre par type + compte actif.
 *
 * `viewingSince` = valeur de lastSeen AU MOMENT de l'ouverture : sert a marquer
 * d'un point les lignes "nouvelles" DANS la vue courante (le badge, lui, est
 * deja retombe a zero). Meme idee que Slack : on ouvre, le badge s'efface, mais
 * les reperes de nouveaute restent visibles le temps de la consultation.
 */

const LAST_SEEN_KEY = "imiel:activityLastSeen";
const EPOCH = new Date(0).toISOString();

function loadLastSeen(): string {
  if (typeof window === "undefined") return EPOCH;
  try {
    const v = localStorage.getItem(LAST_SEEN_KEY);
    if (v) return v;
  } catch {
    /* localStorage indispo */
  }
  // Premier passage : on ancre a "maintenant" pour ne pas afficher un enorme
  // badge sur 30 jours d'historique deja la ; seules les activites qui
  // ARRIVENT ensuite comptent.
  const now = new Date().toISOString();
  try {
    localStorage.setItem(LAST_SEEN_KEY, now);
  } catch {
    /* ignore */
  }
  return now;
}

// PocketBase compare les datetimes comme des CHAINES en format espace
// ("YYYY-MM-DD HH:MM:SS.sssZ"). Un ISO avec "T" exclut silencieusement des
// lignes -> on convertit toujours avant de construire un filtre.
function pbDate(iso: string): string {
  return iso.replace("T", " ");
}

/**
 * Les URLs d'activite sont stockees en forme hash complete "/#/mail/all?..."
 * (identique au champ lu par le service worker au clic d'un push). hashNavigate
 * attend un chemin sans le prefixe "#" -> on le retire.
 */
export function activityHashPath(url: string): string {
  let u = url || "";
  if (u.startsWith("/#")) u = u.slice(2);
  else if (u.startsWith("#")) u = u.slice(1);
  return u || "/mail/all";
}

interface ActivityStore {
  /** Derniere fois que l'utilisateur a "vu" le flux (ISO). Persiste. */
  lastSeen: string;
  /** lastSeen au moment de la derniere ouverture (reperes de nouveaute UI). */
  viewingSince: string;
  /** Nombre d'activites plus recentes que lastSeen (hors mes envois). */
  unreadCount: number;
  refreshUnread: (accountId?: string | null) => Promise<void>;
  /** Pose lastSeen = maintenant (badge -> 0), memorise viewingSince. */
  markSeen: () => void;
}

export const useActivityStore = create<ActivityStore>((set, get) => {
  const initial = loadLastSeen();
  return {
    lastSeen: initial,
    viewingSince: initial,
    unreadCount: 0,

    refreshUnread: async (accountId) => {
      const parts: string[] = [`type != "mail_sent"`, `event_date > "${pbDate(get().lastSeen)}"`];
      if (accountId && accountId !== "all") parts.unshift(`account = "${accountId}"`);
      try {
        const res = await activities().getList(1, 1, {
          filter: parts.join(" && "),
          fields: "id",
          requestKey: "activity-unread",
        });
        set({ unreadCount: res.totalItems });
      } catch {
        /* collection absente ou non authentifie : on garde l'etat courant */
      }
    },

    markSeen: () => {
      const prev = get().lastSeen;
      const now = new Date().toISOString();
      try {
        localStorage.setItem(LAST_SEEN_KEY, now);
      } catch {
        /* ignore */
      }
      set({ viewingSince: prev, lastSeen: now, unreadCount: 0 });
    },
  };
});

/**
 * Alimente le badge : refresh au montage + a chaque changement de compte actif,
 * realtime PocketBase (nouvelle activite ecrite par le worker) et poll de
 * secours (60s) si le SSE n'est pas etabli. A monter UNE fois (layout). Le
 * realtime est debounce (les rafales de sync creent beaucoup d'activites d'un
 * coup) pour ne pas marteler le comptage.
 */
export function useActivityUnread() {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const refreshUnread = useActivityStore((s) => s.refreshUnread);

  const accountRef = useRef(activeAccountId);
  accountRef.current = activeAccountId;

  useEffect(() => {
    void refreshUnread(activeAccountId);
  }, [activeAccountId, refreshUnread]);

  useEffect(() => {
    const userId = getCurrentUserId();
    if (!userId) return;

    let debounce: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refreshUnread(accountRef.current), 1000);
    };

    let unsub: (() => void) | undefined;
    let cancelled = false;
    activities()
      .subscribe("*", (e) => {
        if (e.record?.user === userId) bump();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unsub = fn;
      })
      .catch(() => {
        /* SSE indisponible : le poll de secours prend le relais */
      });

    const poll = setInterval(() => void refreshUnread(accountRef.current), 60_000);

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      if (unsub) unsub();
      clearInterval(poll);
    };
  }, [refreshUnread]);
}

export type ActivityFilter = "all" | "mail" | "tracking" | "newsletter" | "calendar";

const FILTER_TYPES: Record<ActivityFilter, string[]> = {
  all: [],
  mail: ["new_email", "mail_sent"],
  tracking: ["tracking_new", "tracking_status"],
  newsletter: ["newsletter"],
  calendar: ["calendar_reminder", "calendar_suggestion"],
};

const WINDOW_DAYS = 30;
const PER_PAGE = 30;

/**
 * Liste paginee du flux d'activite (fenetre 30 jours), filtree par type et par
 * compte actif, triee du plus recent au plus ancien. Realtime : une nouvelle
 * activite pour l'utilisateur re-fetch la page 1 (debounce). `limit` borne le
 * nombre d'elements charges (apercu de la cloche) ; sans lui, chargement infini
 * via loadMore (page complete).
 */
export function useActivityFeed(filter: ActivityFilter, limit?: number) {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const [items, setItems] = useState<Activity[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);

  const buildFilter = useCallback(() => {
    const parts: string[] = [];
    if (activeAccountId && activeAccountId !== "all") {
      parts.push(`account = "${activeAccountId}"`);
    }
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    parts.push(`event_date >= "${pbDate(since)}"`);
    const types = FILTER_TYPES[filter];
    if (types.length > 0) {
      parts.push("(" + types.map((ty) => `type = "${ty}"`).join(" || ") + ")");
    }
    return parts.join(" && ");
  }, [activeAccountId, filter]);

  const fetchPage = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const perPage = limit ?? PER_PAGE;
        const res = await activities().getList(p, perPage, {
          filter: buildFilter(),
          sort: "-event_date",
          requestKey: `activity-list-${filter}-${p}`,
        });
        setItems((prev) => (p === 1 ? res.items : [...prev, ...res.items]));
        setHasMore(limit ? false : p < res.totalPages);
        setPage(p);
      } catch {
        /* best effort : on garde l'etat courant */
      } finally {
        setLoading(false);
      }
    },
    [buildFilter, filter, limit]
  );

  useEffect(() => {
    setItems([]);
    setLoading(true);
    void fetchPage(1);
  }, [fetchPage]);

  useEffect(() => {
    const userId = getCurrentUserId();
    if (!userId) return;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    activities()
      .subscribe("*", (e) => {
        if (e.record?.user !== userId) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void fetchPage(1), 1500);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unsub = fn;
      })
      .catch(() => {
        /* SSE indisponible */
      });
    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      if (unsub) unsub();
    };
  }, [fetchPage]);

  return {
    items,
    loading,
    hasMore,
    loadMore: () => fetchPage(page + 1),
    refresh: () => fetchPage(1),
  };
}
