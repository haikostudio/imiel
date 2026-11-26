"use client";

const LLM_URL = "/api/ai";

import { useIaDisponible } from "@/lib/ai-settings";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { RemoveScroll } from "react-remove-scroll";
import { Briefcase, CalendarClock, Check, ChevronLeft, ChevronRight, Clock, Cpu, FileText, GripVertical, Languages, Loader2, Minus, MoreHorizontal, MoreVertical, MessageSquareQuote, Paperclip, Pen, PenLine, RefreshCw, Scissors, Send, Smile, Sparkles, Trash2, Undo2, WandSparkles, X, ChevronDown } from "lucide-react";
import { computeDiff, type CorrectionItem, type DiffSegment } from "@/lib/utils/diff";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RecipientInput } from "@/components/mail/RecipientInput";
import { recipientSuggestionsActive } from "@/lib/recipient-suggestions-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useMailStore, type ComposeMode, type ComposeInstance } from "@/lib/stores/mail-store";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { useAutoSave, type DraftData, type SavedAttachment } from "@/lib/hooks/useAutoSave";
import { useDraftSync } from "@/lib/hooks/useDraftSync";
import pb, { messages, type Message, type Account, type EmailAddress, attachments as attachmentsCollection, getFileUrl } from "@/lib/pocketbase";
import { sanitizeHtml, collectRemoteImageUrls } from "@/lib/utils/sanitize";
import { proxiedImageSrc, useProxiedImages } from "@/lib/image-proxy";
import { isPocketBaseFileUrl } from "@/lib/inline-images";
import { buildReplyQuote, buildForwardQuote, splitQuotedBody, joinQuotedBody } from "@/lib/utils/quote";
import { accountSignature, joinSignature, splitSignature } from "@/lib/signature";
import { hashNavigate } from "@/lib/hash-router";
import { useT, t as tStatic } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import { getOpenRouterKey } from "@/lib/ai-settings";
import { sendAction } from "@/lib/ws-channel";
import { beginUndoableSend } from "@/lib/undo-send";
import type { Editor, TranslateTarget } from "./ComposeEditor";
import { DOMSerializer } from "@tiptap/pm/model";

const TRANSLATE_TARGETS: TranslateTarget[] = ["en", "de", "es"];
import {
  formatThread,
  messageAddressNames,
  replyAllRecipients,
  pickReplyTarget,
  parseSseBuffer,
  stripQuoted,
  type ReplyAgentEvent,
  type ReplyAgentStep,
} from "@/lib/reply-agent";
import { conversationParticipants } from "@/lib/contact-memory";
import { costLevelLabel, formatCents, type AiModelPrice } from "@/lib/ai-models";
import { currentAiModel, useAiComposeModel } from "@/lib/hooks/useAiComposeModel";
import dynamic from "next/dynamic";

const ComposeEditor = dynamic(
  () => import("./ComposeEditor").then((m) => ({ default: m.ComposeEditor })),
  { ssr: false, loading: () => <div className="border-input min-h-[120px] rounded-md border" /> }
);

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [query]);

  return matches;
}

// --- Menus de la fenetre de redaction ---
// Petits menus flottants (maquettes) sur telephone comme sur ordinateur :
// popover Radix rendu en portail en z-[100] (au-dessus de la fenetre flottante
// et du tiroir ; le garde onInteractOutside de ComposeSheet reconnait
// [data-radix-popper-content-wrapper]). Un sous-menu (Reformuler, Traduire,
// Programmer l'envoi) remplace le contenu sur place, avec un retour.

type MenuIcon = typeof Clock;

function MenuRow({
  icon: Icon,
  label,
  onClick,
  danger,
  chevron,
  disabled,
  dataRef,
  hint,
  checked,
}: {
  icon?: MenuIcon;
  label: string;
  onClick: () => void;
  danger?: boolean;
  chevron?: boolean;
  disabled?: boolean;
  dataRef?: string;
  /** Texte discret a droite (ex. niveau de cout d'un modele). */
  hint?: string;
  /** Coche a droite (choix en cours d'une liste). */
  checked?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-ref={dataRef}
      className={cn(
        "hover:bg-accent flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors disabled:pointer-events-none disabled:opacity-40",
        danger && "text-destructive"
      )}
    >
      {Icon && <Icon className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{hint}</span>}
      {checked !== undefined && <Check className={cn("size-4 shrink-0", !checked && "invisible")} />}
      {chevron && <ChevronRight className="text-muted-foreground size-4 shrink-0" />}
    </button>
  );
}

function MenuBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:bg-accent flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-xs font-medium"
      data-ref="compose-menu-back"
    >
      <ChevronLeft className="size-4 shrink-0" />
      {label}
    </button>
  );
}

const menuContentClass = "z-[100] w-64 rounded-2xl p-1.5";

export type RephraseVariant = "free" | "friendly" | "professional";

