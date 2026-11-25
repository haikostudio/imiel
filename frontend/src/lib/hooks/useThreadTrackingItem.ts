"use client";

import { useEffect, useState } from "react";
import { trackingItems, type TrackingItem } from "@/lib/pocketbase";

/**
 * Fiche de suivi d'une conversation, partagee par le bandeau du fil
 * (`thread-tracking-bar`) et le tiroir `ThreadTrackingPanel` : UNE seule
 * requete, chargee des que la conversation est suivie (pas seulement a
 * l'ouverture du tiroir).
 *
 * La fiche est creee en async par le worker (extraction LLM) apres "Suivre" :
 * on re-essaie quelques fois (6 x 2,5 s) le temps qu'elle existe. `loading`
 * reste vrai pendant ces essais -> le bandeau montre une silhouette.
 */
export function useThreadTrackingItem(
  threadIds: string[],
  isTracked: boolean,
  /** Change a chaque ouverture du tiroir : relit la fiche (statut a jour) sans vider l'affichage. */
  refreshKey = 0
) {
  // La fiche est memorisee AVEC la cle du fil : changer de conversation
  // n'affiche jamais, meme un instant, la fiche de la precedente.
  const [state, setState] = useState<{ key: string; item: TrackingItem | null }>({ key: "", item: null });
  const [loading, setLoading] = useState(false);

  const threadKey = threadIds.join(",");
  useEffect(() => {
    const ids = threadKey ? threadKey.split(",") : [];
    if (!isTracked || ids.length === 0) {
      setState({ key: "", item: null });
      setLoading(false);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setLoading(true);
    // Une fiche peut fusionner plusieurs threads (thread_ids[]) : on matche le
    // thread principal ET la liste fusionnee, comme le store tracked-threads.
    const orFilter = ids
      .map((id) => `thread_id = "${id}" || thread_ids ~ "${id}"`)
      .join(" || ");
    const filter = `archived = false && (${orFilter})`;
    const tryFetch = async () => {
      try {
        const res = await trackingItems().getList(1, 1, {
          filter,
          sort: "-last_message_date",
          expand: "image_attachment",
          requestKey: `thread-tracking-fiche-${threadKey}`,
        });
        if (cancelled) return;
        if (res.items.length > 0) {
          setState({ key: threadKey, item: res.items[0] });
          setLoading(false);
          return;
        }
      } catch {
        if (cancelled) return;
      }
      attempts++;
      if (attempts < 6) {
        timer = setTimeout(tryFetch, 2500);
      } else {
        setLoading(false);
      }
    };
    void tryFetch();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isTracked, threadKey, refreshKey]);

  const item = isTracked && state.key === threadKey ? state.item : null;
  return { item, loading };
}
