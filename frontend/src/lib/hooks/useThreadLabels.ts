"use client";

import { useCallback, useEffect, useState } from "react";
import pb from "@/lib/pocketbase";

export interface ThreadLabelOverride {
  label: string;
  mode: "included" | "excluded";
}

interface ThreadLabelsResponse {
  thread_id: string;
  labels: string[];
  overrides: ThreadLabelOverride[];
}

export interface UseThreadLabelsReturn {
  /** Ids des labels actuellement presents sur au moins un message du thread. */
  labelIds: string[];
  /** Overrides explicites enregistres pour ce thread. */
  overrides: Map<string, "included" | "excluded">;
  loading: boolean;
  /** Applique le label a toute la conversation et marque l'override "included". */
  addLabel: (labelId: string) => Promise<void>;
  /** Retire le label de toute la conversation et marque l'override "excluded". */
  removeLabel: (labelId: string) => Promise<void>;
  /** Recharge les labels/overrides depuis le serveur. */
  refresh: () => Promise<void>;
}

async function fetchLabels(threadId: string): Promise<ThreadLabelsResponse> {
  return pb.send<ThreadLabelsResponse>(
    `/api/mail/thread/${encodeURIComponent(threadId)}/labels`,
    { method: "GET" }
  );
}

export function useThreadLabels(threadId: string | null): UseThreadLabelsReturn {
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Map<string, "included" | "excluded">>(
    new Map()
  );
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!threadId) {
      setLabelIds([]);
      setOverrides(new Map());
      return;
    }
    setLoading(true);
    try {
      const data = await fetchLabels(threadId);
      setLabelIds(data.labels ?? []);
      const next = new Map<string, "included" | "excluded">();
      for (const o of data.overrides ?? []) next.set(o.label, o.mode);
      setOverrides(next);
    } catch {
      // 401 / 404 / collection absente : etat vide silencieux
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyMode = useCallback(
    async (labelId: string, mode: "included" | "excluded") => {
      if (!threadId) return;
      await pb.send(
        `/api/mail/thread/${encodeURIComponent(threadId)}/label/${encodeURIComponent(labelId)}`,
        {
          method: "POST",
          body: { mode },
        }
      );
      // Maj optimiste : on ajuste localement avant le refresh complet.
      setLabelIds((prev) => {
        if (mode === "included") {
          return prev.includes(labelId) ? prev : [...prev, labelId];
        }
        return prev.filter((id) => id !== labelId);
      });
      setOverrides((prev) => {
        const next = new Map(prev);
        next.set(labelId, mode);
        return next;
      });
    },
    [threadId]
  );

  const addLabel = useCallback(
    (labelId: string) => applyMode(labelId, "included"),
    [applyMode]
  );
  const removeLabel = useCallback(
    (labelId: string) => applyMode(labelId, "excluded"),
    [applyMode]
  );

  return { labelIds, overrides, loading, addLabel, removeLabel, refresh };
}
