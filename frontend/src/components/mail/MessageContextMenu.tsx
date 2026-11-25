"use client";

import { useState, useCallback, useMemo, useRef, cloneElement } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import {
  Reply,
  ReplyAll,
  Forward,
  Archive,
  CheckCheck,
  ListChecks,
  Star,
  Trash2,
  Mail,
  MailOpen,
  Ban,
  ShieldAlert,
  Check,
  Filter,
  Users,
  Printer,
  Download,
  Code,
  Inbox,
  PackageSearch,
  PackagePlus,
  Gauge,
  type LucideIcon,
} from "lucide-react";
import { create } from "zustand";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { useTrackedThreads } from "@/lib/stores/tracked-threads";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { t as tStatic } from "@/lib/i18n";
import { useMailStore } from "@/lib/stores/mail-store";
import { useMessageActions } from "@/lib/hooks/useMessageActions";
import { useSettingsStore, blockSender, unblockSender, groupSender, ungroupSender } from "@/lib/hooks/useSettings";
import { isSenderGrouped } from "@/lib/utils/sender-grouping";
import { getOpenRouterKey } from "@/lib/ai-settings";
import { MessageSourceDialog } from "./MessageSourceDialog";
import { AddToTrackingDrawer } from "./AddToTrackingDrawer";
import { changeMessageImportance } from "@/lib/importance-api";
import { IMPORTANCE_COLORS, IMPORTANCE_LEVELS, isImportance, type Importance } from "@/lib/importance";
import type { Message } from "@/lib/pocketbase";
import { sanitizeHtml } from "@/lib/utils/sanitize";

interface MessageContextMenuProps {
  children: React.ReactNode;
  message: Message;
  /** All messages in the thread (for listing unique senders in the group submenu) */
  threadMessages?: Message[];
  onMarkAsRead?: (messageId: string, read: boolean) => Promise<void>;
  /** Ouvre la conversation de la ligne (volets Suivi / Recapitulatif / Suivi de lecture). */
  onOpenConversation?: () => void;
}

const TRANSLATE_URL = "/api/translate";

/** Taille max d'un batch envoye au LLM (somme des longueurs en chars).
 * On garde des batches relativement petits pour limiter les troncatures et
 * faciliter le retry granulaire en cas d'echec. */
const BATCH_CHAR_BUDGET = 2500;
/** Nb max d'items par batch (un LLM peut perdre le compte sur de longues listes) */
const BATCH_MAX_ITEMS = 40;
/** Texte trop court : on ne perd pas de tokens dessus (pure ponctuation, espaces) */
function shouldTranslate(s: string): boolean {
  if (!s) return false;
  // Au moins un caractere alphabetique
  return /[\p{L}]/u.test(s);
}

