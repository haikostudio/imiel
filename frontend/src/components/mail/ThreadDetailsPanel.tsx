"use client";

import { useState } from "react";
import { toast } from "sonner";
import { RemoveScroll } from "react-remove-scroll";
import {
  Archive,
  CalendarDays,
  CheckCheck,
  Clock,
  Copy,
  Folder,
  Forward,
  MessageSquareText,
  MessagesSquare,
  MoreHorizontal,
  PackageSearch,
  PenSquare,
  Reply,
  ReplyAll,
  StickyNote,
  Tag,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { fr } from "date-fns/locale";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InfoRow, Surface } from "@/components/ui/kit";
import { ContactAvatar } from "@/components/mail/ContactAvatar";
import { ThreadAttachments } from "@/components/mail/ThreadAttachments";
import { ThreadLabelsBar } from "@/components/mail/ThreadLabelsBar";
import { ThreadAnalysisTab } from "@/components/mail/ThreadAnalysisTab";
import { hashBack, hashNavigate, hashSetParams } from "@/lib/hash-router";
import { useMailStore } from "@/lib/stores/mail-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ParticipantDetail } from "@/lib/hooks/useThreads";
import type { Message, TrackingItem } from "@/lib/pocketbase";

// L'ecran Details vit dans l'ADRESSE (`?cd=<fil>`, `&cdt=<onglet>` quand un
// onglet est impose) : "precedent" et le rechargement retombent dessus. Ouvrir
// EMPILE une entree ; fermer revient en arriere quand c'est nous qui l'avons
// empilee, sinon retire les parametres.
let detailsPushed = false;

// Plus d'onglet "Options" (choix utilisateur 2026-10-20) : ses actions vivent
// dans le menu ⋮ du fil. Une ancienne valeur "options" retenue sur l'appareil
// ou dans l'adresse (&cdt=options) n'est plus reconnue -> Infos.
export type DetailsTab = "info" | "attachments" | "people" | "analysis";
const DETAILS_TABS: DetailsTab[] = ["info", "attachments", "people", "analysis"];

function isDetailsTab(value: string | null | undefined): value is DetailsTab {
  return !!value && (DETAILS_TABS as string[]).includes(value);
}

// Dernier onglet CHOISI dans la barre, retenu sur l'appareil (pas de compte :
// chaque appareil a ses habitudes). Ouvrir par les visages n'y touche pas.
const TAB_STORAGE_KEY = "imiel:thread-details-tab";

function readStoredTab(): DetailsTab {
  try {
    const v = window.localStorage.getItem(TAB_STORAGE_KEY);
    return isDetailsTab(v) ? v : "info";
  } catch {
    return "info";
  }
}

function storeTab(tab: DetailsTab) {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    /* stockage indisponible (navigation privee) */
  }
}

function currentDetailsParam(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.hash.split("?")[1] || "").get("cd");
}

/** Ouvre les Details d'un fil. Sans `tab` : le dernier onglet choisi (Infos la
 * premiere fois) ; avec `tab` (ex. "people" depuis les visages) : cet onglet,
 * sans changer l'onglet retenu. */
export function openThreadDetails(threadId: string, tab?: DetailsTab) {
  if (currentDetailsParam() === threadId) return;
  detailsPushed = true;
  hashSetParams({ cd: threadId, cdt: tab ?? null });
}

export function closeThreadDetails() {
  if (!currentDetailsParam()) return;
  if (detailsPushed) {
    detailsPushed = false;
    hashBack();
    return;
  }
  hashSetParams({ cd: null, cdt: null }, { replace: true });
}

/** "jeu. 15 oct. 2026, 10:25" ; "Aujourd'hui, 17:57" ; "Hier, 17:57". */
export function formatDetailDate(date: string, t: (k: string) => string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  const time = format(d, "HH:mm", { locale: fr });
  if (isToday(d)) return `${t("calendar.today")}, ${time}`;
  if (isYesterday(d)) return `${t("thread.yesterday")}, ${time}`;
  return `${format(d, "EEE d MMM yyyy", { locale: fr })}, ${time}`;
}

export interface ThreadDetailsPanelProps {
  open: boolean;
  onClose: () => void;
  isMobile: boolean;
  subject: string;
  participants: ParticipantDetail[];
  messages: Message[];
  firstMessage?: Message;
  lastMessage?: Message;
  folderLabel?: string;
  folderPath?: string;
  threadId: string;
  myEmails: Set<string>;
  /** Onglet impose par l'adresse (`cdt`), sinon le dernier choisi. */
  requestedTab?: string | null;
  /** Onglet Analyse : note IA (HTML) et sa date de generation. */
  briefContent?: string;
  briefGeneratedAt?: string | null;
  /** Onglet Analyse : fiche de suivi du fil (deja chargee par le fil). */
  trackingItem?: TrackingItem | null;
  onScrollToMessage: (id: string) => void;
  onBrief: () => void;
}

