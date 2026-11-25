"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from "@/components/ui/drawer";
import { ThreadView, ParticipantStack, useThreadWithFallback } from "@/components/mail/ThreadView";
import { openThreadDetails } from "@/components/mail/ThreadDetailsPanel";
import { normalizeSubject } from "@/lib/utils/threading";
import { useT } from "@/lib/i18n";
import type { Thread } from "@/lib/hooks/useThreads";

const NO_THREADS: Thread[] = [];
const NO_THREAD = () => undefined;

export interface MobileThreadDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Conversation a ouvrir (par fil ou par message). */
  threadId?: string | null;
  messageId?: string | null;
  /**
   * true : ThreadView affiche `threadId`/`messageId` (mode controle, sans
   * toucher a la selection mail globale - Suivi). false : ThreadView suit la
   * selection du store, ces ids ne servent qu'a l'en-tete (listes de mails,
   * route conversation, fiche contact).
   */
  controlled?: boolean;
  threads?: Thread[];
  loading?: boolean;
  getThread?: (threadId: string) => Thread | undefined;
  /** Tiroir "..." de ThreadView pilote par le parent (facultatif). */
  /** Ex. : un toucher dans le fil le passe en lu sans attendre le delai. */
  onContentClickCapture?: (e: React.MouseEvent) => void;
}

/**
 * Tiroir de conversation du TELEPHONE, le meme partout ou un fil s'ouvre
 * (listes de mails, vue d'ensemble, newsletters, suivi, fiche contact).
 *
 * - Il monte du bas et s'arrete PILE sous la barre d'etat (top = safe-area) :
 *   l'ecran d'ou l'on vient reste visible, assombri, derriere la barre d'etat.
 *   Ancrage top + bottom, AUCUNE unite viewport (dvh sous-estime l'ecran en
 *   PWA iOS) ; pas de `safe-area-top` (il ne sert qu'aux surcouches pleine
 *   hauteur, c'est lui qui creait la bande blanche vide en haut).
 * - Il ne glisse QUE par sa poignee (vaul `handleOnly` + DrawerHandle) : le
 *   fil defile au doigt sans jamais refermer le tiroir. Les boutons de
 *   l'en-tete (retour, visages, sujet, etoile) restent hors de la prise.
 * - Clavier iOS (repositionInputs=false + noBodyStyles, calque sur
 *   AiChatPanel) : quand un champ a le focus et que la zone visible retrecit,
 *   la hauteur du tiroir est calee sur cette zone, moins son decalage du haut,
 *   pour que le pied "Repondre" reste au-dessus du clavier.
 */
