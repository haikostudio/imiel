"use client";

import { type RefObject, useCallback, useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import { AlertTriangle, ChevronRight, Download, Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import { IconCircleButton } from "@/components/ui/kit";
import { getFileUrl, attachments as attachmentsCollection } from "@/lib/pocketbase";
import { useT } from "@/lib/i18n";
import { getFileIcon } from "@/lib/utils/file-icons";
import { formatRelativeDate } from "@/lib/utils/date";
import { cn } from "@/lib/utils";
import { useLightbox } from "./ImageLightbox";
import { THUMB_SIZE, isImageFile, pickThumbnailItems } from "@/lib/utils/thread-thumbnails";
import type { Message, Attachment } from "@/lib/pocketbase";

interface ThreadAttachmentsProps {
  messages: Message[];
  className?: string;
  // Si fourni, le tiroir est confine a ce conteneur (desktop : panneau de
  // lecture) au lieu de couvrir toute la fenetre, et sans flou de fond.
  containerRef?: RefObject<HTMLElement | null>;
  /** "button" : bouton carre a badge ; "row" : carte de l'ecran Details ;
   * "inline" : contenu de l'onglet Pieces jointes des Details (vignettes des
   * images puis liste complete, sans tiroir). */
  variant?: "button" | "row" | "inline";
  /** Nombre de fichiers listes, rendu une fois charge (pastille de l'onglet
   * Pieces jointes des Details : meme decompte que la liste affichee). */
  onCount?: (count: number) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function getFileExtLabel(filename: string, contentType?: string): string {
  const ext = filename.split(".").pop();
  if (ext && ext !== filename) return ext.toUpperCase();
  if (!contentType) return "";
  const sub = contentType.split("/").pop() || "";
  // Extraire le dernier segment apres le dernier "." ou "+" (ex: vnd.openxml...document -> document, svg+xml -> xml)
  const short = sub.split(/[.+]/).pop() || sub;
  return short.toUpperCase();
}

interface AttachmentDisplay {
  id: string;
  filename: string;
  url: string;
  thumbUrl: string;
  contentType?: string;
  size?: number;
  isInline: boolean;
  messageDate: string;
}

/** Construire les displays depuis les fichiers directement stockes sur les messages */
function buildFromMessageFiles(msgs: Message[]): AttachmentDisplay[] {
  const displays: AttachmentDisplay[] = [];
  for (const msg of msgs) {
    if (!msg.has_attachments || !msg.attachments?.length) continue;
    for (const filename of msg.attachments) {
      displays.push({
        id: `${msg.id}-${filename}`,
        filename,
        url: getFileUrl(msg, filename),
        thumbUrl: getFileUrl(msg, filename, THUMB_SIZE),
        isInline: false,
        messageDate: msg.date,
      });
    }
  }
  return displays;
}

export function ThreadAttachments({ messages, className, containerRef, variant = "button", onCount }: ThreadAttachmentsProps) {
  const t = useT();
  const [items, setItems] = useState<AttachmentDisplay[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [zipping, setZipping] = useState(false);
  // Conteneur de confinement (desktop) ; null sur mobile -> tiroir plein ecran.
  const container = containerRef?.current ?? null;
  const contained = container != null;

  // Messages qui ont des pieces jointes
  const messagesWithAttachments = useMemo(
    () => messages.filter((m) => m.has_attachments),
    [messages]
  );

  const messageIds = useMemo(
    () => messagesWithAttachments.map((m) => m.id),
    [messagesWithAttachments]
  );

  const messageDateMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) {
      map.set(m.id, m.date);
    }
    return map;
  }, [messages]);

  useEffect(() => {
    if (messageIds.length === 0) {
      setItems([]);
      setLoaded(true);
      return;
    }

    const filter = messageIds.map((id) => `message="${id}"`).join(" || ");

    attachmentsCollection()
      .getFullList<Attachment>({
        filter,
        requestKey: `thread-att-${messageIds.join("-")}`,
      })
      .then((records) => {
        const fromCollection = records.map((rec) => ({
          id: rec.id,
          filename: rec.filename,
          url: getFileUrl(rec, rec.file),
          thumbUrl: getFileUrl(rec, rec.file, THUMB_SIZE),
          contentType: rec.content_type || undefined,
          size: rec.size > 0 ? rec.size : undefined,
          isInline: !!rec.is_inline,
          messageDate: messageDateMap.get(rec.message) ?? rec.created,
        }));

        if (fromCollection.length > 0) {
          setItems(fromCollection);
        } else {
          setItems(buildFromMessageFiles(messagesWithAttachments));
        }
      })
      .catch(() => {
        setItems(buildFromMessageFiles(messagesWithAttachments));
      })
      .finally(() => setLoaded(true));
  }, [messageIds, messageDateMap, messagesWithAttachments]);

  useEffect(() => {
    if (loaded) onCount?.(items.length);
  }, [loaded, items.length, onCount]);

  const showLightbox = useLightbox((s) => s.show);
  const imageItems = useMemo(
    () => items
      .filter((i) => isImageFile(i.filename, i.contentType))
      .map((i) => ({ url: i.url, filename: i.filename, downloadable: true })),
    [items],
  );
  const thumbItems = useMemo(() => pickThumbnailItems(items), [items]);

  const handleDownloadAll = useCallback(async () => {
    if (zipping) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      const usedNames = new Set<string>();

      await Promise.all(
        items.map(async (att) => {
          const res = await fetch(att.url);
          const blob = await res.blob();
          // Dedupliquer les noms de fichiers
          let name = att.filename;
          let i = 1;
          while (usedNames.has(name)) {
            const dot = att.filename.lastIndexOf(".");
            if (dot > 0) {
              name = `${att.filename.slice(0, dot)} (${i})${att.filename.slice(dot)}`;
            } else {
              name = `${att.filename} (${i})`;
            }
            i++;
          }
          usedNames.add(name);
          zip.file(name, blob);
        })
      );

      const content = await zip.generateAsync({ type: "blob" });
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(content);
      link.download = `pieces-jointes_${date}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } finally {
      setZipping(false);
    }
  }, [items, zipping]);

  // has_attachments=true mais aucune PJ stockee -> bouton sans badge, message dans le tiroir
  const unavailable = items.length === 0;
  const countLabel = `${items.length} ${items.length > 1 ? t("message.attachments") : t("message.attachment")}`;

  // Liste detaillee (tiroir des variantes "button"/"row", onglet "inline").
  // Toucher une image ouvre la visionneuse ; le telechargement reste sur
  // l'icone de droite.
  const renderList = (onBeforeLightbox?: () => void) => (
    <div data-ref="thread-attachments" className="flex flex-col gap-2">
      {items.map((att) => {
        const isImage = isImageFile(att.filename, att.contentType);
        const Icon = getFileIcon(att.filename);
        return (
          <a
            key={att.id}
            href={att.url}
            download={att.filename}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-muted/50 border-border hover:bg-muted flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors"
            data-ref="thread-attachment"
            onClick={isImage ? (e) => {
              if ((e.target as HTMLElement).closest("[data-download]")) return;
              e.preventDefault();
              const idx = imageItems.findIndex((i) => i.url === att.url);
              onBeforeLightbox?.();
              showLightbox(imageItems, Math.max(0, idx));
            } : undefined}
          >
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={att.thumbUrl}
                alt={att.filename}
                className="size-10 shrink-0 cursor-zoom-in rounded object-cover"
                loading="lazy"
              />
            ) : (
              <Icon className="text-muted-foreground size-7 shrink-0" />
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">
                {att.filename}
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {[
                  getFileExtLabel(att.filename, att.contentType),
                  att.size ? formatFileSize(att.size) : null,
                  formatRelativeDate(att.messageDate),
                ].filter(Boolean).join(" \u00B7 ")}
              </span>
            </div>
            <span data-download className="shrink-0 p-1" onClick={isImage ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              const a = document.createElement("a");
              a.href = att.url;
              a.download = att.filename;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
              a.click();
            } : undefined}>
              <Download className="text-muted-foreground size-4" />
            </span>
          </a>
        );
      })}
    </div>
  );

  const downloadAllButton = items.length > 1 && (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleDownloadAll}
      disabled={zipping}
      data-ref="thread-attachments-download-all"
    >
      {zipping ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Download className="size-4" />
      )}
      <span>{t("thread.downloadAll")}</span>
    </Button>
  );

  // Onglet "Pieces jointes" des Details : vignettes des images en tete, puis
  // la liste complete des fichiers. Pas de tiroir.
  if (variant === "inline") {
    if (!loaded) {
      return (
        <p className={cn("px-1 py-6 text-center text-sm text-muted-foreground", className)}>
          {t("loading")}
        </p>
      );
    }
    if (messagesWithAttachments.length === 0) {
      return (
        <div
          className={cn("flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground", className)}
          data-ref="thread-details-no-attachments"
        >
          <Paperclip className="size-6" strokeWidth={1.6} />
          {t("thread.noAttachments")}
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div className={cn("text-muted-foreground flex items-center gap-2 px-1 py-6 text-sm", className)}>
          <AlertTriangle className="size-4 shrink-0" />
          <span>{t("message.attachmentsUnavailable")}</span>
        </div>
      );
    }
    const thumbLightbox = thumbItems.map((i) => ({ url: i.url, filename: i.filename, downloadable: true }));
    return (
      <div className={cn("flex flex-col gap-3", className)} data-ref="thread-details-attachments">
        {thumbItems.length > 0 && (
          <div className="grid grid-cols-3 gap-1.5" data-ref="thread-details-thumbs">
            {thumbItems.map((att, idx) => (
              <button
                key={att.id}
                type="button"
                onClick={() => showLightbox(thumbLightbox, idx)}
                className="aspect-square cursor-zoom-in overflow-hidden rounded-xl bg-muted"
                title={att.filename}
                data-ref="thread-details-thumb"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={att.thumbUrl}
                  alt={att.filename}
                  loading="lazy"
                  className="size-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
        <div className="flex min-h-9 items-center justify-between gap-2">
          <span className="text-sm font-medium">{countLabel}</span>
          {downloadAllButton}
        </div>
        {renderList()}
      </div>
    );
  }

  // Aucun message avec has_attachments=true
  // Carte "Pieces jointes" de l'ecran Details de la conversation : toujours
  // affichee, "Aucune piece jointe" quand le fil n'en porte pas.
  if (variant === "row" && (!loaded || messagesWithAttachments.length === 0)) {
    return (
      <div
        className={cn("flex w-full items-center gap-3.5 px-4 py-3.5 text-left", className)}
        data-ref="thread-attachments-row"
      >
        <Paperclip className="size-5 shrink-0" strokeWidth={1.7} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-semibold">{t("thread.attachmentsTitle")}</span>
          <span className="text-sm text-muted-foreground">
            {loaded ? t("thread.noAttachments") : t("loading")}
          </span>
        </span>
      </div>
    );
  }
  if (!loaded || messagesWithAttachments.length === 0) return null;

  return (
    <>
      {variant === "row" ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={cn("flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-accent/40", className)}
          data-ref="thread-attachments-toggle"
        >
          <Paperclip className="size-5 shrink-0" strokeWidth={1.7} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-base font-semibold">{t("thread.attachmentsTitle")}</span>
            <span className="text-sm text-muted-foreground">
              {unavailable ? t("message.attachmentsUnavailable") : countLabel}
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      ) : (
        /* Bouton carre (icone seule + badge du nombre) : ouvre le tiroir */
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setExpanded(true)}
          className={cn("relative shrink-0", className)}
          data-ref="thread-attachments-toggle"
          title={t("thread.attachmentsTitle")}
          aria-label={unavailable ? t("message.attachmentsUnavailable") : countLabel}
        >
          <Paperclip className="size-5" />
          {!unavailable && (
            <span className="bg-primary text-primary-foreground absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums">
              {items.length}
            </span>
          )}
        </Button>
      )}

      {/* Tiroir : liste detaillee par-dessus le contenu */}
      <Drawer
        open={expanded}
        onOpenChange={setExpanded}
        repositionInputs={false}
        noBodyStyles
        container={container}
      >
        <DrawerContent
          className="flex sheet-max-h flex-col data-[contained=true]:max-h-[calc(var(--app-height,100dvh)*0.85)]"
          container={container}
          contained={contained}
          overlayClassName={contained ? "bg-black/30 backdrop-blur-none" : undefined}
          data-ref="thread-attachments-drawer"
          hideGrip
        >
          <DrawerSheetHeader
            title={unavailable ? t("message.attachmentsUnavailable") : countLabel}
            className="border-b border-border"
            actions={
              items.length > 1 ? (
                <IconCircleButton
                  plain
                  onClick={handleDownloadAll}
                  disabled={zipping}
                  aria-label={t("thread.downloadAll")}
                  title={t("thread.downloadAll")}
                  data-ref="thread-attachments-download-all"
                >
                  {zipping ? <Loader2 className="size-5 animate-spin" /> : <Download className="size-5" strokeWidth={1.8} />}
                </IconCircleButton>
              ) : undefined
            }
          />

          {unavailable ? (
            <div className="text-muted-foreground flex items-center gap-2 px-4 py-6 text-sm">
              <AlertTriangle className="size-4 shrink-0" />
              <span>{t("message.attachmentsUnavailable")}</span>
            </div>
          ) : (
          <div className="overflow-y-auto px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            {renderList(() => setExpanded(false))}
          </div>
          )}
        </DrawerContent>
      </Drawer>
    </>
  );
}