/**
 * Ecran "Details de la conversation" : sous le titre, une barre d'onglets FIXE
 * (Infos, Pieces jointes, Interlocuteurs, Options, Analyse) ; seul l'onglet choisi
 * s'affiche et defile dessous. Infos = valeurs sous leurs libelles ; Pieces
 * jointes = vignettes des images puis liste ; Interlocuteurs = participants et
 * leur menu ; Options = toutes les actions en liste (plus de "Plus
 * d'actions") ; Analyse = note IA, suivi, echeances, etiquettes et fiche "Ce
 * que l'IA sait" de chaque interlocuteur (ThreadAnalysisTab, monte seulement
 * quand l'onglet est choisi). TIROIR VENU DU BAS partout, qui ne glisse que par
 * sa prise (poignee + titre, vaul `handleOnly`), avec son propre verrou de
 * defilement (au telephone il s'ouvre par-dessus le tiroir MODAL de la
 * conversation) ; le fermer d'un glissement passe par onClose (retire ?cd= de
 * l'adresse). Telephone : pleine hauteur sous la barre d'etat. Ordinateur :
 * centre et borne en largeur comme ResponsivePanel, jamais un volet a droite.
 */
export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const { open, onClose, isMobile } = props;
  const t = useT();

  const body = <ThreadDetailsBody {...props} />;

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => !o && onClose()}
      repositionInputs={false}
      noBodyStyles
      handleOnly
    >
      <DrawerContent
        hideGrip
        className={cn(
          "drawer-scroll-native flex flex-col overflow-hidden",
          isMobile
            ? "top-[var(--app-top)] mt-0"
            : "mx-auto h-[calc(var(--app-height,100dvh)*0.9)] w-full max-w-[790px]"
        )}
        data-ref="thread-details"
      >
        <DrawerSheetHeader
          title={t("thread.detailsTitle")}
          handleDataRef="thread-details-handle"
        />
        <RemoveScroll removeScrollBar={false} allowPinchZoom className="flex min-h-0 flex-1 flex-col">
          {body}
        </RemoveScroll>
      </DrawerContent>
    </Drawer>
  );
}

