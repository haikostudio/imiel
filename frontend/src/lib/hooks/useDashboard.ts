"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import pb, { messages, type Message, getCurrentUserId } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import { useLiveRefresh } from "@/lib/hooks/useLiveRefresh";
import { onSyncStatus } from "@/lib/ws-channel";
import { subDays, startOfDay, format, differenceInHours } from "date-fns";
import { fr } from "date-fns/locale";

export interface DashboardStats {
  unreadCount: number;
  unansweredCount: number;
  sentCount7d: number;
  avgResponseTimeHours: number;
}

export interface ActivityDataPoint {
  date: string;
  label: string;
  received: number;
  sent: number;
}

export interface TopContact {
  email: string;
  name: string;
  count: number;
}

interface UseDashboardReturn {
  stats: DashboardStats;
  needsReply: Message[];
  waitingReply: Message[];
  activityData: ActivityDataPoint[];
  topContacts: TopContact[];
  loading: boolean;
}

// Rafales d'events WebSocket -> un seul rechargement. Le rechargement complet
// (liste 7 jours + listes + graphe) est plus lourd que le simple recompte des
// KPI : deux fenetres de coalescence differentes.
const FULL_REFRESH_DEBOUNCE_MS = 1_500;
const STATS_REFRESH_DEBOUNCE_MS = 800;

