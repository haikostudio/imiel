"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { useT } from "@/lib/i18n";
import { hashNavigate } from "@/lib/hash-router";
import {
  getFileUrl,
  messages as messagesCollection,
  type Message,
  type RecordModel,
  type TrackingAssets,
  type TrackingItem,
  type TrackingQrAsset,
  type TrackingStatus,
} from "@/lib/pocketbase";
import { useTrackingEvents } from "@/lib/hooks/useTrackingEvents";
import { TrackingTimeline } from "./TrackingTimeline";
import { ThreadView } from "@/components/mail/ThreadView";
import { MobileThreadDrawer } from "@/components/mail/MobileThreadDrawer";
import { ContactAvatar } from "@/components/mail/ContactAvatar";
import { cn } from "@/lib/utils";
import {
  BottomActionBar,
  DatePill,
  EmptyState,
  EntityAvatar,
  IconCircleButton,
  InfoRow,
  PrimaryAction,
  ScreenHeader,
  SquareAction,
  StatusPill,
  Surface,
  SurfaceTitle,
} from "@/components/ui/kit";
import { Drawer, DrawerContent, DrawerTitle, DrawerSheetHeader } from "@/components/ui/drawer";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  AlertTriangle,
  Archive,
  Banknote,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  Hash,
  History,
  Info,
  Mail,
  MapPin,
  MoreHorizontal,
  MoreVertical,
  Phone,
  QrCode,
  RefreshCw,
  RotateCcw,
  Trash2,
  Truck,
  User,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

/** Classement d'un champ dynamique de fiche pour son rendu :
 * - "code" : numero de suivi, code de retrait/validation, reference... -> mono + copie
 * - "address" : adresse de livraison, point de retrait, depot... -> lien Google Maps
 * L'ordre compte : "code_retrait" doit matcher code AVANT que "retrait" ne
 * l'envoie vers address. */
function fieldKind(key: string): "code" | "address" | "text" {
  if (/(^|_)(code|codes|numero|num|no|ref|reference|suivi|tracking|iban|id)(_|$)/.test(key)) {
    return "code";
  }
  if (/adresse|address|point_(de_)?(retrait|relais|collecte)|relais|depot|lieu|localisation|agence|magasin|boutique/.test(key)) {
    return "address";
  }
  return "text";
}

/** Picto d'un champ de la carte "Informations" (rond gris). */
function fieldIcon(key: string): LucideIcon {
  const k = key.toLowerCase();
  if (/adresse|address|retrait|relais|depot|lieu|agence|magasin/.test(k)) return MapPin;
  if (/mail/.test(k)) return Mail;
  if (/equipe|team|groupe/.test(k)) return Users;
  if (/dossier|folder|ticket/.test(k)) return Folder;
  if (/montant|prix|total|amount|tarif|cout/.test(k)) return Banknote;
  if (/date|echeance|heure|horaire|delai/.test(k)) return CalendarDays;
  if (/tel|phone|mobile/.test(k)) return Phone;
  if (/transporteur|livraison|colis|carrier/.test(k)) return Truck;
  if (/client|nom|contact|conseiller|interlocuteur/.test(k)) return User;
  if (fieldKind(k) === "code") return Hash;
  return Info;
}

function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

/** Source d'affichage d'un asset QR : data URI embarquee (survit a l'expiration
 * de l'URL distante), sinon URL distante, sinon fichier PJ PocketBase. */
function qrImageSrc(q: TrackingQrAsset): string {
  if (q.image) return q.image;
  if (q.url) return q.url;
  if (!q.attachment || !q.file) return "";
  return getFileUrl(
    { id: q.attachment, collectionId: "attachments", collectionName: "attachments" } as RecordModel,
    q.file
  );
}

function dayKey(date: string): string {
  const d = new Date(date);
  return isNaN(d.getTime()) ? "" : d.toDateString();
}

function dayLabel(date: string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  return format(d, "EEE d MMM", { locale: fr });
}