// Menu IA : ligne « Assistant IA › » du menu ⋮ (choix utilisateur carte
// e339f1) qui ouvre ses actions dans un menu CONTEXTUEL a cote, au clic.
// `onDone` referme aussi le menu ⋮ quand une action part.
function ComposeAiMenu({
  busy,
  canDraftReply,
  followUp,
  canSummarize,
  hasBody,
  hasText,
  onOpen,
  onDraftReply,
  onCorrect,
  onRephrase,
  onShorten,
  onTranslate,
  onSummarize,
  onDone,
  t,
}: {
  busy: boolean;
  onDone?: () => void;
  canDraftReply: boolean;
  /** C'est moi qui ai ecrit en dernier : "Rediger une relance". */
  followUp: boolean;
  canSummarize: boolean;
  hasBody: boolean;
  hasText: boolean;
  onOpen: () => void;
  onDraftReply: () => void;
  onCorrect: () => void;
  onRephrase: (variant: RephraseVariant) => void;
  onShorten: () => void;
  onTranslate: (target: TranslateTarget) => void;
  onSummarize: () => void;
  t: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"root" | "rephrase" | "translate" | "model">("root");
  const run = (fn: () => void) => () => { setOpen(false); onDone?.(); fn(); };
  const modelId = useAiComposeModel((s) => s.model);
  const models = useAiComposeModel((s) => s.models);
  const setModel = useAiComposeModel((s) => s.setModel);
  const loadModels = useAiComposeModel((s) => s.loadModels);
  const current = currentAiModel({ model: modelId, models });
  const locale = typeof navigator !== "undefined" ? navigator.language : "fr";
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) { onOpen(); setPage("root"); loadModels(); }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={busy}
          onMouseDown={(e) => e.preventDefault()}
          data-ref="compose-more-ai"
          className="hover:bg-accent data-[state=open]:bg-accent flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Sparkles className="size-4 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{t("compose.aiMenu")}</span>
          <ChevronRight className="text-muted-foreground size-4 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        sideOffset={10}
        collisionPadding={8}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className={cn(menuContentClass, page === "model" && "w-72")}
        data-ref="compose-ai-menu"
      >
        {page === "root" && (
          <>
            {canDraftReply && (
              <MenuRow
                icon={PenLine}
                label={t(followUp ? "compose.aiDraftFollowUp" : "compose.aiDraftReply")}
                onClick={run(onDraftReply)}
                dataRef={followUp ? "compose-ai-draft-followup" : "compose-ai-draft-reply"}
              />
            )}
            <MenuRow icon={WandSparkles} label={t("compose.aiCorrect")} onClick={run(onCorrect)} disabled={!hasText} dataRef="compose-ai-correct" />
            <MenuRow icon={RefreshCw} label={t("compose.aiRephrase")} onClick={() => setPage("rephrase")} disabled={!hasBody} chevron dataRef="compose-ai-rephrase" />
            <MenuRow icon={Scissors} label={t("compose.aiShorten")} onClick={run(onShorten)} disabled={!hasBody} dataRef="compose-ai-shorten" />
            <MenuRow icon={Languages} label={t("compose.translate")} onClick={() => setPage("translate")} disabled={!hasBody} chevron dataRef="compose-ai-translate" />
            {canSummarize && (
              <MenuRow icon={FileText} label={t("compose.aiSummarize")} onClick={run(onSummarize)} dataRef="compose-ai-summarize" />
            )}
            <div className="bg-border mx-2 my-1 h-px" aria-hidden />
            <MenuRow
              icon={Cpu}
              label={current.label}
              hint={costLevelLabel(current.level)}
              onClick={() => setPage("model")}
              chevron
              dataRef="compose-ai-model"
            />
          </>
        )}
        {page === "model" && (
          <>
            <MenuBack label={t("compose.aiModel")} onClick={() => setPage("root")} />
            <div className="max-h-80 overflow-y-auto" data-ref="compose-ai-model-list">
              {models.map((m: AiModelPrice) => (
                <MenuRow
                  key={m.id}
                  label={m.label}
                  hint={`${costLevelLabel(m.level)} · ${formatCents(m.cents, locale)}`}
                  checked={m.id === current.id}
                  onClick={() => { setModel(m.id); setPage("root"); }}
                  dataRef={`compose-ai-model-${m.id.replace(/[^a-z0-9]+/gi, "-")}`}
                />
              ))}
            </div>
          </>
        )}
        {page === "rephrase" && (
          <>
            <MenuBack label={t("compose.aiRephrase")} onClick={() => setPage("root")} />
            <MenuRow icon={RefreshCw} label={t("compose.aiRephraseFree")} onClick={run(() => onRephrase("free"))} dataRef="compose-ai-rephrase-free" />
            <MenuRow icon={Smile} label={t("compose.aiRephraseFriendly")} onClick={run(() => onRephrase("friendly"))} dataRef="compose-ai-rephrase-friendly" />
            <MenuRow icon={Briefcase} label={t("compose.aiRephraseProfessional")} onClick={run(() => onRephrase("professional"))} dataRef="compose-ai-rephrase-professional" />
          </>
        )}
        {page === "translate" && (
          <>
            <MenuBack label={t("compose.translate")} onClick={() => setPage("root")} />
            {TRANSLATE_TARGETS.map((lang) => (
              <MenuRow
                key={lang}
                label={t(`compose.translate.${lang}`)}
                onClick={run(() => onTranslate(lang))}
                dataRef={`compose-editor-translate-${lang}`}
              />
            ))}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// Menu "⋮" de la rangee du bas, a droite (a la place de l'ancienne etoile IA,
// choix utilisateur carte e339f1) : « Assistant IA › » en tete, puis
// programmer l'envoi, signature, historique cite, supprimer le brouillon.
function ComposeMoreMenu({
  aiMenu,
  aiBusy,
  sending,
  signature,
  quote,
  onSchedule,
  onScheduleCustom,
  onSignatureInsert,
  onSignatureEdit,
  onSignatureRemove,
  onQuoteToggle,
  onQuoteRemove,
  onQuoteRestore,
  onDelete,
  t,
}: {
  /** Ligne « Assistant IA › » (ComposeAiMenu), recoit de quoi refermer ce menu. */
  aiMenu?: (close: () => void) => ReactNode;
  /** Une action IA tourne : le bouton ⋮ montre la roue. */
  aiBusy?: boolean;
  sending: boolean;
  signature: "present" | "available" | "none";
  quote: "shown" | "hidden" | "removed" | "none";
  onSchedule: (iso: string) => void;
  onScheduleCustom: () => void;
  onSignatureInsert: () => void;
  onSignatureEdit: () => void;
  onSignatureRemove: () => void;
  onQuoteToggle: () => void;
  onQuoteRemove: () => void;
  onQuoteRestore: () => void;
  onDelete: () => void;
  t: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"root" | "schedule">("root");
  const run = (fn: () => void) => () => { setOpen(false); fn(); };
  const presets = [
    { key: "tomorrow", label: t("compose.presetTomorrowMorning"), get: presetTomorrowMorning },
    { key: "evening", label: t("compose.presetThisEvening"), get: presetThisEvening },
    { key: "monday", label: t("compose.presetMondayMorning"), get: presetNextMondayMorning },
  ];
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setPage("root");
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("compose.moreOptions")}
          title={t("compose.moreOptions")}
          data-ref="compose-form-more"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-foreground shadow-xs transition-colors hover:bg-accent data-[state=open]:bg-muted"
        >
          {aiBusy ? <Loader2 className="size-[1.15rem] animate-spin" /> : <MoreVertical className="size-[1.15rem]" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className={menuContentClass}
        data-ref="compose-more-menu"
      >
        {page === "root" && (
          <>
            {aiMenu && (
              <>
                {aiMenu(() => setOpen(false))}
                <div className="bg-border mx-2 my-1 h-px" aria-hidden />
              </>
            )}
            <MenuRow icon={Clock} label={t("compose.scheduleSend")} onClick={() => setPage("schedule")} disabled={sending} chevron dataRef="compose-form-schedule" />
            {signature === "present" && (
              <>
                <MenuRow icon={Pen} label={t("compose.editSignature")} onClick={run(onSignatureEdit)} dataRef="compose-signature-edit" />
                <MenuRow icon={X} label={t("compose.removeSignatureShort")} onClick={run(onSignatureRemove)} dataRef="compose-signature-remove" />
              </>
            )}
            {signature === "available" && (
              <MenuRow icon={Pen} label={t("compose.insertSignature")} onClick={run(onSignatureInsert)} dataRef="compose-signature-insert" />
            )}
            {signature === "none" && (
              <MenuRow icon={Pen} label={t("compose.addSignature")} onClick={run(onSignatureEdit)} dataRef="compose-signature-add" />
            )}
            {(quote === "shown" || quote === "hidden") && (
              <>
                <MenuRow
                  icon={MessageSquareQuote}
                  label={quote === "shown" ? t("compose.hideQuoted") : t("compose.showQuoted")}
                  onClick={run(onQuoteToggle)}
                  dataRef="compose-quoted-toggle-menu"
                />
                <MenuRow icon={X} label={t("compose.removeQuoted")} onClick={run(onQuoteRemove)} dataRef="compose-quoted-remove" />
              </>
            )}
            {quote === "removed" && (
              <MenuRow icon={MessageSquareQuote} label={t("compose.restoreQuoted")} onClick={run(onQuoteRestore)} dataRef="compose-quoted-restore" />
            )}
            <div className="bg-border mx-2 my-1 h-px" aria-hidden />
            <MenuRow icon={Trash2} label={t("compose.delete")} onClick={run(onDelete)} danger dataRef="compose-form-delete" />
          </>
        )}
        {page === "schedule" && (
          <>
            <MenuBack label={t("compose.scheduleSend")} onClick={() => setPage("root")} />
            {presets.map((p) => (
              <MenuRow
                key={p.key}
                icon={Clock}
                label={p.label}
                onClick={run(() => onSchedule(p.get().toISOString()))}
                dataRef={`compose-schedule-${p.key}`}
              />
            ))}
            <MenuRow icon={CalendarClock} label={t("compose.presetCustom")} onClick={run(onScheduleCustom)} dataRef="compose-schedule-custom" />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function getComposeModeTitle(mode: ComposeMode, t: (key: string) => string): string {
  switch (mode) {
    case "reply":
      return t("compose.reply");
    case "reply-all":
      return t("compose.replyAll");
    case "forward":
      return t("compose.forward");
    case "edit":
      return t("compose.editDraft");
    default:
      return t("newMessage");
  }
}

function HoverPreview({ children, content }: { children: ReactNode; content: ReactNode }) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const handleEnter = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ x: rect.left + rect.width / 2, y: rect.top });
    setShow(true);
  }, []);

  return (
    <div
      ref={triggerRef}
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && createPortal(
        <div
          className="bg-popover text-popover-foreground pointer-events-none fixed z-[100] max-w-[280px] -translate-x-1/2 -translate-y-full rounded-lg border p-2 shadow-lg"
          style={{ left: pos.x, top: pos.y - 8 }}
        >
          {content}
        </div>,
        document.body
      )}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

// --- Positionnement multi-fenetres ---

// Fenetre de redaction sur ordinateur : taille INTERMEDIAIRE (720x720, 800 avec
// pieces jointes), entre l'ancienne 500x520 jugee trop petite et la 1000x1040
// jugee envahissante (choix de l'utilisateur, 2026-10-17). Toujours bornee a
// l'ecran (cf ComposePanel) et redimensionnable a la main. Deux fenetres
// tiennent cote a cote au-dela de ~1500 px de large ; en dessous, elles passent
// en mode empile (compressed).
const PANEL_WIDTH = 720;
const PANEL_DEFAULT_HEIGHT = 720;
const PANEL_DEFAULT_HEIGHT_FILES = 800;
const PANEL_GAP = 8;
const RIGHT_MARGIN = 24;
const STACK_OFFSET = 50;
// Base z-index des fenetres de composition. Doit rester AU-DESSUS du tiroir de
// reponse inline du panneau de lecture (ReplyBox -> Drawer vaul, z-50) : une
// fenetre de composition flottante est toujours au premier plan, sinon elle se
// retrouve prise en sandwich derriere le tiroir (barre de titre + pied qui
// depassent, milieu masque = superposition illisible en bas a droite).
const Z_BASE = 60;

interface PanelPosition {
  right: number;
  zIndex: number;
  compressed: boolean;
}

// Marge entre le panneau de l'assistant IA (ouvert a droite, desktop) et la
// premiere fenetre de composition rangee a sa gauche.
const AI_CHAT_GAP = 12;

function calculatePositions(
  count: number,
  viewportWidth: number,
  focusedIndex: number,
  hoveredIndex: number,
  rightOffset = 0
): PanelPosition[] {
  if (count === 0) return [];
  // Quand le chat IA est ouvert, tout le dock glisse a sa gauche : on raisonne
  // sur la largeur restante puis on decale chaque `right` du meme offset.
  if (rightOffset > 0) {
    return calculatePositions(count, Math.max(0, viewportWidth - rightOffset), focusedIndex, hoveredIndex).map(
      (p) => ({ ...p, right: p.right - RIGHT_MARGIN + rightOffset + AI_CHAT_GAP })
    );
  }

  const totalWidth = RIGHT_MARGIN + count * PANEL_WIDTH + Math.max(0, count - 1) * PANEL_GAP;
  const isCompressed = totalWidth > viewportWidth;

  return Array.from({ length: count }, (_, i) => {
    // reverseI: 0 = plus recent (droite), count-1 = plus ancien (gauche)
    const reverseI = count - 1 - i;

    if (!isCompressed) {
      let zIndex = Z_BASE + i;
      // Meme en mode non-compresse, la fenetre focusee reste au premier plan
      if (focusedIndex >= 0 && i === focusedIndex) {
        zIndex = Z_BASE + count + 5;
      }
      return {
        right: RIGHT_MARGIN + reverseI * (PANEL_WIDTH + PANEL_GAP),
        zIndex,
        compressed: false,
      };
    }

    // Mode compresse : empilement avec decalage
    const right = RIGHT_MARGIN + reverseI * STACK_OFFSET;
    let zIndex = Z_BASE + i;

    // La fenetre focusee a un z-index eleve
    if (focusedIndex >= 0 && i === focusedIndex) {
      zIndex = Z_BASE + count + 5;
    }

    // Au survol : monter encore plus haut que le focus
    if (hoveredIndex >= 0 && i === hoveredIndex) {
      zIndex = Z_BASE + count + 10;
    }

    return { right, zIndex, compressed: true };
  });
}

// Historique cite (reponse) / message transfere, rendu SOUS le texte : une
// pastille "•••" discrete le deplie ou le replie (comme Gmail) ; le menu "⋮"
// le pilote aussi et permet de le retirer. Lecture seule ; son contenu est
// concatene au corps a l'envoi.
function QuotedHistory({
  html,
  open,
  onToggle,
  t,
}: {
  html: string;
  open: boolean;
  onToggle: () => void;
  t: (key: string) => string;
}) {
  // Affichage seulement : les images citees passent par le proxy (verifiees,
  // redessinees, jamais demandees a l'expediteur). Le HTML envoye, lui,
  // garde les adresses d'origine pour le destinataire.
  const remoteUrls = useMemo(() => collectRemoteImageUrls(html), [html]);
  const imagesReady = useProxiedImages(remoteUrls);
  const safe = useMemo(
    () => sanitizeHtml(html, { proxyImageSrc: proxiedImageSrc, trustedImageSrc: isPocketBaseFileUrl }),
    // imagesReady : re-rendu une fois les URL du proxy signees.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, imagesReady]
  );
  return (
    <div data-ref="compose-quoted-history" className="flex cursor-auto flex-col items-start gap-2 px-2">
      <button
        type="button"
        onClick={onToggle}
        className="bg-muted text-muted-foreground hover:text-foreground inline-flex h-5 items-center rounded-full px-2 transition-colors"
        data-ref="compose-quoted-toggle"
        aria-expanded={open}
        aria-label={open ? t("compose.hideQuoted") : t("compose.showQuoted")}
        title={open ? t("compose.hideQuoted") : t("compose.showQuoted")}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div
          data-ref="compose-quoted-content"
          className="prose prose-sm dark:prose-invert text-muted-foreground border-border max-h-64 w-full max-w-none overflow-y-auto border-l-2 pl-3 text-[0.8125rem]"
          dangerouslySetInnerHTML={{ __html: safe }}
        />
      )}
    </div>
  );
}

// Signature de l'adresse d'envoi, rendue SOUS le texte en gris clair (lecture
// seule) et concatenee au corps a l'auto-save et a l'envoi (lib/signature.ts).
// L'ajouter, la modifier ou la retirer se fait dans le menu "⋮".
function ComposeSignature({ html }: { html: string }) {
  const safe = useMemo(() => sanitizeHtml(html, { allowExternalImages: true }), [html]);
  return (
    <div
      data-ref="compose-signature"
      className="text-muted-foreground max-h-48 overflow-hidden px-3 text-[0.8125rem] leading-normal opacity-80 [&_img]:max-w-full [&_p]:m-0"
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

// --- ComposeForm ---

// Bloc repliable de la bande d'en-tete : hauteur animee par grid-template-rows
// (0fr <-> 1fr, pas de hauteur mesuree). Ferme = `inert` (ni tab ni lecteur
// d'ecran). Le padding interne des enfants (p-1) garde les anneaux de focus
// visibles malgre l'overflow-hidden de l'animation.
function HeaderFold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      )}
      inert={!open}
      aria-hidden={!open || undefined}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

interface ComposeFormProps {
  mode: ComposeMode;
  messageId: string | null;
  initialTo: string | null;
  onClose: () => void;
  onMetaChange?: (label: string) => void;
  onHasFiles?: (hasFiles: boolean) => void;
  // Signale s'il y a un contenu de brouillon persiste (destinataire/objet/corps
  // ou piece jointe) : sert a n'afficher le message "brouillon enregistre" que
  // lorsqu'il y a effectivement quelque chose a retrouver.
  onHasContent?: (hasContent: boolean) => void;
  // Emplacement de l'en-tete de la fenetre (tiroir du telephone, barre de
  // titre de l'ordinateur) ou se range le menu "⋮" et le temoin d'enregistrement.
}

// --- Helpers envoi programme ---
// Valeur pour un <input type="datetime-local"> (heure LOCALE, sans timezone).
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function presetTomorrowMorning(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}
function presetThisEvening(): Date {
  const d = new Date();
  d.setHours(18, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}
function presetNextMondayMorning(): Date {
  const d = new Date();
  d.setHours(8, 0, 0, 0);
  let add = (1 - d.getDay() + 7) % 7;
  if (add === 0) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

// Choisir le compte expediteur d'une reponse/transfert = celui dont l'adresse
// etait la CIBLE du mail recu (To puis Cc). Ex : un mail adresse a
// chrisdupont@gmail.com (meme si le nom affiche est "Haiko") doit se
// repondre DEPUIS ce compte, pas depuis le compte actif/premier de la liste.
// Repli sur le compte de reception du message si aucune adresse ne correspond.
// Reponse a MON propre message : le compte qui l'a envoye.
function resolveReplyFromAccountId(msg: Message, accounts: Account[]): string | null {
  const norm = (s?: string) => (s ?? "").trim().toLowerCase();
  const byEmail = new Map(accounts.map((a) => [norm(a.email), a.id] as const));
  const sender = byEmail.get(norm(msg.from_address?.address));
  if (sender) return sender;
  const pick = (list?: EmailAddress[]) => {
    for (const addr of list ?? []) {
      const id = byEmail.get(norm(addr.address));
      if (id) return id;
    }
    return null;
  };
  return (
    pick(msg.to_addresses) ??
    pick(msg.cc_addresses) ??
    (accounts.some((a) => a.id === msg.account) ? msg.account : null)
  );
}

function ComposeForm({ mode, messageId, initialTo, onClose, onMetaChange, onHasFiles, onHasContent }: ComposeFormProps) {
  const iaDispo = useIaDisponible();
  const t = useT();
  const language = useSettingsStore((s) => s.language);
  const editorRef = useRef<Editor | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const { accounts: accs } = useAccounts();
  // Modele du menu IA (ligne "Modele"), envoye a chaque action IA de la fenetre.
  const aiModel = useAiComposeModel((s) => s.model);
  const [fromAccountId, setFromAccountId] = useState(
    activeAccountId && activeAccountId !== "all" ? activeAccountId : ""
  );

  // Selectionner le premier compte si aucun n'est choisi
  useEffect(() => {
    if (!fromAccountId && accs.length > 0) {
      setFromAccountId(accs[0].id);
    }
  }, [accs, fromAccountId]);

  const [to, setTo] = useState(initialTo ?? "");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // Historique cite (reponse) / message transfere, garde SEPARE du corps redige
  // et concatene a l'envoi/l'auto-save. Construit une seule fois par instance.
  const [quotedHtml, setQuotedHtml] = useState("");
  const quoteBuiltRef = useRef(false);
  // Signature de l'adresse d'envoi, gardee HORS du corps redige (comme la
  // citation). `signatureAccountRef` = compte dont la signature est posee ;
  // `signatureRemovedRef` = l'utilisateur l'a retiree de CE message (ou le
  // brouillon rouvert n'en avait pas) : plus jamais reposee automatiquement.
  const [signatureHtml, setSignatureHtml] = useState("");
  const signatureAccountRef = useRef<string | null>(null);
  const signatureRemovedRef = useRef(false);
  // Compte expediteur d'une reponse/transfert resolu une seule fois par instance
  // (adresse cible du mail recu), pour ne pas ecraser un choix manuel ulterieur.
  const fromResolvedRef = useRef(false);
  const [showCcBcc, setShowCcBcc] = useState(false);
  // Nom affiche de chaque adresse pre-remplie (cle en minuscules) : les
  // champs A/Cc/Cci ne portent que des adresses, l'etiquette montre le nom.
  const [recipientNames, setRecipientNames] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [savedAttachments, setSavedAttachments] = useState<SavedAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const [replyMsg, setReplyMsg] = useState<Message | null>(null);
  // Brouillon rouvert (mode edit) issu d'un transfert : pas de References.
  const [editIsForward, setEditIsForward] = useState(false);
  const [editDraftId, setEditDraftId] = useState<string | null>(
    mode === "edit" ? messageId : null
  );
  const [draftLoaded, setDraftLoaded] = useState(mode !== "edit");

  // Envoi programme ("envoyer plus tard")
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [scheduleInput, setScheduleInput] = useState("");

  const { saveDraft, flushSave, deleteDraft, clearDraftState, draftId, sourceId, uploadFiles, removeAttachment, notifyAttachmentsChange } = useAutoSave({
    accountId: fromAccountId || undefined,
    initialDraftId: editDraftId,
    // Reponse/transfert : rattacher le brouillon a la conversation d'origine
    // (thread_id + in_reply_to) pour qu'il ne soit pas detache du thread.
    threadId: replyMsg?.thread_id || undefined,
    replyTo: replyMsg?.message_id || undefined,
  });

  // Flag pour eviter les boucles infinies : sync externe -> setState -> auto-save -> sync
  const skipNextSaveRef = useRef(false);

  // Sync bidirectionnel du brouillon avec les autres editeurs (ReplyBox, etc.)
  useDraftSync(draftId, sourceId, {
    onContentUpdate: useCallback(({ data, attachments, fromAccountId: newAccountId }) => {
      skipNextSaveRef.current = true;
      if (data.html_body !== undefined) {
        // Le corps synchronise porte signature + citation : on ne remet dans
        // l'editeur que la partie redigee.
        const bodyOnly = splitSignature(splitQuotedBody(data.html_body).body).body;
        setBody(bodyOnly);
        editorRef.current?.commands.setContent(bodyOnly);
      }
      if (data.subject !== undefined) setSubject(data.subject);
      setRecipientNames((prev) => ({
        ...prev,
        ...messageAddressNames({
          to_addresses: data.to_addresses,
          cc_addresses: data.cc_addresses,
          bcc_addresses: data.bcc_addresses,
        }),
      }));
      if (data.to_addresses) {
        setTo(data.to_addresses.map((a) => a.address).join(", "));
      }
      if (data.cc_addresses) {
        const ccVal = data.cc_addresses.map((a) => a.address).join(", ");
        setCc(ccVal);
        if (ccVal) setShowCcBcc(true);
      }
      if (data.bcc_addresses) {
        const bccVal = data.bcc_addresses.map((a) => a.address).join(", ");
        setBcc(bccVal);
        if (bccVal) setShowCcBcc(true);
      }
      if (newAccountId) setFromAccountId(newAccountId);
      if (attachments) setSavedAttachments(attachments);
    }, []),
    onDeleted: useCallback(() => {
      onClose();
    }, [onClose]),
    onSent: useCallback(() => {
      onClose();
    }, [onClose]),
  });

  // Charger le brouillon en mode edit
  useEffect(() => {
    if (mode !== "edit" || !messageId) return;

    async function loadDraft() {
      try {
        const msg = await messages().getOne<Message>(messageId!);
        setRecipientNames((prev) => ({ ...prev, ...messageAddressNames(msg) }));
        setTo((msg.to_addresses ?? []).map((a) => a.address).join(", "));
        const ccList = (msg.cc_addresses ?? []).map((a) => a.address).join(", ");
        const bccList = (msg.bcc_addresses ?? []).map((a) => a.address).join(", ");
        if (ccList || bccList) {
          setCc(ccList);
          setBcc(bccList);
          setShowCcBcc(true);
        }
        setSubject(msg.subject ?? "");
        // Re-separer la partie redigee du bloc cite (round-trip brouillon).
        const split = splitQuotedBody(msg.html_body || msg.text_body || "");
        // Puis la signature (jamais reposee une seconde fois au rechargement).
        const sigSplit = splitSignature(split.body);
        setBody(sigSplit.body);
        setSignatureHtml(sigSplit.signature);
        signatureAccountRef.current = msg.account || null;
        if (!sigSplit.signature) signatureRemovedRef.current = true;
        if (split.quote) {
          setQuotedHtml(split.quote);
          quoteBuiltRef.current = true;
        }
        if (msg.account) setFromAccountId(msg.account);
        setEditDraftId(msg.id);

        // Brouillon de REPONSE rouvert : retrouver le message parent pour que
        // l'envoi garde In-Reply-To / References / thread_id. Sans ca, l'envoi
        // repartait avec ces champs vides et la reponse atterrissait dans un
        // fil a part (invisible dans la conversation d'origine).
        const parentMid = msg.in_reply_to || msg.draft_reply_to || "";
        if (parentMid) {
          try {
            const parent = await messages().getFirstListItem<Message>(
              `message_id = "${parentMid.replace(/"/g, '\\"')}" && is_draft = false`,
              { sort: "-date" }
            );
            setEditIsForward(/^(fwd?|tr)\s*:/i.test(msg.subject ?? ""));
            setReplyMsg(parent);
          } catch {
            // Parent introuvable : le worker recolle le lien a l'envoi.
          }
        }
        if (msg.scheduled_at) setScheduledAt(msg.scheduled_at);

        // Charger les pieces jointes existantes du brouillon
        if (msg.has_attachments) {
          try {
            const atts = await attachmentsCollection().getFullList<import("@/lib/pocketbase").Attachment>({
              filter: `message="${msg.id}"`,
            });
            setSavedAttachments(atts.map((a) => ({
              id: a.id,
              filename: a.filename,
              size: a.size,
              file: a.file,
              is_inline: a.is_inline,
            })));
          } catch {
            // Erreur silencieuse
          }
        }

        setDraftLoaded(true);
      } catch {
        setDraftLoaded(true);
      }
    }

    loadDraft();
  }, [messageId, mode]);

  // Pre-remplir si reply/forward
  useEffect(() => {
    if (!messageId || mode === "edit") return;

    async function loadReplyMessage() {
      try {
        const msg = await messages().getOne<Message>(messageId!);
        setReplyMsg(msg);

        // Repondre DEPUIS l'adresse qui etait la cible du mail recu (une seule
        // fois par instance ; accs peut etre vide au premier rendu -> l'effet
        // se re-declenche quand les comptes sont charges).
        if (!fromResolvedRef.current && accs.length > 0) {
          const resolved = resolveReplyFromAccountId(msg, accs);
          if (resolved) {
            fromResolvedRef.current = true;
            setFromAccountId(resolved);
          }
        }

        // Bloc cite construit une seule fois (evite d'ecraser une suppression
        // ou une edition si l'effet se re-declenche sur changement de compte).
        const buildQuote = (fn: typeof buildReplyQuote) => {
          if (quoteBuiltRef.current) return;
          quoteBuiltRef.current = true;
          setQuotedHtml(fn(msg, language));
        };

        switch (mode) {
          case "reply":
          case "reply-all": {
            // "Repondre" et "Repondre a tous" reprennent la MEME configuration
            // (choix utilisateur 2026-10-20) : message recu = auteur + autres A
            // en "A", copies en "Cc" ; mon propre message = ses destinataires
            // d'origine. Aucune de mes adresses (tous comptes), sans doublon.
            const r = replyAllRecipients(msg, accs.map((a) => a.email || ""));
            setRecipientNames((prev) => ({ ...prev, ...messageAddressNames(msg) }));
            setTo(r.to.join(", "));
            if (r.cc.length > 0) {
              setCc(r.cc.join(", "));
              setShowCcBcc(true);
            }
            setSubject(`Re: ${(msg.subject ?? "").replace(/^Re:\s*/i, "")}`);
            buildQuote(buildReplyQuote);
            break;
          }
          case "forward":
            setSubject(`Fwd: ${(msg.subject ?? "").replace(/^Fwd:\s*/i, "")}`);
            buildQuote(buildForwardQuote);
            break;
        }
      } catch {
        // Erreur silencieuse
      }
    }

    loadReplyMessage();
  }, [messageId, mode, accs, fromAccountId, language]);

  // Mettre a jour le label de la barre de titre
  useEffect(() => {
    if (!onMetaChange) return;
    if (subject.trim()) {
      onMetaChange(subject.trim());
    } else {
      const firstRecipient = to.split(",")[0]?.trim();
      if (firstRecipient) {
        onMetaChange(recipientNames[firstRecipient.toLowerCase()] || firstRecipient);
      } else {
        onMetaChange(getComposeModeTitle(mode, t));
      }
    }
  }, [subject, to, recipientNames, mode, onMetaChange, t]);

  // Construire les donnees du brouillon a partir de l'etat courant
  const buildDraftData = useCallback(
    (currentBody: string): DraftData => ({
      to_addresses: to.split(",").map((s) => s.trim()).filter(Boolean).map((a) => ({ address: a })),
      cc_addresses: cc ? cc.split(",").map((s) => s.trim()).filter(Boolean).map((a) => ({ address: a })) : undefined,
      bcc_addresses: bcc ? bcc.split(",").map((s) => s.trim()).filter(Boolean).map((a) => ({ address: a })) : undefined,
      subject,
      html_body: joinQuotedBody(joinSignature(currentBody, signatureHtml), quotedHtml),
    }),
    [to, cc, bcc, subject, quotedHtml, signatureHtml]
  );

  // Signature automatique : posee a l'ouverture (nouveau message, reponse,
  // transfert) et REMPLACEE quand l'adresse d'envoi change. Le texte tape vit
  // dans l'editeur, il n'est jamais touche. Une signature creee pendant que le
  // brouillon est ouvert (lien "Ajouter une signature") y apparait aussi.
  const fromAccount = accs.find((a) => a.id === fromAccountId);
  const fromAccountSignature = accountSignature(fromAccount);
  useEffect(() => {
    if (!draftLoaded || !fromAccount) return;
    if (signatureRemovedRef.current) return;
    if (signatureAccountRef.current === fromAccount.id && signatureHtml) return;
    signatureAccountRef.current = fromAccount.id;
    setSignatureHtml(fromAccountSignature);
  }, [draftLoaded, fromAccount, fromAccountSignature, signatureHtml]);

  const openSignatureSettings = useCallback(() => {
    void flushSave();
    hashNavigate(`/settings?tab=signatures${fromAccountId ? `&account=${fromAccountId}` : ""}`);
  }, [flushSave, fromAccountId]);

  // Auto-save unifie (inclut fromAccountId pour sync du compte expediteur)
  const skipInitialSaveRef = useRef(mode === "edit");
  useEffect(() => {
    if (!to && !cc && !bcc && !subject && !body) return;
    if (skipInitialSaveRef.current) {
      skipInitialSaveRef.current = false;
      return;
    }
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    saveDraft(buildDraftData(body));
  }, [to, cc, bcc, subject, body, fromAccountId, saveDraft, buildDraftData]);

  // Callback pour les changements du body via TipTap
  const handleBodyChange = useCallback(
    (html: string) => {
      setBody(html);
      setUndoAi((u) => (u && Date.now() - u.at > 800 ? null : u));
    },
    []
  );

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        const newFiles = Array.from(e.target.files);
        setFiles((prev) => [...prev, ...newFiles]);
        const uploaded = await uploadFiles(newFiles);
        if (uploaded.length > 0) {
          setSavedAttachments((prev) => {
            const next = [...prev, ...uploaded];
            notifyAttachmentsChange(next);
            return next;
          });
        }
        // Toujours retirer les fichiers pending (uploades ou en erreur)
        setFiles((prev) => prev.filter((f) => !newFiles.includes(f)));
      }
    },
    [uploadFiles, notifyAttachmentsChange]
  );

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleFormDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  }, []);

  const handleFormDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleFormDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleFormDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        const newFiles = Array.from(e.dataTransfer.files);
        setFiles((prev) => [...prev, ...newFiles]);
        const uploaded = await uploadFiles(newFiles);
        if (uploaded.length > 0) {
          setSavedAttachments((prev) => {
            const next = [...prev, ...uploaded];
            notifyAttachmentsChange(next);
            return next;
          });
        }
        setFiles((prev) => prev.filter((f) => !newFiles.includes(f)));
      }
    },
    [uploadFiles, notifyAttachmentsChange]
  );

  // Image placee dans le texte : enregistree comme piece jointe "integree",
  // listee avec les autres, et adressee par son URL servie (remplacee par
  // cid: a l'envoi, cote worker).
  const handleEditorImageUpload = useCallback(
    async (file: File): Promise<string | null> => {
      const uploaded = await uploadFiles([file], { inline: true });
      const att = uploaded[0];
      if (!att?.file) return null;
      setSavedAttachments((prev) => {
        const next = [...prev, ...uploaded];
        notifyAttachmentsChange(next);
        return next;
      });
      return getFileUrl({ id: att.id, collectionId: "", collectionName: "attachments" }, att.file);
    },
    [uploadFiles, notifyAttachmentsChange]
  );

  const handleEditorFileDrop = useCallback(
    async (droppedFiles: File[]) => {
      setFiles((prev) => [...prev, ...droppedFiles]);
      const uploaded = await uploadFiles(droppedFiles);
      if (uploaded.length > 0) {
        setSavedAttachments((prev) => {
          const next = [...prev, ...uploaded];
          notifyAttachmentsChange(next);
          return next;
        });
      }
      setFiles((prev) => prev.filter((f) => !droppedFiles.includes(f)));
    },
    [uploadFiles, notifyAttachmentsChange]
  );

  const removeSavedAttachment = useCallback(async (attachmentId: string) => {
    // Une image placee dans le texte disparait aussi du texte (sinon image
    // cassee chez le destinataire).
    const ed = editorRef.current;
    if (ed) {
      const marker = `/${attachmentId}/`;
      const positions: { pos: number; size: number }[] = [];
      ed.state.doc.descendants((n, pos) => {
        if (n.type.name === "image" && String(n.attrs.src || "").includes(marker)) positions.push({ pos, size: n.nodeSize });
      });
      if (positions.length) {
        const tr = ed.state.tr;
        for (const p of positions.reverse()) tr.delete(p.pos, p.pos + p.size);
        ed.view.dispatch(tr);
      }
    }
    await removeAttachment(attachmentId);
    setSavedAttachments((prev) => {
      const next = prev.filter((a) => a.id !== attachmentId);
      notifyAttachmentsChange(next);
      return next;
    });
  }, [removeAttachment, notifyAttachmentsChange]);

  // Object URLs pour l'apercu des images
  const filePreviewUrls = useMemo(() => {
    return files.map((file) =>
      file.type.startsWith("image/") ? URL.createObjectURL(file) : null
    );
  }, [files]);

  useEffect(() => {
    return () => {
      filePreviewUrls.forEach((url) => {
        if (url) URL.revokeObjectURL(url);
      });
    };
  }, [filePreviewUrls]);

  useEffect(() => {
    onHasFiles?.(files.length > 0 || savedAttachments.length > 0);
  }, [files.length, savedAttachments.length, onHasFiles]);

  useEffect(() => {
    const hasContent =
      to.trim().length > 0 ||
      cc.trim().length > 0 ||
      bcc.trim().length > 0 ||
      subject.trim().length > 0 ||
      body.replace(/<[^>]*>/g, "").trim().length > 0 ||
      files.length > 0 ||
      savedAttachments.length > 0;
    onHasContent?.(hasContent);
  }, [to, cc, bcc, subject, body, files.length, savedAttachments.length, onHasContent]);

  // Drag-and-drop pour reordonner les fichiers
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragOverRef = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const gridGeoRef = useRef<{ cols: number; cellW: number; cellH: number } | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    dragOverRef.current = null;
    e.dataTransfer.setData("text/plain", "");
    e.dataTransfer.effectAllowed = "move";
    const grid = gridRef.current;
    if (grid && grid.children.length > 0) {
      const gap = parseFloat(getComputedStyle(grid).gap) || 8;
      const child = (grid.children[0] as HTMLElement).getBoundingClientRect();
      const cellW = child.width + gap;
      const cellH = child.height + gap;
      const cols = Math.max(1, Math.floor((grid.getBoundingClientRect().width + gap) / cellW));
      gridGeoRef.current = { cols, cellW, cellH };
    }
  }, []);

  const handleGridDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (dragIndex !== null) e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (dragIndex === null || !gridGeoRef.current) return;
    const geo = gridGeoRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const col = Math.min(Math.max(0, Math.floor((e.clientX - rect.left) / geo.cellW)), geo.cols - 1);
    const row = Math.max(0, Math.floor((e.clientY - rect.top) / geo.cellH));
    const index = Math.min(Math.max(0, row * geo.cols + col), savedAttachments.length - 1);
    if (index !== dragOverRef.current) {
      dragOverRef.current = index;
      setDragOverIndex(index);
    }
  }, [dragIndex, savedAttachments.length]);

  const handleDropReorder = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const from = dragIndex;
    const to = dragOverRef.current;
    setDragIndex(null);
    setDragOverIndex(null);
    dragOverRef.current = null;
    gridGeoRef.current = null;
    if (from === null || to === null || from === to) return;
    setSavedAttachments((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, [dragIndex]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
    dragOverRef.current = null;
    gridGeoRef.current = null;
  }, []);

  const [sending, setSending] = useState(false);
  // Champ IA en cours d'analyse : "subject"/"body" (correction) ou "suggest"
  // (suggestion de ton). Sert a n'afficher le spinner QUE sur le bouton clique
  // (sinon tous les boutons IA tournent en meme temps, cf partage d'un seul
  // booleen). aiLoading reste derive pour la logique de desactivation globale.
  const [aiField, setAiField] = useState<"subject" | "body" | "all" | "suggest" | "translate" | "summary" | null>(null);
  const aiLoading = aiField !== null;
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [correctionData, setCorrectionData] = useState<{
    originalHtml: string;
    correctedHtml: string;
    originalSubject: string;
    correctedSubject: string;
  } | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [subjectAccepted, setSubjectAccepted] = useState(true);
  const diff = useMemo(() => {
    if (!correctionData) return null;
    return computeDiff(correctionData.originalHtml, correctionData.correctedHtml);
  }, [correctionData]);

  const subjectChanged = correctionData
    ? (!!correctionData.correctedSubject && correctionData.correctedSubject !== correctionData.originalSubject)
    : false;

  const totalCorrections = (diff?.corrections.length ?? 0) + (subjectChanged ? 1 : 0);
  const acceptedCount = accepted.size + (subjectAccepted && subjectChanged ? 1 : 0);

  useEffect(() => {
    if (correctionData) {
      const d = computeDiff(correctionData.originalHtml, correctionData.correctedHtml);
      setAccepted(new Set(d.corrections.map((c) => c.id)));
      setSubjectAccepted(true);
    }
  }, [correctionData]);
  const invalidateMessages = useMailStore((s) => s.invalidateMessages);

  // "Revenir au texte d'avant" : une action IA qui REMPLACE le texte
  // (reformuler, raccourcir, traduire, reponse redigee) garde le texte
  // precedent. Le bouton disparait a la frappe suivante (garde de 800 ms : le
  // remplacement lui-meme declenche une mise a jour de l'editeur).
  const [undoAi, setUndoAi] = useState<{ html: string; at: number } | null>(null);
  const replaceBodyByAi = useCallback((html: string, previous: string) => {
    setUndoAi({ html: previous, at: Date.now() });
    editorRef.current?.commands.setContent(html);
    setBody(html);
  }, []);
  const revertAi = useCallback(() => {
    if (!undoAi) return;
    editorRef.current?.commands.setContent(undoAi.html);
    setBody(undoAi.html);
    setUndoAi(null);
  }, [undoAi]);

  // Reformuler (libre / plus amical / plus professionnel) et Raccourcir :
  // /api/ai/suggest en mode compose, DANS LA LANGUE DU TEXTE (keepLanguage).
  // Le texte n'est remplace qu'a la reussite ; une erreur le laisse intact.
  const handleAiRewrite = useCallback(async (kind: RephraseVariant | "shorten") => {
    if (!body.replace(/<[^>]*>/g, "").trim()) return;
    const previous = body;
    setAiField("suggest");
    try {
      const acc = accs.find((a) => a.id === fromAccountId);
      const customPrompt =
        kind === "shorten"
          ? "Raccourcis nettement ce brouillon (environ deux fois plus court) : garde chaque information utile, retire les repetitions et les formules superflues, garde le meme ton."
          : kind === "free"
            ? "Reformule ce brouillon avec d'autres mots, plus clair et plus fluide, en gardant le meme ton, le meme sens et toutes les informations."
            : undefined;
      const res = await fetch(`${LLM_URL}/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "compose" as const,
          subject: subject || "",
          draftContent: body,
          userName: acc?.display_name || acc?.email || "",
          language,
          keepLanguage: true,
          tone: kind === "friendly" ? "friendly" : "professional",
          apiKey: getOpenRouterKey(),
          userId: pb.authStore.record?.id,
          model: aiModel,
          ...(customPrompt ? { customPrompt } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || typeof data.reply !== "string" || !data.reply.trim()) throw new Error(data.error);
      replaceBodyByAi(data.reply, previous);
    } catch {
      toast.error(tStatic("compose.aiError"));
    } finally {
      setAiField(null);
    }
  }, [body, subject, language, fromAccountId, accs, aiModel, replaceBodyByAi]);

  // Reponse redigee par l'agent (bouton en bas a droite du champ, reponses
  // seulement) : /api/ai/reply-agent lit les 20 derniers echanges avec
  // l'auteur, etudie le style de l'utilisateur et redige dans la langue de
  // l'auteur. L'avancement arrive en flux (barre de progression). Le texte
  // deja tape sert de CONSIGNE ; il n'est remplace qu'a la reussite (annuler
  // ou echouer laisse le champ intact). Signature et citation vivent hors de
  // l'editeur (signatureHtml / quotedHtml) : setContent ne les touche pas.
  const isReplyContext = !!replyMsg && (mode === "reply" || mode === "reply-all" || (mode === "edit" && !editIsForward));

  // La conversation entiere (pas seulement le message ouvert) : l'IA doit
  // savoir qui a ecrit quoi et qui a ecrit EN DERNIER. Chargee une fois par
  // fil, bornee aux 30 messages les plus recents.
  const [threadMsgs, setThreadMsgs] = useState<Message[]>([]);
  const replyThreadId = isReplyContext ? replyMsg?.thread_id || "" : "";
  useEffect(() => {
    if (!replyThreadId) {
      setThreadMsgs([]);
      return;
    }
    let cancelled = false;
    messages()
      .getList<Message>(1, 30, {
        filter: `thread_id = "${replyThreadId.replace(/"/g, '\\"')}" && is_draft = false`,
        sort: "-date",
        fields:
          "id,message_id,thread_id,subject,date,from_address,to_addresses,cc_addresses,is_draft,is_sent,text_body,html_body:excerpt(1500)",
        skipTotal: true,
      })
      .then((res) => {
        if (!cancelled) setThreadMsgs(res.items);
      })
      .catch(() => {
        // Fil illisible : on retombe sur le seul message ouvert.
      });
    return () => {
      cancelled = true;
    };
  }, [replyThreadId]);

  const myAddrs = useMemo(() => accs.map((a) => (a.email || "").toLowerCase()).filter(Boolean), [accs]);
  const conversation = useMemo(() => {
    if (!replyMsg) return [];
    const withText = (m: Message): Message => ({
      ...m,
      text_body: m.text_body?.trim() ? m.text_body : (m.html_body || "").replace(/<[^>]*>/g, " "),
    });
    return [...threadMsgs, replyMsg].map(withText);
  }, [threadMsgs, replyMsg]);
  const replyTarget = useMemo(() => pickReplyTarget(conversation, myAddrs), [conversation, myAddrs]);
  const [aiReply, setAiReply] = useState<{ step: ReplyAgentStep; pct: number } | null>(null);
  const [aiReplyCreep, setAiReplyCreep] = useState(0);
  const aiReplyAbortRef = useRef<AbortController | null>(null);
  // Version francaise de LECTURE de la reponse (jamais dans `body`, donc jamais
  // envoyee ni auto-sauvee). Non nul = la reponse redigee n'est pas en francais.
  const [frView, setFrView] = useState<{ html: string; open: boolean; loading: boolean } | null>(null);

  // La barre avance doucement entre deux etapes (un appel IA peut durer 20 s).
  useEffect(() => {
    if (!aiReply) return;
    setAiReplyCreep(0);
    const id = window.setInterval(() => setAiReplyCreep((c) => Math.min(c + 0.6, 22)), 500);
    return () => window.clearInterval(id);
  }, [aiReply]);

  useEffect(() => () => aiReplyAbortRef.current?.abort(), []);

  const handleAiReply = useCallback(async () => {
    if (!replyMsg || aiReplyAbortRef.current) return;
    const ctrl = new AbortController();
    aiReplyAbortRef.current = ctrl;
    setAiReply({ step: "collect", pct: 2 });

    // Interlocuteur et message de reference tires de TOUTE la conversation :
    // l'autre a ecrit en dernier -> on repond a son dernier message ; c'est
    // moi -> relance de mon dernier envoi. Jamais mon propre texte presente
    // comme "le mail recu".
    const followup = replyTarget.mode === "followup";
    const ref = (followup ? replyTarget.lastMine : replyTarget.lastIncoming) || replyMsg;
    const fallbackSender =
      replyMsg.from_address?.address && !myAddrs.includes(replyMsg.from_address.address.toLowerCase())
        ? replyMsg.from_address
        : replyMsg.to_addresses?.find((a) => a?.address && !myAddrs.includes(a.address.toLowerCase())) || replyMsg.from_address;
    const sender = replyTarget.interlocutor || fallbackSender;
    const fromAcc = accs.find((a) => a.id === fromAccountId);
    const refText = ref.text_body || (ref.html_body || "").replace(/<[^>]*>/g, " ") || "";
    const original = (stripQuoted(refText) || refText).replace(/[ \t]+/g, " ").slice(0, 6000);

    try {
      const res = await fetch(`${LLM_URL}/reply-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          authToken: pb.authStore.token,
          userId: pb.authStore.record?.id,
          userName: fromAcc?.display_name || fromAcc?.email || "",
          subject: replyMsg.subject || "",
          originalMessage: original,
          originalDate: ref.date,
          sender: { name: sender?.name || "", address: sender?.address || "" },
          threadContext: formatThread(conversation, myAddrs),
          threadIds: conversation.map((m) => m.id),
          participants: conversationParticipants(conversation, myAddrs),
          mode: replyTarget.mode,
          model: aiModel,
          draftContent: body.trim() ? body : undefined,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: Extract<ReplyAgentEvent, { type: "done" }> | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBuffer(done ? `${buffer}\n\n` : buffer);
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          if (ev.type === "step") setAiReply({ step: ev.step, pct: ev.pct });
          else if (ev.type === "done") result = ev;
          else if (ev.type === "error") throw new Error(ev.message);
        }
        if (done) break;
      }
      if (!result?.html) throw new Error("empty reply");
      if (body.replace(/<[^>]*>/g, "").trim()) replaceBodyByAi(result.html, body);
      else {
        editorRef.current?.commands.setContent(result.html);
        setBody(result.html);
      }
      setFrView(
        result.language && result.language !== "fr"
          ? { html: result.translationFr || "", open: false, loading: false }
          : null
      );
    } catch (err) {
      if (!ctrl.signal.aborted) {
        console.warn("[reply-agent]", err);
        toast.error(tStatic("compose.aiReplyError"));
      }
    } finally {
      aiReplyAbortRef.current = null;
      setAiReply(null);
    }
  }, [replyMsg, replyTarget, conversation, myAddrs, aiModel, accs, fromAccountId, body, replaceBodyByAi]);

  const cancelAiReply = useCallback(() => {
    aiReplyAbortRef.current?.abort();
  }, []);

  // "Actualiser" du cadre francais : retraduit le texte COURANT (retouche).
  const refreshFrench = useCallback(async () => {
    if (!body.trim()) return;
    setFrView((v) => (v ? { ...v, open: true, loading: true } : v));
    try {
      const res = await fetch(`${LLM_URL}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: body, target: "fr", model: aiModel }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.html !== "string") throw new Error(data.error || "translate failed");
      setFrView((v) => (v ? { ...v, html: data.html as string, loading: false } : v));
    } catch {
      toast.error(tStatic("compose.translateError"));
      setFrView((v) => (v ? { ...v, loading: false } : v));
    }
  }, [body, aiModel]);

  // Bouton "Ameliorer avec l'IA" : corrige le message via l'IA en restant le PLUS
  // PROCHE POSSIBLE de l'original (orthographe/grammaire/ponctuation + tournures
  // reellement maladroites, sans reformuler ni changer le sens/ton/structure),
  // puis AFFICHE le diff (systeme de revue de corrections) pour que l'utilisateur
  // valide/rejette chaque changement. On passe par /api/ai/correct (qui preserve
  // le HTML) et NON /suggest (qui reecrit tout et casse la structure).
  //
  // SCOPE PAR CHAMP : l'analyse ne porte QUE sur le champ dont le bouton IA a ete
  // clique. Le bouton du sujet (scope "subject") n'envoie que l'objet et laisse le
  // corps intact ; le bouton de l'editeur (scope "body") n'envoie que le corps et
  // laisse l'objet intact. On ne corrige donc JAMAIS les deux d'un seul clic.
  // Menu IA > "Corriger" : scope "all" = l'objet ET le texte en une fois
  // (chacun seulement s'il n'est pas vide).
  const handleAiCorrect = useCallback(async (scope: "subject" | "body" | "all" = "body") => {
    if (correctionData) return;
    const wantSubject = scope !== "body" && !!subject.trim();
    const wantBody = scope !== "subject" && !!body.replace(/<[^>]*>/g, "").trim();
    if (!wantSubject && !wantBody) return;
    setAiField(scope);
    try {
      const res = await fetch(`${LLM_URL}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // On n'envoie que le champ demande ; l'autre reste vide pour que l'IA
          // n'y touche pas.
          subject: wantSubject ? subject || "" : "",
          body: wantBody ? body : "",
          language,
          apiKey: getOpenRouterKey(),
          model: aiModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Le champ non demande garde sa valeur d'origine (aucun diff propose).
      const correctedHtml =
        wantBody && typeof data.body === "string" && data.body ? data.body : body;
      const correctedSubject =
        wantSubject && typeof data.subject === "string" ? data.subject : subject || "";
      const subjChanged =
        wantSubject && !!correctedSubject && correctedSubject !== (subject || "");
      const d = computeDiff(body, correctedHtml);

      if (d.corrections.length === 0 && !subjChanged) {
        toast.success(tStatic("compose.noCorrections"));
        return;
      }

      setCorrectionData({
        originalHtml: body,
        correctedHtml,
        originalSubject: subject || "",
        correctedSubject,
      });
    } catch {
      toast.error(tStatic("compose.correctError"));
    } finally {
      setAiField(null);
    }
  }, [body, subject, language, correctionData, aiModel]);

  // Menu IA > Traduire : la SELECTION du texte (figee a l'ouverture du menu,
  // qui vole le focus) ou, sans selection, tout le texte. Signature et
  // citation vivent hors de l'editeur : elles ne sont jamais traduites.
  const translateRangeRef = useRef<{ from: number; to: number } | null>(null);
  const rememberSelection = useCallback(() => {
    const ed = editorRef.current;
    translateRangeRef.current = ed ? { from: ed.state.selection.from, to: ed.state.selection.to } : null;
  }, []);
  const handleTranslate = useCallback(async (target: TranslateTarget) => {
    const ed = editorRef.current;
    if (!ed) return;
    const doc = ed.state.doc;
    const saved = translateRangeRef.current;
    const whole = !saved || saved.from === saved.to;
    const from = whole ? 0 : Math.max(0, Math.min(saved.from, doc.content.size));
    const to = whole ? doc.content.size : Math.max(from, Math.min(saved.to, doc.content.size));
    const slice = doc.slice(from, to);
    if (!slice.content.textBetween(0, slice.content.size, " ").trim()) return;
    const container = document.createElement("div");
    container.appendChild(DOMSerializer.fromSchema(ed.schema).serializeFragment(slice.content));
    const previous = body;
    setAiField("translate");
    try {
      const res = await fetch(`${LLM_URL}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: container.innerHTML, target, apiKey: getOpenRouterKey(), model: aiModel }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.html !== "string" || !data.html.trim()) throw new Error(data.error || "translate failed");
      if (ed.isDestroyed) return;
      setUndoAi({ html: previous, at: Date.now() });
      ed.chain().focus().insertContentAt({ from, to: Math.min(to, ed.state.doc.content.size) }, data.html).run();
      setBody(ed.getHTML());
    } catch {
      toast.error(tStatic("compose.translateError"));
    } finally {
      setAiField(null);
      translateRangeRef.current = null;
    }
  }, [body, aiModel]);

  // Menu IA > "Resumer le mail recu" : resume du message d'origine, affiche
  // dans un encart refermable AU-DESSUS du texte (jamais dans le corps, donc
  // jamais envoye ni sauvegarde).
  const [summary, setSummary] = useState<{ html: string; loading: boolean } | null>(null);
  const handleSummarize = useCallback(async () => {
    if (!replyMsg) return;
    // Le dernier mail RECU de la conversation (pas mon propre envoi).
    const received = replyTarget.lastIncoming?.id === replyMsg.id ? replyMsg : replyTarget.lastIncoming || replyMsg;
    setSummary({ html: "", loading: true });
    setAiField("summary");
    try {
      let receivedBody = received.html_body || received.text_body || "";
      if (received.id !== replyMsg.id) {
        // Les messages du fil sont charges en extrait : relire le corps entier.
        const full = await messages().getOne<Message>(received.id, { fields: "html_body,text_body" }).catch(() => null);
        receivedBody = full?.html_body || full?.text_body || receivedBody;
      }
      const from = received.from_address;
      const res = await fetch(`${LLM_URL}/brief`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: received.subject || replyMsg.subject || "",
          language,
          apiKey: getOpenRouterKey(),
          model: aiModel,
          messages: [{
            from: from?.name || from?.address || "",
            fromAddress: from?.address || "",
            date: received.date,
            mine: false,
            body: receivedBody,
          }],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.brief !== "string" || !data.brief.trim()) throw new Error(data.error || "brief failed");
      setSummary({ html: data.brief, loading: false });
    } catch {
      setSummary(null);
      toast.error(tStatic("compose.aiError"));
    } finally {
      setAiField(null);
    }
  }, [replyMsg, replyTarget, language, aiModel]);

  const toggleCorrection = useCallback((id: number) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const acceptAllCorrections = useCallback(() => {
    if (diff) setAccepted(new Set(diff.corrections.map((c) => c.id)));
    setSubjectAccepted(true);
  }, [diff]);

  const handleApplyCorrections = useCallback(() => {
    if (!correctionData || !diff) return;

    let finalHtml: string;
    if (accepted.size === diff.corrections.length) {
      finalHtml = correctionData.correctedHtml;
    } else if (accepted.size === 0) {
      finalHtml = correctionData.originalHtml;
    } else {
      finalHtml = correctionData.correctedHtml;
      for (const c of diff.corrections) {
        if (!accepted.has(c.id) && c.corrected.trim() && c.original.trim()) {
          finalHtml = finalHtml.replace(c.corrected.trim(), c.original.trim());
        }
      }
    }

    editorRef.current?.commands.setContent(finalHtml);
    setBody(finalHtml);

    const finalSubject = subjectAccepted && subjectChanged
      ? correctionData.correctedSubject
      : correctionData.originalSubject;
    setSubject(finalSubject);

    setCorrectionData(null);
    toast.success(tStatic("compose.corrected"));
  }, [correctionData, diff, accepted, subjectAccepted, subjectChanged]);

  const handleDismissCorrections = useCallback(() => {
    setCorrectionData(null);
  }, []);


  const handleDeleteDraft = useCallback(async () => {
    await deleteDraft();
    setShowDeleteConfirm(false);
    toast.success(tStatic("compose.draftDeleted"));
    invalidateMessages();
    onClose();
  }, [deleteDraft, onClose, invalidateMessages]);

  const handleSend = useCallback(async () => {
    const accountId = fromAccountId || accs[0]?.id;
    if (!accountId) {
      toast.error(tStatic("compose.noAccountSelected"));
      return;
    }

    const toAddresses = to
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (toAddresses.length === 0) {
      toast.error(tStatic("compose.addRecipient"));
      return;
    }

    setSending(true);
    try {
      // 1) Flush l'auto-save en cours et recupere le draftId le plus a jour.
      // Sans ca, une auto-save en vol et l'upsert ci-dessous peuvent creer deux
      // brouillons distincts ou faire echouer un PATCH PB (race).
      const flushedDraftId = await flushSave();

      // Upsert du brouillon via l'endpoint /api/mail/auto-save (admin-context cote serveur :
      // gere folder=drafts, from_address, et recree un draft si l'id est obsolete).
      // Le worker /send reprend ensuite is_draft=false, is_sent=true, folder=sent, thread_id.
      const upsertBody: Record<string, unknown> = {
        account_id: accountId,
        to: toAddresses.map((a) => ({ address: a })),
        cc: cc
          ? cc
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((a) => ({ address: a }))
          : [],
        bcc: bcc
          ? bcc
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((a) => ({ address: a }))
          : [],
        subject,
        html_body: joinQuotedBody(joinSignature(body, signatureHtml), quotedHtml),
        text_body: "",
        in_reply_to: replyMsg?.message_id || "",
        // En reponse, la chaine References doit inclure le Message-ID du message
        // auquel on repond (RFC 5322) pour un threading correct chez le destinataire.
        references:
          (mode === "reply" || mode === "reply-all" || (mode === "edit" && !editIsForward)) && replyMsg?.message_id
            ? [...(replyMsg.references || []), replyMsg.message_id].filter(Boolean)
            : replyMsg?.references || [],
        thread_id: replyMsg?.thread_id || "",
      };
      const effectiveDraftId = flushedDraftId || draftId;
      if (effectiveDraftId) {
        upsertBody.draft_id = effectiveDraftId;
      }

      const upsertResult = await pb.send<{ draft_id: string }>("/api/mail/auto-save", {
        method: "POST",
        body: upsertBody,
      });
      const msgId = upsertResult.draft_id;

      // Uploader les eventuelles nouvelles PJ AVANT la fenetre d'annulation :
      // le brouillon est ainsi complet cote PB. L'envoi differe (worker /send)
      // reprend les PJ deja persistees, et une annulation rouvre le brouillon
      // intact (mode edit). Cf handleScheduleSend, meme approche.
      if (files.length > 0) {
        try {
          await uploadFiles(files);
        } catch {
          // best-effort : les PJ deja persistees restent
        }
      }

      // Ids de brouillons potentiellement orphelins a retirer a l'envoi effectif
      // (draftId du hook, msgId envoye, editDraftId initial).
      const idsToRemove = new Set<string>();
      if (effectiveDraftId) idsToRemove.add(effectiveDraftId);
      if (msgId) idsToRemove.add(msgId);
      if (editDraftId) idsToRemove.add(editDraftId);

      // Envoi DIFFERE de 15s avec toast "Annuler l'envoi". On ne contacte le
      // worker SMTP qu'a l'expiration : cliquer "Annuler" rouvre le brouillon
      // (rien n'a ete envoye). Voir lib/undo-send.ts.
      beginUndoableSend({
        draftId: msgId,
        accountId,
        isReply: mode === "reply" || mode === "reply-all" || (mode === "edit" && !!replyMsg && !editIsForward),
        replyMsgId: replyMsg?.id,
        draftIdsToClear: [...idsToRemove],
        sourceId,
        reopen: () => useMailStore.getState().openCompose("edit", msgId),
      });

      clearDraftState();
      onClose();
    } catch (err) {
      const detail = err && typeof err === "object" && "data" in err
        ? JSON.stringify((err as { data: unknown }).data)
        : "";
      console.error("Send failed:", err, detail);
      // Les erreurs PocketBase ("The requested resource wasn't found.") sont
      // des messages generiques en anglais : on affiche le texte localise, le
      // detail reste dans la console.
      const isPbError = !!err && typeof err === "object" && "status" in err;
      toast.error(
        err instanceof Error && !isPbError ? err.message : tStatic("compose.sendError")
      );
    } finally {
      setSending(false);
    }
  }, [mode, fromAccountId, accs, to, cc, bcc, subject, body, quotedHtml, files, savedAttachments, draftId, editDraftId, replyMsg, editIsForward, onClose, flushSave, clearDraftState, uploadFiles, sourceId, signatureHtml]);

  // Programmer l'envoi : persiste le brouillon (comme un envoi) puis pose la
  // date via /api/mail/schedule. Le cron PB enverra le brouillon a echeance.
  // La fenetre reste ouverte + affiche la barre jaune.
  const handleScheduleSend = useCallback(
    async (whenIso: string) => {
      const accountId = fromAccountId || accs[0]?.id;
      if (!accountId) {
        toast.error(tStatic("compose.noAccountSelected"));
        return;
      }
      const toAddresses = to.split(",").map((s) => s.trim()).filter(Boolean);
      if (toAddresses.length === 0) {
        toast.error(tStatic("compose.addRecipient"));
        return;
      }
      const when = new Date(whenIso);
      if (isNaN(when.getTime()) || when.getTime() <= Date.now()) {
        toast.error(tStatic("compose.schedulePast"));
        return;
      }
      try {
        const flushedDraftId = await flushSave();
        const upsertBody: Record<string, unknown> = {
          account_id: accountId,
          to: toAddresses.map((a) => ({ address: a })),
          cc: cc
            ? cc.split(",").map((s) => s.trim()).filter(Boolean).map((a) => ({ address: a }))
            : [],
          bcc: bcc
            ? bcc.split(",").map((s) => s.trim()).filter(Boolean).map((a) => ({ address: a }))
            : [],
          subject,
          html_body: joinQuotedBody(joinSignature(body, signatureHtml), quotedHtml),
          text_body: "",
          in_reply_to: replyMsg?.message_id || "",
          references:
            (mode === "reply" || mode === "reply-all" || (mode === "edit" && !editIsForward)) && replyMsg?.message_id
              ? [...(replyMsg.references || []), replyMsg.message_id].filter(Boolean)
              : replyMsg?.references || [],
          thread_id: replyMsg?.thread_id || "",
        };
        const effectiveDraftId = flushedDraftId || draftId;
        if (effectiveDraftId) upsertBody.draft_id = effectiveDraftId;

        const upsertResult = await pb.send<{ draft_id: string }>("/api/mail/auto-save", {
          method: "POST",
          body: upsertBody,
        });
        const msgId = upsertResult.draft_id;

        // Uploader les eventuelles PJ nouvelles avant l'echeance (le worker
        // /send reprend les attachments PB au moment de l'envoi).
        if (files.length > 0) {
          try {
            const uploaded = await uploadFiles(files);
            if (uploaded.length) setSavedAttachments((prev) => [...prev, ...uploaded]);
            setFiles([]);
          } catch {
            // best-effort : les PJ deja persistees restent, on programme quand meme
          }
        }

        await pb.send("/api/mail/schedule", {
          method: "POST",
          body: { draft_id: msgId, scheduled_at: when.toISOString() },
        });

        setScheduledAt(when.toISOString());
        setShowScheduleDialog(false);
        toast.success(tStatic("compose.scheduleSaved"));
        invalidateMessages();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : tStatic("compose.scheduleError"));
      }
    },
    [mode, fromAccountId, accs, to, cc, bcc, subject, body, quotedHtml, signatureHtml, files, replyMsg, editIsForward, draftId, flushSave, uploadFiles, invalidateMessages]
  );

  const handleCancelSchedule = useCallback(async () => {
    const targetId = draftId || editDraftId;
    if (!targetId) {
      setScheduledAt(null);
      return;
    }
    try {
      await pb.send("/api/mail/schedule", {
        method: "POST",
        body: { draft_id: targetId, scheduled_at: "" },
      });
      setScheduledAt(null);
      toast.success(tStatic("compose.scheduleCanceled"));
      invalidateMessages();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tStatic("compose.scheduleError"));
    }
  }, [draftId, editDraftId, invalidateMessages]);

  const openScheduleDialog = useCallback(() => {
    const base = scheduledAt ? new Date(scheduledAt) : presetTomorrowMorning();
    setScheduleInput(toLocalInputValue(base));
    setShowScheduleDialog(true);
  }, [scheduledAt]);

  // Libelle de la barre jaune : date absolue localisee + relatif ("dans 3 h").
  const scheduledLabel = useMemo(() => {
    if (!scheduledAt) return "";
    const target = new Date(scheduledAt);
    if (isNaN(target.getTime())) return "";
    const abs = target.toLocaleString(language, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    let rel = "";
    try {
      const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
      const min = Math.round((target.getTime() - Date.now()) / 60000);
      if (Math.abs(min) < 60) rel = rtf.format(min, "minute");
      else {
        const h = Math.round(min / 60);
        if (Math.abs(h) < 24) rel = rtf.format(h, "hour");
        else rel = rtf.format(Math.round(h / 24), "day");
      }
    } catch {
      // Intl.RelativeTimeFormat indispo : on garde juste l'absolu
    }
    return rel ? `${abs} (${rel})` : abs;
  }, [scheduledAt, language]);

  const currentAccount = accs.find((a) => a.id === fromAccountId);

  // --- Bande d'en-tete repliable (cartes De / A / Objet) ---
  // Toujours depliee a l'ouverture ; se replie quand le texte prend le focus ou
  // quand le corps defile, et se rouvre d'un clic sur la ligne de resume. Elle
  // vit HORS de la zone qui defile : elle reste collee en haut, le texte
  // defile seul en dessous.
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  // Position de reference du defilement : on replie au-dela de quelques px.
  const scrollAnchorRef = useRef(0);
  // Apres un depliage, la zone de corps retrecit (scrollTop peut etre recale
  // par le navigateur) : on ignore ce defilement induit le temps de l'animation.
  const ignoreScrollUntilRef = useRef(0);
  // Appui dans la bande : ces controles peuvent redonner le focus au texte, ce
  // focus-la ne doit pas replier la bande.
  const headerPressAtRef = useRef(0);

  const collapseHeader = useCallback(() => {
    // Saisie en cours dans un champ de la bande : on ne replie pas sous le doigt.
    if (headerRef.current?.contains(document.activeElement)) return;
    setHeaderCollapsed(true);
  }, []);

  const handleEditorFocus = useCallback(() => {
    if (Date.now() - headerPressAtRef.current < 600) return;
    collapseHeader();
  }, [collapseHeader]);

  const expandHeader = useCallback(() => {
    ignoreScrollUntilRef.current = Date.now() + 400;
    setHeaderCollapsed(false);
  }, []);

  // Objet corrige par l'IA : sa revue (ancien/nouveau) vit dans la carte Objet
  // -> on deplie la bande pour qu'elle soit visible avec la barre de revue.
  useEffect(() => {
    if (subjectChanged) expandHeader();
  }, [subjectChanged, expandHeader]);

  const handleBodyScroll = useCallback(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    if (headerCollapsed || Date.now() < ignoreScrollUntilRef.current) {
      scrollAnchorRef.current = top;
      return;
    }
    if (Math.abs(top - scrollAnchorRef.current) > 12) collapseHeader();
  }, [headerCollapsed, collapseHeader]);

  // Un appui dans la carte du texte, hors du texte lui-meme (marge, vide sous
  // la derniere ligne), place le curseur a la fin : toute la carte est le champ.
  const handleCardPointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(".ProseMirror, button, a, input, textarea, [role='button'], [data-ref='compose-quoted-content'], [data-ref='compose-form-attachments'], [data-ref='compose-ai-summary'], [data-ref='compose-french-view']")) return;
    const ed = editorRef.current;
    if (!ed || !ed.isEditable || correctionData) return;
    e.preventDefault();
    ed.commands.focus("end");
  }, [correctionData]);

  // Historique cite : replie par defaut (deplie en transfert), pilote par le
  // menu "⋮" et par la pastille "•••" sous le texte. Retire, il peut revenir.
  const [quoteOpen, setQuoteOpen] = useState(mode === "forward");
  const removedQuoteRef = useRef("");
  const [quoteRemoved, setQuoteRemoved] = useState(false);

  const toList = to.split(",").map((s) => s.trim()).filter(Boolean);
  const toSummary = toList.length > 0
    ? `${toList[0]}${toList.length > 1 ? ` +${toList.length - 1}` : ""}`
    : t("compose.headerNoRecipient");
  const fromInitial = ((currentAccount?.display_name || currentAccount?.label || currentAccount?.email || "?").trim()[0] || "?").toUpperCase();
  const bodyHasText = body.replace(/<[^>]*>/g, "").trim().length > 0;
  const aiBusy = aiLoading || !!aiReply;
  // `compose-card` : repere des cartes (De, A, Objet, texte), blanches en Miel.
  const cardClass = "compose-card rounded-2xl border border-border bg-background";

  // Menu "⋮" (programmer, signature, historique cite, supprimer) : pose en
  // haut a droite de la carte du texte. L'enregistrement automatique n'a plus
  // de temoin visible (useAutoSave tourne toujours).
  const moreMenu = (
      <ComposeMoreMenu
        aiBusy={aiBusy}
        aiMenu={!iaDispo ? undefined : (close) => (
          <ComposeAiMenu
            busy={aiBusy}
            onDone={close}
            canDraftReply={isReplyContext && !correctionData}
            followUp={replyTarget.mode === "followup"}
            canSummarize={!!replyTarget.lastIncoming}
            hasBody={bodyHasText && !correctionData}
            hasText={(bodyHasText || !!subject.trim()) && !correctionData}
            onOpen={rememberSelection}
            onDraftReply={handleAiReply}
            onCorrect={() => handleAiCorrect("all")}
            onRephrase={(v) => handleAiRewrite(v)}
            onShorten={() => handleAiRewrite("shorten")}
            onTranslate={handleTranslate}
            onSummarize={handleSummarize}
            t={t}
          />
        )}
        sending={sending}
        signature={signatureHtml ? "present" : fromAccountSignature ? "available" : "none"}
        quote={quotedHtml ? (quoteOpen ? "shown" : "hidden") : quoteRemoved ? "removed" : "none"}
        onSchedule={handleScheduleSend}
        onScheduleCustom={openScheduleDialog}
        onSignatureInsert={() => {
          if (!fromAccount) return;
          signatureRemovedRef.current = false;
          signatureAccountRef.current = fromAccount.id;
          setSignatureHtml(fromAccountSignature);
        }}
        onSignatureEdit={openSignatureSettings}
        onSignatureRemove={() => {
          signatureRemovedRef.current = true;
          setSignatureHtml("");
        }}
        onQuoteToggle={() => setQuoteOpen((v) => !v)}
        onQuoteRemove={() => {
          removedQuoteRef.current = quotedHtml;
          setQuoteRemoved(true);
          setQuotedHtml("");
        }}
        onQuoteRestore={() => {
          setQuotedHtml(removedQuoteRef.current);
          setQuoteRemoved(false);
          setQuoteOpen(true);
        }}
        onDelete={() => setShowDeleteConfirm(true)}
        t={t}
      />
  );

  return (
    <div
      data-ref="compose-form"
      // Defile dans son ensemble quand la place manque (clavier ouvert, curseur
      // dans A/Objet) : la carte du texte garde son plancher au lieu d'etre
      // ecrasee, et "Envoyer" reste colle en bas (sticky).
      className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain"
      onDragEnter={handleFormDragEnter}
      onDragLeave={handleFormDragLeave}
      onDragOver={handleFormDragOver}
      onDrop={handleFormDrop}
    >
      {isDragging && (
        <div className="border-primary bg-primary/5 absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed">
          <span className="text-primary text-sm font-medium">{t("compose.dropFiles")}</span>
        </div>
      )}
      {/* Envoi programme. Mobile = libelle puis actions sur 2 lignes (evite le
          libelle comprime en colonne etroite) ; desktop = une ligne. */}
      {scheduledAt && (
        <div className="mb-2 flex shrink-0 flex-col gap-1.5 rounded-2xl bg-muted px-3 py-2 text-xs text-foreground sm:flex-row sm:items-center sm:gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Clock className="size-4 shrink-0" />
            <span className="min-w-0">
              <span className="font-medium">{t("compose.scheduledPrefix")}</span>
              {scheduledLabel ? ` · ${scheduledLabel}` : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-4 pl-6 sm:pl-0">
            <button
              type="button"
              onClick={openScheduleDialog}
              className="font-medium underline underline-offset-2 hover:opacity-80"
            >
              {t("compose.editSchedule")}
            </button>
            <button
              type="button"
              onClick={handleCancelSchedule}
              className="font-medium underline underline-offset-2 hover:opacity-80"
            >
              {t("compose.cancelSchedule")}
            </button>
          </div>
        </div>
      )}
      <div
        ref={headerRef}
        data-ref="compose-form-header"
        data-collapsed={headerCollapsed ? "true" : "false"}
        onPointerDownCapture={() => { headerPressAtRef.current = Date.now(); }}
        className="flex shrink-0 flex-col pb-2"
      >
        {/* Replie : une ligne "A ... · objet" (clic = deplie) */}
        <HeaderFold open={headerCollapsed}>
          <div className="p-px">
            <button
              type="button"
              onClick={expandHeader}
              className={cn(cardClass, "hover:bg-accent/50 flex h-11 w-full min-w-0 items-center gap-2 px-3.5 text-left text-[0.8125rem] transition-colors")}
              aria-label={t("compose.headerExpand")}
              aria-expanded={!headerCollapsed}
              data-ref="compose-form-header-summary"
            >
              <span className="text-muted-foreground shrink-0">{t("compose.to")}</span>
              <span className="min-w-0 shrink truncate">{toSummary}</span>
              <span className="text-muted-foreground shrink-0">·</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate">
                {subject.trim() || t("message.noSubject")}
              </span>
              <ChevronDown className="text-muted-foreground size-4 shrink-0" />
            </button>
          </div>
        </HeaderFold>
        {/* Deplie : trois cartes De / A (+ Cc / Cci) / Objet */}
        <HeaderFold open={!headerCollapsed}>
          <div className="flex flex-col gap-2 p-px">
            {/* De : pastille a l'initiale + adresse ; un appui change de compte */}
            <Select value={fromAccountId} onValueChange={setFromAccountId}>
              <SelectTrigger
                data-ref="compose-form-from"
                aria-label={t("compose.from")}
                className={cn(cardClass, "h-auto! w-full gap-3 px-2.5 py-2 text-left text-[0.875rem] shadow-none dark:bg-background")}
              >
                <span className="bg-muted text-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-[0.8125rem] font-medium" aria-hidden>
                  {fromInitial}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {currentAccount?.email || t("compose.chooseAccount")}
                </span>
              </SelectTrigger>
              <SelectContent position="popper" className="z-[100] max-w-[calc(100vw-2rem)]">
                {accs.map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    {acc.label} ({acc.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* A (+ Cc / Cci dans la meme carte) ; le bouton "Cc" fait apparaitre les copies */}
            <div className={cn(cardClass, "flex flex-col")} data-ref="compose-form-recipients">
              <div className="flex min-h-12 items-center gap-2 py-1.5 pr-1.5 pl-3.5">
                <span data-ref="compose-form-to-label" className="text-muted-foreground w-7 shrink-0 text-[0.875rem]">
                  {t("compose.to")}
                </span>
                <RecipientInput
                  value={to}
                  onChange={setTo}
                  names={recipientNames}
                  placeholder={t("compose.toPlaceholder")}
                  data-ref="compose-form-to"
                  className="flex-1 border-0 px-0 shadow-none focus-within:ring-0"
                />
                <button
                  type="button"
                  onClick={() => setShowCcBcc(!showCcBcc)}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center justify-center rounded-full px-3 text-[0.8125rem] font-medium transition-colors",
                    showCcBcc
                      ? "bg-foreground/15 text-foreground hover:bg-foreground/20"
                      : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                  aria-label={t("compose.ccBcc")}
                  aria-expanded={showCcBcc}
                  title={t("compose.ccBcc")}
                  data-ref="compose-form-ccbcc-toggle"
                >
                  {t("compose.cc")}
                </button>
              </div>
              {showCcBcc && (
                <>
                  <div className="border-border flex min-h-11 items-center gap-2 border-t py-1 pr-3 pl-3.5">
                    <span className="text-muted-foreground w-7 shrink-0 text-[0.875rem]">{t("compose.cc")}</span>
                    <RecipientInput
                      value={cc}
                      onChange={setCc}
                      names={recipientNames}
                      placeholder={t("compose.ccPlaceholder")}
                      data-ref="compose-form-cc"
                      className="flex-1 border-0 px-0 shadow-none focus-within:ring-0"
                    />
                  </div>
                  <div className="border-border flex min-h-11 items-center gap-2 border-t py-1 pr-3 pl-3.5">
                    <span className="text-muted-foreground w-7 shrink-0 text-[0.875rem]">{t("compose.bcc")}</span>
                    <RecipientInput
                      value={bcc}
                      onChange={setBcc}
                      names={recipientNames}
                      placeholder={t("compose.bccPlaceholder")}
                      data-ref="compose-form-bcc"
                      className="flex-1 border-0 px-0 shadow-none focus-within:ring-0"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Objet */}
            <div className={cn(cardClass, "flex min-h-12 items-center gap-3 px-3.5")}>
              <FileText className="text-muted-foreground size-[1.15rem] shrink-0" strokeWidth={1.7} aria-hidden />
              {correctionData && subjectChanged ? (
                <button
                  type="button"
                  className={cn(
                    "my-1.5 flex min-w-0 flex-1 flex-wrap items-center gap-x-2 rounded-lg px-2 py-1.5 text-left text-[0.875rem] transition-colors",
                    subjectAccepted ? "bg-green-500/10" : "bg-muted"
                  )}
                  onClick={() => setSubjectAccepted(!subjectAccepted)}
                  data-ref="compose-form-subject-review"
                >
                  {subjectAccepted ? (
                    <>
                      <span className="text-red-500/60 line-through">{correctionData.originalSubject}</span>
                      <span className="font-medium text-green-700 dark:text-green-400">{correctionData.correctedSubject}</span>
                    </>
                  ) : (
                    <span>{correctionData.originalSubject}</span>
                  )}
                </button>
              ) : (
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={t("compose.subjectPlaceholder")}
                  aria-label={t("compose.subject")}
                  data-ref="compose-form-subject"
                  className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent py-3 text-[0.875rem] outline-none"
                  disabled={!!correctionData}
                />
              )}
            </div>
          </div>
        </HeaderFold>
        {/* Revue des corrections IA : dans la bande (HORS HeaderFold et hors
            de la zone qui defile) -> toujours visible pendant la revue, bande
            repliee ou depliee, quel que soit le defilement du texte. */}
        {correctionData && diff && totalCorrections > 0 && (
          <div
            data-ref="compose-form-correction-bar"
            className="bg-muted/40 mt-2 flex items-center justify-between gap-2 rounded-2xl border px-3 py-1.5"
          >
            <span className="text-muted-foreground min-w-0 truncate text-xs">
              {acceptedCount}/{totalCorrections} {t("compose.corrections")}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="xs" className="h-7 text-xs" onClick={acceptAllCorrections}>
                {t("compose.acceptAll")}
              </Button>
              <Button size="xs" className="h-7 text-xs" onClick={handleApplyCorrections} disabled={acceptedCount === 0}>
                <Check className="size-3" />
                {t("compose.apply")} ({acceptedCount})
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-7"
                onClick={handleDismissCorrections}
                aria-label={t("close")}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Carte du texte : le texte (et ce qui l'accompagne) defile, la rangee
          B / trombone / IA reste au pied de la carte. */}
      <div data-ref="compose-form-card" className={cn(cardClass, "relative flex min-h-[9rem] flex-1 flex-col")}>
      <div
        ref={bodyScrollRef}
        onScroll={handleBodyScroll}
        onPointerDown={handleCardPointerDown}
        data-ref="compose-form-body"
        className="flex min-h-0 flex-1 cursor-text flex-col gap-3 overflow-y-auto overscroll-contain pt-1 pr-1 pb-2 pl-1 [&>*]:shrink-0"
      >
      {summary && (
        <div data-ref="compose-ai-summary" className="bg-muted/60 mx-2 mt-1.5 rounded-xl px-3 py-2.5 cursor-auto">
          <div className="mb-1 flex items-center gap-2">
            <FileText className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs font-medium">{t("compose.aiSummaryTitle")}</span>
            <button
              type="button"
              onClick={() => setSummary(null)}
              className="text-muted-foreground hover:text-foreground -mr-1 rounded-md p-0.5"
              aria-label={t("close")}
              data-ref="compose-ai-summary-close"
            >
              <X className="size-3.5" />
            </button>
          </div>
          {summary.loading ? (
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          ) : (
            <div
              className="prose prose-sm dark:prose-invert max-w-none text-[0.8125rem] leading-relaxed [&_p]:my-1 [&_ul]:my-1"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(summary.html) }}
            />
          )}
        </div>
      )}

      {aiReply && (
        <div data-ref="compose-ai-reply-progress" className="flex flex-col gap-1.5 px-2 pt-1.5" role="status" aria-live="polite">
          <div className="flex items-center gap-2 text-xs">
            <Sparkles className="text-primary size-3.5 shrink-0" />
            <span className="text-muted-foreground min-w-0 flex-1 truncate">
              {t(`compose.aiReplyStep.${aiReply.step}`)}
            </span>
            <button
              type="button"
              data-ref="compose-ai-reply-cancel"
              onClick={cancelAiReply}
              className="text-muted-foreground hover:text-foreground shrink-0 underline-offset-2 hover:underline"
            >
              {t("compose.aiReplyCancel")}
            </button>
          </div>
          <div className="bg-muted h-1.5 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full rounded-full transition-[width] duration-500 ease-out"
              style={{ width: `${Math.min(97, aiReply.pct + aiReplyCreep)}%` }}
            />
          </div>
        </div>
      )}

      {/* Editeur. L'historique cite (reponse/transfert) vit dans `quotedHtml`,
          rendu sous le texte et concatene au corps a l'envoi. */}
      {draftLoaded ? (
        <ComposeEditor
          content={mode === "edit" ? body : ""}
          onChange={handleBodyChange}
          onFileDrop={handleEditorFileDrop}
          onUploadImage={handleEditorImageUpload}
          className="flex-1"
          editorRef={editorRef}
          toolbarHost={toolbarHost}
          compactToolbar
          onAttachFiles={() => fileInputRef.current?.click()}
          toolbarEnd={moreMenu}
          onEditorFocus={handleEditorFocus}
          aiReplyBusy={!!aiReply}
          correctionContent={correctionData && diff && diff.corrections.length > 0 ? (
            <>
              {diff.segments.map((seg, idx) => {
                if (seg.type === "unchanged") {
                  return <span key={idx}>{seg.text}</span>;
                }
                const c = diff.corrections.find((x) => x.id === seg.correctionId);
                if (!c) return null;
                const isAccepted = accepted.has(c.id);
                return (
                  <span
                    key={idx}
                    role="button"
                    tabIndex={0}
                    className={cn(
                      "inline cursor-pointer rounded-sm px-0.5 transition-colors",
                      isAccepted
                        ? "bg-green-500/15 hover:bg-green-500/25"
                        : "bg-muted hover:bg-muted/80"
                    )}
                    onClick={() => toggleCorrection(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") toggleCorrection(c.id);
                    }}
                  >
                    {isAccepted ? (
                      <>
                        {c.original && (
                          <span className="text-red-500/60 line-through">{c.original}</span>
                        )}
                        {c.original && c.corrected && " "}
                        {c.corrected && (
                          <span className="font-medium text-green-700 dark:text-green-400">{c.corrected}</span>
                        )}
                      </>
                    ) : (
                      <span>{c.original || c.corrected}</span>
                    )}
                  </span>
                );
              })}
            </>
          ) : undefined}
        />
      ) : (
        <div className="min-h-[6rem]" />
      )}

      {frView && !aiReply && (
        <div data-ref="compose-french-view" className="flex cursor-auto flex-col gap-1.5 px-2">
          <div className="flex items-center gap-3 text-xs">
            <button
              type="button"
              data-ref="compose-french-toggle"
              onClick={() => {
                const opening = !frView.open;
                setFrView({ ...frView, open: opening });
                if (opening && !frView.html && !frView.loading) refreshFrench();
              }}
              className="text-primary font-medium underline-offset-2 hover:underline"
            >
              {frView.open ? t("compose.hideFrench") : t("compose.viewInFrench")}
            </button>
            {frView.open && (
              <button
                type="button"
                data-ref="compose-french-refresh"
                onClick={refreshFrench}
                disabled={frView.loading || !body.trim()}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline disabled:opacity-50"
              >
                {frView.loading && <Loader2 className="size-3 animate-spin" />}
                {t("compose.frenchRefresh")}
              </button>
            )}
          </div>
          {frView.open && (
            <div
              data-ref="compose-french-frame"
              className="bg-muted/50 rounded-xl px-3 py-2"
            >
              <div className="text-muted-foreground mb-1 text-[11px]">{t("compose.frenchTitle")}</div>
              {frView.html ? (
                <div
                  className="prose prose-sm dark:prose-invert max-h-64 max-w-none overflow-y-auto text-[0.9375rem] leading-relaxed md:text-[0.8125rem] [&_p]:my-1"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(frView.html) }}
                />
              ) : (
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
              )}
            </div>
          )}
        </div>
      )}

      {/* Signature : visible en gris clair (elle part avec le mail) ; ses
          reglages sont dans le menu "⋮". */}
      {draftLoaded && signatureHtml && (
        <ComposeSignature html={signatureHtml} />
      )}

      {/* Historique cite / message transfere : pastille "•••" discrete. */}
      {quotedHtml && (
        <QuotedHistory
          html={quotedHtml}
          open={quoteOpen}
          onToggle={() => setQuoteOpen((v) => !v)}
          t={t}
        />
      )}

      {/* Fichiers joints */}
      {(files.length > 0 || savedAttachments.length > 0) && (() => {
        function getVisualOrder(i: number): number {
          if (dragIndex === null || dragOverIndex === null || dragIndex === dragOverIndex) return i;
          if (i === dragIndex) return dragOverIndex;
          if (dragIndex < dragOverIndex) {
            if (i > dragIndex && i <= dragOverIndex) return i - 1;
          } else {
            if (i >= dragOverIndex && i < dragIndex) return i + 1;
          }
          return i;
        }

        return (
          <div
            ref={gridRef}
            data-ref="compose-form-attachments"
            className="flex cursor-auto flex-col gap-1 px-2"
            onDragOver={handleGridDragOver}
            onDrop={handleDropReorder}
          >
            {savedAttachments.map((att, i) => {
              const isDragged = i === dragIndex;
              return (
                <div
                  key={att.id}
                  data-ref="compose-form-attachment"
                  draggable
                  onDragStart={(e) => handleDragStart(e, i)}
                  onDragEnd={handleDragEnd}
                  style={{ order: getVisualOrder(i) }}
                  className={cn(
                    "bg-muted flex w-full cursor-grab items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs active:cursor-grabbing",
                    isDragged && dragOverIndex !== null && dragIndex !== dragOverIndex
                      ? "border-primary bg-primary/10 border-2 border-dashed opacity-50"
                      : "border-2 border-transparent"
                  )}
                >
                  <GripVertical className="text-muted-foreground size-3 shrink-0" />
                  {att.file && /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(att.file) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={getFileUrl({ id: att.id, collectionId: "", collectionName: "attachments" }, att.file)}
                      alt=""
                      className="size-5 shrink-0 rounded-sm object-cover"
                      data-ref="compose-form-attachment-thumb"
                    />
                  ) : (
                    <Paperclip className="size-3 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{att.filename}</span>
                  <span className="text-muted-foreground shrink-0">{formatFileSize(att.size)}</span>
                  <button
                    onClick={() => removeSavedAttachment(att.id)}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    aria-label={`${t("compose.remove")}${att.filename}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
            {files.map((file, i) => (
              <div
                key={`${file.name}-${file.size}-${i}`}
                data-ref="compose-form-attachment"
                style={{ order: savedAttachments.length + i }}
                className="bg-muted flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs border-2 border-transparent opacity-60"
              >
                <Loader2 className="size-3 shrink-0 animate-spin" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="text-muted-foreground shrink-0">{formatFileSize(file.size)}</span>
                <button
                  onClick={() => removeFile(i)}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  aria-label={`${t("compose.remove")}${file.name}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        );
      })()}

      </div>

      {/* "Revenir au texte d'avant" apres un remplacement par l'IA */}
      {undoAi && (
        <div data-ref="compose-ai-undo" className="flex shrink-0 items-center gap-2 px-3 pb-1 text-xs">
          <Sparkles className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-muted-foreground min-w-0 flex-1 truncate">{t("compose.aiReplaced")}</span>
          <button
            type="button"
            onClick={revertAi}
            className="text-foreground inline-flex shrink-0 items-center gap-1 font-medium underline-offset-2 hover:underline"
            data-ref="compose-ai-undo-button"
          >
            <Undo2 className="size-3.5" />
            {t("compose.aiRevert")}
          </button>
        </div>
      )}

      {/* Rangee du pied de la carte : B / trombone / IA (rendue par l'editeur) */}
      <div ref={setToolbarHost} data-ref="compose-form-footer" className="shrink-0 px-2 pb-2" />
      </div>

      {/* Input fichier cache, declenche par le trombone */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
        data-ref="compose-form-file-input"
      />

      {/* Envoyer : grand bouton pleine largeur (la programmation est dans "⋮") */}
      <div data-ref="compose-form-toolbar" className="sticky bottom-0 z-10 shrink-0 bg-background pt-3">
        <Button
          onClick={handleSend}
          disabled={sending}
          data-ref="compose-form-send"
          className="h-12 w-full rounded-2xl text-[0.9375rem] font-medium"
        >
          {sending ? <Loader2 className="size-[1.15rem] animate-spin" /> : <Send className="size-[1.15rem]" />}
          {sending ? t("compose.sending") : t("compose.send")}
        </Button>
      </div>

      {/* Modale de confirmation de suppression */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("compose.deleteDraftConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("compose.deleteDraftConfirmDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              {t("compose.cancel")}
            </Button>
            <Button variant="destructive" onClick={handleDeleteDraft}>
              {t("compose.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modale de programmation de l'envoi */}
      <Dialog open={showScheduleDialog} onOpenChange={setShowScheduleDialog}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("compose.scheduleTitle")}</DialogTitle>
            <DialogDescription>{t("compose.scheduleDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="schedule-datetime" className="text-sm">
              {t("compose.scheduleDateTime")}
            </Label>
            <Input
              id="schedule-datetime"
              type="datetime-local"
              value={scheduleInput}
              min={toLocalInputValue(new Date())}
              onChange={(e) => setScheduleInput(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowScheduleDialog(false)}>
              {t("compose.cancel")}
            </Button>
            <Button
              onClick={() => {
                const d = new Date(scheduleInput);
                if (isNaN(d.getTime()) || d.getTime() <= Date.now()) {
                  toast.error(tStatic("compose.schedulePast"));
                  return;
                }
                handleScheduleSend(d.toISOString());
              }}
            >
              {t("compose.scheduleConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

// --- ComposePanel : un seul panneau de composition ---

interface ComposePanelProps {
  instance: ComposeInstance;
  position: PanelPosition;
  isFocused: boolean;
  isHovered: boolean;
  onFocus: () => void;
  onHover: () => void;
  onLeave: () => void;
}

function ComposePanel({ instance, position, isFocused, isHovered, onFocus, onHover, onLeave }: ComposePanelProps) {
  const t = useT();
  const closeCompose = useMailStore((s) => s.closeCompose);
  const toggleComposeMinimized = useMailStore((s) => s.toggleComposeMinimized);
  const updateComposeTitleLabel = useMailStore((s) => s.updateComposeTitleLabel);
  const setComposeHasContent = useMailStore((s) => s.setComposeHasContent);
  const reportHasContent = useCallback(
    (has: boolean) => setComposeHasContent(instance.id, has),
    [setComposeHasContent, instance.id]
  );
  const [animating, setAnimating] = useState(false);
  const [titleLabel, setTitleLabel] = useState(instance.titleLabel || getComposeModeTitle(instance.mode, t));
  const [hasFiles, setHasFiles] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Dimensions personnalisees (redimensionnement manuel). null = valeurs par defaut.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  // Redimensionnement : la fenetre est ancree en bas a droite, donc la largeur
  // s'etend vers la gauche et la hauteur vers le haut.
  const startResize = useCallback(
    (e: React.PointerEvent, dir: { left?: boolean; top?: boolean }) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = rect.width;
      const startH = rect.height;
      setResizing(true);
      const onMove = (ev: PointerEvent) => {
        let width = startW;
        let height = startH;
        if (dir.left) width = startW + (startX - ev.clientX);
        if (dir.top) height = startH + (startY - ev.clientY);
        const maxW = window.innerWidth - position.right - 8;
        const maxH = window.innerHeight - 8;
        width = Math.max(360, Math.min(width, maxW));
        height = Math.max(220, Math.min(height, maxH));
        setSize({ width, height });
      };
      const onUp = () => {
        setResizing(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [position.right]
  );

  const handleMetaChange = useCallback((label: string) => {
    setTitleLabel(label);
    updateComposeTitleLabel(instance.id, label);
  }, [instance.id, updateComposeTitleLabel]);

  // Charger le sujet depuis PB si titleLabel absent (migration instances existantes)
  useEffect(() => {
    if (instance.titleLabel || !instance.replyToMessageId) return;
    messages().getOne<Message>(instance.replyToMessageId).then((msg) => {
      const label = msg.subject?.trim();
      if (label) {
        setTitleLabel(label);
        updateComposeTitleLabel(instance.id, label);
      }
    }).catch(() => {});
  }, [instance.titleLabel, instance.replyToMessageId, instance.id, updateComposeTitleLabel]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimating(true));
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    closeCompose(instance.id);
  }, [closeCompose, instance.id]);

  const handleMinimize = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    toggleComposeMinimized(instance.id);
  }, [toggleComposeMinimized, instance.id]);

  const vpH = typeof window !== "undefined" ? window.innerHeight : 900;
  const vpW = typeof window !== "undefined" ? window.innerWidth : 1440;
  const defaultHeight = Math.round(
    Math.max(220, Math.min(hasFiles ? PANEL_DEFAULT_HEIGHT_FILES : PANEL_DEFAULT_HEIGHT, vpH - 16))
  );
  const panelWidth = size?.width ?? Math.max(360, Math.min(PANEL_WIDTH, vpW - position.right - 8));
  const panelHeight = instance.minimized ? 48 : (size?.height ?? defaultHeight);

  return (
    <div
      ref={panelRef}
      data-ref="compose-panel"
      role="region"
      aria-label="Composition de message"
      className={cn(
        // pointer-events-auto OBLIGATOIRE : quand un layer Radix/vaul (tiroir de
        // reponse, dialog...) est ouvert, il pose `pointer-events:none` en inline
        // sur <body>. Cette valeur HERITE jusqu'a la fenetre de composition
        // (fixed, enfant de body) qui ne la surcharge pas -> tous les clics la
        // TRAVERSENT et atterrissent sur le tiroir derriere. On force donc la
        // fenetre flottante a rester interactive independamment de l'etat du body.
        "fixed bottom-0 flex flex-col pointer-events-auto",
        "rounded-t-2xl border border-b-0 bg-background",
        // Pas de transition pendant le redimensionnement (sinon la fenetre traine)
        resizing ? "" : "transition-all duration-200 ease-in-out",
        animating ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
        isHovered && position.compressed
          ? "shadow-2xl ring-2 ring-primary/20"
          : "shadow-xl"
      )}
      style={{
        right: position.right,
        zIndex: position.zIndex,
        width: panelWidth,
        height: panelHeight,
      }}
      onMouseDown={onFocus}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
    >
      {/* Poignees de redimensionnement (fenetre ancree en bas a droite) */}
      {!instance.minimized && (
        <>
          <div
            onPointerDown={(e) => startResize(e, { top: true })}
            className="absolute -top-1 left-3 right-3 z-10 h-2 cursor-ns-resize"
            aria-hidden
          />
          <div
            onPointerDown={(e) => startResize(e, { left: true })}
            className="absolute -left-1 bottom-0 top-3 z-10 w-2 cursor-ew-resize"
            aria-hidden
          />
          <div
            onPointerDown={(e) => startResize(e, { left: true, top: true })}
            className="group/resize absolute left-1.5 top-1.5 z-20 flex size-4 cursor-nwse-resize items-start justify-start"
            aria-hidden
            title={t("compose.resize")}
          >
            <svg
              viewBox="0 0 10 10"
              fill="currentColor"
              className="text-muted-foreground/70 group-hover/resize:text-foreground size-2.5 transition-colors"
            >
              <circle cx="1.5" cy="1.5" r="1.1" />
              <circle cx="5" cy="1.5" r="1.1" />
              <circle cx="1.5" cy="5" r="1.1" />
            </svg>
          </div>
        </>
      )}

      {/* Barre de titre */}
      <div
        data-ref="compose-panel-titlebar"
        className={cn(
          "flex h-12 shrink-0 cursor-pointer items-center justify-between gap-2",
          "rounded-t-2xl bg-background pr-2.5 pl-5 text-foreground"
        )}
        onClick={() => toggleComposeMinimized(instance.id)}
      >
        <span className="min-w-0 truncate text-[0.9375rem] font-semibold">
          {titleLabel}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={handleMinimize}
            className="hover:bg-accent inline-flex size-8 items-center justify-center rounded-full transition-colors"
            aria-label={t("compose.minimize")}
            title={t("compose.minimize")}
          >
            <Minus className="size-4" />
          </button>
          <button
            onClick={handleClose}
            className="hover:bg-accent inline-flex size-8 items-center justify-center rounded-full transition-colors"
            aria-label={t("close")}
            title={t("close")}
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* Corps du formulaire */}
      {!instance.minimized && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pt-1 pb-4">
          <ComposeForm
            mode={instance.mode}
            messageId={instance.replyToMessageId}
            initialTo={instance.initialTo}
            onClose={() => closeCompose(instance.id)}
            onMetaChange={handleMetaChange}
            onHasFiles={setHasFiles}
            onHasContent={reportHasContent}
          />
        </div>
      )}
    </div>
  );
}

// --- ComposeContainer : gere le positionnement de tous les panneaux ---

function ComposeContainer({ instances }: { instances: ComposeInstance[] }) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedComposeId = useMailStore((s) => s.focusedComposeId);
  const focusCompose = useMailStore((s) => s.focusCompose);
  const [viewportWidth, setViewportWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1920
  );

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Delai de 300ms avant d'activer le hover pour eviter les declenchements accidentels
  const handleHover = useCallback((id: string) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoveredId(id), 300);
  }, []);

  const handleLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    // La derniere fenetre survolee reste au premier plan via le focus
    if (hoveredId) {
      focusCompose(hoveredId);
    }
    setHoveredId(null);
  }, [hoveredId, focusCompose]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const focusedIndex = focusedComposeId
    ? instances.findIndex((inst) => inst.id === focusedComposeId)
    : -1;

  const hoveredIndex = hoveredId
    ? instances.findIndex((inst) => inst.id === hoveredId)
    : -1;

  // ComposeContainer n'est rendu que sur desktop : le panneau IA y est une
  // colonne a droite, les fenetres se rangent donc a sa gauche avec une marge.
  const aiChatOpen = useMailStore((s) => s.aiChatOpen);
  const aiChatWidth = useMailStore((s) => s.aiChatWidth);
  const rightOffset = aiChatOpen ? aiChatWidth : 0;

  const positions = useMemo(() => {
    return calculatePositions(instances.length, viewportWidth, focusedIndex, hoveredIndex, rightOffset);
  }, [instances.length, viewportWidth, focusedIndex, hoveredIndex, rightOffset]);

  return (
    <>
      {instances.map((instance, index) => (
        <ComposePanel
          key={instance.id}
          instance={instance}
          position={positions[index]}
          isFocused={focusedComposeId === instance.id}
          isHovered={hoveredId === instance.id}
          onFocus={() => focusCompose(instance.id)}
          onHover={() => handleHover(instance.id)}
          onLeave={handleLeave}
        />
      ))}
    </>
  );
}

// --- ComposeSheet : version mobile (un seul panneau) ---

function ComposeSheet({ instance }: { instance: ComposeInstance }) {
  const t = useT();
  const closeCompose = useMailStore((s) => s.closeCompose);
  const setComposeHasContent = useMailStore((s) => s.setComposeHasContent);
  const title = getComposeModeTitle(instance.mode, t);
  const hasContentRef = useRef(false);
  const reportHasContent = useCallback(
    (has: boolean) => {
      hasContentRef.current = has;
      setComposeHasContent(instance.id, has);
    },
    [setComposeHasContent, instance.id]
  );

  // Fermeture par geste utilisateur (X, glissement, voile) : le brouillon est
  // auto-sauvegarde, on confirme et on rappelle ou le retrouver.
  const closeWithNotice = useCallback(() => {
    if (hasContentRef.current) {
      toast.success(t("compose.draftSavedTitle"), {
        description: t("compose.draftSavedWhere"),
      });
    }
    closeCompose(instance.id);
  }, [closeCompose, instance.id, t]);

  return (
    // Tiroir bas draggable (vaul Drawer) : poignee de glissement + drag-to-close,
    // comme le reste de l'app mobile (ReplyBox, AiChatPanel). NON-modal (pas de
    // focus-trap qui generait l'editeur / les tiroirs enfants) ; le sizing clavier
    // reste gere par .compose-sheet-mobile (plein ecran au-dessus du clavier).
    // `handleOnly` : SEULS la poignee et le titre font glisser le tiroir. Sans
    // ca vaul ecoute chaque geste du corps (capture du pointeur, test "faut-il
    // glisser ?") et, sur iPhone, un glisser vers le bas dans le texte deja
    // defile ne remontait plus le contenu (#2429). Le corps garde ainsi le
    // defilement natif dans les deux sens.
    <Drawer
      open
      onOpenChange={(open) => !open && closeWithNotice()}
      repositionInputs={false}
      noBodyStyles
      modal={false}
      handleOnly
    >
      <DrawerContent
        className="compose-sheet-mobile mt-0"
        data-ref="compose-sheet"
        hideGrip
        manualOverlay
        onOverlayClick={() => {
          // Suggestions de destinataires ouvertes (ou fermees a l'instant par ce
          // meme tap) : ce clic sur le voile ne fait que les dismisser, il ne
          // doit pas fermer le brouillon.
          if (recipientSuggestionsActive()) return;
          closeWithNotice();
        }}
        // Ne pas fermer la composition quand l'interaction "exterieure" vient du
        // bottom sheet "..." (et son voile) qui se stacke par-dessus, d'un
        // popover Radix rendu en portail (ex: le selecteur d'expediteur "De" :
        // fermer sa liste ne doit PAS fermer le brouillon), ou d'une liste de
        // suggestions de destinataires en train de se fermer.
        onInteractOutside={(e) => {
          const target = e.detail.originalEvent.target as HTMLElement | null;
          if (
            recipientSuggestionsActive() ||
            (target &&
              target.closest(
                '[data-ref="compose-more-sheet"], .compose-more-overlay, [data-radix-popper-content-wrapper], [data-radix-select-viewport]'
              ))
          ) {
            e.preventDefault();
          }
        }}
      >
        {/* En-tete : titre centre, sans bouton (le "⋮" vit dans la carte du
            texte), pas de croix. La prise
            (poignee + titre) fait glisser le tiroir : le glisser vers le bas
            passe par onOpenChange -> closeWithNotice (brouillon garde). Le
            menu reste HORS de la prise. La bande herite de l'arrondi du
            tiroir : un fond carre recouvrait ses coins (defaut corrige). */}
        <DrawerSheetHeader
          title={title}
          dataRef="compose-sheet-header"
          handleDataRef="compose-sheet-handle"
        />
        {/* Verrou de defilement PROPRE au tiroir. Ouvert depuis une
            conversation (Repondre, brouillon d'un fil), le tiroir du fil reste
            monte dessous : c'est un tiroir vaul MODAL, dont l'overlay Radix pose
            un verrou react-remove-scroll qui annule (preventDefault) tout
            touchmove hors de son propre contenu -> notre corps, rendu en portail
            ailleurs, ne defilait plus au doigt (iPhone). react-remove-scroll
            n'ecoute que le verrou le plus recent : en en posant un ici, c'est le
            notre qui juge, et il laisse defiler ce qu'il contient. */}
        <RemoveScroll
          removeScrollBar={false}
          allowPinchZoom
          // Seule reserve du bas : la barre d'accueil hors clavier ; clavier
          // ouvert (html.kb-open), "Envoyer" se pose juste au-dessus de lui.
          className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] [.kb-open_&]:pb-2"
        >
          <ComposeForm
            mode={instance.mode}
            messageId={instance.replyToMessageId}
            initialTo={instance.initialTo}
            onClose={() => closeCompose(instance.id)}
            onHasContent={reportHasContent}
          />
        </RemoveScroll>
      </DrawerContent>
    </Drawer>
  );
}

// --- ComposeDialog : point d'entree ---

export function ComposeDialog() {
  const composeInstances = useMailStore((s) => s.composeInstances);
  const isMobile = useMediaQuery("(max-width: 768px)");

  if (composeInstances.length === 0) return null;

  if (isMobile) {
    // Mobile : afficher uniquement la derniere instance
    const lastInstance = composeInstances[composeInstances.length - 1];
    return <ComposeSheet instance={lastInstance} />;
  }

  // Desktop : afficher tous les panneaux
  return <ComposeContainer instances={composeInstances} />;
}