export function useDashboard(): UseDashboardReturn {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const newMessagesSignal = useMailStore((s) => s.newMessagesSignal);
  const messagesRefreshKey = useMailStore((s) => s.messagesRefreshKey);
  const localMessageUpdate = useMailStore((s) => s.localMessageUpdate);
  const localMessageRemoval = useMailStore((s) => s.localMessageRemoval);

  const [stats, setStats] = useState<DashboardStats>({
    unreadCount: 0,
    unansweredCount: 0,
    sentCount7d: 0,
    avgResponseTimeHours: 0,
  });
  const [needsReply, setNeedsReply] = useState<Message[]>([]);
  const [waitingReply, setWaitingReply] = useState<Message[]>([]);
  const [activityData, setActivityData] = useState<ActivityDataPoint[]>([]);
  const [topContacts, setTopContacts] = useState<TopContact[]>([]);
  const [loading, setLoading] = useState(true);

  // Compte actif lu au moment du fetch : les rafraichissements temps reel sont
  // declenches par des callbacks stables (WS), pas par le cycle de rendu.
  const accountRef = useRef(activeAccountId);
  accountRef.current = activeAccountId;

  // Un seul fetch "gagnant" a la fois : un rafraichissement plus recent
  // invalide le precedent (evite d'ecraser des donnees fraiches).
  const runIdRef = useRef(0);

  // --- Recompte seul des KPI (SQL direct, peu couteux) ---
  const fetchStats = useCallback(async () => {
    const accountId = accountRef.current;
    const qs =
      accountId && accountId !== "all"
        ? `?account_id=${encodeURIComponent(accountId)}`
        : "";
    try {
      const counts = await pb.send<{
        unreadCount: number;
        unansweredCount: number;
      }>(`/api/mail/dashboard-stats${qs}`, { method: "GET" });
      setStats((prev) => ({
        ...prev,
        unreadCount: counts.unreadCount,
        unansweredCount: counts.unansweredCount,
      }));
    } catch {
      // Erreur silencieuse
    }
  }, []);

  // --- Rechargement complet du tableau de bord ---
  // `soft` = rafraichissement temps reel : on ne repasse PAS en `loading`,
  // donc pas de squelette qui clignote sous les yeux de l'utilisateur.
  const fetchDashboard = useCallback(
    async (soft = false) => {
      const userId = getCurrentUserId();
      if (!userId) {
        setLoading(false);
        return;
      }

      const runId = ++runIdRef.current;
      const stale = () => runId !== runIdRef.current;
      if (!soft) setLoading(true);

      try {
        const accountId = accountRef.current;
        const accountFilter =
          accountId && accountId !== "all" ? `account = "${accountId}"` : "";

        const now = new Date();
        const sevenDaysAgo = subDays(now, 7).toISOString();
        const oneDayAgo = subDays(now, 1).toISOString();

        // Récupérer les messages des 7 derniers jours
        const recentFilter = [accountFilter, `date >= "${sevenDaysAgo}"`]
          .filter(Boolean)
          .join(" && ");

        const recentMessages = await messages().getFullList<Message>({
          filter: recentFilter,
          sort: "-date",
        });

        if (stale()) return;

        // Compteurs (non lus + non repondus) via SQL-direct : le COUNT par le
        // record-API PB faisait timeout sur ~36k mails (validation per-row de
        // l'access rule). Cf backend/pb_hooks/dashboard-stats.pb.js.
        const statsQs =
          accountId && accountId !== "all"
            ? `?account_id=${encodeURIComponent(accountId)}`
            : "";
        const counts = await pb.send<{ unreadCount: number; unansweredCount: number }>(
          `/api/mail/dashboard-stats${statsQs}`,
          { method: "GET" }
        );

        // Stats
        const sentMessages = recentMessages.filter(
          (m) => !m.is_draft && m.is_sent
        );

        // Calculer le temps de réponse moyen
        const responseTimes: number[] = [];
        const answeredMessages = recentMessages.filter((m) => m.is_answered);
        for (const msg of answeredMessages) {
          // Chercher la réponse dans le même thread
          const reply = recentMessages.find(
            (m) =>
              m.in_reply_to === msg.message_id &&
              new Date(m.date).getTime() > new Date(msg.date).getTime()
          );
          if (reply) {
            responseTimes.push(
              differenceInHours(new Date(reply.date), new Date(msg.date))
            );
          }
        }

        const avgResponseTime =
          responseTimes.length > 0
            ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
            : 0;

        if (stale()) return;

        setStats({
          unreadCount: counts.unreadCount,
          unansweredCount: counts.unansweredCount,
          sentCount7d: sentMessages.length,
          avgResponseTimeHours: Math.round(avgResponseTime * 10) / 10,
        });

        // Messages nécessitant une réponse :
        // Lus + pas répondus + inbox + pas newsletter
        const needsReplyFilter = [
          accountFilter,
          `is_read = true`,
          `is_answered = false`,
          `is_draft = false`,
        ]
          .filter(Boolean)
          .join(" && ");

        const needsReplyResult = await messages().getList<Message>(1, 20, {
          filter: needsReplyFilter,
          sort: "-date",
          skipTotal: true,
        });

        if (stale()) return;

        setNeedsReply(needsReplyResult.items);

        // Messages en attente de réponse :
        // Envoyés + pas de réponse dans le thread + >24h
        const waitingFilter = [
          accountFilter,
          `is_answered = false`,
          `is_draft = false`,
          `date <= "${oneDayAgo}"`,
        ]
          .filter(Boolean)
          .join(" && ");

        const waitingResult = await messages().getList<Message>(1, 20, {
          filter: waitingFilter,
          sort: "-date",
          skipTotal: true,
        });

        if (stale()) return;
        setWaitingReply(waitingResult.items);

        // Données d'activité (7 jours)
        const activity: ActivityDataPoint[] = [];
        for (let i = 6; i >= 0; i--) {
          const day = subDays(now, i);
          const dayStart = startOfDay(day);
          const dayKey = format(day, "yyyy-MM-dd");
          const dayLabel = format(day, "EEE d", { locale: fr });

          const dayMessages = recentMessages.filter((m) => {
            const msgDate = startOfDay(new Date(m.date));
            return msgDate.getTime() === dayStart.getTime();
          });

          activity.push({
            date: dayKey,
            label: dayLabel,
            received: dayMessages.filter((m) => !m.is_draft).length,
            sent: dayMessages.filter((m) => m.is_draft === false).length,
          });
        }

        if (stale()) return;
        setActivityData(activity);

        // Top contacts
        const contactMap = new Map<
          string,
          { name: string; count: number }
        >();
        for (const msg of recentMessages) {
          const email = msg.from_address?.address;
          if (!email) continue;
          const existing = contactMap.get(email);
          if (existing) {
            existing.count++;
          } else {
            contactMap.set(email, { name: msg.from_address?.name || email, count: 1 });
          }
        }

        const sorted = Array.from(contactMap.entries())
          .map(([email, data]) => ({ email, ...data }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);

        if (stale()) return;
        setTopContacts(sorted);
      } catch {
        // Erreur silencieuse
      } finally {
        if (!stale()) setLoading(false);
      }
    },
    []
  );

  // Chargement initial + rechargement au changement de compte actif.
  useEffect(() => {
    void fetchDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId, fetchDashboard]);

  const scheduleFullRefresh = useLiveRefresh(
    () => void fetchDashboard(true),
    FULL_REFRESH_DEBOUNCE_MS
  );
  const scheduleStatsRefresh = useLiveRefresh(
    () => void fetchStats(),
    STATS_REFRESH_DEBOUNCE_MS
  );

  // --- Temps reel : nouveaux mails (WebSocket -> newMessagesSignal) ---
  const prevSignalRef = useRef(newMessagesSignal);
  useEffect(() => {
    if (newMessagesSignal === prevSignalRef.current) return;
    prevSignalRef.current = newMessagesSignal;
    scheduleFullRefresh();
  }, [newMessagesSignal, scheduleFullRefresh]);

  // Retour au premier plan / invalidation globale de la liste.
  const prevRefreshKeyRef = useRef(messagesRefreshKey);
  useEffect(() => {
    if (messagesRefreshKey === prevRefreshKeyRef.current) return;
    prevRefreshKeyRef.current = messagesRefreshKey;
    scheduleFullRefresh();
  }, [messagesRefreshKey, scheduleFullRefresh]);

  // --- Temps reel : changement d'etat d'un mail (lu, repondu, favori...) ---
  const seenUpdateTsRef = useRef(localMessageUpdate?.ts ?? 0);
  useEffect(() => {
    if (!localMessageUpdate || localMessageUpdate.ts <= seenUpdateTsRef.current) {
      return;
    }
    seenUpdateTsRef.current = localMessageUpdate.ts;
    const { id, changes } = localMessageUpdate;

    // Mise a jour douce des deux listes : on applique le changement sur place,
    // et un mail qui vient d'obtenir une reponse quitte les listes "en attente".
    const patch = (prev: Message[]) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;
      if (changes.is_answered === true || changes.is_draft === true) {
        return prev.filter((m) => m.id !== id);
      }
      const next = [...prev];
      next[idx] = { ...next[idx], ...changes } as Message;
      return next;
    };
    setNeedsReply(patch);
    setWaitingReply(patch);

    // Les KPI non lus / sans reponse changent : recompte cible, pas de
    // rechargement complet.
    scheduleStatsRefresh();
  }, [localMessageUpdate, scheduleStatsRefresh]);

  // --- Temps reel : mails supprimes / deplaces ---
  const seenRemovalTsRef = useRef(localMessageRemoval?.ts ?? 0);
  useEffect(() => {
    if (
      !localMessageRemoval ||
      localMessageRemoval.ts <= seenRemovalTsRef.current
    ) {
      return;
    }
    seenRemovalTsRef.current = localMessageRemoval.ts;
    const removed = new Set(localMessageRemoval.ids);
    setNeedsReply((prev) => prev.filter((m) => !removed.has(m.id)));
    setWaitingReply((prev) => prev.filter((m) => !removed.has(m.id)));
    scheduleStatsRefresh();
  }, [localMessageRemoval, scheduleStatsRefresh]);

  // --- Temps reel : fin d'un cycle de sync du worker ---
  useEffect(() => {
    return onSyncStatus((event) => {
      const accountId = accountRef.current;
      if (accountId && accountId !== "all" && event.accountId !== accountId) {
        return;
      }
      if (event.status !== "idle") return;
      // Sync avec du nouveau -> tout le tableau bouge (graphe, contacts,
      // listes). Sync a vide (safety poll ~1 min) -> simple recompte des KPI.
      if (event.newMessages && event.newMessages > 0) scheduleFullRefresh();
      else scheduleStatsRefresh();
    });
  }, [scheduleFullRefresh, scheduleStatsRefresh]);

  return { stats, needsReply, waitingReply, activityData, topContacts, loading };
}