/** Decoupe un tableau de strings en batches selon BATCH_CHAR_BUDGET / MAX_ITEMS */
function buildBatches(items: string[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let size = 0;
  for (let i = 0; i < items.length; i++) {
    const len = items[i].length;
    if (
      current.length > 0 &&
      (size + len > BATCH_CHAR_BUDGET || current.length >= BATCH_MAX_ITEMS)
    ) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(i);
    size += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function postTranslateBatch(
  items: string[],
  targetLang: string,
  sourceLang: string,
): Promise<string[]> {
  const res = await fetch(`${TRANSLATE_URL}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, source: sourceLang, target: targetLang, apiKey: getOpenRouterKey() }),
  });
  if (!res.ok) throw new Error("Translation failed");
  const data = await res.json();
  if (!Array.isArray(data.translations) || data.translations.length !== items.length) {
    throw new Error("Translation failed: mismatched array");
  }
  return data.translations as string[];
}

/** Traduit un batch ; en cas d'echec, fallback en dichotomie jusqu'a 1 item. */
async function translateBatchWithFallback(
  items: string[],
  targetLang: string,
  sourceLang: string,
): Promise<string[]> {
  try {
    return await postTranslateBatch(items, targetLang, sourceLang);
  } catch (err) {
    if (items.length <= 1) {
      // Echec irrecuperable : on garde l'original pour ne rien perdre.
      console.warn("[translate] giving up on item", err);
      return items.slice();
    }
    const mid = Math.ceil(items.length / 2);
    const [left, right] = await Promise.all([
      translateBatchWithFallback(items.slice(0, mid), targetLang, sourceLang),
      translateBatchWithFallback(items.slice(mid), targetLang, sourceLang),
    ]);
    return [...left, ...right];
  }
}

/** Collect all text nodes with visible content from a DOM tree */
function collectTextNodes(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.textContent && node.textContent.trim()) nodes.push(node);
  }
  return nodes;
}

/**
 * Translate HTML in-place: extract every visible text node, translate them as
 * a JSON array (preserves 1:1 mapping) and write back into the same nodes.
 * Tous les tags HTML/styles/attributs sont preserves tels quels.
 */
async function translateHtml(
  html: string,
  targetLang: string,
  sourceLang: string,
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Nettoyage : elements masques / trackers / styles / scripts
  doc.querySelectorAll(
    'style, script, [style*="display:none"], [style*="display: none"], ' +
    '[style*="opacity:0"], [style*="opacity: 0"], ' +
    '[style*="font-size:1px"], [style*="font-size: 1px"], ' +
    '[style*="visibility:hidden"], [style*="visibility: hidden"], ' +
    '[width="1"][height="1"], .preheader'
  ).forEach((el) => el.remove());
  const commentWalker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  let c: Comment | null;
  while ((c = commentWalker.nextNode() as Comment | null)) comments.push(c);
  comments.forEach((cm) => cm.remove());

  const textNodes = collectTextNodes(doc.body);
  if (textNodes.length === 0) return doc.body.innerHTML;

  // On envoie le contenu brut (textContent) pour preserver eventuels espaces
  // significatifs ; on skip ceux qui n'ont rien a traduire (URLs pures,
  // ponctuation) pour economiser les tokens.
  const rawTexts = textNodes.map((tn) => tn.textContent ?? "");
  const translatable: { index: number; text: string }[] = [];
  rawTexts.forEach((t, i) => {
    if (shouldTranslate(t)) translatable.push({ index: i, text: t });
  });
  if (translatable.length === 0) return doc.body.innerHTML;

  const items = translatable.map((t) => t.text);
  const batches = buildBatches(items);

  const translatedByBatch = await Promise.all(
    batches.map((indices) => {
      const batchItems = indices.map((i) => items[i]);
      return translateBatchWithFallback(batchItems, targetLang, sourceLang);
    }),
  );

  // Reapplique les traductions dans les nodes d'origine.
  for (let b = 0; b < batches.length; b++) {
    const indices = batches[b];
    const translations = translatedByBatch[b];
    for (let k = 0; k < indices.length; k++) {
      const itemIdx = indices[k];
      const nodeIdx = translatable[itemIdx].index;
      const translated = translations[k];
      if (typeof translated === "string" && translated.length > 0) {
        textNodes[nodeIdx].textContent = translated;
      }
    }
  }

  return doc.body.innerHTML;
}

export async function translateText(
  text: string,
  targetLang: string,
  sourceLang = "auto",
  format: "text" | "html" = "text",
): Promise<string> {
  if (format === "html") {
    return translateHtml(text, targetLang, sourceLang);
  }
  // Pour du texte plat, on utilise aussi le batch JSON (un seul element)
  // pour profiter du fallback dichotomique en cas de troncature.
  const lines = text.split(/\n{2,}/);
  const indices: number[] = [];
  const items: string[] = [];
  lines.forEach((line, i) => {
    if (shouldTranslate(line)) {
      indices.push(i);
      items.push(line);
    }
  });
  if (items.length === 0) return text;

  const batches = buildBatches(items);
  const translatedByBatch = await Promise.all(
    batches.map((idxs) =>
      translateBatchWithFallback(
        idxs.map((i) => items[i]),
        targetLang,
        sourceLang,
      ),
    ),
  );

  const out = lines.slice();
  for (let b = 0; b < batches.length; b++) {
    const idxs = batches[b];
    const tr = translatedByBatch[b];
    for (let k = 0; k < idxs.length; k++) {
      const lineIdx = indices[idxs[k]];
      if (typeof tr[k] === "string" && tr[k].length > 0) {
        out[lineIdx] = tr[k];
      }
    }
  }
  return out.join("\n\n");
}

/** Strip HTML tags and collapse whitespace to get clean text for language detection */
export function stripHtmlForDetection(text: string): string {
  if (!text) return "";
  // If text contains HTML tags, parse and extract textContent
  if (/<[^>]+>/.test(text)) {
    const div = document.createElement("div");
    div.innerHTML = text;
    return (div.textContent || "").replace(/\s+/g, " ").trim();
  }
  return text.replace(/\s+/g, " ").trim();
}

export async function detectLanguage(text: string): Promise<string> {
  try {
    const clean = stripHtmlForDetection(text);
    if (!clean || clean.length < 10) return "auto";
    const res = await fetch(`${TRANSLATE_URL}/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: clean.substring(0, 500), apiKey: getOpenRouterKey() }),
    });
    if (!res.ok) return "auto";
    const data: { confidence: number; language: string }[] = await res.json();
    return data[0]?.language || "auto";
  } catch {
    return "auto";
  }
}

export interface LibreLanguage {
  code: string;
  name: string;
}

let fetchLanguagesPromise: Promise<LibreLanguage[]> | null = null;

