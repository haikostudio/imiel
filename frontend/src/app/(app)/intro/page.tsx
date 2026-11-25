"use client";

import { PageSearchField } from "@/components/layout/PageSearchField";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Mail,
  CalendarDays,
  Newspaper,
  PackageSearch,
  Inbox,
  PenSquare,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { hashNavigate, useHashSelection } from "@/lib/hash-router";
import { MobileThreadDrawer } from "@/components/mail/MobileThreadDrawer";
import { useMessageActions } from "@/lib/hooks/useMessageActions";
import { cancelPendingMarkRead, flushMarkReadOnContentClick, scheduleMarkRead } from "@/lib/mark-read-timer";
import { useMailStore } from "@/lib/stores/mail-store";
import { useAgendaEvents } from "@/lib/hooks/useAgendaEvents";
import { useCalendarGroups } from "@/lib/hooks/useCalendarGroups";
import { MobileFooterBar } from "@/components/layout/MobileFooterBar";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import { isMultiDay } from "@/lib/utils/calendar";
import { useNewsletters } from "@/lib/hooks/useNewsletters";
import { useTracking } from "@/lib/hooks/useTracking";
import { clearMailListPageCache, fetchMailListPage } from "@/lib/mail-list-api";
import { useLiveRefresh } from "@/lib/hooks/useLiveRefresh";
import { ReadStatusChecks } from "@/components/mail/ReadStatusChecks";
import { AwaitingReplyBadge } from "@/components/mail/AwaitingReplyBadge";
import { applyThreadTails, buildThreadsFromMessages } from "@/lib/hooks/useThreads";
import { useLabels } from "@/lib/hooks/useLabels";
import { getAwaitingReplySince } from "@/lib/utils/awaiting-reply";
import { useCorrespondents } from "@/lib/stores/correspondents-store";
import { useReadStatus } from "@/lib/stores/read-status-store";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import {
  EmptyState,
  EntityAvatar,
  ListRow,
  SectionCard,
  TagPill,
} from "@/components/ui/kit";
import { formatListDate, formatRelativeDate } from "@/lib/utils/date";
import pb, { getCurrentUserId } from "@/lib/pocketbase";
import type { Message, CalendarEvent, TrackingItem } from "@/lib/pocketbase";

// Deux statuts : ouvert vs cloture (done/cancelled = cloture).
const isClosedItem = (it: TrackingItem) =>
  it.status === "done" || it.status === "cancelled";

