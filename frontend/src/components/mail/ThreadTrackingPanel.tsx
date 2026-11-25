"use client";

import { type RefObject } from "react";
import { Loader2, PackageSearch, SquareArrowOutUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import { IconCircleButton } from "@/components/ui/kit";
import { useT } from "@/lib/i18n";
import { hashNavigate } from "@/lib/hash-router";
import { getFileUrl, type TrackingItem } from "@/lib/pocketbase";
import { useTrackingEvents } from "@/lib/hooks/useTrackingEvents";
import { TrackingTimeline } from "@/components/suivi/TrackingTimeline";

interface ThreadTrackingPanelProps {
  /** Ouvert/ferme par le bouton PackageSearch de l'en-tete. */
  open: boolean;
  onClose: () => void;
  /**
   * Fiche de la conversation, lue par ThreadView (useThreadTrackingItem) et
   * partagee avec le bandeau du fil : le tiroir ne refait pas la requete.
   */
  item: TrackingItem | null;
  /** Fiche en cours de lecture / pas encore creee par le worker. */
  loading: boolean;
  /** La conversation est-elle suivie ? (etat du store tracked-threads). */
  isTracked: boolean;
  /** Action en cours (track/untrack). */
  busy: boolean;
  /** Bascule le suivi (suit si non suivi, retire sinon). */
  onToggle: () => void;
  /**
   * Confinement desktop (panneau de lecture). undefined sur mobile -> le tiroir
   * s'ouvre en plein ecran par-dessus le drawer de lecture (comme ReplyBox /
   * ThreadAttachments).
   */
  containerRef?: RefObject<HTMLElement | null>;
}

/**
 * Volet de SUIVI d'une conversation, ouvert par le bouton PackageSearch de
 * l'en-tete (pendant de la note IA). Tiroir bottom-sheet (mobile) / confine au
 * panneau de lecture (desktop), comme ThreadAttachments -> s'ouvre PAR-DESSUS
 * le contenu, pas en section sous le sujet.
 *
 * - Conversation NON suivie : explication + bouton "Suivre" (footer).
 * - Conversation suivie : la fiche (type, statut, titre, champs, image) et sa
 *   chronologie, + "Ne plus suivre" (footer) et un raccourci vers le flux Suivi.
 */
export function ThreadTrackingPanel({
  open,
  onClose,
  item,
  loading,
  isTracked,
  busy,
  onToggle,
  containerRef,
}: ThreadTrackingPanelProps) {
  const t = useT();
  const container = containerRef?.current ?? null;
  const contained = container != null;
  const { events, loading: eventsLoading } = useTrackingEvents(
    isTracked && item ? item.id : null
  );

  const isClosed = item
    ? item.status === "done" || item.status === "cancelled"
    : false;
  const fieldEntries = item
    ? Object.entries(item.fields || {}).filter(
        ([, v]) => v != null && String(v).trim() !== ""
      )
    : [];
  const img = item?.expand?.image_attachment;
  const imageUrl = img ? getFileUrl(img, img.file) : "";

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      repositionInputs={false}
      noBodyStyles
      container={container}
    >
      <DrawerContent
        className="flex sheet-max-h flex-col data-[contained=true]:max-h-[calc(var(--app-height,100dvh)*0.85)]"
        container={container}
        contained={contained}
        overlayClassName={contained ? "bg-black/30 backdrop-blur-none" : undefined}
        data-ref="thread-tracking-drawer"
        hideGrip
      >
        <DrawerSheetHeader
          title={t("tracking.title")}
          className="border-b"
          actions={
            isTracked && item ? (
              <IconCircleButton
                plain
                onClick={() => hashNavigate("/suivi")}
                aria-label={t("tracking.openInSuivi")}
                title={t("tracking.openInSuivi")}
                data-ref="thread-tracking-open-suivi"
              >
                <SquareArrowOutUpRight className="size-5" strokeWidth={1.8} />
              </IconCircleButton>
            ) : undefined
          }
        />

        {/* Corps defilant */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm">
          {!isTracked ? (
            <p className="text-muted-foreground leading-relaxed">
              {t("tracking.panelNotTrackedHint")}
            </p>
          ) : loading && !item ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("tracking.panelCreating")}
            </div>
          ) : item ? (
            <>
              {/* Type + statut */}
              <div className="flex flex-wrap items-center gap-2">
                {item.type && (
                  <Badge variant="outline" className="capitalize">
                    {item.type}
                  </Badge>
                )}
                <Badge variant={isClosed ? "secondary" : "default"}>
                  {isClosed
                    ? t("tracking.statusDone")
                    : t("tracking.statusOpen")}
                </Badge>
                {item.status_label && (
                  <span className="text-xs text-muted-foreground">
                    {item.status_label}
                  </span>
                )}
              </div>

              {/* Titre */}
              <h3 className="mt-2 text-base font-semibold leading-tight break-words [overflow-wrap:anywhere]">
                {item.title}
              </h3>
              {item.merchant &&
                !(item.title || "")
                  .toLowerCase()
                  .includes(item.merchant.toLowerCase()) && (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {item.merchant}
                  </p>
                )}

              {/* Image produit */}
              {imageUrl && (
                <div className="mt-3 overflow-hidden rounded-lg border bg-muted/30">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageUrl}
                    alt={item.title}
                    className="max-h-44 w-full object-contain"
                  />
                </div>
              )}

              {/* Champs dynamiques */}
              {fieldEntries.length > 0 && (
                <dl className="mt-4 divide-y rounded-lg border">
                  {fieldEntries.map(([k, v]) => (
                    <div key={k} className="flex gap-3 px-3 py-2 text-sm">
                      <dt className="w-2/5 shrink-0 capitalize text-muted-foreground">
                        {k.replace(/_/g, " ")}
                      </dt>
                      <dd className="min-w-0 flex-1 break-words [overflow-wrap:anywhere] font-medium">
                        {v}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}

              {/* Chronologie */}
              <div className="mt-5">
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("tracking.timeline")}
                </h4>
                <TrackingTimeline events={events} loading={eventsLoading} />
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">{t("tracking.panelNoFiche")}</p>
          )}
        </div>

        {/* Footer epingle : action principale (suivre / ne plus suivre) */}
        <div className="flex shrink-0 items-center gap-2 border-t bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {!isTracked ? (
            <Button
              type="button"
              size="sm"
              className="flex-1"
              onClick={onToggle}
              disabled={busy}
              data-ref="thread-tracking-track"
            >
              {busy ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : (
                <PackageSearch className="mr-1.5 size-4" />
              )}
              {t("tracking.track")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={onToggle}
              disabled={busy}
              data-ref="thread-tracking-untrack"
            >
              {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              {t("tracking.untrack")}
            </Button>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
