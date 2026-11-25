"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  threadBriefs,
  getCurrentUserId,
  type Message,
  type ThreadBrief,
} from "@/lib/pocketbase";
import { getOpenRouterKey } from "@/lib/ai-settings";
import { useBriefedThreads } from "@/lib/stores/briefed-threads";

function messageBody(m: Message): string {
  if (m.text_body && m.text_body.trim()) return m.text_body;
  if (m.html_body) return m.html_body;
  return m.snippet || "";
}

function escapeFilter(value: string): string {
  return value.replace(/"/g, '\\"');
}

interface GenerateOptions {
  /** Recalcule entierement le brief en ignorant les notes precedentes. */
  force?: boolean;
  language?: string;
}

export function useThreadBrief(threadId: string, msgs: Message[]) {
  const [record, setRecord] = useState<ThreadBrief | null>(null);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Date de la derniere generation (place la note dans le fil) : `updated` du
  // record, ou l'instant de la generation si l'enregistrement a echoue.
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  // Messages tries du plus ancien au plus recent
  const sorted = useMemo(
    () =>
      [...msgs].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      ),
    [msgs]
  );

  const sortedRef = useRef(sorted);
  sortedRef.current = sorted;

  const currentCount = sorted.length;

  const hasNew = useMemo(
    () => !!record && !!content && record.message_count !== currentCount,
    [record, content, currentCount]
  );

  // Charger un brief existant pour ce thread
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRecord(null);
    setContent("");
    setGeneratedAt(null);

    const userId = getCurrentUserId();
    if (!userId || !threadId) {
      setLoading(false);
      return;
    }

    threadBriefs()
      .getFirstListItem<ThreadBrief>(
        `user = "${escapeFilter(userId)}" && thread_id = "${escapeFilter(threadId)}"`
      )
      .then((rec) => {
        if (cancelled) return;
        setRecord(rec);
        setContent(rec.content || "");
        setGeneratedAt(rec.updated || rec.created || null);
      })
      .catch(() => {
        // Aucun brief ou collection absente : etat vide silencieux
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const persist = useCallback(
    async (
      html: string,
      count: number,
      lastId: string,
      lastDate: string
    ): Promise<ThreadBrief | null> => {
      const userId = getCurrentUserId();
      if (!userId || !threadId) return null;
      const data = {
        user: userId,
        thread_id: threadId,
        content: html,
        message_count: count,
        last_message_id: lastId,
        last_message_date: lastDate,
      };
      const existing = record;
      if (existing) {
        return threadBriefs().update<ThreadBrief>(existing.id, data);
      }
      return threadBriefs().create<ThreadBrief>(data);
    },
    [threadId, record]
  );

  const generate = useCallback(
    async (opts: GenerateOptions = {}) => {
      const list = sortedRef.current;
      if (list.length === 0 || generating) return;

      const prev = record;
      const incremental = !opts.force && !!prev && !!prev.content;

      let payloadMsgs = list;
      if (incremental) {
        const lastDate = prev!.last_message_date;
        payloadMsgs = lastDate
          ? list.filter((m) => m.date > lastDate)
          : list.filter((m) => m.id !== prev!.last_message_id);
        // Rien de neuf : conserver le brief tel quel
        if (payloadMsgs.length === 0) return;
      }

      setGenerating(true);
      setError(null);

      const newest = list[list.length - 1];
      const subject = list[0]?.subject || "";

      const body = {
        subject,
        language: opts.language || "fr",
        previousBrief: incremental ? prev!.content : "",
        messages: payloadMsgs.map((m) => ({
          from:
            m.from_address?.name || m.from_address?.address || "inconnu",
          fromAddress: m.from_address?.address || "",
          date: m.date,
          mine: !!m.is_sent,
          body: messageBody(m),
        })),
      };

      try {
        const res = await fetch("/api/ai/brief", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body,
            apiKey: getOpenRouterKey(),
          }),
        });
        const data = await res.json();
        if (data?.error || !data?.brief) {
          throw new Error(data?.error || "Generation echouee");
        }

        const html = data.brief as string;
        setContent(html);
        setGeneratedAt(new Date().toISOString());

        try {
          const saved = await persist(
            html,
            list.length,
            newest.id,
            newest.date
          );
          if (saved) {
            setRecord(saved);
            if (saved.updated) setGeneratedAt(saved.updated);
            // Icone de note de la liste, sans attendre le temps reel.
            useBriefedThreads.getState().add(threadId);
          }

          // Push de la note vers le Cerveau (memoire centrale) - non bloquant.
          // No-op cote worker si la cle Cerveau n'est pas configuree.
          const uid = getCurrentUserId();
          if (uid && threadId) {
            void fetch("/worker/cerveau/brief", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId: uid, threadId }),
            }).catch(() => {});
          }
        } catch {
          // Persistance impossible (collection absente cote PB) :
          // le brief reste affiche pour cette session.
          setError("save");
        }
      } catch (err) {
        setError((err as Error).message || "Generation echouee");
      } finally {
        setGenerating(false);
      }
    },
    [record, generating, persist, threadId]
  );

  return {
    content,
    record,
    generatedAt,
    loading,
    generating,
    error,
    hasNew,
    currentCount,
    generate,
  };
}
