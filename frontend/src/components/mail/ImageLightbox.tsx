"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useT } from "@/lib/i18n";

export interface LightboxImage {
  url: string;
  filename?: string;
  /** Vrai si l'image a un fichier telechargeable (PJ) */
  downloadable?: boolean;
}

// Registre des images de chaque message, par conversation : la visionneuse
// fait defiler TOUTES les images du fil, dans l'ordre chronologique.
interface Entry { threadKey: string; date: string; images: LightboxImage[] }
const registry = new Map<string, Entry>();

export function registerMessageImages(messageId: string, entry: Entry | null) {
  if (entry && entry.images.length) registry.set(messageId, entry);
  else registry.delete(messageId);
}

function threadImages(threadKey: string): LightboxImage[] {
  const entries = [...registry.values()]
    .filter((e) => e.threadKey === threadKey)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const seen = new Set<string>();
  const out: LightboxImage[] = [];
  for (const e of entries) {
    for (const img of e.images) {
      if (seen.has(img.url)) continue;
      seen.add(img.url);
      out.push(img);
    }
  }
  return out;
}

interface LightboxState {
  images: LightboxImage[];
  index: number;
  open: boolean;
  show: (images: LightboxImage[], index: number) => void;
  close: () => void;
  go: (delta: number) => void;
}

export const useLightbox = create<LightboxState>((set) => ({
  images: [],
  index: 0,
  open: false,
  show: (images, index) => set({ images, index: Math.max(0, index), open: images.length > 0 }),
  close: () => set({ open: false }),
  go: (delta) =>
    set((s) => (s.images.length ? { index: (s.index + delta + s.images.length) % s.images.length } : s)),
}));

function absUrl(u: string): string {
  try { return new URL(u, window.location.href).href; } catch { return u; }
}

/** Ouvre la visionneuse sur `url`, parmi les images de la conversation. */
export function openImageInThread(threadKey: string, rawUrl: string, fallback?: LightboxImage[]) {
  const target = absUrl(rawUrl);
  let list = threadImages(threadKey);
  let idx = list.findIndex((i) => absUrl(i.url) === target);
  const url = idx >= 0 ? list[idx].url : rawUrl;
  if (idx < 0) {
    list = fallback && fallback.length ? fallback : [{ url }];
    idx = list.findIndex((i) => absUrl(i.url) === target);
    if (idx < 0) {
      list = [{ url }, ...list];
      idx = 0;
    }
  }
  useLightbox.getState().show(list, idx);
}

export function ImageLightbox() {
  const t = useT();
  const { images, index, open, close, go } = useLightbox();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); go(-1); }
    },
    [close, go],
  );

  useEffect(() => {
    if (!open) return;
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onKey]);

  if (!mounted || !open || !images.length) return null;
  const current = images[Math.min(index, images.length - 1)];
  const many = images.length > 1;

  return createPortal(
    <div
      data-ref="image-lightbox"
      role="dialog"
      aria-modal="true"
      className="pointer-events-auto fixed inset-0 z-[200] flex flex-col bg-black/90 text-white"
      onClick={close}
    >
      <div className="box-content flex h-12 shrink-0 items-center gap-2 px-3 pt-[var(--app-top)]" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate text-sm">
          {current.filename || ""}
          {many && <span className="ml-2 text-white/60 tabular-nums">{index + 1} / {images.length}</span>}
        </span>
        <a
          href={current.url}
          download={current.filename || true}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md p-2 hover:bg-white/10"
          aria-label={t("lightbox.download")}
          title={t("lightbox.download")}
          data-ref="image-lightbox-download"
        >
          <Download className="size-5" />
        </a>
        <button type="button" onClick={close} className="rounded-md p-2 hover:bg-white/10" aria-label={t("lightbox.close")} data-ref="image-lightbox-close">
          <X className="size-5" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={current.url}
          src={current.url}
          alt={current.filename || ""}
          className="max-h-full max-w-full select-none object-contain"
          onClick={(e) => e.stopPropagation()}
          data-ref="image-lightbox-image"
        />
        {many && (
          <>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); go(-1); }}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 hover:bg-black/70"
              aria-label={t("lightbox.previous")}
              data-ref="image-lightbox-prev"
            >
              <ChevronLeft className="size-6" />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); go(1); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 hover:bg-black/70"
              aria-label={t("lightbox.next")}
              data-ref="image-lightbox-next"
            >
              <ChevronRight className="size-6" />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