function ThreadDetailsBody({
  open,
  subject,
  participants,
  messages,
  firstMessage,
  lastMessage,
  folderLabel,
  folderPath,
  threadId,
  myEmails,
  requestedTab,
  onScrollToMessage,
  onBrief,
  briefContent = "",
  briefGeneratedAt,
  trackingItem = null,
}: ThreadDetailsPanelProps) {
  const t = useT();
  const openCompose = useMailStore((s) => s.openCompose);

  // Onglet affiche : a chaque OUVERTURE, celui qu'impose l'adresse (visages ->
  // Interlocuteurs) ou le dernier choisi dans la barre (Infos la premiere
  // fois). Etat ajuste pendant le rendu, pas dans un effet.
  const openKey = open ? `open:${requestedTab ?? ""}` : null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailsTab>("info");
  if (openKey !== shownFor) {
    setShownFor(openKey);
    if (openKey) setTab(isDetailsTab(requestedTab) ? requestedTab : readStoredTab());
  }
  const chooseTab = (next: DetailsTab) => {
    setTab(next);
    storeTab(next);
  };

  // Participants : interlocuteurs puis copies, sans doublon d'adresse.
  const seen = new Set<string>();
  const people = participants.filter((p) => {
    const key = (p.address || p.name).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("tracking.copied"));
    } catch {
      /* presse-papiers indisponible */
    }
  }

  // Pastille de compte : Pieces jointes = la liste de l'onglet (relevee par
  // ThreadAttachments, monte en permanence mais cache hors de son onglet),
  // Interlocuteurs = les personnes listees. Rien a 0.
  const [attachmentCount, setAttachmentCount] = useState(0);
  const tabs: { key: DetailsTab; label: string; count?: number }[] = [
    { key: "info", label: t("thread.tabInfo") },
    { key: "attachments", label: t("thread.attachmentsTitle"), count: attachmentCount },
    { key: "people", label: t("thread.tabPeople"), count: people.length },
    { key: "analysis", label: t("thread.tabAnalysis") },
  ];


  return (
    <>
      {/* Barre d'onglets : hors de la zone qui defile, elle reste en place.
          Cinq onglets ne tiennent pas en entier sur un telephone : la barre
          glisse alors de cote (libelles jamais tronques) et l'onglet choisi
          est ramene en vue. */}
      <div className="shrink-0 px-3 pt-1 pb-2 md:px-4">
        <div
          role="tablist"
          aria-label={t("thread.detailsTitle")}
          data-ref="thread-details-tabs"
          className="flex gap-1 overflow-x-auto overscroll-x-contain rounded-2xl bg-muted p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map(({ key, label, count }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => chooseTab(key)}
                ref={active ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}
                data-ref={`thread-details-tab-${key}`}
                className={cn(
                  "flex shrink-0 flex-auto items-center justify-center gap-1 rounded-xl px-2 py-2 text-xs leading-tight font-medium whitespace-nowrap transition-colors",
                  active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <span>{label}</span>
                {!!count && count > 0 && (
                  <span
                    data-ref={`thread-details-tab-count-${key}`}
                    className={cn(
                      "inline-flex h-[1.125rem] min-w-[1.125rem] shrink-0 items-center justify-center rounded-full px-1 text-[0.6875rem] leading-none font-semibold tabular-nums",
                      active ? "bg-primary-foreground text-primary" : "bg-foreground/10 text-foreground"
                    )}
                  >
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div
        data-ref="thread-details-body"
        role="tabpanel"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-4"
      >
        {tab === "info" && (
          // Sujet, dates, nombre de messages, dossier, etiquettes : la valeur
          // SOUS son libelle.
          <Surface className="px-4" data-ref="thread-details-info">
            <InfoRow stacked icon={MessageSquareText} label={t("thread.subject")} value={subject} chevron={false} />
            {firstMessage && (
              <InfoRow
                stacked
                icon={CalendarDays}
                label={t("thread.startDate")}
                value={formatDetailDate(firstMessage.date, t)}
                onClick={() => onScrollToMessage(firstMessage.id)}
              />
            )}
            {lastMessage && (
              <InfoRow
                stacked
                icon={Clock}
                label={t("thread.lastMessage")}
                value={formatDetailDate(lastMessage.date, t)}
                onClick={() => onScrollToMessage(lastMessage.id)}
              />
            )}
            <InfoRow
              stacked
              icon={MessagesSquare}
              label={t("thread.messageCount")}
              value={String(messages.length)}
              chevron={false}
            />
            {folderLabel && (
              <InfoRow
                stacked
                icon={Folder}
                label={t("thread.folder")}
                value={folderLabel}
                onClick={folderPath ? () => hashNavigate(folderPath) : undefined}
                chevron={!!folderPath}
              />
            )}
            <InfoRow stacked icon={Tag} label={t("filter.labels")} chevron={false}>
              <ThreadLabelsBar threadId={threadId} variant="inline" />
            </InfoRow>
          </Surface>
        )}

        <ThreadAttachments
          messages={messages}
          variant="inline"
          onCount={setAttachmentCount}
          className={tab === "attachments" ? undefined : "hidden"}
        />

        {tab === "people" && (
          <Surface data-ref="thread-details-participants">
            <div className="flex flex-col px-4 py-1.5">
              {people.map((p) => {
                const mine = myEmails.has((p.address || "").toLowerCase());
                return (
                  <div
                    key={p.address || p.name}
                    className="flex items-center gap-3.5 border-b border-border py-3 last:border-b-0"
                  >
                    <ContactAvatar name={p.name || p.address} email={p.address} className="size-11 shrink-0" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[0.9375rem]">
                        {p.name || p.address}
                        {mine && <span className="text-muted-foreground"> ({t("thread.me")})</span>}
                      </span>
                      <span className="truncate text-sm text-muted-foreground">
                        {p.role === "cc" ? `${t("thread.cc")} · ` : ""}
                        {p.address}
                      </span>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-accent"
                          aria-label={t("compose.moreOptions")}
                        >
                          <MoreHorizontal className="size-5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        {p.address && (
                          <DropdownMenuItem onSelect={() => openCompose("new", null, p.address)}>
                            <PenSquare className="size-4" />
                            {t("thread.writeTo")}
                          </DropdownMenuItem>
                        )}
                        {p.address && (
                          <DropdownMenuItem onSelect={() => copy(p.address)}>
                            <Copy className="size-4" />
                            {t("thread.copyAddress")}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => hashNavigate(`/contacts`)}>
                          <UserRound className="size-4" />
                          {t("contacts")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              })}
            </div>
          </Surface>
        )}

        {tab === "analysis" && (
          <ThreadAnalysisTab
            threadId={threadId}
            people={people}
            myEmails={myEmails}
            briefContent={briefContent}
            briefGeneratedAt={briefGeneratedAt}
            onBrief={onBrief}
            trackingItem={trackingItem}
          />
        )}
      </div>
    </>
  );
}