function timeLabel(date: string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  return format(d, "HH:mm", { locale: fr });
}

/** Ecran affiche pour la fiche ouverte (porte par l'adresse, ?fv=). */
export type TrackingView = "mails" | "details" | "timeline";

export interface TrackingDetailProps {
  item: TrackingItem;
  view?: TrackingView;
  onSetStatus: (item: TrackingItem, status: TrackingStatus, label: string) => void;
  onArchive: (id: string) => void;
  onRemove: (id: string) => void;
  // Va chercher les mails LIES (paiement, expedition, livraison...) deja
  // presents et complete la chronologie de CETTE fiche. Retourne le nb rattache.
  onRebuild: (id: string) => Promise<number>;
  // Mobile : la fiche est un ecran plein (tiroir) -> les tiroirs empiles
  // couvrent tout l'ecran. Desktop : ils sont confines au panneau de detail.
  isMobile?: boolean;
  /** Retour depuis l'ecran des mails (telephone : refermer la fiche). */
  onBack?: () => void;
  /** Ouvre un sous-ecran (details, chronologie). */
  onOpenView?: (view: Exclude<TrackingView, "mails">) => void;
  /** Ferme le sous-ecran courant (retour a l'ecran precedent). */
  onCloseView?: () => void;
}

/**
 * Fiche de suivi en TROIS ecrans (maquettes #08d68, #9c11, #78e0) :
 * - "mails" : les mails du dossier, groupes par jour sur une frise, chacun
 *   avec "Ouvrir le mail", et le bouton "Cloturer" en bas ;
 * - "details" : pastilles d'etat, titre, carte "Informations" (copie d'un
 *   clic, adresses vers Maps, QR codes) et lien vers la chronologie ;
 * - "timeline" : etapes resumees par l'IA, "Reconstruire la chronologie".
 */
