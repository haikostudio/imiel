"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import pb, { type Message } from "@/lib/pocketbase";
import { buildThread, buildThreadsFromMessages, type Thread } from "@/lib/hooks/useThreads";
import { normalizeSubject } from "@/lib/utils/threading";

interface UseContactThreadsReturn {
  threads: Thread[];
  loading: boolean;
  getThread: (threadId: string) => Thread | undefined;
}

/**
 * Fusionne les threads ayant le meme sujet normalise en un seul thread.
 * Utile pour les contacts qui envoient plusieurs emails distincts avec le meme sujet
 * (ex: notifications repetees, newsletters) qui n'ont pas de references entre eux.
 */
function mergeThreadsBySubject(threads: Thread[]): Thread[] {
  const subjectMap = new Map<string, Thread[]>();

  for (const thread of threads) {
    const key = normalizeSubject(thread.subject).toLowerCase().trim() || thread.id;
    const existing = subjectMap.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      subjectMap.set(key, [thread]);
    }
  }

  const merged: Thread[] = [];
  for (const group of subjectMap.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
    } else {
      // Fusionner tous les messages des threads du groupe
      const allMessages = group.flatMap((t) => t.messages);
      merged.push(buildThread(allMessages));
    }
  }

  // Trier par date du dernier message (DESC)
  merged.sort(
    (a, b) =>
      new Date(b.lastMessage.date).getTime() -
      new Date(a.lastMessage.date).getTime()
  );

  return merged;
}

export function useContactThreads(contactEmail: string | null): UseContactThreadsReturn {
  const [rawMessages, setRawMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!contactEmail) {
      setRawMessages([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    async function fetchMessages() {
      try {
        const escaped = contactEmail!.replace(/"/g, '\\"');
        const filter = `(from_address.address ~ "${escaped}" || to_addresses ~ "${escaped}" || cc_addresses ~ "${escaped}")`;
        const result = await pb.collection<Message>("messages").getFullList({
          filter,
          sort: "-date",
        });

        if (cancelled) return;
        setRawMessages(result);
      } catch {
        if (!cancelled) setRawMessages([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchMessages();
    return () => { cancelled = true; };
  }, [contactEmail]);

  const threads = useMemo(() => {
    if (rawMessages.length === 0) return [];
    const baseThreads = buildThreadsFromMessages(rawMessages);
    return mergeThreadsBySubject(baseThreads);
  }, [rawMessages]);

  const getThread = useCallback(
    (threadId: string) => threads.find((t) => t.id === threadId),
    [threads]
  );

  return { threads, loading, getThread };
}
