"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ShieldAlert,
  ChevronRight,
  MessagesSquare,
  PackageSearch,
  EllipsisVertical,
} from "lucide-react";
import { RemoveScroll } from "react-remove-scroll";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import { format, isToday, isYesterday } from "date-fns";
import { fr } from "date-fns/locale";
import { DatePill, IconCircleButton, StatusPill } from "@/components/ui/kit";
import { ThreadDetailsPanel, openThreadDetails, closeThreadDetails } from "./ThreadDetailsPanel";
import { useHashRouter } from "@/lib/hash-router";
import { useFoldersAll } from "@/lib/hooks/useFolders";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ContactAvatar } from "@/components/mail/ContactAvatar";
import { useIsMiel } from "@/lib/hooks/useSettings";
import { useThreads, buildThread, deduplicateMessages, type Thread, type ParticipantDetail } from "@/lib/hooks/useThreads";
import { useT, t as tStatic } from "@/lib/i18n";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { useMailStore } from "@/lib/stores/mail-store";
import { hasReplyAllExtra, lastReceivedMessage } from "@/lib/reply-agent";
import { useMessageActions } from "@/lib/hooks/useMessageActions";
import { useTrackedThreads } from "@/lib/stores/tracked-threads";
import { cn } from "@/lib/utils";
import { normalizeSubject } from "@/lib/utils/threading";
import { stripReplacementChars } from "@/lib/utils/sanitize";
import { formatRelativeDate } from "@/lib/utils/date";
import { messages, type Message, type ReadReceipt } from "@/lib/pocketbase";
import { useReadReceipts } from "@/lib/hooks/useReadReceipts";
import { useThreadTrackingItem } from "@/lib/hooks/useThreadTrackingItem";
import { MessageAccordion } from "./MessageAccordion";
import { useConversationActions, useThreadPanelRequest, type ConversationPanel, type MenuRow } from "./MessageContextMenu";
import { ThreadBriefPanel } from "./ThreadBriefPanel";
import { ThreadBriefBubble, parseBriefDate } from "./ThreadBriefBubble";
import { useThreadBrief } from "@/lib/hooks/useThreadBrief";
import { ReadReceiptsPanel } from "./ReadReceiptsPanel";
import { ThreadTrackingPanel } from "./ThreadTrackingPanel";
import { ThreadLabelsBar } from "./ThreadLabelsBar";
import { ThreadAttachments } from "./ThreadAttachments";
import { computeSeriesContinuations, type SeriesEntry } from "@/lib/utils/message-series";

/** Cle de la note IA dans la suite affichee du fil (pastilles de date). */
const BRIEF_ITEM_ID = "__thread-brief__";

