"use client";

import { useCallback, useEffect, useState } from "react";
import pb, { getCurrentUserId, type NewsletterPost } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";

const PER_PAGE = 20;

/**
 * Flux Newsletters : liste paginee des syntheses IA (newsletter_posts), tri
 * antichronologique. Lecture directe via le SDK PB (la collection restreint
 * deja aux lignes de l'utilisateur). Le backfill passe par le mail-worker.
 */
export function useNewsletters(tag: string | null = null) {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const [posts, setPosts] = useState<NewsletterPost[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);

  // Le flux suit le compte actif. "all" (le defaut) ou etat non resolu (null)
  // => tous les comptes. La collection PB restreint deja aux lignes du user.
  const accountClause =
    activeAccountId && activeAccountId !== "all"
      ? `account = "${activeAccountId}"`
      : "";
  // Filtre par etiquette : element EXACT du tableau JSON (les guillemets
  // evitent que "GPT" attrape "GPT-5" ; LIKE ignore la casse ASCII).
  const tagClause = tag ? `tags ~ '"${tag.replace(/['"\\]/g, "")}"'` : "";
  const accountFilter = [accountClause, tagClause].filter(Boolean).join(" && ");

  const fetchPage = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const res = await pb
          .collection("newsletter_posts")
          .getList<NewsletterPost>(p, PER_PAGE, {
            filter: accountFilter,
            sort: "-message_date",
            requestKey: `newsletters-${p}`,
          });
        setTotalPages(res.totalPages);
        setPosts((prev) => (p === 1 ? res.items : [...prev, ...res.items]));
        setPage(p);
      } catch {
        /* collection absente ou non authentifie */
      } finally {
        setLoading(false);
      }
    },
    [accountFilter]
  );

  // Chargement initial + rechargement au changement de compte actif.
  useEffect(() => {
    setPosts([]);
    void fetchPage(1);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (loading || page >= totalPages) return;
    void fetchPage(page + 1);
  }, [loading, page, totalPages, fetchPage]);

  const markRead = useCallback(async (id: string) => {
    setPosts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, is_read: true } : p))
    );
    try {
      await pb
        .collection("newsletter_posts")
        .update(id, { is_read: true }, { requestKey: null });
    } catch {
      /* best effort */
    }
  }, []);

  const refresh = useCallback(() => fetchPage(1), [fetchPage]);

  /** Corrige les etiquettes d'une newsletter (optimiste, retour arriere si echec). */
  const setTags = useCallback(async (id: string, tags: string[]) => {
    let before: string[] | null | undefined;
    setPosts((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        before = p.tags;
        return { ...p, tags };
      })
    );
    try {
      await pb.collection("newsletter_posts").update(id, { tags, tags_done: true }, { requestKey: null });
      return true;
    } catch {
      setPosts((prev) => prev.map((p) => (p.id === id ? { ...p, tags: before ?? [] } : p)));
      return false;
    }
  }, []);

  // Declenche le backfill worker (newsletters des 30 derniers jours) puis
  // rafraichit le flux jusqu'a la fin du traitement.
  const triggerBackfill = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) return;
    setBackfilling(true);
    try {
      await fetch("/worker/newsletters/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        await fetchPage(1);
        try {
          const r = await fetch(
            `/worker/newsletters/status?userId=${encodeURIComponent(userId)}`
          );
          const s = (await r.json()) as { running?: boolean };
          if (!s.running) break;
        } catch {
          /* on continue d'essayer */
        }
      }
    } catch {
      /* worker indisponible */
    } finally {
      setBackfilling(false);
    }
  }, [fetchPage]);

  // Vide entierement le flux (supprime tous les posts cote serveur).
  const purge = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) return;
    try {
      await fetch("/worker/newsletters/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
    } catch {
      /* worker indisponible */
    }
    setPosts([]);
    setPage(1);
    setTotalPages(1);
  }, []);

  return {
    posts,
    loading,
    hasMore: page < totalPages,
    loadMore,
    markRead,
    refresh,
    setTags,
    triggerBackfill,
    backfilling,
    purge,
  };
}
