"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Share } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import {
  displayHost,
  filenameFromContentDisposition,
  filenameFromUrl,
  LINK_VIEWER_SKIP_ATTR,
  previewKindFor,
} from "@/lib/link-open";
import { classifyLinkHere, openOutsideApp, routeClassifiedLink, useLinkViewer } from "@/lib/stores/link-viewer";

/**
 * Tiroir des liens de l'APPLICATION INSTALLEE (cf lib/link-open.ts) + l'UNIQUE
 * ecouteur de clics global (capture sur document) qui aiguille les liens :
 * fichiers de l'app -> ce tiroir ; autres sites -> navigateur systeme, ouvert
 * DANS le geste (le tiroir ne sert alors que de repli si l'ouverture est
 * refusee). Monte une fois dans AuthenticatedLayout. Inactif en onglet
 * classique et dans l'app de bureau (classifyLink rend "ignore").
 */

interface FileState {
  status: "loading" | "ready" | "error";
  blobUrl?: string;
  blob?: Blob;
  name: string;
  type: string;
  preview: ReturnType<typeof previewKindFor>;
}

export function LinkViewerDrawer() {
  const t = useT();
  const url = useLinkViewer((s) => s.url);
  const kind = useLinkViewer((s) => s.kind);
  const close = useLinkViewer((s) => s.close);
  const [file, setFile] = useState<FileState | null>(null);
  const blobRef = useRef<string | null>(null);

  // UN SEUL ecouteur global, en capture : preventDefault sans arreter la
  // propagation (les gestes propres du lien continuent de jouer).
  useEffect(() => {
    function linkFrom(e: Event): HTMLAnchorElement | null {
      const target = e.target as Element | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.hasAttribute(LINK_VIEWER_SKIP_ATTR)) return null;
      return a;
    }
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = linkFrom(e);
      if (!a) return;
      const kind = classifyLinkHere(a.getAttribute("href") || "", {
        download: a.hasAttribute("download"),
        target: a.getAttribute("target"),
      });
      if (kind === "ignore") return;
      e.preventDefault();
      routeClassifiedLink(a.href, kind);
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Fichier de l'application : recu par fetch puis montre en blob:.
  useEffect(() => {
    if (!url || kind !== "file") return;
    const controller = new AbortController();
    const fallbackName = filenameFromUrl(url);
    setFile({ status: "loading", name: fallbackName, type: "", preview: "other" });
    (async () => {
      try {
        const r = await fetch(url, { signal: controller.signal, credentials: "include" });
        if (!r.ok) throw new Error(String(r.status));
        const type = (r.headers.get("content-type") || "").split(";")[0].trim();
        const name = filenameFromContentDisposition(r.headers.get("content-disposition")) || fallbackName;
        const preview = previewKindFor(type);
        if (preview === "video") {
          // Une video ne se charge pas en entier : le lecteur lit l'adresse.
          controller.abort();
          setFile({ status: "ready", name, type, preview, blobUrl: url });
          return;
        }
        const blob = await r.blob();
        const blobUrl = URL.createObjectURL(blob);
        blobRef.current = blobUrl;
        setFile({ status: "ready", blob, blobUrl, name, type, preview });
      } catch {
        if (!controller.signal.aborted) {
          setFile({ status: "error", name: fallbackName, type: "", preview: "other" });
        }
      }
    })();
    return () => {
      controller.abort();
    };
  }, [url, kind]);

  // Revoquer les adresses blob: a la fermeture.
  useEffect(() => {
    if (url) return;
    if (blobRef.current) {
      URL.revokeObjectURL(blobRef.current);
      blobRef.current = null;
    }
    setFile(null);
  }, [url]);

  async function saveFile() {
    if (!file?.blob) return;
    const f = new File([file.blob], file.name, { type: file.type || file.blob.type });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (typeof nav.share === "function" && nav.canShare?.({ files: [f] })) {
      try {
        await nav.share({ files: [f] });
        return;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return; // feuille refermee
      }
    }
    const a = document.createElement("a");
    a.href = file.blobUrl || "";
    a.download = file.name;
    a.setAttribute(LINK_VIEWER_SKIP_ATTR, "");
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const open = !!url && !!kind;
  const title = kind === "file" ? file?.name || (url ? filenameFromUrl(url) : "") : url ? displayHost(url) : "";

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      repositionInputs={false}
      noBodyStyles
      handleOnly
    >
      <DrawerContent
        data-ref="link-viewer"
        className="top-[var(--app-top)] z-[80] mt-0 flex flex-col overflow-hidden"
        overlayClassName="z-[80]"
        hideGrip
      >
        <DrawerSheetHeader
          title={title}
          className="border-b"
          titleDataRef="link-viewer-title"
          actions={kind === "file" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void saveFile()}
              disabled={!file?.blob}
              title={t("linkViewer.save")}
              data-ref="link-viewer-save"
            >
              <Share className="size-4.5" />
              <span className="sr-only">{t("linkViewer.save")}</span>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                if (url) openOutsideApp(url);
              }}
              title={t("linkViewer.openInBrowser")}
              data-ref="link-viewer-external"
            >
              <ExternalLink className="size-4.5" />
              <span className="sr-only">{t("linkViewer.openInBrowser")}</span>
            </Button>
          )}
        />
        <div className="relative min-h-0 flex-1 bg-background pb-[env(safe-area-inset-bottom)]">
          {kind === "external" && url && (
            <CenteredNotice text={t("linkViewer.blocked")}>
              <Button
                size="sm"
                onClick={() => {
                  openOutsideApp(url);
                  close();
                }}
                data-ref="link-viewer-open-browser"
              >
                <ExternalLink className="size-4" />
                {t("linkViewer.openInBrowser")}
              </Button>
            </CenteredNotice>
          )}
          {kind === "file" && file?.status === "loading" && (
            <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("linkViewer.loading")}
            </div>
          )}
          {kind === "file" && file?.status === "error" && (
            <CenteredNotice text={t("linkViewer.loadFailed")} />
          )}
          {kind === "file" && file?.status === "ready" && file.blobUrl && (
            <FilePreview file={file} noPreviewText={t("linkViewer.noPreview")} saveLabel={t("linkViewer.save")} onSave={() => void saveFile()} />
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function CenteredNotice({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-4 px-8 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  );
}

function FilePreview({
  file,
  noPreviewText,
  saveLabel,
  onSave,
}: {
  file: FileState;
  noPreviewText: string;
  saveLabel: string;
  onSave: () => void;
}) {
  const src = file.blobUrl || "";
  if (file.preview === "image") {
    return (
      <div className="flex size-full items-center justify-center overflow-auto bg-black/90 p-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={file.name} data-ref="link-viewer-image" className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  if (file.preview === "pdf" || file.preview === "text") {
    return <iframe src={src} title={file.name} data-ref="link-viewer-doc" className="size-full border-0 bg-white" />;
  }
  if (file.preview === "video") {
    return (
      <div className="flex size-full items-center justify-center bg-black">
        <video src={src} controls playsInline className="max-h-full max-w-full" />
      </div>
    );
  }
  const size = file.blob ? formatSize(file.blob.size) : "";
  return (
    <CenteredNotice text={noPreviewText}>
      <p className="max-w-full truncate text-sm font-medium">
        {file.name}
        {size && <span className="ml-2 text-muted-foreground">{size}</span>}
      </p>
      <Button size="sm" onClick={onSave}>
        <Share className="size-4" />
        {saveLabel}
      </Button>
    </CenteredNotice>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}