export function TrackingDetail({
  item,
  view = "mails",
  onSetStatus,
  onArchive,
  onRemove,
  onRebuild,
  isMobile = false,
  onBack,
  onOpenView,
  onCloseView,
}: TrackingDetailProps) {
  const t = useT();
  const { events, loading, refresh: refreshEvents } = useTrackingEvents(item.id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [mailId, setMailId] = useState<string | null>(null);
  // Telephone : "Ouvrir la conversation" du menu ouvre le fil d'origine dans
  // le tiroir de conversation commun (au lieu de quitter la fiche).
  const [mailThreadId, setMailThreadId] = useState<string | null>(null);
  // QR codes trouves dans les PJ des fils de la fiche. Etat local rafraichi par
  // un scan worker (sans LLM, incremental) declenche a l'ouverture de la fiche ;
  // en attendant on affiche ce que la fiche porte deja (item.assets).
  const [scannedAssets, setScannedAssets] = useState<TrackingAssets | null>(null);
  const [zoomQr, setZoomQr] = useState<TrackingQrAsset | null>(null);
  const assets = scannedAssets ?? item.assets ?? null;
  const qrAssets = (assets?.qr || []).filter((q) => qrImageSrc(q) !== "");

  useEffect(() => {
    setScannedAssets(null);
    setZoomQr(null);
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/worker/tracking/assets/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId: item.id }),
        });
        if (!r.ok) return;
        const data = (await r.json()) as { assets?: TrackingAssets };
        if (!cancelled && data?.assets) setScannedAssets(data.assets);
      } catch {
        /* best effort : on garde item.assets */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  // Mails du dossier : les messages rattaches aux evenements de la fiche
  // (un evenement par message), lus en une requete legere (sans les corps).
  const messageIds = useMemo(
    () => Array.from(new Set(events.map((e) => e.message).filter(Boolean))),
    [events]
  );
  const messageIdsKey = messageIds.join(",");
  const [mails, setMails] = useState<Record<string, Message>>({});
  useEffect(() => {
    if (messageIds.length === 0) {
      setMails({});
      return;
    }
    let cancelled = false;
    messagesCollection()
      .getList<Message>(1, Math.min(messageIds.length, 100), {
        filter: messageIds.slice(0, 100).map((id) => `id="${id}"`).join(" || "),
        fields: "id,subject,snippet,from_address,date,thread_id,is_sent",
        requestKey: `tracking-mails-${item.id}`,
      })
      .then((res) => {
        if (cancelled) return;
        const map: Record<string, Message> = {};
        for (const m of res.items) map[m.id] = m;
        setMails(map);
      })
      .catch(() => {
        /* best effort : la frise retombe sur les libelles d'evenement */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageIdsKey, item.id]);

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("tracking.copied"));
    } catch {
      /* clipboard indisponible (contexte non securise) : rien */
    }
  }

  async function handleRebuild() {
    if (rebuilding) return;
    setRebuilding(true);
    try {
      // onRebuild recharge aussi la fiche (titre, champs) cote page.
      await onRebuild(item.id);
      await refreshEvents();
      toast.success(t("tracking.rebuildDoneToast"));
    } finally {
      setRebuilding(false);
    }
  }
  // Sur ordinateur, les tiroirs (actions, mail) sont confines au panneau de
  // detail ; le panneau racine sert de conteneur.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const contained = !isMobile;

  // Deux statuts seulement : ouvert vs cloture (done/cancelled = cloture).
  const isClosed = item.status === "done" || item.status === "cancelled";

  const fieldEntries = Object.entries(item.fields || {}).filter(
    ([, v]) => v != null && String(v).trim() !== ""
  );

  const img = item.expand?.image_attachment;
  const imageUrl = img ? getFileUrl(img, img.file) : "";
  const correspondent =
    item.merchant && !(item.title || "").toLowerCase().includes(item.merchant.toLowerCase())
      ? item.merchant
      : item.merchant || item.sender_domain;
  const headerName = item.merchant || item.title;

  // ------------------------------------------------------------ Barre du bas
  const bottomBar = (withMore: boolean) => (
    <BottomActionBar>
      {isClosed ? (
        <PrimaryAction
          icon={RotateCcw}
          variant="outline"
          onClick={() => onSetStatus(item, "active", t("tracking.eventReopened"))}
          data-ref="tracking-reopen"
        >
          {t("tracking.reopen")}
        </PrimaryAction>
      ) : (
        <PrimaryAction
          icon={CheckCircle2}
          onClick={() => onSetStatus(item, "done", t("tracking.eventClosed"))}
          data-ref="tracking-close"
        >
          {t("tracking.close")}
        </PrimaryAction>
      )}
      {withMore && (
        <SquareAction onClick={() => setMenuOpen(true)} aria-label={t("more")} title={t("more")}>
          <MoreHorizontal />
        </SquareAction>
      )}
    </BottomActionBar>
  );

  // ------------------------------------------------------------ Ecran : mails
  const mailEvents = events.filter((e) => e.message);
  const mailsScreen = (
    <>
      <ScreenHeader
        leading="none"
        onLeading={onBack}
        leadingLabel={t("close")}
        avatar={<EntityAvatar name={headerName} domain={item.sender_domain} shape="folder" size="md" />}
        title={headerName}
        subtitle={
          mailEvents.length > 1
            ? t("tracking.eventsCount", { count: String(mailEvents.length) })
            : t("tracking.eventCount")
        }
        onTitleClick={() => onOpenView?.("details")}
        trailing={
          <IconCircleButton
            onClick={() => onOpenView?.("details")}
            aria-label={t("tracking.detailsTitle")}
            title={t("tracking.detailsTitle")}
            data-ref="tracking-open-details"
          >
            <MoreVertical />
          </IconCircleButton>
        }
        data-ref="tracking-mails-header"
      />
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-2 md:px-5">
        {loading && events.length === 0 ? (
          <p className="px-1 py-6 text-sm text-muted-foreground">{t("loading")}</p>
        ) : mailEvents.length === 0 ? (
          <EmptyState icon={Mail} title={t("tracking.noMails")} />
        ) : (
          <ol className="relative" data-ref="tracking-mails">
            {/* Trait vertical de la frise */}
            <span className="absolute top-2 bottom-4 left-[1.15rem] w-px bg-border" aria-hidden />
            {mailEvents.map((ev, i) => {
              const m = mails[ev.message];
              const date = m?.date || ev.date;
              const prev = i > 0 ? mailEvents[i - 1] : null;
              const prevDate = prev ? mails[prev.message]?.date || prev.date : "";
              const showDay = !prev || dayKey(date) !== dayKey(prevDate);
              const sender = m?.from_address?.name || m?.from_address?.address || ev.author || t("tracking.you");
              return (
                <li key={ev.id} className="relative">
                  {showDay && <DatePill className="relative z-10 pl-10">{dayLabel(date)}</DatePill>}
                  <div className="flex gap-3 pb-3">
                    {/* Rond de la frise = visage de l'auteur du mail (logo du
                        domaine ou initiales), cercle plein sur le fond pour
                        couper le trait vertical. */}
                    <span
                      className="relative z-10 mt-3.5 inline-flex size-[2.3rem] shrink-0 rounded-full bg-background ring-4 ring-background"
                      data-ref="tracking-mail-author"
                    >
                      <ContactAvatar
                        name={sender}
                        email={m?.from_address?.address || ""}
                        className="size-[2.3rem]"
                        textClassName="text-xs"
                      />
                    </span>
                    <Surface className="min-w-0 flex-1">
                      <div className="px-4 pt-3.5 pb-3">
                        <div className="min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className="min-w-0 truncate text-[0.9375rem] font-medium">{sender}</span>
                            <span className="shrink-0 text-sm text-muted-foreground">{timeLabel(date)}</span>
                          </div>
                          <p className="mt-0.5 text-[0.9375rem] leading-snug break-words [overflow-wrap:anywhere]">
                            {m?.subject || ev.label}
                          </p>
                          {(m?.snippet || ev.detail) && (
                            <p className="mt-1 line-clamp-6 text-sm leading-relaxed text-muted-foreground break-words [overflow-wrap:anywhere]">
                              {m?.snippet || ev.detail}
                            </p>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setMailId(ev.message)}
                        className="flex w-full items-center gap-3 border-t border-border px-4 py-3 text-left text-[0.9375rem] transition-colors hover:bg-accent/50"
                        data-ref="tracking-open-mail"
                      >
                        <Mail className="size-5 shrink-0" strokeWidth={1.6} />
                        <span className="flex-1">{t("tracking.viewMail")}</span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    </Surface>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {bottomBar(true)}
    </>
  );

  // ---------------------------------------------------------- Ecran : details
  const detailsScreen = (
    <>
      <ScreenHeader
        leading={isMobile ? "back" : "close"}
        onLeading={onCloseView}
        leadingLabel={isMobile ? t("thread.back") : t("close")}
        title={t("tracking.detailsTitle")}
        centered
        trailing={
          <IconCircleButton onClick={() => setMenuOpen(true)} aria-label={t("more")} title={t("more")}>
            <MoreVertical />
          </IconCircleButton>
        }
        className="border-b-0"
        data-ref="tracking-details-header"
      />
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 pb-3 md:px-5">
        <div className="flex flex-col gap-3">
          {/* Etat, titre, correspondant */}
          <Surface className="px-4 py-4">
            <div className="mb-3 flex flex-wrap items-center gap-2" data-ref="tracking-status-pills">
              {item.type && (
                <StatusPill variant="outline" className="capitalize">
                  {item.type}
                </StatusPill>
              )}
              <StatusPill variant={isClosed ? "muted" : "solid"}>
                {isClosed ? t("tracking.statusDone") : t("tracking.statusOpen")}
              </StatusPill>
              {item.status_label && <StatusPill variant="muted">{item.status_label}</StatusPill>}
              {item.closure_suggested && !isClosed && (
                <StatusPill variant="outline">
                  <AlertTriangle className="size-3.5" />
                  {t("tracking.toClose")}
                </StatusPill>
              )}
            </div>
            <h2 className="text-[1.6rem] leading-tight font-semibold tracking-tight break-words [overflow-wrap:anywhere]">
              {item.title}
            </h2>
            {correspondent && (
              <p className="mt-1 text-lg text-muted-foreground">{correspondent}</p>
            )}
            {imageUrl && (
              <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl} alt={item.title} className="max-h-56 w-full object-contain" />
              </div>
            )}
          </Surface>

          {/* Informations extraites */}
          <Surface data-ref="tracking-informations">
            <SurfaceTitle className="border-b border-border pb-3">{t("tracking.details")}</SurfaceTitle>
            <div className="px-4">
              {item.context_summary && (
                <InfoRow
                  icon={FileText}
                  iconStyle="circle"
                  label={t("tracking.summary")}
                  value={item.context_summary}
                  chevron={false}
                />
              )}
              {fieldEntries.map(([k, v]) => {
                const kind = fieldKind(k);
                const label = k.replace(/_/g, " ");
                const value = String(v);
                return (
                  <InfoRow
                    key={k}
                    icon={fieldIcon(k)}
                    iconStyle="circle"
                    label={<span className="capitalize">{label}</span>}
                    mono={kind === "code"}
                    copyValue={kind === "code" ? value : undefined}
                    onCopy={copyValue}
                    chevron={false}
                  >
                    {kind === "address" ? (
                      // Adresse cliquable -> Google Maps (itineraire vers le
                      // point de retrait / depot / lieu de RDV)
                      <a
                        href={mapsUrl(value)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t("tracking.openInMaps")}
                        className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
                      >
                        {value}
                      </a>
                    ) : (
                      value
                    )}
                  </InfoRow>
                );
              })}
              {/* QR codes trouves dans les PJ des mails (bon de retrait,
                  etiquette point relais, billet...). Fond blanc force : un QR
                  doit rester scannable en mode sombre. Tap -> zoom. */}
              {qrAssets.length > 0 && (
                <InfoRow
                  icon={QrCode}
                  iconStyle="circle"
                  label={qrAssets.length > 1 ? t("tracking.qrCodes") : t("tracking.qrCode")}
                  chevron={false}
                >
                  <div className="flex flex-wrap gap-2">
                    {qrAssets.map((q) => (
                      <button
                        key={q.attachment || q.url}
                        type="button"
                        onClick={() => setZoomQr(q)}
                        title={t("tracking.qrCodes")}
                        className="size-20 shrink-0 overflow-hidden rounded-xl bg-white transition-transform active:scale-95"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={qrImageSrc(q)}
                          alt={q.filename || "QR code"}
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="size-full object-contain"
                        />
                      </button>
                    ))}
                  </div>
                </InfoRow>
              )}
              {!item.context_summary && fieldEntries.length === 0 && qrAssets.length === 0 && (
                <p className="py-4 text-sm text-muted-foreground">{t("tracking.noDetails")}</p>
              )}
            </div>
          </Surface>

          {/* Chronologie */}
          <Surface>
            <InfoRow
              icon={History}
              label={<span className="text-[0.9375rem] text-foreground">{t("tracking.timeline")}</span>}
              value={
                <span className="text-muted-foreground">
                  {events.length > 1
                    ? t("tracking.eventsCount", { count: String(events.length) })
                    : t("tracking.eventCount")}
                </span>
              }
              onClick={() => onOpenView?.("timeline")}
              className="px-4"
              divider={false}
            />
          </Surface>
        </div>
      </div>
      {bottomBar(false)}
    </>
  );

  // -------------------------------------------------------- Ecran : chronologie
  const timelineScreen = (
    <>
      <ScreenHeader
        leading="back"
        onLeading={onCloseView}
        leadingLabel={t("thread.back")}
        title={t("tracking.timeline")}
        centered
        trailing={
          // Structure FIXE : une seule icone (rotation par classe) et les deux
          // libelles empiles dans la meme cellule de grille, l'inactif cache
          // (pas d'ancien libelle peint sous le nouveau sur iPhone, pas de saut).
          <button
            type="button"
            onClick={handleRebuild}
            disabled={rebuilding}
            aria-busy={rebuilding}
            title={t("tracking.rebuildHint")}
            className="inline-flex h-11 max-w-[9.5rem] items-center gap-2 rounded-2xl bg-muted px-2.5 text-left text-[0.7rem] leading-tight transition-colors hover:bg-accent disabled:opacity-100 md:max-w-none md:text-xs"
            data-ref="tracking-rebuild"
          >
            <RefreshCw className={cn("size-[1.05rem] shrink-0", rebuilding && "animate-spin")} strokeWidth={1.7} />
            <span className="grid">
              <span className={cn("col-start-1 row-start-1", rebuilding && "invisible")} aria-hidden={rebuilding}>
                {t("tracking.rebuild")}
              </span>
              <span className={cn("col-start-1 row-start-1", !rebuilding && "invisible")} aria-hidden={!rebuilding}>
                {t("tracking.rebuilding")}
              </span>
            </span>
          </button>
        }
        data-ref="tracking-timeline-header"
      />
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3 md:px-5">
        <TrackingTimeline events={events} loading={loading} onOpenMail={setMailId} />
      </div>
      {bottomBar(true)}
    </>
  );

  const screen = view === "details" ? detailsScreen : view === "timeline" ? timelineScreen : mailsScreen;

  return (
    <div ref={setContainerEl} className="relative flex h-full flex-col bg-background" data-view={view}>
      {screen}

      {/* Tiroir "plus d'actions" : feuille du bas sur telephone, confinee au
          panneau de detail sur ordinateur. modal=false + voile maison pour
          s'empiler au-dessus de la fiche sans la fermer. */}
      <Drawer
        open={menuOpen}
        onOpenChange={setMenuOpen}
        repositionInputs={false}
        noBodyStyles
        modal={false}
        container={contained ? containerEl : undefined}
      >
        <DrawerContent
          className="z-[60] sheet-max-h data-[contained=true]:max-h-[calc(var(--app-height,100dvh)*0.8)]"
          container={contained ? containerEl : undefined}
          contained={contained}
          manualOverlay
          onOverlayClick={() => setMenuOpen(false)}
          overlayClassName="tracking-more-overlay z-[60]"
          data-ref="tracking-more-sheet"
          hideGrip
        >
          <DrawerSheetHeader
            title={t("compose.moreOptions")}
          />
          <div className="flex flex-col px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {view !== "details" && (
              <MenuRow icon={Info} label={t("tracking.detailsTitle")} onClick={() => { setMenuOpen(false); onOpenView?.("details"); }} />
            )}
            {view !== "timeline" && (
              <MenuRow icon={History} label={t("tracking.timeline")} onClick={() => { setMenuOpen(false); onOpenView?.("timeline"); }} />
            )}
            {item.thread_id && (
              <MenuRow
                icon={Mail}
                label={t("tracking.openThread")}
                onClick={() => {
                  setMenuOpen(false);
                  if (isMobile) setMailThreadId(item.thread_id);
                  else hashNavigate(`/mail/thread/${item.thread_id}`);
                }}
              />
            )}
            <MenuRow
              icon={RefreshCw}
              label={t("tracking.rebuild")}
              onClick={() => {
                setMenuOpen(false);
                void handleRebuild();
              }}
            />
            <MenuRow
              icon={Archive}
              label={t("tracking.archive")}
              onClick={() => {
                setMenuOpen(false);
                onArchive(item.id);
              }}
            />
            <MenuRow
              icon={Trash2}
              label={t("tracking.delete")}
              destructive
              onClick={() => {
                setMenuOpen(false);
                setDeleteOpen(true);
              }}
            />
          </div>
        </DrawerContent>
      </Drawer>

      {/* Tiroir conversation source d'une etape : ouvre le FIL COMPLET (ThreadView,
          comme depuis les conversations : barre d'images externes, reponses,
          actions). Pilote par l'id du message (controlled, sans toucher a la
          navigation mail globale). z-50 par defaut (PAS z-[60]) : ThreadView
          embarque ses propres tiroirs en z-50, empiles par ordre de portail.
          Telephone : tiroir de conversation commun (poignee, arret sous la
          barre du haut), modal, empile par-dessus la fiche. */}
      {isMobile && (
        <MobileThreadDrawer
          open={!!mailId || !!mailThreadId}
          onClose={() => {
            setMailId(null);
            setMailThreadId(null);
          }}
          controlled
          threadId={mailId ? null : mailThreadId}
          messageId={mailId}
        />
      )}
      <Drawer
        open={!!mailId && !isMobile}
        onOpenChange={(open) => {
          if (!open) setMailId(null);
        }}
        repositionInputs={false}
        noBodyStyles
        modal={false}
        container={contained ? containerEl : undefined}
      >
        <DrawerContent
          className="flex h-[calc(var(--app-height,100dvh)*0.88)] flex-col"
          container={contained ? containerEl : undefined}
          contained={contained}
          manualOverlay
          onOverlayClick={() => setMailId(null)}
          overlayClassName="tracking-mail-overlay"
          data-ref="tracking-mail-sheet"
        >
          <DrawerTitle className="sr-only">{t("tracking.viewMail")}</DrawerTitle>
          {/* Ordinateur uniquement (le telephone passe par MobileThreadDrawer) :
              en-tete du panneau confine au volet de detail, inchange. */}
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5" data-drawer-header="desktop">
            <IconCircleButton plain onClick={() => setMailId(null)} aria-label={t("close")}>
              <X className="size-5" />
            </IconCircleButton>
            <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-medium">
              {(mailId && mails[mailId]?.subject) || t("tracking.viewMail")}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {mailId && (
              <ThreadView
                messageId={mailId}
                threads={[]}
                loading={false}
                getThread={() => undefined}
              />
            )}
          </div>
        </DrawerContent>
      </Drawer>

      {/* Zoom QR code : plein format sur fond blanc (scannable au guichet /
          point relais, meme en mode sombre) + contenu decode copiable. */}
      <Dialog open={!!zoomQr} onOpenChange={(open) => !open && setZoomQr(null)}>
        <DialogContent className="z-[70] max-w-md gap-3 p-4" data-ref="tracking-qr-zoom">
          <DialogTitle className="text-sm font-medium">
            {zoomQr?.filename || t("tracking.qrCodes")}
          </DialogTitle>
          {zoomQr && (
            <>
              <div className="rounded-2xl bg-white p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrImageSrc(zoomQr)}
                  alt={zoomQr.filename || "QR code"}
                  referrerPolicy="no-referrer"
                  className="mx-auto max-h-[calc(var(--app-height,100dvh)*0.55)] w-full object-contain"
                />
              </div>
              {zoomQr.data && (
                <button
                  type="button"
                  onClick={() => copyValue(zoomQr.data)}
                  title={t("tracking.copyHint")}
                  className="text-muted-foreground active:bg-muted flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left text-xs"
                >
                  <Copy className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-all">
                    <span className="text-foreground/70 mb-0.5 block text-[10px] font-semibold uppercase tracking-wider">
                      {t("tracking.qrContent")}
                    </span>
                    {zoomQr.data}
                  </span>
                </button>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirmation de suppression (declenchee depuis le tiroir d'actions) */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("tracking.delete")}</AlertDialogTitle>
            <AlertDialogDescription>{t("tracking.deleteConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDeleteOpen(false);
                onRemove(item.id);
              }}
            >
              {t("tracking.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MenuRow({
  icon: Icon,
  label,
  onClick,
  destructive = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors active:bg-muted",
        destructive && "text-destructive active:bg-destructive/10"
      )}
    >
      <Icon className={cn("size-4 shrink-0", !destructive && "text-muted-foreground")} />
      {label}
    </button>
  );
}
