"use client";

import { useCallback, useEffect, useState } from "react";
import pb, { getCurrentUserId, type AlertTopic } from "@/lib/pocketbase";

/**
 * Sujets d'alerte newsletter (alert_topics) : lus, ajoutes, modifies,
 * supprimes par l'utilisateur. Le worker les verifie a chaque nouvelle
 * newsletter et notifie quand l'un d'eux est aborde.
 */
export function useAlertTopics(enabled = true) {
  const [topics, setTopics] = useState<AlertTopic[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await pb
        .collection<AlertTopic>("alert_topics")
        .getFullList({ sort: "created", requestKey: "alert-topics" });
      setTopics(res);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh().catch(() => {});
  }, [enabled, refresh]);

  const addTopic = useCallback(async (name: string, description = "") => {
    const user = getCurrentUserId();
    if (!user) throw new Error("not authenticated");
    const rec = await pb
      .collection<AlertTopic>("alert_topics")
      .create({ user, name: name.trim(), description: description.trim() });
    setTopics((prev) => [...prev, rec]);
    return rec;
  }, []);

  const updateTopic = useCallback(async (id: string, name: string, description = "") => {
    const patch = { name: name.trim(), description: description.trim() };
    setTopics((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    try {
      await pb.collection("alert_topics").update(id, patch);
    } catch (err) {
      void refresh().catch(() => {});
      throw err;
    }
  }, [refresh]);

  const removeTopic = useCallback(async (id: string) => {
    setTopics((prev) => prev.filter((t) => t.id !== id));
    try {
      await pb.collection("alert_topics").delete(id);
    } catch (err) {
      void refresh().catch(() => {});
      throw err;
    }
  }, [refresh]);

  return { topics, loading, refresh, addTopic, updateTopic, removeTopic };
}