export function MobileThreadDrawer({
  open,
  onClose,
  threadId = null,
  messageId = null,
  controlled = false,
  threads = NO_THREADS,
  loading = false,
  getThread = NO_THREAD,
  onContentClickCapture,
}: MobileThreadDrawerProps) {
  const t = useT();
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const resolved = useThreadWithFallback({ threadId, messageId, threads, getThread });
  // Garder le dernier fil affiche pendant l'animation de fermeture (la
  // selection repasse a null avant la fin du glissement) : pas de flash
  // "Chargement" pendant la sortie. Etat ajuste pendant le rendu (pas de ref
  // lue au rendu, refusee par le compilateur React).
  const [lastThread, setLastThread] = useState<Thread | null>(null);
  if (resolved && resolved !== lastThread) setLastThread(resolved);
  const thread = resolved ?? (open ? null : lastThread);

  // Le fil resolu (eventuellement charge par le repli) est rendu a ThreadView
  // par ses donnees : il n'a pas a le recharger une seconde fois.
  const viewThreads = useMemo(
    () => (resolved && !threads.some((th) => th.id === resolved.id) ? [...threads, resolved] : threads),
    [threads, resolved]
  );
  const viewGetThread = useCallback(
    (id: string) => getThread(id) ?? (resolved && resolved.id === id ? resolved : undefined),
    [getThread, resolved]
  );

  useEffect(() => {
    if (!open) return;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const drawerEl = contentRef.current;
    let raf = 0;
    // CLAVIER = champ de saisie au focus ET zone visible reduite : une zone
    // visible reduite SANS champ actif (lancement de l'app, retour d'une
    // fenetre systeme ou de Safari) figeait le tiroir trop court -> grand vide
    // sous "Repondre". On recalcule aussi au retour au premier plan.
    const apply = () => {
      raf = 0;
      const el = contentRef.current;
      if (!el) return;
      const docH = document.documentElement.clientHeight;
      const active = document.activeElement as HTMLElement | null;
      const typing =
        !!active &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable === true);
      const keyboard = typing && vv.height < docH - 60;
      if (!keyboard) {
        el.style.height = "";
        return;
      }
      // Position de mise en page (sans le transform de vaul).
      const top = parseFloat(getComputedStyle(el).top) || 0;
      el.style.height = `${Math.max(160, Math.round(vv.offsetTop + vv.height - top))}px`;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const scheduleLater = () => {
      schedule();
      window.setTimeout(schedule, 300);
    };
    schedule();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", scheduleLater);
    window.addEventListener("pageshow", scheduleLater);
    document.addEventListener("visibilitychange", scheduleLater);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", scheduleLater);
      window.removeEventListener("pageshow", scheduleLater);
      document.removeEventListener("visibilitychange", scheduleLater);
      if (drawerEl) drawerEl.style.height = "";
    };
  }, [open]);

  const subject = thread ? normalizeSubject(thread.subject) || t("message.noSubject") : t("loading");

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      handleOnly
      repositionInputs={false}
      noBodyStyles
    >
      <DrawerContent
        ref={contentRef}
        data-ref="thread-drawer"
        hideGrip
        className="drawer-scroll-native top-[var(--app-top)] mt-0 flex flex-col overflow-hidden"
      >
        <DrawerTitle className="sr-only">{subject}</DrawerTitle>
        {/* Prise du tiroir : seule zone qui le fait glisser / fermer. De l'air
            au-dessus et sous la poignee (ce tiroir seulement : la poignee
            commune reste serree pour les autres) ; le rembourrage fait partie
            de la prise, donc plus facile a attraper. */}
        <DrawerHandle className="shrink-0 pt-2.5 pb-2" data-ref="thread-drawer-handle" />
        {/* En-tete de la conversation (maquette #5847), SANS croix : on ferme
            en glissant la prise vers le bas (onOpenChange). Visages des
            participants, sujet, nombre de participants ; le titre et les
            visages ouvrent les Details de la conversation. */}
        <header
          className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-2.5 pb-1.5"
          data-drawer-header="custom"
        >
          {thread && (
            <ParticipantStack
              details={thread.participantDetails}
              onClick={() => openThreadDetails(thread.id, "people")}
            />
          )}
          <button
            type="button"
            onClick={() => thread && openThreadDetails(thread.id)}
            disabled={!thread}
            className="flex min-w-0 flex-1 flex-col text-left"
            data-ref="thread-drawer-title"
          >
            <span className="truncate text-base leading-tight font-semibold">{subject}</span>
            {thread && (
              <span className="truncate text-sm text-muted-foreground">
                {thread.participantDetails.length > 1
                  ? t("thread.participantsCount", { count: String(thread.participantDetails.length) })
                  : t("thread.participantCount")}
              </span>
            )}
          </button>
          {/* Etoile de la conversation, posee par ThreadView (qui connait
              toutes les copies du fil) dans cet emplacement. */}
          <span ref={setHeaderSlot} className="contents" data-ref="thread-header-actions" />
        </header>
        <div className="min-h-0 flex-1 overflow-hidden" onClickCapture={onContentClickCapture}>
          {/* ThreadView fournit son propre pied de reponse (bouton noir
              "Repondre" + pieces jointes) qui ouvre la fenetre de redaction. */}
          {(open || thread) && (
            <ThreadView
              // Pendant la sortie, le fil reste affiche (la selection est deja
              // retombee a null).
              {...(!open && thread
                ? { threadId: thread.id }
                : controlled
                  ? { threadId, messageId }
                  : {})}
              threads={viewThreads}
              loading={loading}
              getThread={viewGetThread}
              headerActionsSlot={headerSlot}
              embeddedHeader
            />
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