// Comme la vue Liste du calendrier : heure de debut, ou "Journee" pour un
// rendez-vous sur toute la journee ou qui deborde sur plusieurs jours (son
// heure de debut serait celle d'un autre jour).
// Heure en 24 h dans la langue de l'app (meme formatage que le calendrier),
// pas celle du navigateur (qui donnait "06:00 AM").
const EVENT_LOCALES: Record<string, string> = { fr: "fr-FR", en: "en-US", de: "de-DE", it: "it-IT" };
function formatEventTime(ev: CalendarEvent, t: (k: string) => string, language: string): string {
  if (ev.all_day || isMultiDay(ev)) return t("intro.allDay");
  try {
    return new Intl.DateTimeFormat(EVENT_LOCALES[language] || "fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ev.start));
  } catch {
    return "";
  }
}

export default function IntroPage() {
  const t = useT();
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const selectMessage = useMailStore((s) => s.selectMessage);
  const openCompose = useMailStore((s) => s.openCompose);
  const language = useSettingsStore((s) => s.language);
  const ensureReadStatusLoaded = useReadStatus((s) => s.ensureLoaded);
  useEffect(() => {
    ensureReadStatusLoaded();
  }, [ensureReadStatusLoaded]);
  const { accounts } = useAccounts();
  const myEmails = useMemo(() => {
    const s = new Set<string>();
    for (const a of accounts) if (a.email) s.add(a.email.toLowerCase());
    return s;
  }, [accounts]);
  const isMineMail = (m: Message) =>
    !!m.is_sent || myEmails.has((m.from_address?.address || "").toLowerCase());

  const { byId: labelsById } = useLabels();
  // Correspondants (adresses deja ecrites) : alimente le rappel "attend depuis".
  const correspondents = useCorrespondents((s) => s.addresses);
  const ensureCorrespondentsLoaded = useCorrespondents((s) => s.ensureLoaded);
  useEffect(() => {
    ensureCorrespondentsLoaded();
  }, [ensureCorrespondentsLoaded]);

  // --- Dernieres conversations (une ligne par fil, lues ou non) ---
  // `latestMails` = messages recus de "Tous les messages" ; `latestTails` =
  // dernier message de chacun de leurs fils tous dossiers confondus (sa propre
  // reponse comprise) : la ligne montre le dernier echange, comme Gmail.
  const [latestMails, setLatestMails] = useState<Message[]>([]);
  const [latestTails, setLatestTails] = useState<Record<string, Message>>({});
  const [mailsLoading, setMailsLoading] = useState(true);

  // `soft` = rafraichissement temps reel : pas de repassage en "Chargement...",
  // la liste se met a jour sous les yeux sans clignoter.
  const loadMails = useCallback(
    async (soft = false) => {
      if (!soft) setMailsLoading(true);
      try {
        // CRITIQUE : purger le cache client de /api/mail/list avant un refetch
        // temps reel. fetchMailListPage garde chaque page 90s : sans purge, on
        // relit la page 1 PERIMEE et le nouveau mail n'apparait jamais.
        if (soft) clearMailListPageCache();
        const res = await fetchMailListPage({
          // Une page de 50 messages (meme requete que le prechargement de
          // "Tous les messages", donc souvent deja en cache) : regroupes par
          // fil, ils donnent les 10 dernieres conversations.
          page: 1,
          perPage: 50,
          accountId: activeAccountId,
          view: "all_mail",
          isDraft: false,
          sort: "date",
          withTails: true,
        });
        // Les doublons multi-comptes (un meme mail recu sur deux comptes lies)
        // sont fusionnes par buildThread (dedup par Message-ID) ; on garde les
        // deux copies pour unir leur flag "repondu".
        setLatestMails(res.items);
        setLatestTails(res.thread_tails ?? {});
      } catch {
        /* best effort */
      } finally {
        if (!soft) setMailsLoading(false);
      }
    },
    [activeAccountId]
  );

  useEffect(() => {
    void loadMails();
  }, [loadMails]);

  // --- Temps reel : les blocs suivent le WebSocket, sans action manuelle ---
  const newMessagesSignal = useMailStore((s) => s.newMessagesSignal);
  const messagesRefreshKey = useMailStore((s) => s.messagesRefreshKey);
  const localMessageUpdate = useMailStore((s) => s.localMessageUpdate);
  const localMessageRemoval = useMailStore((s) => s.localMessageRemoval);

  const scheduleMailsRefresh = useLiveRefresh(() => void loadMails(true), 400);

  // Nouveau mail recu (ou envoye) : rechargement doux des derniers mails.
  const prevSignalRef = useRef(newMessagesSignal);
  useEffect(() => {
    if (newMessagesSignal === prevSignalRef.current) return;
    prevSignalRef.current = newMessagesSignal;
    scheduleMailsRefresh();
  }, [newMessagesSignal, scheduleMailsRefresh]);

  // Retour au premier plan / invalidation globale de la liste.
  const prevRefreshKeyRef = useRef(messagesRefreshKey);
  useEffect(() => {
    if (messagesRefreshKey === prevRefreshKeyRef.current) return;
    prevRefreshKeyRef.current = messagesRefreshKey;
    scheduleMailsRefresh();
  }, [messagesRefreshKey, scheduleMailsRefresh]);

  // Changement d'etat d'un mail (lu/non lu, favori...) : patch sur place, la
  // ligne change d'apparence sans recharger le bloc.
  const seenUpdateTsRef = useRef(localMessageUpdate?.ts ?? 0);
  useEffect(() => {
    if (!localMessageUpdate || localMessageUpdate.ts <= seenUpdateTsRef.current) {
      return;
    }
    seenUpdateTsRef.current = localMessageUpdate.ts;
    const { id, changes } = localMessageUpdate;
    setLatestMails((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...changes } as Message;
      return next;
    });
  }, [localMessageUpdate]);

  // Mail supprime / deplace : retrait immediat puis recharge pour completer
  // les 10 lignes du bloc.
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
    setLatestMails((prev) => {
      const next = prev.filter((m) => !removed.has(m.id));
      return next.length === prev.length ? prev : next;
    });
    scheduleMailsRefresh();
  }, [localMessageRemoval, scheduleMailsRefresh]);

  // --- Evenements du jour (a venir) ---
  const [dayStart, dayEnd] = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return [start, end] as const;
  }, []);
  const { events, refresh: refreshEvents } = useAgendaEvents(dayStart, dayEnd);
  // Couleur de l'agenda de chaque rendez-vous (donnee du groupe, comme le
  // calendrier ; gris si le groupe n'est pas encore charge).
  const { groups: calendarGroupList } = useCalendarGroups();
  const groupColor = useMemo(() => {
    const map = new Map(calendarGroupList.map((g) => [g.id, g.color]));
    return (groupId: string) => map.get(groupId) || "#888";
  }, [calendarGroupList]);
  const todayEvents = useMemo(() => {
    const now = Date.now();
    return events
      .filter((ev) => new Date(ev.end).getTime() >= now)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      .slice(0, 5);
  }, [events]);

  // --- Newsletters (3 dernieres) ---
  const { posts, refresh: refreshNewsletters } = useNewsletters();
  const latestNewsletters = useMemo(() => posts.slice(0, 3), [posts]);

  // --- Suivis actifs (5 derniers) ---
  const { items, statusLines, refresh: refreshTracking } = useTracking();
  const activeTracking = useMemo(
    () => items.filter((it) => !isClosedItem(it)).slice(0, 5),
    [items]
  );

  // Newsletters et suivis sont ecrits par le worker (synthese IA, fiches) :
  // ils n'arrivent pas par le hub WebSocket (qui ne relaie que les mails,
  // dossiers, comptes et labels). On ecoute donc le temps reel PocketBase de
  // ces deux collections, comme le fait l'agenda du jour.
  const scheduleSideRefresh = useLiveRefresh(() => {
    void refreshNewsletters();
    void refreshTracking();
  }, 1_000);

  useEffect(() => {
    const userId = getCurrentUserId();
    if (!userId) return;

    let cancelled = false;
    const unsubs: Array<() => void> = [];

    for (const collection of ["newsletter_posts", "tracking_items"]) {
      pb.collection(collection)
        .subscribe("*", (e) => {
          const record = e.record as { user?: string } | undefined;
          if (record?.user === userId) scheduleSideRefresh();
        })
        .then((fn) => {
          if (cancelled) fn();
          else unsubs.push(fn);
        })
        .catch(() => {
          // SSE indisponible : le tire-pour-rafraichir prend le relais.
        });
    }

    return () => {
      cancelled = true;
      for (const fn of unsubs) fn();
    };
  }, [scheduleSideRefresh]);

  const handleRefresh = async () => {
    await Promise.all([
      // `true` : purge le cache de liste (donnees reellement fraiches) et
      // laisse l'indicateur du tire-pour-rafraichir seul a l'ecran.
      loadMails(true),
      refreshEvents(),
      refreshNewsletters(),
      refreshTracking(),
    ]);
  };

  const latestThreads = useMemo(
    () =>
      applyThreadTails(
        buildThreadsFromMessages(latestMails),
        new Map(Object.entries(latestTails))
      ).slice(0, 10),
    [latestMails, latestTails]
  );

  // Participants de la ligne : "Moi" pour mes adresses (une fois), comme Gmail.
  const formatParticipants = (names: { name: string; address: string }[]) => {
    const out: string[] = [];
    let meAdded = false;
    for (const p of names) {
      if (myEmails.has((p.address || "").toLowerCase())) {
        if (meAdded) continue;
        meAdded = true;
        out.push(t("thread.me"));
      } else {
        out.push(p.name || p.address);
      }
    }
    if (out.length <= 2) return out.join(", ");
    return `${out[0]}, ${out[1]} +${out.length - 2}`;
  };

  // Telephone : la conversation s'ouvre dans le tiroir commun, PAR-DESSUS la
  // vue d'ensemble (comme suivi, newsletters, fiche contact) ; le fil ouvert
  // vit dans l'adresse (?t=) : le geste retour referme le tiroir et laisse la
  // vue d'ensemble. Ordinateur : la boite « Tous les messages » avec ce fil
  // ouvert dans le volet de lecture (#/mail/all?t=&m=).
  const isMobile = useIsMobile();
  const { value: drawerThreadId, open: openDrawerThread, close: closeDrawerThread } =
    useHashSelection("t", ["m"]);
  const [drawerMessageId, setDrawerMessageId] = useState<string | null>(null);
  const { markAsRead } = useMessageActions();
  const autoMarkReadSeconds = useSettingsStore((s) => s.autoMarkReadSeconds);
  function openMail(m: Message) {
    if (isMobile) {
      setDrawerMessageId(m.id);
      openDrawerThread(m.thread_id);
      if (!m.is_read) {
        scheduleMarkRead(`thread:${m.thread_id}`, autoMarkReadSeconds, () => {
          void markAsRead(m.id, true);
        });
      }
      return;
    }
    selectMessage(m.id, m.thread_id, true);
    hashNavigate(`/mail/all?t=${encodeURIComponent(m.thread_id)}&m=${encodeURIComponent(m.id)}`);
  }
  function closeMailDrawer() {
    cancelPendingMarkRead();
    closeDrawerThread();
  }

  return (
    <div data-ref="overview-page" data-veil="" className="flex h-full flex-col bg-background">
      <PullToRefresh onRefresh={handleRefresh}>
        {/* Telephone : la barre du pied reserve elle-meme sa hauteur (zone
            principale). Ordinateur : un peu plus d'air autour des blocs. */}
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-3 pt-1 pb-6 md:gap-5 md:px-8 md:pt-7 md:pb-10">
          {/* Pas de grand titre "Vue d'ensemble" sur telephone (choix
              utilisateur, repete) : la page commence directement par ses blocs. */}
          {/* Miel ordinateur : la recherche en tete, sur la largeur de la
              colonne des blocs (ouvre la recherche globale). */}
          <PageSearchField placeholder={t("searchIn.overview")} />
          {/* Aujourd'hui */}
          <SectionCard
            icon={CalendarDays}
            title={t("intro.today")}
            count={todayEvents.length}
            onSeeAll={() => hashNavigate("/calendar")}
            seeAllLabel={t("intro.seeAll")}
            data-ref="intro-today"
          >
            {todayEvents.length === 0 ? (
              <EmptyState
                icon={CalendarDays}
                title={t("intro.noEvents")}
                description={t("intro.noEventsHint")}
              />
            ) : (
              todayEvents.map((ev) => (
                // Ligne du calendrier (vue Liste) : pastille de la couleur de
                // l'agenda, titre, heure de debut a droite ou "Journee".
                <ListRow
                  key={ev.id}
                  onClick={() => hashNavigate(`/calendar?event=${encodeURIComponent(ev.id)}`)}
                  className="items-center"
                  leading={
                    <span
                      className="block size-2.5 rounded-full"
                      style={{ backgroundColor: groupColor(ev.group) }}
                      data-ref="intro-event-dot"
                    />
                  }
                  title={ev.title || t("intro.noSubject")}
                  meta={
                    <span className="whitespace-nowrap" data-ref="intro-event-time">
                      {formatEventTime(ev, t, language)}
                    </span>
                  }
                  subtitle={ev.location ? <span className="text-muted-foreground">{ev.location}</span> : undefined}
                />
              ))
            )}
          </SectionCard>

          {/* Derniers mails */}
          <SectionCard
            icon={Mail}
            title={t("intro.latest")}
            onSeeAll={() => hashNavigate("/mail/all")}
            seeAllLabel={t("intro.seeAll")}
            data-ref="intro-latest"
          >
            {latestThreads.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title={mailsLoading ? t("loading") : t("intro.noMail")}
              />
            ) : (
              latestThreads.map((th) => {
                // Avatar : le correspondant (dernier mail recu de la vue) ;
                // extrait/date : le dernier message REEL du fil, reponse comprise.
                const contact = th.lastMessage;
                const shown = th.displayMessage;
                const unread = th.unreadCount > 0;
                const awaitingSince = getAwaitingReplySince(shown, {
                  myEmails,
                  correspondents,
                  answered: th.displayAnswered,
                  labelName: (id) => labelsById.get(id)?.name,
                });
                const labelId = th.messages.flatMap((m) => m.labels || []).find((id) => labelsById.has(id));
                const label = labelId ? labelsById.get(labelId) : undefined;
                return (
                  <ListRow
                    key={th.id}
                    onClick={() => openMail(contact)}
                    leading={
                      <EntityAvatar
                        name={contact.from_address?.name || contact.from_address?.address || "?"}
                        email={contact.from_address?.address || ""}
                        size="lg"
                      />
                    }
                    unread={unread}
                    title={formatParticipants(th.participantNames) || t("intro.unknownSender")}
                    meta={
                      <span className="flex items-center gap-1">
                        <ReadStatusChecks messageId={shown.id} messageRfc={shown.message_id} isSent={isMineMail(shown)} />
                        {awaitingSince ? (
                          <AwaitingReplyBadge since={awaitingSince} className="text-[11px]" />
                        ) : (
                          <time>{shown.date ? formatListDate(shown.date) : ""}</time>
                        )}
                      </span>
                    }
                    subtitle={shown.subject || contact.subject || t("intro.noSubject")}
                    description={shown.snippet || undefined}
                    trailing={label ? <TagPill>{label.name}</TagPill> : undefined}
                  />
                );
              })
            )}
          </SectionCard>

          {/* Suivis actifs + newsletters : cote a cote sur ordinateur */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5">
            <SectionCard
              icon={PackageSearch}
              title={t("intro.tracking")}
              count={activeTracking.length}
              onSeeAll={() => hashNavigate("/suivi")}
              seeAllLabel={t("intro.seeAll")}
              data-ref="intro-tracking"
            >
              {activeTracking.length === 0 ? (
                <EmptyState icon={PackageSearch} title={t("intro.noTracking")} />
              ) : (
                activeTracking.map((it) => {
                  const label = it.merchant || it.sender_domain || it.title;
                  const last = statusLines[it.id];
                  const description =
                    last && last !== it.status_label ? last : it.context_summary || undefined;
                  return (
                    <ListRow
                      key={it.id}
                      onClick={() => hashNavigate(`/suivi?f=${encodeURIComponent(it.id)}`)}
                      leading={
                        // Un dossier de suivi est TOUJOURS un carre arrondi.
                        <EntityAvatar name={label} domain={it.sender_domain} shape="folder" size="lg" />
                      }
                      unread={!it.is_read}
                      strong={false}
                      title={it.title}
                      meta={it.last_message_date ? formatRelativeDate(it.last_message_date) : ""}
                      subtitle={<span className="text-muted-foreground">{it.status_label}</span>}
                      description={description}
                      chevron
                    />
                  );
                })
              )}
            </SectionCard>

            {/* Dernieres newsletters */}
            <SectionCard
              icon={Newspaper}
              title={t("intro.newsletters")}
              onSeeAll={() => hashNavigate("/newsletters")}
              seeAllLabel={t("intro.seeAll")}
              data-ref="intro-newsletters"
            >
              {latestNewsletters.length === 0 ? (
                <EmptyState icon={Newspaper} title={t("intro.noNewsletters")} />
              ) : (
                latestNewsletters.map((p) => (
                  <ListRow
                    key={p.id}
                    onClick={() => hashNavigate(`/newsletters?post=${encodeURIComponent(p.id)}`)}
                    leading={
                      <EntityAvatar
                        name={p.source_name || p.source_address || "?"}
                        email={p.source_address || ""}
                        size="lg"
                      />
                    }
                    unread={!p.is_read}
                    strong={false}
                    title={p.title || p.original_subject || p.source_name}
                    meta={p.message_date ? formatRelativeDate(p.message_date) : ""}
                    subtitle={<span className="text-muted-foreground">{p.source_name}</span>}
                    description={
                      p.summary ? `${t("intro.summaryPrefix")} ${p.summary}` : undefined
                    }
                    chevron
                  />
                ))
              )}
            </SectionCard>
          </div>
        </div>
      </PullToRefresh>
      {isMobile && <MobileFooterBar compose onCompose={() => openCompose("new")} />}
      {isMobile && (
        <MobileThreadDrawer
          open={!!drawerThreadId}
          onClose={closeMailDrawer}
          controlled
          threadId={drawerThreadId}
          messageId={drawerThreadId ? drawerMessageId : null}
          onContentClickCapture={flushMarkReadOnContentClick}
        />
      )}
    </div>
  );
}
