"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { RemoveScroll } from "react-remove-scroll";
import { X } from "lucide-react";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import { IconCircleButton } from "@/components/ui/kit";
import { useT } from "@/lib/i18n";
import { EmailBodyFrame } from "./EmailBodyFrame";

interface MessageHtmlViewProps {
  open: boolean;
  onClose: () => void;
  isMobile: boolean;
  /** Ordinateur : volet de la conversation (`[data-ref="thread-pane"]`) que
   * le panneau recouvre ; a defaut, toute la fenetre. */
  container: HTMLElement | null;
  title: string;
  /** HTML deja nettoye (sanitizeHtml) : original ou traduction. */
  html: string;
  onMailto: (email: string) => void;
  onImageClick: (src: string) => void;
}

/**
 * Version d'origine (mise en page HTML) d'un mail du fil : le fil n'affiche
 * que des bulles de texte, la pastille "HTML" ou "Voir en HTML" ouvre ceci.
 * Telephone : tiroir pleine hauteur qui ne glisse que par sa prise (vaul
 * `handleOnly`), avec son propre verrou de defilement (ouvert par-dessus le
 * tiroir MODAL de la conversation). Ordinateur : panneau qui couvre le volet
 * de la conversation, ferme par la croix ou Echap.
 */
export function MessageHtmlView(props: MessageHtmlViewProps) {
  const { open, onClose, isMobile, container, title } = props;
  const t = useT();

  useEffect(() => {
    if (!open || isMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, isMobile, onClose]);

  if (isMobile) {
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
          data-ref="thread-message-html-view"
          className="drawer-scroll-native top-[var(--app-top)] mt-0 flex flex-col overflow-hidden"
        >
          <DrawerSheetHeader
            title={title}
            className="border-b border-border"
            handleDataRef="thread-message-html-handle"
          />
          <RemoveScroll removeScrollBar={false} allowPinchZoom className="flex min-h-0 flex-1 flex-col">
            <HtmlBody {...props} />
          </RemoveScroll>
        </DrawerContent>
      </Drawer>
    );
  }

  if (!open) return null;
  const pane = container ?? document.body;
  return createPortal(
    <div
      data-ref="thread-message-html-view"
      className={
        pane === document.body
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "absolute inset-0 z-40 flex flex-col bg-background"
      }
      role="dialog"
      aria-label={title}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <IconCircleButton plain onClick={onClose} aria-label={t("close")} data-ref="thread-message-html-close">
          <X className="size-5" strokeWidth={1.8} />
        </IconCircleButton>
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
      </div>
      <HtmlBody {...props} />
    </div>,
    pane
  );
}

function HtmlBody({ html, onMailto, onImageClick }: MessageHtmlViewProps) {
  return (
    <div
      data-ref="thread-message-html-body"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-background px-3 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <div data-ref="thread-message-frame" className="overflow-hidden rounded-2xl border border-border bg-white">
        <EmailBodyFrame html={html} onMailto={onMailto} onImageClick={onImageClick} />
      </div>
    </div>
  );
}
