"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { t as tStatic } from "@/lib/i18n";
import pb, {
  getCurrentUserId,
  trackingItems,
  trackingEvents,
  type TrackingItem,
  type TrackingStatus,
} from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";

const PER_PAGE = 30;

/**
 * Liste des conversations de suivi (tracking_items), tri par derniere activite.
 * Lecture directe via le SDK PB (la collection restreint deja aux lignes de
 * l'utilisateur). Le backfill passe par le mail-worker. Les fiches archivees
 * sont masquees par defaut.
 */
export function useTracking() {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const [items, setItems] = useState<TrackingItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<{ done: number; total: number } | null>(null);

  const accountFilter =
    activeAccountId && activeAccountId !== "all"
      ? `account = "${activeAccountId}" && `
      : "";
  const filter = `${accountFilter}archived = false`;

  const fetchPage = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const res = await trackingItems().getList(p, PER_PAGE, {
          filter,
          sort: "-last_message_date",
          expand: "image_attachment",
          requestKey: `tracking-${p}`,
        });
        setTotalPages(res.totalPages);
        setItems((prev) => (p === 1 ? res.items : [...prev, ...res.items]));
        setPage(p);
      } catch {
        /* collection absente ou non authentifie */
      } finally {
        setLoading(false);
      }
    },
    [filter]
  );

  useEffect(() => {
    setItems([]);
    void fetchPage(1);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (loading || page >= totalPages) return;
    void fetchPage(page + 1);
  }, [loading, page, totalPages, fetchPage]);

  const refresh = useCallback(() => fetchPage(1), [fetchPage]);

  // "Dernier statut connu" affiche sous le sujet dans la liste : le label de
  // l'evenement de timeline du DERNIER message de chaque fiche (ex: "Livraison
  // prevue demain !"). UNE requete batchee par page (1 event par fiche via
  // message = last_message_id, UNIQUE(item, message)), tres legere.
  const [statusLines, setStatusLines] = useState<Record<string, string>>({});
  const lastMsgKey = useMemo(
    () =>
      items
        .map((it) => it.last_message_id)
        .filter(Boolean)
        .join(","),
    [items]
  );
  useEffect(() => {
    const ids = lastMsgKey ? lastMsgKey.split(",") : [];
    if (ids.length === 0) {
      setStatusLines({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const filter = ids.map((id) => `message = "${id}"`).join(" || ");
        const evs = await trackingEvents().getFullList({
          filter,
          fields: "item,label",
          requestKey: "tracking-status-lines",
        });
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const ev of evs) {
          const label = (ev.label || "").trim();
          if (label && !map[ev.item]) map[ev.item] = label;
        }
        setStatusLines(map);
      } catch {
        /* best effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lastMsgKey]);

  const patchLocal = useCallback((id: string, patch: Partial<TrackingItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const markRead = useCallback(
    async (id: string) => {
      patchLocal(id, { is_read: true });
      try {
        await trackingItems().update(id, { is_read: true }, { requestKey: null });
      } catch {
        /* best effort */
      }
    },
    [patchLocal]
  );

  /**
   * Change le statut d'une fiche (cloturer / rouvrir / annuler...) et journalise
   * un evenement de timeline. La suggestion de cloture est effacee (l'utilisateur
   * a tranche).
   */
  const setStatus = useCallback(
    async (item: TrackingItem, status: TrackingStatus, label: string) => {
      patchLocal(item.id, { status, closure_suggested: false });
      toast.success(tStatic(status === "active" ? "tracking.reopenedToast" : "tracking.closedToast"));
      const userId = getCurrentUserId();
      try {
        await trackingItems().update(
          item.id,
          { status, closure_suggested: false },
          { requestKey: null }
        );
        if (userId) {
          await trackingEvents().create({
            user: userId,
            item: item.id,
            date: new Date().toISOString(),
            kind: "status_change",
            label,
            detail: "",
            changed_fields: {},
          });
        }
      } catch {
        /* best effort */
      }
    },
    [patchLocal]
  );

  const archive = useCallback(
    async (id: string) => {
      setItems((prev) => prev.filter((it) => it.id !== id));
      toast.success(tStatic("tracking.archivedToast"));
      try {
        await trackingItems().update(id, { archived: true }, { requestKey: null });
      } catch {
        /* best effort */
      }
    },
    []
  );

  const remove = useCallback(async (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    toast.success(tStatic("tracking.deletedToast"));
    try {
      await trackingItems().delete(id);
    } catch {
      /* best effort */
    }
  }, []);

  // Nombre de fiches qui seraient reconstruites (pour annoncer le cout AVANT
  // de lancer). Retourne null si le worker est indisponible.
  const rebuildEstimate = useCallback(async (): Promise<number | null> => {
    const userId = getCurrentUserId();
    if (!userId) return null;
    try {
      const r = await fetch(
        `/worker/tracking/rebuild-estimate?userId=${encodeURIComponent(userId)}`
      );
      const s = (await r.json()) as { fiches?: number };
      return typeof s.fiches === "number" ? s.fiches : null;
    } catch {
      return null;
    }
  }, []);

  // Reconstruit TOUTES les fiches : va chercher les mails lies (paiement,
  // expedition, livraison...) deja presents et complete les chronologies.
  // Suit la progression jusqu'a la fin.
  const rebuildAll = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) return;
    setRebuilding(true);
    setRebuildProgress(null);
    try {
      await fetch("/worker/tracking/rebuild-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      for (let i = 0; i < 1200; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        await fetchPage(1);
        try {
          const r = await fetch(
            `/worker/tracking/rebuild-status?userId=${encodeURIComponent(userId)}`
          );
          const s = (await r.json()) as { running?: boolean; done?: number; total?: number };
          setRebuildProgress({ done: s.done ?? 0, total: s.total ?? 0 });
          if (!s.running) break;
        } catch {
          /* on continue d'essayer */
        }
      }
      toast.success(tStatic("tracking.rebuildDoneToast"));
    } catch {
      /* worker indisponible */
    } finally {
      setRebuilding(false);
    }
  }, [fetchPage]);

  // Nombre de mails inbox des N derniers jours qui seraient repasses (annonce du
  // cout AVANT lancement). Retourne null si le worker est indisponible.
  const reprocessEstimate = useCallback(async (days = 30): Promise<number | null> => {
    const userId = getCurrentUserId();
    if (!userId) return null;
    try {
      const r = await fetch(
        `/worker/tracking/reprocess-estimate?userId=${encodeURIComponent(userId)}&days=${days}`
      );
      const s = (await r.json()) as { mails?: number };
      return typeof s.mails === "number" ? s.mails : null;
    } catch {
      return null;
    }
  }, []);

  // Repasse les mails inbox des N derniers jours dans le pipeline live : le LLM
  // les rattache aux fiches ouvertes (rattrapage des mails deja recus mais
  // loupes). Reutilise l'indicateur de progression de la reconstruction.
  const reprocessRecent = useCallback(
    async (days = 30) => {
      const userId = getCurrentUserId();
      if (!userId) return;
      setRebuilding(true);
      setRebuildProgress(null);
      try {
        await fetch("/worker/tracking/reprocess-recent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, days }),
        });
        let attached = 0;
        for (let i = 0; i < 2400; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          await fetchPage(1);
          try {
            const r = await fetch(
              `/worker/tracking/reprocess-status?userId=${encodeURIComponent(userId)}`
            );
            const s = (await r.json()) as {
              running?: boolean;
              done?: number;
              total?: number;
              attached?: number;
            };
            setRebuildProgress({ done: s.done ?? 0, total: s.total ?? 0 });
            attached = s.attached ?? attached;
            if (!s.running) break;
          } catch {
            /* on continue d'essayer */
          }
        }
        toast.success(tStatic("tracking.reprocessDoneToast", { count: String(attached) }));
      } catch {
        /* worker indisponible */
      } finally {
        setRebuilding(false);
      }
    },
    [fetchPage]
  );

  // Reconstruit UNE fiche (gather de ses fils lies). Retourne le nb rattache.
  const rebuildOne = useCallback(async (itemId: string): Promise<number> => {
    try {
      const r = await fetch("/worker/tracking/rebuild-one", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
      });
      const s = (await r.json()) as { attached?: number };
      return s.attached ?? 0;
    } catch {
      return 0;
    }
  }, []);

  const purge = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) return;
    try {
      await fetch("/worker/tracking/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
    } catch {
      /* worker indisponible */
    }
    setItems([]);
    setPage(1);
    setTotalPages(1);
    toast.success(tStatic("tracking.purgedToast"));
  }, []);

  return {
    items,
    statusLines,
    loading,
    hasMore: page < totalPages,
    loadMore,
    refresh,
    markRead,
    setStatus,
    archive,
    remove,
    rebuildEstimate,
    rebuildAll,
    rebuildOne,
    reprocessEstimate,
    reprocessRecent,
    rebuilding,
    rebuildProgress,
    purge,
  };
}

/** Recharge ponctuellement le compteur de suivis "a suivre" (active/waiting). */
export async function fetchTrackingAttentionCount(): Promise<number> {
  try {
    const res = await trackingItems().getList(1, 1, {
      filter: `archived = false && (status = "active" || status = "waiting")`,
      fields: "id",
      requestKey: "tracking-attention",
    });
    return res.totalItems;
  } catch {
    return 0;
  }
}