function ThreadViewSkeleton() {
  return (
    <div data-ref="thread-view-skeleton" className="flex flex-col gap-4 p-4">
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-3 w-24" />
      <Separator />
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex flex-col gap-1">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  );
}

function ThreadViewEmpty() {
  const t = useT();
  return (
    <div data-ref="thread-view-empty" className="flex flex-1 flex-col items-center justify-center gap-3 py-16">
      <div className="bg-muted rounded-full p-4">
        <MessagesSquare className="text-muted-foreground size-8" />
      </div>
      <div className="text-center">
        <p className="font-medium">{t("message.noMessageSelected")}</p>
        <p className="text-muted-foreground text-sm">
          {t("message.selectMessage")}
        </p>
      </div>
    </div>
  );
}

interface ThreadViewInnerProps {
  thread: Thread;
  // Mobile : le bouton pieces jointes est rendu dans le pied du tiroir (a cote
  // de "Repondre") par la page parente -> on masque la version interne.
  hideAttachments?: boolean;
  /** Emplacement, dans l'en-tete que porte la page (tiroir mobile), ou poser
   * l'etoile de la conversation. */
  headerActionsSlot?: HTMLElement | null;
  /** Le tiroir du telephone porte deja l'en-tete du fil (visages, titre). */
  embeddedHeader?: boolean;
}

function ThreadViewInner({
  thread,
  hideAttachments,
  headerActionsSlot,
  embeddedHeader,
}: ThreadViewInnerProps) {
  const t = useT();
  const isMiel = useIsMiel();
  const { accounts: accs } = useAccounts();
  const activeFolder = useMailStore((s) => s.activeFolder);
  const searchMatchMessageId = useMailStore((s) => s.searchMatchMessageId);
  const openCompose = useMailStore((s) => s.openCompose);
  const { moveToInbox } = useMessageActions();
  const isInSpam = activeFolder === "spam";

  // Charger tous les messages du thread (cross-folder : inbox + sent + etc.)
  const [rawMessages, setRawMessages] = useState<Message[]>(thread.messages);
  const [crossFolderLoaded, setCrossFolderLoaded] = useState(false);

  // Cle stable pour eviter les re-runs sur nouvelle reference de thread
  const threadMsgIds = useMemo(
    () => thread.messages.map((m) => m.id).join(","),
    [thread.messages],
  );

  useEffect(() => {
    setRawMessages(thread.messages);
    setCrossFolderLoaded(false);

    // Collecter tous les thread_id uniques (threads fusionnes par sujet)
    const uniqueThreadIds = [...new Set(
      thread.messages
        .map((m) => m.thread_id)
        .filter((id): id is string => !!id)
    )];

    if (uniqueThreadIds.length === 0) {
      setCrossFolderLoaded(true);
      return;
    }

    let cancelled = false;
    const filter = uniqueThreadIds
      .map((id) => `thread_id = "${id.replace(/"/g, '\\"')}"`)
      .join(" || ");
    messages()
      .getFullList<Message>({
        filter: `(${filter}) && is_draft = false`,
        sort: "date",
      })
      .then((allMsgs) => {
        if (cancelled) return;
        // Fusionner : conserver les messages du thread qui ne sont pas dans les resultats cross-folder
        // (ex: messages avec thread_id vide fusionnes par sujet dans groupMessagesByThread)
        const fetchedIds = new Set(allMsgs.map(m => m.id));
        const extraMsgs = thread.messages.filter(m => !fetchedIds.has(m.id));
        setRawMessages([...allMsgs, ...extraMsgs]);
        setCrossFolderLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setCrossFolderLoaded(true);
      });

    return () => { cancelled = true; };
  }, [threadMsgIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reagir aux mises a jour locales (lu/non-lu, starred, etc.)
  const localMessageUpdate = useMailStore((s) => s.localMessageUpdate);

  useEffect(() => {
    if (!localMessageUpdate) return;
    const { id, changes } = localMessageUpdate;
    setRawMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], ...changes } as Message;
      return updated;
    });
  }, [localMessageUpdate]);

  // Recharger le fil quand un nouveau message arrive (ex: la reponse qu'on
  // vient d'envoyer). Le message envoye passe de brouillon -> Envoyes en gardant
  // le meme thread_id, mais n'entre PAS dans la liste "Tous les messages"
  // (is_sent=false) : sans ce refetch, thread.messages ne change pas, donc
  // l'effet cross-folder ci-dessus ne se rejoue jamais et la reponse
  // n'apparait dans la conversation ouverte qu'apres l'avoir quittee/rouverte.
  const newMessagesSignal = useMailStore((s) => s.newMessagesSignal);
  const prevNewMsgSignalRef = useRef(newMessagesSignal);
  useEffect(() => {
    if (newMessagesSignal === prevNewMsgSignalRef.current) return;
    prevNewMsgSignalRef.current = newMessagesSignal;
    if (!crossFolderLoaded) return; // le chargement initial captera deja les nouveaux

    const uniqueThreadIds = [...new Set(
      thread.messages.map((m) => m.thread_id).filter((id): id is string => !!id)
    )];
    if (uniqueThreadIds.length === 0) return;

    let cancelled = false;
    const filter = uniqueThreadIds
      .map((id) => `thread_id = "${id.replace(/"/g, '\\"')}"`)
      .join(" || ");
    messages()
      .getFullList<Message>({
        filter: `(${filter}) && is_draft = false`,
        sort: "date",
      })
      .then((allMsgs) => {
        if (cancelled) return;
        setRawMessages((prev) => {
          const fetchedIds = new Set(allMsgs.map((m) => m.id));
          // Conserver les messages hors resultat (thread_id vide fusionne par sujet)
          const extra = prev.filter((m) => !fetchedIds.has(m.id) && !m.is_draft);
          return [...allMsgs, ...extra];
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newMessagesSignal]);

  // Dedupliquer les messages (meme email dans plusieurs dossiers IMAP, ou double sync)
  const fullMessages = useMemo(() => deduplicateMessages(rawMessages), [rawMessages]);

  // Emails de l'utilisateur (ses propres messages, accuses de lecture)
  const userEmails = useMemo(() => {
    const emails = new Set<string>();
    for (const acc of accs) {
      if (acc.email) emails.add(acc.email.toLowerCase());
    }
    return emails;
  }, [accs]);

  // Recalculer les metadonnees a partir de fullMessages
  const threadMeta = useMemo(() => {
    const participantMap = new Map<string, { address: string; name: string }>();
    const interlocutorAddrs = new Set<string>();
    for (const msg of fullMessages) {
      if (msg.from_address?.address) {
        const addr = msg.from_address.address;
        const key = addr.toLowerCase();
        interlocutorAddrs.add(key);
        if (!participantMap.has(key) || (msg.from_address.name && msg.from_address.name !== addr)) {
          participantMap.set(key, { address: addr, name: msg.from_address.name || addr });
        }
      }
      for (const to of msg.to_addresses ?? []) {
        if (to.address) {
          const key = to.address.toLowerCase();
          interlocutorAddrs.add(key);
          if (!participantMap.has(key) || (to.name && to.name !== to.address)) {
            participantMap.set(key, { address: to.address, name: to.name || to.address });
          }
        }
      }
      for (const cc of msg.cc_addresses ?? []) {
        if (cc.address) {
          const key = cc.address.toLowerCase();
          if (!participantMap.has(key) || (cc.name && cc.name !== cc.address)) {
            participantMap.set(key, { address: cc.address, name: cc.name || cc.address });
          }
        }
      }
    }
    const details: ParticipantDetail[] = [];
    for (const [key, { address, name }] of participantMap) {
      details.push({
        address,
        name,
        role: interlocutorAddrs.has(key) ? "interlocutor" : "cc",
      });
    }
    const sorted = [...fullMessages].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    return {
      participants: Array.from(participantMap.keys()),
      participantDetails: details,
      lastMessage: sorted[sorted.length - 1] ?? thread.lastMessage,
    };
  }, [fullMessages, thread.lastMessage]);

  // Brouillons du fil : affiches DANS la conversation, tous en tete du
  // fil, le plus recemment modifie en premier ; le plus recent est aussi repris par le
  // bouton "Repondre". Relus quand une fenetre de composition s'ouvre/se ferme
  // (l'auto-save final arrive juste apres la fermeture -> 2e lecture differee)
  // et a chaque invalidation de liste (envoi, suppression de brouillon).
  const [threadDrafts, setThreadDrafts] = useState<Message[]>([]);
  const [draftChecked, setDraftChecked] = useState(false);
  const existingDraft = threadDrafts[0] ?? null;
  const composeCount = useMailStore((s) => s.composeInstances.length);
  const messagesRefreshKey = useMailStore((s) => s.messagesRefreshKey);

  useEffect(() => {
    const uniqueThreadIds = [...new Set(
      thread.messages
        .map((m) => m.thread_id)
        .filter((id): id is string => !!id)
    )];

    if (uniqueThreadIds.length === 0) {
      setThreadDrafts([]);
      setDraftChecked(true);
      return;
    }

    let cancelled = false;
    const filter = uniqueThreadIds
      .map((id) => `thread_id = "${id.replace(/"/g, '\\"')}"`)
      .join(" || ");
    const load = () =>
      messages()
        .getList<Message>(1, 10, {
          filter: `(${filter}) && is_draft = true`,
          sort: "-date",
          skipTotal: true,
        })
        .then((res) => {
          if (!cancelled) setThreadDrafts(res.items);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setDraftChecked(true);
        });
    load();
    const late = setTimeout(load, 1500);

    return () => { cancelled = true; clearTimeout(late); };
  }, [thread, composeCount, messagesRefreshKey]);

  // Brief / notes IA de la discussion
  const [briefOpen, setBriefOpen] = useState(false);

  const briefThreadId = threadMeta.lastMessage.thread_id || thread.id;
  // UN seul etat de note pour la bulle du fil ET le module de generation.
  const brief = useThreadBrief(briefThreadId, fullMessages);
  const hasBrief = !!brief.content;
  const briefDate = useMemo(() => parseBriefDate(brief.generatedAt), [brief.generatedAt]);
  // Sujet affiche en titre de l'en-tete (deja normalise par buildThread).
  const headerSubject = stripReplacementChars(thread.subject || "").trim() || tStatic("message.noSubject");

  // Ecran "Details de la conversation", porte par l'adresse (?cd=<fil>).
  const { searchParams: hashParams } = useHashRouter();
  const detailsOpen = hashParams.get("cd") === thread.id;
  // Le titre rouvre le dernier onglet choisi ; les visages, Interlocuteurs.
  const openDetails = useCallback(() => openThreadDetails(thread.id), [thread.id]);
  const openDetailsPeople = useCallback(() => openThreadDetails(thread.id, "people"), [thread.id]);
  const participantCount = threadMeta.participants.length;
  const participantsLabel =
    participantCount > 1
      ? t("thread.participantsCount", { count: String(participantCount) })
      : t("thread.participantCount");

  // --- Suivi (decouple de l'etoile/favori) ---
  // Une conversation peut fusionner plusieurs thread_id (regroupement par sujet) :
  // on teste tous ceux du fil contre l'ensemble des threads suivis.
  const convoThreadIds = useMemo(() => {
    const s = new Set<string>();
    for (const m of fullMessages) if (m.thread_id) s.add(m.thread_id);
    if (briefThreadId) s.add(briefThreadId);
    return Array.from(s);
  }, [fullMessages, briefThreadId]);
  const ensureTrackedLoaded = useTrackedThreads((s) => s.ensureLoaded);
  const trackThread = useTrackedThreads((s) => s.requestTrack);
  const untrackThread = useTrackedThreads((s) => s.untrack);
  const isTracked = useTrackedThreads((s) => convoThreadIds.some((id) => s.ids.has(id)));
  const [trackBusy, setTrackBusy] = useState(false);
  // Volet de suivi (ouvert par le bouton PackageSearch ; pendant de la note IA)
  const [trackingOpen, setTrackingOpen] = useState(false);
  // Fiche de suivi, lue des que le fil est suivi : nourrit le bandeau du fil ET
  // le tiroir (une seule requete). Relue a chaque ouverture du tiroir.
  const [trackingOpenCount, setTrackingOpenCount] = useState(0);
  useEffect(() => {
    if (trackingOpen) setTrackingOpenCount((n) => n + 1);
  }, [trackingOpen]);
  const { item: trackingItem, loading: trackingItemLoading } = useThreadTrackingItem(
    convoThreadIds,
    isTracked,
    trackingOpenCount
  );
  const trackingClosed =
    trackingItem?.status === "done" || trackingItem?.status === "cancelled";

  // --- Suivi de lecture (pixel de tracking sur les mails envoyes) ---
  // Volet ouvert par le bouton CheckCheck de l'en-tete : timeline
  // Envoye -> Lu -> Relu par message de la conversation.
  // PIEGE : un mail envoye a soi-meme / a un autre compte synchronise existe en
  // PLUSIEURS copies PB (record Envoyes + copie recue) partageant le meme
  // message_id RFC ; les evenements sont rattaches au record ENVOYE alors que
  // la dedup du fil peut garder l'autre copie -> on interroge TOUTES les copies
  // brutes puis on remappe chaque evenement vers la copie affichee.
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  // Un menu des vues (sous un message) est ouvert : releve a l'ouverture puis
  // en continu tant qu'il reste ouvert.
  const [viewsMenuOpen, setViewsMenuOpen] = useState(false);
  const isOwnMessage = useCallback(
    (m: Message) => {
      const from = m.from_address?.address?.toLowerCase() || "";
      return m.is_sent || (from !== "" && userEmails.has(from));
    },
    [userEmails]
  );
  // Premier mail CHRONOLOGIQUE de toute la conversation (copies cross-dossier
  // comprises, brouillons exclus) : s'il est de l'utilisateur, il porte le
  // fond bleu clair = conversation entamee par lui. L'affichage est inverse
  // (plus recent en haut) : ne pas prendre le premier rendu.
  const openerId = useMemo(() => {
    let first: Message | null = null;
    for (const m of fullMessages) {
      if (m.is_draft) continue;
      if (!first || new Date(m.date).getTime() < new Date(first.date).getTime()) first = m;
    }
    return first && isOwnMessage(first) ? first.id : null;
  }, [fullMessages, isOwnMessage]);
  const sentMessageIds = useMemo(
    () => rawMessages.filter(isOwnMessage).map((m) => m.id),
    [rawMessages, isOwnMessage]
  );
  const {
    receipts: rawReceipts,
    loading: receiptsLoading,
    hasOpens,
    refresh: refreshReceipts,
  } = useReadReceipts(sentMessageIds, { poll: receiptsOpen || viewsMenuOpen });
  const receipts = useMemo(() => {
    const rfcById = new Map(rawMessages.map((m) => [m.id, m.message_id]));
    const displayedByRfc = new Map(
      fullMessages.filter((m) => m.message_id).map((m) => [m.message_id, m.id])
    );
    return rawReceipts.map((r) => {
      const rfc = rfcById.get(r.message);
      const target = rfc ? displayedByRfc.get(rfc) : undefined;
      return target && target !== r.message ? { ...r, message: target } : r;
    });
  }, [rawReceipts, rawMessages, fullMessages]);
  // Evenements de suivi par message affiche (vues sous la bulle des messages a
  // soi) : chaque message ne compte que SES evenements.
  const receiptsById = useMemo(() => {
    const map = new Map<string, ReadReceipt[]>();
    for (const r of receipts) {
      const list = map.get(r.message) ?? [];
      list.push(r);
      map.set(r.message, list);
    }
    return map;
  }, [receipts]);
  const handleViewsOpenChange = useCallback(
    (o: boolean) => {
      setViewsMenuOpen(o);
      if (o) void refreshReceipts();
    },
    [refreshReceipts]
  );
  useEffect(() => {
    ensureTrackedLoaded();
  }, [ensureTrackedLoaded]);
  const handleToggleTracking = useCallback(async () => {
    const seedId = threadMeta.lastMessage?.id;
    if (!seedId || trackBusy) return;
    setTrackBusy(true);
    try {
      if (isTracked) {
        const ok = await untrackThread(seedId, briefThreadId);
        if (ok) toast.success(tStatic("tracking.removed"));
      } else {
        // Cherche d'abord un suivi ressemblant (choix utilisateur), toasts
        // centralises dans le store.
        await trackThread(seedId, briefThreadId);
      }
    } finally {
      setTrackBusy(false);
    }
  }, [threadMeta.lastMessage?.id, trackBusy, isTracked, untrackThread, trackThread, briefThreadId]);

  // Mobile : le thread s'ouvre lui-meme dans un drawer. Les tiroirs internes
  // (reponse, pieces jointes) ne doivent PAS etre confines au pane (sinon leur
  // backdrop ne couvre pas l'en-tete du drawer de lecture) -> plein ecran.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  // Repondre ouvre la fenetre de composition complete (meme fenetre qu'un
  // brouillon / transfert : objet, Cc/Cci, PJ, IA, correction, envoi
  // programme...). Un brouillon existant pour ce fil est repris tel quel
  // (mode edit) ; sinon on repond au dernier message recu du fil.
  // Le bouton du bas repond au dernier message RECU (pas a mon propre envoi
  // le plus recent) en reprenant sa configuration : auteur + autres A en "A",
  // copies en "Cc", sans moi (replyAllRecipients). Independant du reglage
  // "Repondre a tous par defaut". Fil sans message recu : dernier message.
  const replyTarget = useMemo(
    () => lastReceivedMessage(fullMessages, userEmails) ?? threadMeta.lastMessage,
    [fullMessages, userEmails, threadMeta.lastMessage]
  );
  const replyPlaceholder = hasReplyAllExtra(replyTarget, userEmails)
    ? t("thread.replyAllPlaceholder")
    : t("thread.replyPlaceholder");
  const handleReplyClick = useCallback(() => {
    if (existingDraft) {
      openCompose("edit", existingDraft.id);
    } else {
      openCompose("reply-all", replyTarget.id);
    }
  }, [existingDraft, openCompose, replyTarget.id]);

  // Brouillons : TOUS en tete du fil, le plus recemment modifie en premier
  // (l'auto-save rafraichit `date`), sous la pastille de leur propre jour. Ils
  // ne sont plus colles au message auquel ils repondent (demande utilisateur :
  // un brouillon modifie a l'instant restait enfoui sous un vieux message).
  const sortedDrafts = useMemo(() => {
    const ts = (m: Message) => {
      const v = new Date(m.auto_saved_at || m.date).getTime();
      return isNaN(v) ? 0 : v;
    };
    return [...threadDrafts].sort((x, y) => ts(y) - ts(x));
  }, [threadDrafts]);

  const openDraft = useCallback(
    (id: string) => openCompose("edit", id),
    [openCompose]
  );
  // Messages du plus recent au plus ancien
  const reversed = useMemo(
    () => [...fullMessages].reverse(),
    [fullMessages]
  );

  // Tous les messages sont toujours ouverts : ni repli d'un message, ni
  // regroupement des messages intermediaires.

  // Note IA dans le fil, a la date de sa derniere generation : le fil est
  // affiche du plus recent au plus ancien, la note se pose donc juste AVANT le
  // premier message (affiche) au plus aussi ancien qu'elle ; aucun -> en bas.
  const briefIndex = useMemo(() => {
    if (!hasBrief) return -1;
    if (!briefDate) return 0;
    const at = briefDate.getTime();
    const i = reversed.findIndex((m) => new Date(m.date).getTime() <= at);
    return i === -1 ? reversed.length : i;
  }, [hasBrief, briefDate, reversed]);

  // Pastille de date au-dessus du premier element affiche de chaque jour
  // (messages ET note IA, dans l'ordre d'affichage).
  const dayPillIds = useMemo(() => {
    const ids = new Set<string>();
    let lastDay = "";
    const visit = (id: string, date: Date) => {
      const day = isNaN(date.getTime()) ? "" : date.toDateString();
      if (day && day !== lastDay) ids.add(id);
      lastDay = day;
    };
    for (const d of sortedDrafts) visit(d.id, new Date(d.date));
    reversed.forEach((m, i) => {
      if (i === briefIndex) visit(BRIEF_ITEM_ID, briefDate ?? new Date());
      visit(m.id, new Date(m.date));
    });
    if (briefIndex === reversed.length) visit(BRIEF_ITEM_ID, briefDate ?? new Date());
    return ids;
  }, [sortedDrafts, reversed, briefIndex, briefDate]);
  const dayPill = (m: Pick<Message, "id" | "date">) => {
    if (!dayPillIds.has(m.id)) return null;
    const d = new Date(m.date);
    const label = isToday(d)
      ? t("calendar.today")
      : isYesterday(d)
        ? t("thread.yesterday")
        : format(d, "EEE d MMM yyyy", { locale: fr });
    return <DatePill key={`day-${m.id}`}>{label}</DatePill>;
  };

  // Series facon messagerie : sur la suite AFFICHEE du fil (le bloc des
  // brouillons en tete coupe la serie), un message qui suit un message de la meme adresse le
  // meme jour ne repete ni l'avatar ni le nom.
  const seriesContinuations = useMemo(() => {
    const entries: SeriesEntry[] = [];
    if (sortedDrafts.length > 0) entries.push({ kind: "break" });
    reversed.forEach((m, i) => {
      // La note IA intercalee coupe une serie.
      if (i === briefIndex) entries.push({ kind: "break" });
      entries.push({
        kind: "message",
        id: m.id,
        sender: m.from_address?.address || "",
        date: m.date,
        open: true,
      });
    });
    return computeSeriesContinuations(entries);
  }, [reversed, sortedDrafts.length, briefIndex]);

  // Compte d'envoi : signale seulement quand l'utilisateur a ecrit depuis au
  // moins DEUX de ses adresses dans ce fil (brouillons exclus). Pastille de la
  // couleur choisie pour le compte + son nom ; adresse hors comptes = elle-meme,
  // pastille grise.
  const senderAccountById = useMemo(() => {
    const map = new Map<string, { label: string; color: string | null }>();
    const own = fullMessages.filter((m) => !m.is_draft && isOwnMessage(m));
    const addresses = new Set(
      own.map((m) => m.from_address?.address?.toLowerCase() || "").filter(Boolean)
    );
    if (addresses.size < 2) return map;
    for (const m of own) {
      const from = m.from_address?.address?.toLowerCase() || "";
      const acc = from
        ? accs.find((a) => a.email?.toLowerCase() === from)
        : accs.find((a) => a.id === m.account);
      if (acc) {
        map.set(m.id, { label: acc.label || acc.display_name || acc.email, color: acc.color || null });
      } else if (from) {
        map.set(m.id, { label: m.from_address?.address || from, color: null });
      }
    }
    return map;
  }, [fullMessages, isOwnMessage, accs]);

  // Faire defiler le fil jusqu'a un element (message, note IA)
  const scrollToSelector = useCallback(
    (selector: string, behavior: ScrollBehavior = "smooth") => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const el = container.querySelector(selector);
      if (!el) return;
      // Barre flottante de l'auteur : posee par-dessus le haut du fil (hors du
      // defilement), on garde sa hauteur + ses marges libres au-dessus du
      // message vise.
      const stickyEl = container.parentElement?.querySelector<HTMLElement>("[data-ref='thread-sticky-headers']");
      // (Le bandeau de suivi est dans le flux, en tete du fil : rien a reserver.)
      const stickyHeight = stickyEl ? stickyEl.offsetHeight + 16 : 0;
      // Ordinateur : l'en-tete du fil est colle en haut du defilement.
      const headerEl = container.querySelector<HTMLElement>("[data-ref='thread-header']");
      const headerHeight =
        headerEl && getComputedStyle(headerEl).position === "sticky" ? headerEl.offsetHeight : 0;
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const offset = elRect.top - containerRect.top + container.scrollTop - stickyHeight - headerHeight;
      container.scrollTo({ top: offset, behavior });
    },
    []
  );
  const scrollToMessage = useCallback(
    (messageId: string, behavior: ScrollBehavior = "smooth") =>
      scrollToSelector(`[data-message-id="${messageId}"]`, behavior),
    [scrollToSelector]
  );

  // Une generation terminee : on amene la note (bulle du fil) a l'ecran.
  const wasGeneratingRef = useRef(false);
  useEffect(() => {
    if (wasGeneratingRef.current && !brief.generating && brief.content) {
      setTimeout(() => scrollToSelector("[data-ref='thread-brief-bubble']"), 100);
    }
    wasGeneratingRef.current = brief.generating;
  }, [brief.generating, brief.content, scrollToSelector]);

  // Laisse le fil se poser (chargement cross-dossier, mise en page) avant de
  // defiler.
  const scrollToMessageSoon = useCallback(
    (messageId: string) => {
      setTimeout(() => scrollToMessage(messageId), 300);
    },
    [scrollToMessage]
  );

  // Saut depuis un resultat de recherche : scroller sur le message qui
  // matche (sauf s'il est deja le plus recent, en tete). Aucun surlignage
  // visuel : le fond gris arrondi posait un "fond fantome" retire a la demande.
  useEffect(() => {
    if (!searchMatchMessageId) return;
    if (!reversed.some((m) => m.id === searchMatchMessageId)) return;
    if (reversed[0]?.id === searchMatchMessageId) return;
    scrollToMessageSoon(searchMatchMessageId);
  }, [searchMatchMessageId, reversed, scrollToMessageSoon]);

  // --- Sticky headers via JS scroll detection ---
  // Un seul header sticky empile a la fois (au-dela ca mange l'ecran sur mobile).
  const MAX_STICKY = 1;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [stickyIds, setStickyIds] = useState<string[]>([]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Ordinateur : ce qui passe sous l'en-tete colle est deja "au-dessus".
      const header = container.querySelector<HTMLElement>("[data-ref='thread-header']");
      const headerOffset =
        header && getComputedStyle(header).position === "sticky" ? header.offsetHeight : 0;
      const containerTop = container.getBoundingClientRect().top + headerOffset;
      const items = container.querySelectorAll("[data-message-id]");

      const above: string[] = [];
      items.forEach((el) => {
        if (el.getBoundingClientRect().top < containerTop) {
          const id = el.getAttribute("data-message-id");
          if (id) above.push(id);
        }
      });

      const last = above.slice(-MAX_STICKY);
      setStickyIds((prev) => {
        if (prev.length === last.length && prev.every((id, i) => id === last[i])) return prev;
        return last;
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [fullMessages]);

  const stickyMessages = useMemo(
    () => stickyIds.map((id) => fullMessages.find((m) => m.id === id)).filter(Boolean) as Message[],
    [stickyIds, fullMessages]
  );

  const paneRef = useRef<HTMLDivElement>(null);

  // Ordinateur : l'en-tete du fil est COLLE en haut du defilement (md:sticky) ;
  // la barre flottante de l'auteur se pose juste dessous. Sa hauteur suit le
  // rendu (titre sur une ligne, echelle d'interface).
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () =>
      setHeaderHeight(getComputedStyle(el).position === "sticky" ? el.offsetHeight : 0);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  // Dossier du dernier message (ligne "Dossier" des Details).
  const allFolders = useFoldersAll().folders;
  const folderInfo = useMemo(() => {
    const f = allFolders.find((x) => x.id === threadMeta.lastMessage.folder);
    if (!f) return null;
    const system = ["inbox", "sent", "drafts", "trash", "spam", "archive"].includes(f.type);
    return {
      label: system ? t(`folder.${f.type}`) : f.name,
      path: system ? `/mail/${f.type}` : `/mail/${f.id}`,
    };
  }, [allFolders, threadMeta.lastMessage.folder, t]);

  // Archiver depuis les Details : toutes les copies du fil de la vue, un seul
  // toast, puis retour a la liste.
  const { archiveMessage } = useMessageActions();
  const handleArchiveThread = useCallback(async () => {
    closeThreadDetails();
    useMailStore.getState().requestCloseThread();
    for (const m of thread.messages) {
      await archiveMessage(m.id, { silent: true });
    }
    toast.success(tStatic("message.archived"));
  }, [thread.messages, archiveMessage]);

  // Menu ⋮ du fil : MEME liste que le menu de la liste (useConversationActions,
  // source unique). Les volets (suivi, suivi de lecture, recapitulatif)
  // s'ouvrent apres la fermeture du menu (tiroir sur telephone).
  const openPanel = useCallback((panel: ConversationPanel) => {
    if (panel === "tracking") setTrackingOpen(true);
    else if (panel === "readReceipts") setReceiptsOpen(true);
    else setBriefOpen(true);
  }, []);
  const convo = useConversationActions({
    message: threadMeta.lastMessage,
    threadMessages: fullMessages,
    starCopies: rawMessages,
    isMobile,
    openPanel,
    onReply: () => {
      if (existingDraft) openCompose("edit", existingDraft.id);
      else openCompose("reply", replyTarget.id);
    },
    replyTarget,
    onArchive: () => void handleArchiveThread(),
    state: { tracked: isTracked, hasOpens, hasBrief },
  });
  const threadActions = convo.rows;

  // Volet demande depuis le menu de la LISTE (la ligne a ouvert ce fil).
  const panelRequest = useThreadPanelRequest((s) => s.request);
  useEffect(() => {
    if (!panelRequest) return;
    // Demande perimee (fil jamais ouvert, ex. brouillon) : ignoree.
    if (Date.now() - panelRequest.at > 8000) {
      useThreadPanelRequest.getState().clear();
      return;
    }
    const ids = new Set(panelRequest.ids);
    const matches =
      ids.has(thread.id) ||
      convoThreadIds.some((id) => ids.has(id)) ||
      thread.messages.some((m) => ids.has(m.id));
    if (!matches) return;
    useThreadPanelRequest.getState().clear();
    openPanel(panelRequest.panel);
  }, [panelRequest, thread.id, thread.messages, convoThreadIds, openPanel]);

  const briefNode = hasBrief ? (
    <div key={BRIEF_ITEM_ID} className="contents">
      {dayPill({ id: BRIEF_ITEM_ID, date: (briefDate ?? new Date()).toISOString() })}
      <ThreadBriefBubble content={brief.content} generatedAt={briefDate} />
    </div>
  ) : null;

  return (
    <div ref={paneRef} data-ref="thread-pane" className="group/pane relative h-full bg-background">
      {/* Auteur du message en cours de lecture : barre FLOTTANTE aux coins
          arrondis, posee par-dessus le haut du fil (hors du defilement : elle
          ne decale pas le contenu en apparaissant). Toucher = revenir en tete
          de ce message. */}
      {/* Apparence Miel : bandeau de l'auteur retire (choix utilisateur, carte
          « Finitions Miel ») ; le fil s'efface sous l'en-tete dans un fondu. */}
      {!isMiel && stickyMessages.length > 0 && (
        <div
          data-ref="thread-sticky-headers"
          className="pointer-events-none absolute inset-x-2 top-2 z-20 md:inset-x-4"
          style={headerHeight ? { top: headerHeight + 8 } : undefined}
        >
          {stickyMessages.map((msg) => {
            const name = msg.from_address?.name || msg.from_address?.address || "";
            const email = msg.from_address?.address || "";
            return (
              <button
                key={msg.id}
                type="button"
                onClick={() => scrollToMessage(msg.id)}
                data-ref="thread-sticky-author"
                className="pointer-events-auto flex w-full items-center gap-2.5 rounded-2xl border border-border bg-background/90 py-1.5 pr-3 pl-1.5 text-sm shadow-md shadow-black/10 backdrop-blur-md animate-in fade-in-0 slide-in-from-top-1 duration-150 supports-[backdrop-filter]:bg-background/75"
              >
                <ContactAvatar
                  name={name}
                  email={email}
                  className="size-7 shrink-0"
                  textClassName="text-[10px]"
                />
                <span className="truncate font-medium">{name}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {formatRelativeDate(msg.date)}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div
        ref={scrollContainerRef}
        className="absolute inset-0 overflow-y-auto overscroll-contain"
      >
        <div className="flex min-h-full flex-col">
        <div className="overflow-clip bg-background">
        {/* Bandeau "N'est pas un spam" */}
        {isInSpam && (
          <div className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={async () => {
                // Ne deplacer que les copies actuellement dans le dossier spam
                // (fullMessages est cross-folder : inclut sent/inbox/all mail).
                // Tenter de PATCH une copie hors spam declenche un 500 PB.
                // Toast unique : chaque deplacement individuel reste muet.
                for (const msg of thread.messages) {
                  await moveToInbox(msg.id, { silent: true });
                }
                toast.success(tStatic("message.movedToInbox"));
              }}
            >
              <ShieldAlert className="mr-1.5 size-3.5" />
              {t("message.notSpam")}
            </Button>
          </div>
        )}

        {/* En-tete du fil (charte) : visages des participants et sujet (vers
            les Details de la conversation), puis l'etoile de la conversation.
            Sur telephone, quand la page porte deja cet en-tete dans son tiroir,
            il n'est rendu que sur ordinateur. */}
        <div
          ref={headerRef}
          data-ref="thread-header"
          className={cn(
            "border-b border-border bg-background md:sticky md:top-0 md:z-30",
            embeddedHeader && "hidden md:block"
          )}
        >
          <div className="flex min-h-12 min-w-0 items-center gap-2.5 py-2 pr-2 pl-4 md:pr-3 md:pl-5">
            <ParticipantStack details={threadMeta.participantDetails} onClick={openDetailsPeople} />
            <button
              type="button"
              onClick={openDetails}
              className="flex min-w-0 flex-1 flex-col text-left"
              data-ref="thread-header-title"
            >
              <h2
                data-ref="thread-header-subject"
                className="truncate text-base leading-tight font-semibold"
                title={headerSubject}
              >
                {headerSubject}
              </h2>
              <span data-ref="thread-header-meta" className="truncate text-sm text-muted-foreground">
                {crossFolderLoaded ? (
                  <>
                    {participantsLabel}
                    <span className="hidden md:inline">
                      {" "}&middot; {fullMessages.length} {fullMessages.length > 1 ? t("thread.messages") : t("thread.message")}
                    </span>
                  </>
                ) : (
                  <Skeleton className="inline-block h-3.5 w-28 align-middle" />
                )}
              </span>
            </button>
            {/* Toutes les actions du fil dans UN menu (choix utilisateur
                2026-10-20) : l'ancien onglet Options des Details et les quatre
                icones du haut (suivi de lecture, suivi, note, favori). */}
            <ThreadActionsMenu actions={threadActions} isMobile={false} />
          </div>
        </div>

        {/* Bandeau de suivi : la conversation est suivie -> titre de la fiche et
            son etat ; un appui ouvre le tiroir de suivi. Rendu HORS de
            l'en-tete (visible aussi sur telephone, ou l'en-tete vit dans le
            tiroir de lecture). DANS LE FLUX, en tete du fil (choix
            utilisateur, carte 7fe69814) : il part avec le defilement et n'est
            visible qu'en haut de la conversation -> il ne recouvre jamais un
            message ; la barre de l'auteur reste en top-2 et scrollToMessage ne
            reserve pas sa hauteur. Ne PAS le remettre en sticky. */}
        {isTracked && (
          <div data-ref="thread-tracking-float" className="mx-2 my-2 md:mx-4">
            <button
              type="button"
              onClick={() => setTrackingOpen(true)}
              data-ref="thread-tracking-bar"
              title={t("tracking.barOpen")}
              aria-expanded={trackingOpen}
              className="flex h-10 w-full min-w-0 items-center gap-2.5 rounded-2xl border border-border bg-background/90 pr-2.5 pl-3 text-left text-sm shadow-md shadow-black/10 backdrop-blur-md transition-colors hover:bg-accent supports-[backdrop-filter]:bg-background/75"
            >
              <PackageSearch className="size-4 shrink-0 text-tracking" />
              <span data-ref="thread-tracking-bar-title" className="min-w-0 flex-1 truncate font-medium">
                {trackingItem?.title || t("tracking.title")}
              </span>
              {trackingItem ? (
                <StatusPill
                  variant="outline"
                  data-ref="thread-tracking-bar-status"
                  className="h-6 max-w-[45%] min-w-0 px-2.5 text-xs"
                >
                  <span className="truncate">
                    {trackingItem.status_label ||
                      (trackingClosed ? t("tracking.statusDone") : t("tracking.statusOpen"))}
                  </span>
                </StatusPill>
              ) : trackingItemLoading ? (
                <Skeleton className="h-6 w-24 shrink-0 rounded-full" />
              ) : null}
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </div>
        )}

        {/* Suivi de la conversation - tiroir ouvert par le bouton PackageSearch
            ou le bandeau (par-dessus le contenu : plein ecran mobile, confine au
            pane desktop) */}
        <ThreadTrackingPanel
          open={trackingOpen}
          onClose={() => setTrackingOpen(false)}
          item={trackingItem}
          loading={trackingItemLoading}
          isTracked={isTracked}
          busy={trackBusy}
          onToggle={handleToggleTracking}
          containerRef={isMobile ? undefined : paneRef}
        />

        {/* Suivi de lecture - tiroir ouvert par le bouton CheckCheck : timeline
            Envoye -> Lu -> Relu de chaque message (pixel de tracking) */}
        <ReadReceiptsPanel
          open={receiptsOpen}
          onClose={() => setReceiptsOpen(false)}
          messages={fullMessages}
          userEmails={userEmails}
          receipts={receipts}
          loading={receiptsLoading}
          containerRef={isMobile ? undefined : paneRef}
        />

        {/* Module de generation de la note IA - entre l'en-tete et le premier
            message ; la note elle-meme est une bulle du fil (ThreadBriefBubble). */}
        {convo.dialogs}

        <ThreadBriefPanel
          brief={brief}
          generatedAt={briefDate}
          open={briefOpen}
          onClose={() => setBriefOpen(false)}
        />

        {/* Messages du fil, tous ouverts. Conteneur de requete (@container),
            garde pour des mesures en cqw (la colonne des messages n'en depend plus). */}
        <div className="@container">
        <div data-ref="thread-messages" className="py-2">
          {/* Brouillons : en tete du fil, le plus recent d'abord */}
          {sortedDrafts.map((d) => (
            <div key={d.id} className="contents">
              {dayPill(d)}
              <MessageAccordion message={d} draft isMine onOpenDraft={openDraft} />
            </div>
          ))}
          {reversed.map((message, i) => (
            <div key={message.id} className="contents">
              {i === briefIndex && briefNode}
              {dayPill(message)}
              <MessageAccordion
                message={message}
                receipts={isOwnMessage(message) ? receiptsById.get(message.id) ?? [] : null}
                onViewsOpenChange={handleViewsOpenChange}
                isMine={isOwnMessage(message)}
                isConversationOpener={message.id === openerId}
                seriesContinuation={seriesContinuations.has(message.id)}
                senderAccount={senderAccountById.get(message.id) ?? null}
                myEmails={userEmails}
              />
            </div>
          ))}
          {briefIndex === reversed.length && briefNode}
        </div>
        </div>
        </div>

        {/* Pieces jointes + reponse : suit le contenu sur mobile, reste en bas sur desktop */}
        <div className="sticky kb-sticky-bottom z-10 mt-auto flex flex-col border-t border-border">
          <div data-ref="thread-reply" className="bg-background px-3 pt-2 pb-[max(0.625rem,env(safe-area-inset-bottom))] md:px-5 md:pb-3">
            {draftChecked && (
              <button
                type="button"
                onClick={handleReplyClick}
                data-ref="thread-reply-open"
                className="relative flex h-10 w-full min-w-0 items-center gap-2 rounded-full border border-border bg-background px-4 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50"
              >
                <span className="min-w-0 flex-1 truncate">
                  {existingDraft ? t("thread.draftOpen") : replyPlaceholder}
                </span>
                {existingDraft && (
                  <span className="bg-primary size-2 shrink-0 rounded-full" aria-hidden />
                )}
              </button>
            )}
          </div>
        </div>
        </div>
      </div>

      {headerActionsSlot &&
        createPortal(<ThreadActionsMenu actions={threadActions} isMobile={isMobile} />, headerActionsSlot)}

      {/* Details de la conversation : tiroir glissable sur telephone, panneau
          a droite (dans le fil) sur ordinateur. */}
      <ThreadDetailsPanel
        open={detailsOpen}
        onClose={closeThreadDetails}
        isMobile={isMobile}
        subject={headerSubject}
        participants={threadMeta.participantDetails}
        messages={fullMessages}
        firstMessage={fullMessages[0]}
        lastMessage={fullMessages[fullMessages.length - 1]}
        folderLabel={folderInfo?.label}
        folderPath={folderInfo?.path}
        threadId={briefThreadId}
        myEmails={userEmails}
        requestedTab={hashParams.get("cdt")}
        briefContent={brief.content}
        briefGeneratedAt={brief.generatedAt}
        trackingItem={trackingItem}
        onScrollToMessage={(id) => {
          closeThreadDetails();
          setTimeout(() => scrollToMessageSoon(id), 350);
        }}
        onBrief={() => {
          closeThreadDetails();
          setTimeout(() => setBriefOpen(true), 350);
        }}
      />
    </div>
  );
}

/**
 * Bouton ⋮ en haut a droite du fil : memes lignes que le menu de la liste
 * (useConversationActions, choix utilisateur 2026-10-21), separateurs compris.
 * Ordinateur : menu deroulant ; telephone (porte par `headerActionsSlot` du
 * tiroir de conversation) : petit tiroir du bas, poignee seule (handleOnly) et
 * son propre RemoveScroll, comme les autres menus du telephone.
 */
export function ThreadActionsMenu({ actions, isMobile }: { actions: MenuRow[]; isMobile: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label = t("thread.actions");
  const trigger = (
    <IconCircleButton
      plain
      className="size-9"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={open}
      data-ref="thread-actions-menu"
      onClick={isMobile ? () => setOpen(true) : undefined}
    >
      <EllipsisVertical className="size-5" strokeWidth={1.8} />
    </IconCircleButton>
  );
  if (isMobile) {
    return (
      <>
        {trigger}
        <Drawer open={open} onOpenChange={setOpen} repositionInputs={false} noBodyStyles handleOnly>
          <DrawerContent hideGrip className="drawer-scroll-native sheet-max-h" data-ref="thread-actions-sheet">
            <DrawerSheetHeader title={label} handleDataRef="thread-actions-handle" />
            <RemoveScroll removeScrollBar={false} allowPinchZoom className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2 pb-[max(1rem,env(safe-area-inset-bottom))] [&>*]:shrink-0">
                {actions.map((a) =>
                  a.type === "separator" ? (
                    <div key={a.key} className="bg-border my-1 h-px" aria-hidden />
                  ) : a.type !== "item" ? null : (
                  <button
                    key={a.key}
                    type="button"
                    disabled={a.disabled}
                    onClick={() => {
                      setOpen(false);
                      a.onSelect();
                    }}
                    className={cn(
                      "flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors active:bg-muted disabled:opacity-50",
                      a.active && "font-semibold"
                    )}
                    data-ref={`thread-actions-${a.key}`}
                  >
                    <a.Icon className={cn("size-4 shrink-0", a.iconClassName ?? "text-muted-foreground")} />
                    {a.label}
                  </button>
                  )
                )}
              </div>
            </RemoveScroll>
          </DrawerContent>
        </Drawer>
      </>
    );
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[60] min-w-56" data-ref="thread-actions-list">
        {actions.map((a) =>
          a.type === "separator" ? (
            <DropdownMenuSeparator key={a.key} />
          ) : a.type !== "item" ? null : (
            <DropdownMenuItem
              key={a.key}
              disabled={a.disabled}
              onSelect={() => a.onSelect()}
              className={cn(a.active && "font-semibold")}
              data-ref={`thread-actions-${a.key}`}
            >
              <a.Icon className={cn(a.iconClassName)} />
              {a.label}
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Visages empiles des participants (deux au plus, puis "+N") ; touchables
 * vers les Details de la conversation quand `onClick` est fourni. */
export function ParticipantStack({ details, onClick }: { details: ParticipantDetail[]; onClick?: () => void }) {
  const t = useT();
  const shown = details.slice(0, 2);
  const extra = details.length - shown.length;
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      {...(onClick ? { type: "button" as const, onClick, "aria-label": t("thread.detailsTitle") } : {})}
      className="flex shrink-0 items-center -space-x-2"
      data-ref="thread-header-avatars"
    >
      {shown.map((p) => (
        <ContactAvatar
          key={p.address || p.name}
          name={p.name || p.address}
          email={p.address}
          className="size-7 ring-2 ring-background"
          textClassName="text-[10px]"
        />
      ))}
      {extra > 0 && (
        <span className="relative inline-flex size-7 items-center justify-center rounded-full bg-muted text-xs font-medium ring-2 ring-background">
          +{extra}
        </span>
      )}
    </Wrapper>
  );
}

interface ThreadViewProps {
  threads?: Thread[];
  loading?: boolean;
  getThread?: (threadId: string) => Thread | undefined;
  hideAttachments?: boolean;
  // Mode controle : impose la conversation a afficher (par message ou par
  // thread) sans dependre de la navigation mail globale du store (ex: apercu
  // d'un mail depuis le Suivi). Si l'un des deux est fourni, la selection du
  // store est ignoree.
  messageId?: string | null;
  threadId?: string | null;
  // Tiroir "..." mobile pilote par le parent (bouton dans son entete). Sans
  // ces props, ThreadView garde son propre bouton dans sa rangee d'actions.
  headerActionsSlot?: HTMLElement | null;
  /** Le tiroir du telephone porte deja l'en-tete du fil (visages, titre). */
  embeddedHeader?: boolean;
}

/**
 * Conversation d'un fil ou d'un message : cherchee d'abord dans les donnees
 * locales (`getThread` / `threads`), sinon chargee depuis PocketBase. Partagee
 * par ThreadView et par l'en-tete du tiroir de conversation du telephone
 * (MobileThreadDrawer), qui doit afficher le sujet meme quand le fil ouvert
 * n'est pas dans la liste chargee (vue d'ensemble, newsletters, suivi...).
 */
export function useThreadWithFallback({
  threadId,
  messageId,
  threads,
  getThread,
}: {
  threadId: string | null;
  messageId: string | null;
  threads: Thread[];
  getThread: (threadId: string) => Thread | undefined;
}): Thread | null {
  // Fallback : charger le thread depuis PB si non trouve localement
  const [fallbackThread, setFallbackThread] = useState<Thread | null>(null);
  const fallbackKeyRef = useRef<string>("");

  // Chercher le thread localement
  const localThread =
    (threadId ? getThread(threadId) : undefined) ??
    (messageId ? threads.find((t) => t.messages.some((m) => m.id === messageId)) : undefined);

  // Fallback fetch quand le thread n'est pas dans les donnees locales
  useEffect(() => {
    const key = `${threadId ?? ""}|${messageId ?? ""}`;
    if (localThread || (!threadId && !messageId)) {
      fallbackKeyRef.current = "";
      setFallbackThread(null);
      return;
    }
    if (key === fallbackKeyRef.current) return;
    fallbackKeyRef.current = key;

    let cancelled = false;

    const fetchThread = async () => {
      try {
        let threadMsgs: Message[];
        if (threadId) {
          threadMsgs = await messages().getFullList<Message>({
            filter: `thread_id = "${threadId.replace(/"/g, '\\"')}" && is_draft = false`,
            sort: "date",
          });
        } else if (messageId) {
          const msg = await messages().getOne<Message>(messageId);
          if (msg.thread_id) {
            threadMsgs = await messages().getFullList<Message>({
              filter: `thread_id = "${msg.thread_id.replace(/"/g, '\\"')}" && is_draft = false`,
              sort: "date",
            });
          } else {
            threadMsgs = [msg];
          }
        } else {
          return;
        }
        if (cancelled || threadMsgs.length === 0) return;
        setFallbackThread(buildThread(threadMsgs));
      } catch {
        // Ignorer les erreurs de fetch
      }
    };

    fetchThread();
    return () => { cancelled = true; };
  }, [threadId, messageId, localThread]);

  return localThread ?? fallbackThread;
}

export function ThreadView(props: ThreadViewProps = {}) {
  const storeThreadId = useMailStore((s) => s.selectedThreadId);
  const storeMessageId = useMailStore((s) => s.selectedMessageId);
  const controlled = props.messageId !== undefined || props.threadId !== undefined;
  const selectedThreadId = controlled ? (props.threadId ?? null) : storeThreadId;
  const selectedMessageId = controlled ? (props.messageId ?? null) : storeMessageId;

  // Utiliser les props du parent si fournies, sinon fallback sur useThreads interne
  const hasExternalData = props.threads !== undefined;
  const internal = useThreads({ enabled: !hasExternalData });
  const threads = hasExternalData ? props.threads! : internal.threads;
  const loading = props.loading ?? internal.loading;
  const getThread = props.getThread ?? internal.getThread;

  const resolvedThread = useThreadWithFallback({
    threadId: selectedThreadId,
    messageId: selectedMessageId,
    threads,
    getThread,
  });

  if (loading && threads.length === 0) {
    return <ThreadViewSkeleton />;
  }

  if (!selectedThreadId && !selectedMessageId) {
    return <ThreadViewEmpty />;
  }

  const thread = resolvedThread;

  if (!thread) {
    // En attente du fallback fetch
    if (selectedThreadId || selectedMessageId) {
      return <ThreadViewSkeleton />;
    }
    return <ThreadViewEmpty />;
  }

  return (
    <ThreadViewInner
      key={selectedThreadId ?? thread.id}
      thread={thread}
      hideAttachments={props.hideAttachments}
      headerActionsSlot={props.headerActionsSlot}
      embeddedHeader={props.embeddedHeader}
    />
  );
}

interface ParticipantsPopoverProps {
  details: ParticipantDetail[];
  children: React.ReactNode;
}

export function ParticipantsPopover({ details, children }: ParticipantsPopoverProps) {
  const t = useT();
  const interlocutors = details.filter((d) => d.role === "interlocutor");
  const ccList = details.filter((d) => d.role === "cc");

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="px-3 py-2 text-xs font-semibold text-muted-foreground">
          {t("thread.participants")} ({details.length})
        </div>
        <Separator />
        <div className="max-h-60 overflow-y-auto">
          {interlocutors.length > 0 && (
            <div className="px-3 py-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("thread.interlocutor")}{interlocutors.length > 1 ? "s" : ""}
              </span>
              <ul className="mt-1 space-y-1">
                {interlocutors.map((p) => (
                  <li key={p.address} className="flex items-center gap-2 text-sm">
                    <ContactAvatar
                      name={p.name}
                      email={p.address}
                      className="size-6 shrink-0"
                      textClassName="text-[10px]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{p.name}</div>
                      {p.name !== p.address && (
                        <div className="truncate text-[10px] text-muted-foreground">{p.address}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ccList.length > 0 && (
            <div className="px-3 py-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("thread.cc")}
              </span>
              <ul className="mt-1 space-y-1">
                {ccList.map((p) => (
                  <li key={p.address} className="flex items-center gap-2 text-sm">
                    <ContactAvatar
                      name={p.name}
                      email={p.address}
                      className="size-6 shrink-0"
                      textClassName="text-[10px]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{p.name}</div>
                      {p.name !== p.address && (
                        <div className="truncate text-[10px] text-muted-foreground">{p.address}</div>
                      )}
                    </div>
                    <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[9px]">CC</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