export async function fetchLanguages(): Promise<LibreLanguage[]> {
  if (fetchLanguagesPromise) return fetchLanguagesPromise;
  fetchLanguagesPromise = (async () => {
    try {
      const res = await fetch(`${TRANSLATE_URL}/languages`);
      if (!res.ok) return [];
      return res.json() as Promise<LibreLanguage[]>;
    } catch {
      return [];
    } finally {
      fetchLanguagesPromise = null;
    }
  })();
  return fetchLanguagesPromise;
}

export function generateEml(message: Message): string {
  const lines: string[] = [];
  lines.push(`From: ${message.from_address?.name ? `${message.from_address.name} <${message.from_address.address}>` : message.from_address?.address}`);
  lines.push(`To: ${message.to_addresses?.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", ")}`);
  if (message.cc_addresses?.length) {
    lines.push(`Cc: ${message.cc_addresses.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", ")}`);
  }
  lines.push(`Subject: ${message.subject}`);
  lines.push(`Date: ${message.date}`);
  if (message.message_id) lines.push(`Message-ID: ${message.message_id}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/html; charset=utf-8");
  lines.push("");
  lines.push(message.html_body || message.text_body || "");
  return lines.join("\r\n");
}

function escHtml(v: string): string {
  return v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

/**
 * Impression d'un message. `bodyHtml` = corps DEJA nettoye (images via le
 * proxy) quand l'appelant l'a ; sinon le HTML est nettoye ici sans aucune
 * image distante : la fenetre d'impression partage l'origine de l'app, le
 * HTML brut d'un mail n'y est jamais ecrit.
 */
export function printMessage(message: Message, bodyHtml?: string) {
  const win = window.open("", "_blank", "width=800,height=600");
  if (!win) return;
  const body = bodyHtml
    ?? (message.html_body ? sanitizeHtml(message.html_body) : `<pre>${escHtml(message.text_body || "")}</pre>`);
  const from = message.from_address;
  win.document.write(`
    <html><head><title>${escHtml(message.subject || "")}</title>
    <style>body { font-family: -apple-system, system-ui, sans-serif; padding: 24px; max-width: 800px; margin: 0 auto; }
    .header { border-bottom: 1px solid #e5e7eb; padding-bottom: 16px; margin-bottom: 16px; }
    .field { font-size: 14px; color: #6b7280; margin: 4px 0; }
    .subject { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    .body { font-size: 14px; line-height: 1.6; }
    .body img { max-width: 100%; height: auto; }</style></head><body>
    <div class="header">
      <div class="subject">${escHtml(message.subject || "")}</div>
      <div class="field">De : ${escHtml(from?.name || "")} &lt;${escHtml(from?.address || "")}&gt;</div>
      <div class="field">A : ${message.to_addresses?.map((a) => `${escHtml(a.name || "")} &lt;${escHtml(a.address)}&gt;`).join(", ") || ""}</div>
      <div class="field">Date : ${new Date(message.date).toLocaleString()}</div>
    </div>
    <div class="body">${body}</div>
    </body></html>
  `);
  // Impression une fois les images (proxy) chargees, avec un plafond.
  let printed = false;
  const doPrint = () => {
    if (printed) return;
    printed = true;
    win.print();
  };
  win.addEventListener("load", doPrint);
  win.document.close();
  setTimeout(doPrint, 2500);
}

/** Une entree du menu, factorisee pour etre rendue soit en ContextMenu ancre
 * (desktop, clic droit), soit en bottom sheet Drawer (mobile, appui long),
 * soit dans le menu ⋮ d'une conversation ouverte (ThreadActionsMenu). */
export type MenuRow =
  | { type: "separator"; key: string }
  | { type: "group-sender"; key: string }
  | {
      type: "item";
      key: string;
      Icon: LucideIcon;
      label: string;
      onSelect: () => void;
      iconClassName?: string;
      active?: boolean;
      disabled?: boolean;
    };

function menuItem(
  key: string,
  Icon: LucideIcon,
  label: string,
  onSelect: () => void,
  extra?: { iconClassName?: string; active?: boolean; disabled?: boolean },
): MenuRow {
  return { type: "item", key, Icon, label, onSelect, ...extra };
}

/** Avale le "ghost click" qui suit un appui long sur tactile (iOS dispatch un
 * click synthetique ~300ms apres le touchend, a la position du doigt). Comme le
 * Drawer vient de s'ouvrir a cet endroit, ce click activerait sinon l'element
 * apparu sous le doigt (1er item -> Repondre, ou le voile -> fermeture). On
 * intercepte UN seul click en phase capture (avant qu'il atteigne le Drawer). */
function swallowNextClick() {
  let timer = 0;
  function cleanup() {
    document.removeEventListener("click", swallow, true);
    window.clearTimeout(timer);
  }
  function swallow(ev: MouseEvent) {
    ev.stopPropagation();
    ev.preventDefault();
    cleanup();
  }
  timer = window.setTimeout(cleanup, 600);
  document.addEventListener("click", swallow, true);
}

function menuSep(key: string): MenuRow {
  return { type: "separator", key };
}

/** Volets d'une conversation ouverte, demandables depuis un menu. */
export type ConversationPanel = "tracking" | "readReceipts" | "brief";

/**
 * Demande d'ouverture d'un volet faite depuis la LISTE (le volet vit dans
 * ThreadView) : la ligne ouvre la conversation puis pose la demande, que
 * ThreadView consomme des que le fil affiche correspond a l'un des `ids`
 * (id de conversation, thread_id ou id de message).
 */
export const useThreadPanelRequest = create<{
  request: { ids: string[]; panel: ConversationPanel; at: number } | null;
  ask: (ids: string[], panel: ConversationPanel) => void;
  clear: () => void;
}>((set) => ({
  request: null,
  ask: (ids, panel) => set({ request: { ids: ids.filter(Boolean), panel, at: Date.now() } }),
  clear: () => set({ request: null }),
}));

/**
 * Favori d'une conversation : la conversation est en favori si l'un de ses
 * messages affiches l'est ; basculer met ou retire TOUS les messages en
 * favori, copies d'autres dossiers comprises, avec un seul toast.
 */
export function useThreadStar(shown: Message[], copies?: Message[]) {
  const t = useT();
  const { markAsStarred } = useMessageActions();
  const starred = shown.some((m) => m.is_starred);
  // Etat optimiste : l'etoile bascule tout de suite, puis suit le fil des que
  // l'etat reel change (la bascule n'est valable que depuis l'etat d'origine).
  const [optimistic, setOptimistic] = useState<{ from: boolean; to: boolean } | null>(null);
  const lit = optimistic && optimistic.from === starred ? optimistic.to : starred;
  const toggle = async () => {
    const target = !lit;
    setOptimistic({ from: starred, to: target });
    const all = copies && copies.length > 0 ? copies : shown;
    const ids = [...new Set(all.filter((m) => !m.is_draft && !!m.is_starred !== target).map((m) => m.id))];
    // L'un apres l'autre : ThreadView ne lit qu'UNE mise a jour locale a la
    // fois (localMessageUpdate) ; envoyees ensemble, seule la derniere copie
    // passait en favori dans le fil et le second toucher en oubliait.
    for (const id of ids) await markAsStarred(id, target, { silent: true });
    // Fin des envois : l'etoile suit l'etat reel (retabli si un envoi a echoue).
    setOptimistic(null);
    toast.success(tStatic(target ? "message.starred" : "message.unstarred"));
  };
  const label = lit ? t("message.removeFavorite") : t("message.addFavorite");
  return { lit, toggle, label };
}

export interface ConversationActionsOptions {
  /** Message vise par les actions unitaires (dernier message de la conversation). */
  message: Message;
  /** Messages de la conversation (archivage, favori, regroupement). */
  threadMessages?: Message[];
  /** Copies brutes cross-dossier (favori : toutes les copies). */
  starCopies?: Message[];
  onMarkAsRead?: (messageId: string, read: boolean) => Promise<void>;
  isMobile: boolean;
  /** Ouvre un volet de la conversation (ThreadView) ; absent = depuis la liste. */
  openPanel?: (panel: ConversationPanel) => void;
  /** Depuis la liste : ouvre la conversation de la ligne. */
  onOpenConversation?: () => void;
  /** Surcharges du fil ouvert (brouillon repris, cible de reponse). */
  onReply?: () => void;
  replyTarget?: Message;
  onArchive?: () => void;
  state?: { tracked?: boolean; hasOpens?: boolean; hasBrief?: boolean };
  /** Sous-menu "Grouper par expediteur" : liste seulement. */
  includeGroupSender?: boolean;
}

/**
 * SOURCE UNIQUE des actions d'une conversation (choix utilisateur
 * 2026-10-21) : le menu de la liste (clic droit / appui long) et le menu ⋮
 * du fil ouvert affichent CES lignes, dans cet ordre ; seul le regroupement
 * par expediteur est reserve a la liste. Rend aussi les dialogues de
 * confirmation (supprimer, spam), la source et le tiroir "suivi existant".
 */
export function useConversationActions(opts: ConversationActionsOptions) {
  const {
    message,
    threadMessages,
    starCopies,
    onMarkAsRead,
    isMobile,
    openPanel,
    onOpenConversation,
    onReply,
    replyTarget,
    onArchive,
    state,
    includeGroupSender,
  } = opts;
  const t = useT();
  const openCompose = useMailStore((s) => s.openCompose);
  const openFilterRule = useMailStore((s) => s.openFilterRule);
  const activeFolder = useMailStore((s) => s.activeFolder);
  const { markAsRead, moveToTrash, moveToSpam, moveToInbox, permanentDelete, archiveMessage } = useMessageActions();
  const convoMessages = useMemo(
    () => (threadMessages?.length ? threadMessages : [message]),
    [message, threadMessages]
  );
  const trackedInStore = useTrackedThreads((s) =>
    convoMessages.some((m) => !!m.thread_id && s.ids.has(m.thread_id))
  );
  const isTracked = state?.tracked ?? trackedInStore;
  const star = useThreadStar(convoMessages, starCopies);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // "Changer le niveau" : vise le mail RECU le plus recent de la conversation
  // (la derniere ligne peut etre notre propre reponse, sans niveau).
  const importanceTarget = useMemo(() => {
    const received = convoMessages.filter((m) => !m.is_sent);
    if (!received.length) return message;
    return received.reduce((a, b) => ((b.date || "") > (a.date || "") ? b : a));
  }, [convoMessages, message]);
  const [importanceOpen, setImportanceOpen] = useState(false);
  const [importanceChoice, setImportanceChoice] = useState<Importance>("important");
  const [importanceBusy, setImportanceBusy] = useState(false);
  const [showSpamConfirm, setShowSpamConfirm] = useState(false);
  const [addToTrackingOpen, setAddToTrackingOpen] = useState(false);
  const isInSpam = activeFolder === "spam";
  const isInTrash = activeFolder === "trash";

  const blockedSenders = useSettingsStore((s) => s.blockedSenders);
  const groupedSenders = useSettingsStore((s) => s.groupedSenders);
  const senderName = message.from_address?.name || message.from_address?.address || "";
  const senderEmail = message.from_address?.address || "";
  const isSenderBlocked = senderEmail ? blockedSenders.includes(senderEmail) : false;

  // Collect unique senders from thread messages (or just the current message)
  // Deduplicate by name+address so GitHub-style notifications (same address, different names) show all authors
  const uniqueSenders = useMemo(() => {
    const seen = new Set<string>();
    const senders: { address: string; name: string }[] = [];
    for (const msg of convoMessages) {
      const addr = msg.from_address?.address?.toLowerCase();
      if (!addr) continue;
      const name = msg.from_address?.name || addr;
      const key = `${addr}|${name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        senders.push({ address: addr, name });
      }
    }
    return senders;
  }, [convoMessages]);

  // Sur telephone, un volet (tiroir) ouvert depuis un menu-tiroir attend la fin
  // de l'animation de sortie du menu avant de s'empiler.
  const afterMenu = useCallback(
    (fn: () => void) => () => {
      if (isMobile) setTimeout(fn, 350);
      else fn();
    },
    [isMobile]
  );

  // Volet demande : directement dans le fil ouvert ; depuis la liste, on ouvre
  // la conversation puis ThreadView consomme la demande.
  const showPanel = useCallback(
    (panel: ConversationPanel) => {
      if (openPanel) {
        afterMenu(() => openPanel(panel))();
        return;
      }
      onOpenConversation?.();
      const ids = [message.id, message.thread_id || ""];
      afterMenu(() => useThreadPanelRequest.getState().ask(ids, panel))();
    },
    [openPanel, onOpenConversation, message.id, message.thread_id, afterMenu]
  );

  const replyTo = replyTarget ?? message;

  const handleDelete = useCallback(async () => {
    if (isInTrash) {
      await permanentDelete(message.id);
    } else {
      await moveToTrash(message.id);
    }
    setShowDeleteConfirm(false);
  }, [message.id, moveToTrash, permanentDelete, isInTrash]);

  const handleRestore = useCallback(async () => {
    await moveToInbox(message.id);
  }, [message.id, moveToInbox]);

  // Referme la conversation SI c'est bien celle de ce message qui est ouverte
  // (le menu sert aussi bien une ligne de liste qu'un message affiche) : on ne
  // referme jamais un fil sans rapport avec le geste.
  const closeIfOpen = useCallback(() => {
    const { selectedThreadId, selectedMessageId, requestCloseThread } = useMailStore.getState();
    const isOpen =
      (!!message.thread_id && selectedThreadId === message.thread_id) ||
      selectedMessageId === message.id;
    if (isOpen) requestCloseThread();
  }, [message.id, message.thread_id]);

  const handleToggleRead = useCallback(async () => {
    const markUnread = message.is_read;
    // "Non lu" : si la conversation est a l'ecran, on la referme d'abord — sinon
    // l'ecran de lecture la repasserait en lu dans la foulee.
    if (markUnread) closeIfOpen();
    const toggleFn = onMarkAsRead ?? markAsRead;
    await toggleFn(message.id, !message.is_read);
    toast.success(tStatic(markUnread ? "message.markedUnread" : "message.markedRead"));
  }, [message.id, message.is_read, markAsRead, onMarkAsRead, closeIfOpen]);

  // Archiver : toutes les copies de la conversation, un seul toast.
  const handleArchive = useCallback(async () => {
    if (onArchive) {
      onArchive();
      return;
    }
    closeIfOpen();
    for (const m of convoMessages) {
      if (m.is_draft) continue;
      await archiveMessage(m.id, { silent: true });
    }
    toast.success(tStatic("message.archived"));
  }, [onArchive, closeIfOpen, convoMessages, archiveMessage]);

  // Toasts blocage/deblocage geres par blockSender/unblockSender (useSettings)
  const handleBlock = useCallback(async () => {
    if (!senderEmail) return;
    if (isSenderBlocked) {
      await unblockSender(senderEmail);
      return;
    }
    // Bloquer referme la conversation de l'expediteur : la liste redevient
    // visible pendant que ses lignes jouent leur animation de retrait, et le
    // bandeau d'annulation reste utilisable par-dessus.
    closeIfOpen();
    await blockSender(senderEmail);
  }, [senderEmail, isSenderBlocked, closeIfOpen]);

  const handleSpam = useCallback(async () => {
    await moveToSpam(message.id);
    setShowSpamConfirm(false);
  }, [message.id, moveToSpam]);

  const handleNotSpam = useCallback(async () => {
    await moveToInbox(message.id);
  }, [message.id, moveToInbox]);

  const handleDownload = useCallback(() => {
    const eml = generateEml(message);
    const blob = new Blob([eml], { type: "message/rfc822" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${message.subject || "message"}.eml`;
    a.click();
    URL.revokeObjectURL(url);
  }, [message]);

  // Ordre et separateurs IDENTIQUES dans les deux menus.
  const rows: MenuRow[] = [
    menuItem("reply", Reply, t("compose.reply"), onReply ?? (() => openCompose("reply", replyTo.id))),
    menuItem("replyAll", ReplyAll, t("compose.replyAll"), () => openCompose("reply-all", replyTo.id)),
    menuItem("forward", Forward, t("compose.forward"), () => openCompose("forward", message.id)),
    menuSep("sep1"),
    ...(isInTrash ? [menuItem("restore", Inbox, t("message.restore"), handleRestore)] : []),
    ...(isInTrash ? [] : [menuItem("archive", Archive, t("message.archive"), () => void handleArchive())]),
    menuItem(
      "toggleRead",
      message.is_read ? Mail : MailOpen,
      message.is_read ? t("message.markAsUnread") : t("message.markAsRead"),
      handleToggleRead,
    ),
    menuItem(
      "delete",
      Trash2,
      isInTrash ? t("message.deletePermanently") : t("message.moveToTrash"),
      () => setShowDeleteConfirm(true),
    ),
    menuSep("sep2"),
    menuItem(
      "block",
      Ban,
      isSenderBlocked
        ? t("message.unblockSender", { sender: senderName })
        : t("message.blockSender", { sender: senderName }),
      handleBlock,
    ),
    isInSpam
      ? menuItem("notSpam", ShieldAlert, t("message.notSpam"), handleNotSpam)
      : menuItem("spam", ShieldAlert, t("message.reportSpam"), () => setShowSpamConfirm(true)),
    ...(includeGroupSender && uniqueSenders.length > 0 ? [{ type: "group-sender" as const, key: "groupSender" }] : []),
    menuSep("sep3"),
    menuItem("tracking", PackageSearch, t("tracking.title"), () => showPanel("tracking"), {
      iconClassName: isTracked ? "text-tracking" : undefined,
      active: isTracked,
    }),
    menuItem("addToTracking", PackagePlus, t("tracking.addToExisting"), afterMenu(() => setAddToTrackingOpen(true))),
    menuItem("readReceipts", CheckCheck, t("readReceipts.title"), () => showPanel("readReceipts"), {
      active: state?.hasOpens,
    }),
    menuItem("brief", ListChecks, t("thread.brief"), () => showPanel("brief"), {
      iconClassName: state?.hasBrief ? "text-note-strong" : undefined,
      active: state?.hasBrief,
    }),
    menuItem("star", Star, star.label, () => void star.toggle(), {
      iconClassName: star.lit ? "fill-starred text-starred" : undefined,
    }),
    ...(importanceTarget.is_sent || importanceTarget.is_draft
      ? []
      : [
          menuItem("changeImportance", Gauge, t("importance.change"), () => {
            setImportanceChoice(isImportance(importanceTarget.importance) ? importanceTarget.importance : "important");
            setImportanceOpen(true);
          }),
        ]),
    menuSep("sep4"),
    menuItem("filter", Filter, t("message.filterSimilar"), () => openFilterRule(message)),
    menuSep("sep5"),
    menuItem("print", Printer, t("message.print"), () => printMessage(message)),
    menuItem("download", Download, t("message.downloadMessage"), handleDownload),
    menuItem("original", Code, t("message.showOriginal"), () => setSourceOpen(true)),
  ];

  // Bascule group/ungroup d'un expediteur (partage desktop/mobile).
  const toggleGroupSender = async (address: string, isGrouped: boolean) => {
    if (isGrouped) {
      await ungroupSender(address);
      toast.success(tStatic("message.senderUngrouped"));
    } else {
      await groupSender(address);
      toast.success(tStatic("message.senderGrouped"));
    }
  };

  const dialogs = (
    <>
      <MessageSourceDialog
        message={message}
        open={sourceOpen}
        onOpenChange={setSourceOpen}
      />

      <AddToTrackingDrawer
        open={addToTrackingOpen}
        onOpenChange={setAddToTrackingOpen}
        messageIds={[message.id]}
      />

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{isInTrash ? t("message.deletePermanentlyConfirmTitle") : t("message.deleteConfirmTitle")}</DialogTitle>
            <DialogDescription>{isInTrash ? t("message.deletePermanentlyConfirmDescription") : t("message.deleteConfirmDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              {isInTrash ? t("message.deletePermanently") : t("message.moveToTrash")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importanceOpen} onOpenChange={(o) => !importanceBusy && setImportanceOpen(o)}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm [&>*]:min-w-0" data-ref="importance-dialog">
          <DialogHeader>
            <DialogTitle>{t("importance.change")}</DialogTitle>
            <DialogDescription className="truncate">
              {importanceTarget.from_address?.name || importanceTarget.from_address?.address || ""}
              {importanceTarget.subject ? ` · ${importanceTarget.subject}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("importance.forLevel")}>
            {IMPORTANCE_LEVELS.map((lvl) => (
              <button
                key={lvl}
                type="button"
                role="radio"
                aria-checked={importanceChoice === lvl}
                onClick={() => setImportanceChoice(lvl)}
                data-ref={`importance-choice-${lvl}`}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-medium transition-colors",
                  importanceChoice === lvl ? "border-foreground bg-accent" : "border-border hover:bg-accent/60"
                )}
              >
                <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: IMPORTANCE_COLORS[lvl] }} />
                {t(`importance.level.${lvl}`)}
              </button>
            ))}
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            {(["message", "sender"] as const).map((scope) => (
              <Button
                key={scope}
                variant={scope === "message" ? "default" : "outline"}
                disabled={importanceBusy}
                data-ref={`importance-apply-${scope}`}
                onClick={async () => {
                  setImportanceBusy(true);
                  try {
                    const res = await changeMessageImportance(importanceTarget.id, importanceChoice, scope);
                    const level = tStatic(`importance.level.${importanceChoice}`).toLowerCase();
                    toast.success(
                      scope === "message"
                        ? tStatic("importance.changedMessage", { level })
                        : tStatic("importance.changedSender", {
                            count: String(res.updated),
                            sender: res.sender || "",
                            level,
                          })
                    );
                    setImportanceOpen(false);
                  } catch {
                    toast.error(tStatic("importance.changeError"));
                  } finally {
                    setImportanceBusy(false);
                  }
                }}
              >
                {t(scope === "message" ? "importance.scopeMessage" : "importance.scopeSender")}
              </Button>
            ))}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showSpamConfirm} onOpenChange={setShowSpamConfirm}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("message.spamConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("message.spamConfirmDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSpamConfirm(false)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={handleSpam}>
              {t("message.reportSpam")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return { rows, dialogs, uniqueSenders, groupedSenders, toggleGroupSender, senderName };
}

export function MessageContextMenu({ children, message, threadMessages, onMarkAsRead, onOpenConversation }: MessageContextMenuProps) {
  const t = useT();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isMobile = useIsMobile();
  // Le relachement du clic droit qui ouvre le menu peut tomber sur une ligne
  // (Chrome Linux/Windows ouvre au mousedown) : Radix la choisirait au
  // pointerup (ex. Repondre -> brouillon vide). Ignore pendant 500 ms.
  const openedAtRef = useRef(0);
  const guardRelease = (e: React.PointerEvent) => {
    if (Date.now() - openedAtRef.current < 500) e.preventDefault();
  };
  const { rows, dialogs, uniqueSenders, groupedSenders, toggleGroupSender, senderName } = useConversationActions({
    message,
    threadMessages,
    onMarkAsRead,
    isMobile,
    onOpenConversation,
    includeGroupSender: true,
  });


  return (
    <>
      {isMobile ? (
        <>
          {/* Mobile : l'appui long (synthetique `contextmenu` dispatche par
              SwipeableMailRow) ouvre un bottom sheet Drawer au lieu d'un menu
              ancre. On greffe le handler directement sur la ligne (qui propage
              ses props au DOM) sans passer par Radix. */}
          {cloneElement(
            children as React.ReactElement<{ onContextMenu?: React.MouseEventHandler }>,
            {
              onContextMenu: (e: React.MouseEvent) => {
                e.preventDefault();
                setDrawerOpen(true);
                swallowNextClick();
              },
            },
          )}
          <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} repositionInputs={false} noBodyStyles>
            <DrawerContent hideGrip className="sheet-max-h" data-ref="message-context-sheet">
              <DrawerSheetHeader
                title={senderName || t("compose.moreOptions")}
              />
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {rows.map((row) => {
                  if (row.type === "separator")
                    return <div key={row.key} className="bg-border my-1 h-px" aria-hidden />;
                  if (row.type === "group-sender")
                    return (
                      <div key={row.key} className="flex flex-col">
                        <div className="text-muted-foreground flex items-center gap-3 px-3 pt-2 pb-1 text-xs">
                          <Users className="size-4 shrink-0" />
                          {t("message.groupSender")}
                        </div>
                        {uniqueSenders.map((sender) => {
                          const isGrouped = isSenderGrouped(groupedSenders, sender.address);
                          return (
                            <button
                              key={`${sender.address}|${sender.name}`}
                              type="button"
                              onClick={() => toggleGroupSender(sender.address, isGrouped)}
                              className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors active:bg-muted"
                            >
                              <div className={cn("flex size-4 shrink-0 items-center justify-center rounded-sm border", isGrouped ? "border-foreground/70" : "border-muted-foreground/30")}>
                                {isGrouped && <Check className="size-3 text-foreground" />}
                              </div>
                              <div className="flex min-w-0 flex-col">
                                <span className="truncate">{sender.name}</span>
                                {sender.name.toLowerCase() !== sender.address && (
                                  <span className="text-muted-foreground truncate text-xs">{sender.address}</span>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    );
                  const { Icon } = row;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      onClick={() => {
                        setDrawerOpen(false);
                        row.onSelect();
                      }}
                      disabled={row.disabled}
                      className={cn(
                        "flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors active:bg-muted disabled:opacity-50",
                        row.active && "font-semibold"
                      )}
                      data-ref={`message-context-${row.key}`}
                    >
                      <Icon className={cn("size-4 shrink-0", row.iconClassName ?? "text-muted-foreground")} />
                      {row.label}
                    </button>
                  );
                })}
              </div>
            </DrawerContent>
          </Drawer>
        </>
      ) : (
        <ContextMenu
          onOpenChange={(o) => {
            if (o) openedAtRef.current = Date.now();
          }}
        >
          <ContextMenuTrigger asChild>
            {children}
          </ContextMenuTrigger>
          <ContextMenuContent className="w-64" data-ref="message-context-list">
            {rows.map((row) => {
              if (row.type === "separator") return <ContextMenuSeparator key={row.key} />;
              if (row.type === "group-sender")
                return (
                  <ContextMenuSub key={row.key}>
                    <ContextMenuSubTrigger>
                      <Users />
                      {t("message.groupSender")}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-64">
                      {uniqueSenders.map((sender) => {
                        const isGrouped = isSenderGrouped(groupedSenders, sender.address);
                        return (
                          <ContextMenuItem
                            key={`${sender.address}|${sender.name}`}
                            onPointerUp={guardRelease}
                            onClick={() => toggleGroupSender(sender.address, isGrouped)}
                          >
                            <div className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border ${isGrouped ? "border-foreground/70" : "border-muted-foreground/30"}`}>
                              {isGrouped && <Check className="size-3 text-foreground" />}
                            </div>
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate text-sm">{sender.name}</span>
                              {sender.name.toLowerCase() !== sender.address && (
                                <span className="truncate text-xs text-muted-foreground">{sender.address}</span>
                              )}
                            </div>
                          </ContextMenuItem>
                        );
                      })}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                );
              const { Icon } = row;
              return (
                <ContextMenuItem
                  key={row.key}
                  onPointerUp={guardRelease}
                  onClick={row.onSelect}
                  disabled={row.disabled}
                  className={cn(row.active && "font-semibold")}
                  data-ref={`message-context-${row.key}`}
                >
                  <Icon className={cn(row.iconClassName)} />
                  {row.label}
                </ContextMenuItem>
              );
            })}
          </ContextMenuContent>
        </ContextMenu>
      )}

      {dialogs}
    </>
  );
}
