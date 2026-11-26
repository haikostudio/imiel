"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Download } from "lucide-react";
import { useT } from "@/lib/i18n";
import { getFileIcon } from "@/lib/utils/file-icons";
import { formatRelativeDate } from "@/lib/utils/date";
import { isImageAttachment, type MessageAttachmentItem } from "@/lib/inline-images";
import type { Message } from "@/lib/pocketbase";
import { PREFIXE_PIECE, telechargerPiece, urlPiece } from "@/lib/cloud/actions";

/** iMiel Cloud : piece jointe lue chez le fournisseur a l'ouverture. */
const estCloud = (url: string) => url.startsWith(PREFIXE_PIECE);

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
  const short = sub.split(/[.+]/).pop() || sub;
  return short.toUpperCase();
}

interface AttachmentListProps {
  message: Message;
  /** PJ du message (chargees par le parent), null = chargement en cours */
  items: MessageAttachmentItem[] | null;
  /** Clic sur une image : visionneuse plein ecran */
  onOpenImage?: (url: string) => void;
}

interface HoverPreview { url: string; top: number; left: number }

const PREVIEW_W = 320;
const PREVIEW_H = 240;

export function AttachmentList({ message, items, onOpenImage }: AttachmentListProps) {
  const t = useT();
  const [preview, setPreview] = useState<HoverPreview | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canHover = useRef(false);
  // iMiel Cloud : vignettes des images lues a la demande (adresse blob:).
  const [resolus, setResolus] = useState<Record<string, string>>({});
  useEffect(() => {
    for (const att of items || []) {
      if (!estCloud(att.url) || resolus[att.id] || !isImageAttachment(att.filename, att.contentType)) continue;
      void urlPiece(att.url).then((u) => setResolus((r) => ({ ...r, [att.id]: u }))).catch(() => {});
    }
  }, [items, resolus]);
  const adresse = (att: MessageAttachmentItem) => resolus[att.id] || (estCloud(att.url) ? "" : att.url);
  const telechargerCloud = (att: MessageAttachmentItem) => (e: React.MouseEvent) => {
    if (!estCloud(att.url)) return;
    e.preventDefault();
    void telechargerPiece(att.url, att.filename);
  };

  useEffect(() => {
    canHover.current = typeof window !== "undefined" && window.matchMedia?.("(hover: hover)").matches;
    return () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); };
  }, []);

  const showPreview = useCallback((url: string, el: HTMLElement) => {
    if (!canHover.current) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.min(Math.max(8, r.left), vw - PREVIEW_W - 8);
      const below = r.bottom + 8;
      const top = below + PREVIEW_H > vh - 8 ? Math.max(8, r.top - PREVIEW_H - 8) : below;
      setPreview({ url, top, left });
    }, 250);
  }, []);

  const hidePreview = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setPreview(null);
  }, []);

  if (items === null) return null;

  // has_attachments=true mais aucune PJ stockee
  if (items.length === 0) {
    if (!message.has_attachments) return null;
    return (
      <div
        data-ref="thread-message-attachments"
        className="rounded-lg bg-muted/50"
      >
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>{t("message.attachmentsUnavailable")}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-ref="thread-message-attachments"
      className="rounded-lg bg-muted/50"
    >
      <div className="flex flex-col gap-3 p-3">
        <p className="text-muted-foreground text-xs font-medium">
          {items.length}{" "}
          {items.length > 1 ? t("message.attachments") : t("message.attachment")}
        </p>
        {/* Une piece jointe par ligne : la liste vit dans la colonne du message. */}
        <div className="flex flex-col gap-2">
          {items.map((att) => {
            const Icon = getFileIcon(att.filename);
            const isImage = isImageAttachment(att.filename, att.contentType) && !!onOpenImage;
            const meta = [
              getFileExtLabel(att.filename, att.contentType),
              att.size ? formatFileSize(att.size) : null,
              formatRelativeDate(message.date),
            ].filter(Boolean).join(" · ");

            if (!isImage) {
              return (
                <a
                  key={att.id}
                  href={estCloud(att.url) ? "#" : att.url}
                  onClick={telechargerCloud(att)}
                  download={att.filename}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-ref="thread-message-attachment"
                  className="bg-muted/50 border-border hover:bg-muted flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors"
                >
                  <Icon className="text-muted-foreground size-5 shrink-0" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{att.filename}</span>
                    <span className="text-muted-foreground truncate text-xs">{meta}</span>
                  </div>
                  <Download className="text-muted-foreground size-3.5 shrink-0" />
                </a>
              );
            }

            return (
              <div
                key={att.id}
                data-ref="thread-message-attachment"
                data-kind="image"
                className="bg-muted/50 border-border hover:bg-muted flex items-center gap-2.5 rounded-lg border py-1.5 pl-1.5 pr-1 transition-colors"
              >
                <button
                  type="button"
                  onClick={() => { hidePreview(); const u = adresse(att); if (u) onOpenImage?.(u); }}
                  onMouseEnter={(e) => adresse(att) && showPreview(adresse(att), e.currentTarget)}
                  onMouseLeave={hidePreview}
                  className="flex min-w-0 flex-1 cursor-zoom-in items-center gap-2.5 text-left"
                  title={t("attachment.preview")}
                  data-ref="thread-message-attachment-open"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={adresse(att) || undefined}
                    alt={att.filename}
                    loading="lazy"
                    className="bg-background size-9 shrink-0 rounded object-cover"
                    data-ref="thread-message-attachment-thumb"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{att.filename}</span>
                    <span className="text-muted-foreground truncate text-xs">{meta}</span>
                  </span>
                </button>
                <a
                  href={estCloud(att.url) ? "#" : att.url}
                  onClick={telechargerCloud(att)}
                  download={att.filename}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground shrink-0 rounded p-1.5"
                  aria-label={t("attachment.download")}
                  title={t("attachment.download")}
                  data-ref="thread-message-attachment-download"
                >
                  <Download className="size-3.5" />
                </a>
              </div>
            );
          })}
        </div>
      </div>
      {preview && typeof document !== "undefined" &&
        createPortal(
          <div
            data-ref="thread-message-attachment-preview"
            className="bg-popover border-border pointer-events-none fixed z-[150] flex items-center justify-center overflow-hidden rounded-lg border p-1 shadow-lg"
            style={{ top: preview.top, left: preview.left, width: PREVIEW_W, height: PREVIEW_H }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview.url} alt="" className="max-h-full max-w-full object-contain" />
          </div>,
          document.body,
        )}
    </div>
  );
}
