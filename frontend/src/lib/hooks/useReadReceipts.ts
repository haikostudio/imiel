"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { readReceipts, type ReadReceipt } from "@/lib/pocketbase";

/**
 * Evenements de suivi de lecture (pixel) des messages ENVOYES d'une
 * conversation. Un fetch au montage (tinte le bouton de l'en-tete si le mail
 * a ete lu) + polling leger quand le drawer est ouvert (les ouvertures
 * arrivent en async cote worker).
 */
export function useReadReceipts(
  messageIds: string[],
  options: { poll?: boolean } = {}
) {
  const { poll = false } = options;
  const [receipts, setReceipts] = useState<ReadReceipt[]>([]);
  const [loading, setLoading] = useState(false);
  const key = messageIds.join(",");

  const refresh = useCallback(async () => {
    if (messageIds.length === 0) {
      setReceipts([]);
      return;
    }
    try {
      const filter = messageIds.map((id) => `message = "${id}"`).join(" || ");
      const items = await readReceipts().getFullList({
        filter: `(${filter})`,
        sort: "date",
        requestKey: `read-receipts-${key}`,
      });
      setReceipts(items);
    } catch {
      // collection absente (migration pas passee) ou requete annulee : silencieux
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    let cancelled = false;
    if (messageIds.length === 0) {
      setReceipts([]);
      return;
    }
    setLoading(true);
    void refresh().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refresh]);

  // Polling leger pendant que le drawer est ouvert
  useEffect(() => {
    if (!poll || messageIds.length === 0) return;
    const interval = setInterval(() => void refresh(), 20000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, key, refresh]);

  const openCountByMessage = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of receipts) {
      if (r.kind === "opened") counts[r.message] = (counts[r.message] || 0) + 1;
    }
    return counts;
  }, [receipts]);

  const hasOpens = useMemo(
    () => receipts.some((r) => r.kind === "opened"),
    [receipts]
  );

  return { receipts, loading, refresh, openCountByMessage, hasOpens };
}
