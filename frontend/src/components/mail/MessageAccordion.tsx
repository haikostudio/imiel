"use client";

import { useIaDisponible } from "@/lib/ai-settings";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Archive,
  Mail,
  MailOpen,
  Ban,
  ShieldAlert,
  Filter,
  Languages,
  Loader2,
  Printer,
  Download,
  Code,
  Copy,
  FileCode2,
  Info,
  Paperclip,
  Newspaper,
  ChevronDown,
  EllipsisVertical,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { RemoveScroll } from "react-remove-scroll";
import { cn } from "@/lib/utils";
import { ContactAvatar } from "@/components/mail/ContactAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { formatFullDate } from "@/lib/utils/date";
import { sanitizeHtml, collectRemoteImageUrls, stripReplacementChars } from "@/lib/utils/sanitize";
import { proxiedImageSrc, useProxiedImages } from "@/lib/image-proxy";
import { AttachmentList } from "./AttachmentList";
import { MessageViews } from "./MessageViews";
import { CalendarEventCard } from "./CalendarEventCard";
import { EmailBodyFrame } from "./EmailBodyFrame";
import { MessageHtmlView } from "./MessageHtmlView";
import { openImageInThread, registerMessageImages, type LightboxImage } from "./ImageLightbox";
import {
  fetchMessageAttachments,
  isImageAttachment,
  isPocketBaseFileUrl,
  referencedCids,
  resolveCidImages,
  normalizeCid,
  type MessageAttachmentItem,
} from "@/lib/inline-images";
import { useMailStore } from "@/lib/stores/mail-store";
import { useMessageActions } from "@/lib/hooks/useMessageActions";
import { useNewsletterSources } from "@/lib/hooks/useNewsletterSources";
import { useCalendarEvents } from "@/lib/hooks/useCalendarEvents";
import { useSettingsStore, blockSender, useIsMiel } from "@/lib/hooks/useSettings";
import { useT } from "@/lib/i18n";
import { t as tStatic } from "@/lib/i18n";
import type { Message, ReadReceipt } from "@/lib/pocketbase";
import { uniqueRecipients } from "@/lib/utils/recipients";
import { hasReplyAllExtra, normAddr } from "@/lib/reply-agent";
import {
  detectLanguage,
  stripHtmlForDetection,
  translateText,
  fetchLanguages,
  generateEml,
  printMessage,
  type LibreLanguage,
} from "./MessageContextMenu";
import { MessageSourceDialog } from "./MessageSourceDialog";
import { TranslateDialog, type TranslationResult } from "./TranslateDialog";
import { parseHeaderDetails, type AuthResult } from "@/lib/utils/headers";
import {
  classifyMessagePresentation,
  extractBubbleText,
  splitQuoteHeader,
  type MessagePresentation,
} from "@/lib/utils/message-presentation";

let cachedLanguages: LibreLanguage[] | null = null;

const QUOTE_BTN_STYLES = [
  "display:inline-flex",
  "align-items:center",
  "justify-content:center",
  "border-radius:6px",
  "border:1px solid var(--border)",
  "padding:2px 8px",
  "cursor:pointer",
  "color:var(--muted-foreground)",
  "background:transparent",
  "margin:4px 0",
  "font-size:14px",
  "line-height:1",
  "letter-spacing:0.2em",
  "transition:background 0.15s",
].join(";");

function addQuoteToggles(html: string): string {
  if (!html || typeof window === "undefined") return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const quotes = doc.querySelectorAll(
      'blockquote, .gmail_quote, .gmail_extra, .yahoo_quoted, [id="appendonsend"], #divRplyFwdMsg'
    );
    if (quotes.length === 0) return html;

    // Chaque quote est traitee individuellement (pas de dedup parent).
    // Les quotes imbriquees ont chacune leur propre bouton toggle.
    // L'ouverture est en cascade : ouvrir le niveau N revele le bouton du niveau N+1.
    quotes.forEach((q) => {
      (q as HTMLElement).style.display = "none";
      q.setAttribute("data-collapsed-quote", "true");

      const btn = doc.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-quote-toggle", "true");
      btn.setAttribute("style", QUOTE_BTN_STYLES);
      btn.setAttribute(
        "onmouseenter",
        "this.style.background='var(--muted)'"
      );
      btn.setAttribute(
        "onmouseleave",
        "this.style.background='transparent'"
      );
      btn.textContent = "\u00B7\u00B7\u00B7";
      btn.title = tStatic("message.showQuotedText");

      q.parentNode?.insertBefore(btn, q);
    });
    return doc.body.innerHTML;
  } catch {
    return html;
  }
}

function getLanguageName(code: string): string {
  const lang = cachedLanguages?.find((l) => l.code === code);
  return lang?.name || code;
}

/** Une action d'un message, factorisee pour etre rendue soit dans le menu du
 * clic droit (ordinateur), soit dans le tiroir de l'appui long (telephone). */
type MoreRow =
  | { type: "sep"; key: string }
  | { type: "item"; key: string; Icon: LucideIcon; label: string; onSelect: () => void; destructive?: boolean };

interface MessageAccordionProps {
  message: Message;
  onReply?: (mode: "reply" | "reply-all", messageId: string) => void;
  /** Suivi de lecture d'un mail ENVOYE : ses evenements (envoi, reception,
   * ouvertures). Present (meme vide) pour les messages a soi ; le bouton des
   * vues ne s'affiche que si le mail est suivi (au moins un evenement : le
   * pixel n'existe que sur les envois faits depuis l'app). */
  receipts?: ReadReceipt[] | null;
  /** Le menu des vues s'ouvre / se ferme (releve en continu pendant). */
  onViewsOpenChange?: (open: boolean) => void;
  /** Brouillon du fil : badge "Brouillon", ni appui long ni details, contenu
   * toujours ouvert (hors accordeon), historique cite retire ; clic = reprise. */
  draft?: boolean;
  onOpenDraft?: (id: string) => void;
  /** Mail ecrit par l'utilisateur : bulle foncee a droite (jeton primary),
   * sans avatar ni nom ; sinon bulle grise a gauche avec avatar et nom. */
  isMine?: boolean;
  /** Premier mail (chronologique) de la conversation ET ecrit par
   * l'utilisateur : fond bleu clair (jeton mine), repere d'une conversation
   * entamee par lui. Ses autres mails restent noirs (primary). */
  isConversationOpener?: boolean;
  /** Suite d'une serie (meme adresse, meme jour, message du dessus affiche) :
   * ni avatar ni nom, seulement l'heure et les coches (lib/utils/message-series). */
  seriesContinuation?: boolean;
  /** Compte d'envoi a signaler (fil ou l'utilisateur ecrit depuis >= 2 de ses
   * adresses) : pastille de la couleur du compte + son nom avant l'heure. */
  senderAccount?: { label: string; color: string | null } | null;
  /** Adresses de l'utilisateur (tous comptes, minuscules) : "vous" dans la
   * ligne des destinataires, et "Repondre a tous" seulement s'il vise d'autres
   * personnes que l'auteur. */
  myEmails?: ReadonlySet<string>;
}

const NO_EMAILS: ReadonlySet<string> = new Set();

// Retire l'historique cite (.haiko-quote / blockquote) d'un HTML de brouillon :
// le message repondu est affiche juste en dessous dans le fil.
function stripQuotedHistory(html: string): string {
  if (!html || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(".haiko-quote, blockquote").forEach((el) => el.remove());
  return doc.body.innerHTML;
}

// Fond du corps d'un brouillon (= amber-50, fond de la ligne en clair).
const DRAFT_PAPER = "#fffbeb";
// Meme marge que les bulles du fil (px-3 py-2) : brouillons ET mails mis en
// page (le texte ne touche plus le bord ni les coins arrondis du bloc).
const FRAME_PADDING = "8px 12px";

// Appui long sur un message (telephone) : ouvre son tiroir d'actions. Annule
// des que le doigt bouge (defilement), comme lib/hooks/useLongPress.ts.
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;

/** Heure d'un message dans le fil : la pastille de date porte deja le jour. */
function formatMessageTime(date: string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+|[\w.+-]+@[\w-]+\.[\w.-]+)/g;

/** Texte de bulle avec liens et adresses cliquables (ouverts hors de l'app). */
function LinkifiedText({ text }: { text: string }) {
  const openCompose = useMailStore((s) => s.openCompose);
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        if (part.includes("@") && !part.startsWith("http")) {
          return (
            <button
              key={i}
              type="button"
              onClick={() => openCompose("new", null, part)}
              className="underline decoration-current/40 underline-offset-2 hover:decoration-current"
            >
              {part}
            </button>
          );
        }
        const href = part.startsWith("http") ? part : `https://${part}`;
        return (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-current/40 underline-offset-2 hover:decoration-current"
          >
            {part}
          </a>
        );
      })}
    </>
  );
}

export function MessageAccordion({ message, onReply, receipts = null, onViewsOpenChange, draft = false, onOpenDraft, isMine = false, isConversationOpener = false, seriesContinuation = false, senderAccount = null, myEmails = NO_EMAILS }: MessageAccordionProps) {
  const iaDispo = useIaDisponible();
  const t = useT();
  const isMobile = useIsMobile();
  const isMiel = useIsMiel();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [htmlOpen, setHtmlOpen] = useState(false);
  const [htmlPane, setHtmlPane] = useState<HTMLElement | null>(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const contextOpenedAtRef = useRef(0);
  const openCompose = useMailStore((s) => s.openCompose);
  const openFilterRule = useMailStore((s) => s.openFilterRule);
  const { markAsRead, moveToTrash, archiveMessage, moveToSpam, moveToInbox } = useMessageActions();
  const { isSource, addSource, removeSource } = useNewsletterSources();
  const appLanguage = useSettingsStore((s) => s.language);
  const { events: calendarEvents, loading: calendarLoading } = useCalendarEvents(message);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showTranslate, setShowTranslate] = useState(false);
  const [translation, setTranslation] = useState<TranslationResult | null>(null);
  const [detectedLang, setDetectedLang] = useState<string | null>(null);
  const [quickTranslating, setQuickTranslating] = useState(false);
  const detectRan = useRef(false);

  // Detection automatique de la langue au montage
  useEffect(() => {
    if (detectRan.current || draft) return;
    // Extraire du texte propre (sans HTML) pour la detection
    let bodyText = stripHtmlForDetection(message.text_body || "");
    if (bodyText.length < 20) {
      bodyText = stripHtmlForDetection(message.html_body || "");
    }
    if (bodyText.length < 20) {
      bodyText = message.snippet || "";
    }
    // Combiner sujet + corps tronque pour une meilleure detection
    const subject = (message.subject || "").trim();
    const detectText = subject
      ? `${subject}\n${bodyText.substring(0, 400)}`
      : bodyText.substring(0, 500);
    if (!detectText || detectText.length < 20) return;
    detectRan.current = true;
    // Charger le cache des langues en parallele
    if (!cachedLanguages) {
      fetchLanguages().then((langs) => {
        if (langs.length > 0) cachedLanguages = langs;
      });
    }
    detectLanguage(detectText).then((lang) => {
      if (lang && lang !== "auto" && lang !== appLanguage) {
        setDetectedLang(lang);
      }
    }).catch(() => {});
  }, [message.text_body, message.snippet, message.html_body, message.subject, appLanguage, draft]);

  // Traduction rapide en un clic
  const handleQuickTranslate = useCallback(async () => {
    const content = message.html_body || message.text_body || "";
    if (!content || !detectedLang) return;
    setQuickTranslating(true);
    try {
      const format = message.html_body ? "html" : "text";
      const result = await translateText(content, appLanguage, detectedLang, format as "text" | "html");
      setTranslation({
        translatedHtml: result,
        sourceLang: detectedLang,
        sourceLabel: getLanguageName(detectedLang),
        targetLabel: getLanguageName(appLanguage),
      });
    } catch {
      toast.error(tStatic("message.translateError"));
    } finally {
      setQuickTranslating(false);
    }
  }, [message.html_body, message.text_body, detectedLang, appLanguage]);

  const senderName = message.from_address?.name || message.from_address?.address || "";
  const senderEmail = message.from_address?.address || "";
  const recipients = useMemo(
    () =>
      uniqueRecipients([
        message.to_addresses,
        message.cc_addresses,
        message.bcc_addresses,
      ]),
    [message.to_addresses, message.cc_addresses, message.bcc_addresses]
  );

  const handleReply = () => {
    if (onReply) onReply("reply", message.id);
    else openCompose("reply", message.id);
  };
  const handleReplyAll = () => {
    if (onReply) onReply("reply-all", message.id);
    else openCompose("reply-all", message.id);
  };
  const handleForward = () => openCompose("forward", message.id);

  // Gestes rapides sous le message (survol sur ordinateur, bouton a chevron
  // sur telephone). "Repondre a tous" seulement s'il vise d'autres personnes
  // que l'auteur (meme regle que la fenetre de redaction : replyAllRecipients).
  const canReplyAll = useMemo(() => hasReplyAllExtra(message, myEmails), [message, myEmails]);
  const quickActions: { key: string; Icon: LucideIcon; label: string; onSelect: () => void }[] = [
    { key: "reply", Icon: Reply, label: t("message.reply"), onSelect: handleReply },
    ...(canReplyAll ? [{ key: "replyAll", Icon: ReplyAll, label: t("compose.replyAll"), onSelect: handleReplyAll }] : []),
    { key: "forward", Icon: Forward, label: t("message.forward"), onSelect: handleForward },
  ];
  const [quickOpen, setQuickOpen] = useState(false);

  // Destinataires de tout message (recu OU envoye, choix utilisateur
  // 2026-10-20) : pile de mini-avatars sous la bulle, menu A / Cc / Cci au clic
  // sur le visage de l'auteur ou sur la pile. Au-dela de STACK_MAX visages, "+N".
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  const avatarTriggerRef = useRef<HTMLButtonElement>(null);
  const STACK_MAX = 3;
  const stackHead = recipients.length > STACK_MAX ? recipients.slice(0, STACK_MAX - 1) : recipients;
  const stackRest = recipients.length - stackHead.length;

  const handleDelete = async () => {
    await moveToTrash(message.id);
    setShowDeleteConfirm(false);
  };
  const handleArchive = async () => { await archiveMessage(message.id); };
  const handleToggleRead = async () => {
    const markUnread = message.is_read;
    // "Non lu" depuis la conversation OUVERTE : on referme et on revient a la
    // liste, ou la ligne reprend son apparence non lue. La fermeture annule
    // aussi le marquage differe, sinon le fil rebasculerait en lu juste apres.
    if (markUnread) useMailStore.getState().requestCloseThread();
    await markAsRead(message.id, !message.is_read);
    toast.success(tStatic(markUnread ? "message.markedUnread" : "message.markedRead"));
  };
  const handleBlock = async () => {
    if (!senderEmail) return;
    // Fermer la conversation ouverte (pane desktop / drawer mobile) : la liste
    // redevient visible pendant que les lignes de l'expediteur bloque jouent
    // leur animation de retrait (blockSender -> notifySenderRemoval + toast).
    useMailStore.getState().requestCloseThread();
    await moveToSpam(message.id, { silent: true });
    await blockSender(senderEmail);
  };
  const handleSpam = async () => {
    await moveToSpam(message.id);
  };
  const handleNotSpam = async () => {
    await moveToInbox(message.id);
  };
  const handleFilterSimilar = () => {
    openFilterRule(message);
  };
  const isNewsletterSource = isSource(senderEmail);
  const handleToggleNewsletterSource = async () => {
    if (!senderEmail) return;
    try {
      if (isNewsletterSource) {
        await removeSource(senderEmail);
        toast.success(tStatic("newsletters.sourceRemoved"));
      } else {
        await addSource(senderEmail, senderName);
        toast.success(tStatic("newsletters.sourceAdded", { sender: senderName }));
      }
    } catch {
      toast.error(tStatic("newsletters.sourceError"));
    }
  };
  const handleTranslate = () => {
    setShowTranslate(true);
  };
  const handleTranslated = (result: TranslationResult) => {
    setTranslation(result);
  };
  const handleShowOriginal = () => {
    setTranslation(null);
  };
  // Impression : le corps deja nettoye (images via le proxy), jamais le HTML brut.
  const handlePrint = () => {
    printMessage(message, message.html_body ? (translation ? translatedHtmlBody : sanitizedBody) : undefined);
  };
  const handleDownload = () => {
    const eml = generateEml(message);
    const blob = new Blob([eml], { type: "message/rfc822" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${message.subject || "message"}.eml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const activeFolder = useMailStore((s) => s.activeFolder);
  // Images distantes affichees d'office, toujours via le proxy du worker
  // (verifiees + redessinees, lib/image-proxy.ts) ; pixels espions jamais
  // demandes. Le dossier indesirables n'en charge aucune.
  const inSpam = activeFolder === "spam";
  const remoteImageUrls = useMemo(
    () => (!draft && !inSpam && message.html_body ? collectRemoteImageUrls(message.html_body) : []),
    [draft, inSpam, message.html_body]
  );
  const imagesReady = useProxiedImages(remoteImageUrls);
  const proxyImageSrc = inSpam ? undefined : proxiedImageSrc;

  // Corps non charge : on n'a que les metadonnees de la liste (LIST_FIELDS exclut
  // html_body/text_body). Le ThreadView fetch le contenu complet apres montage.
  const bodyLoaded = message.html_body !== undefined || message.text_body !== undefined;
  // Corps rendu une fois les images signees (squelette entre-temps) : pas de
  // second rendu du cadre quand elles arrivent.
  const bodyReady = bodyLoaded && imagesReady;

  // Pieces jointes du message : liste, images integrees (cid:) et visionneuse
  // partagent la meme lecture.
  const hasCidRefs = !!message.html_body && /cid:/i.test(message.html_body);
  const needsAttachments = message.has_attachments || hasCidRefs;
  const [attItems, setAttItems] = useState<MessageAttachmentItem[] | null>(null);
  useEffect(() => {
    if (!needsAttachments) {
      setAttItems([]);
      return;
    }
    let alive = true;
    void fetchMessageAttachments(message).then((items) => {
      if (alive) setAttItems(items);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id, needsAttachments]);

  const sanitizedBody = useMemo(() => {
    if (draft) {
      // Brouillon : contenu propre a l'utilisateur, rendu tel que le verra le
      // destinataire (images comprises), sans l'historique cite.
      if (message.html_body) {
        const resolved = resolveCidImages(stripQuotedHistory(message.html_body), attItems ?? []);
        return sanitizeHtml(resolved, { allowExternalImages: true, trustedImageSrc: isPocketBaseFileUrl });
      }
      return stripReplacementChars(message.text_body ?? "");
    }
    if (message.html_body) {
      const resolved = resolveCidImages(message.html_body, attItems ?? []);
      const sanitized = sanitizeHtml(resolved, { proxyImageSrc, trustedImageSrc: isPocketBaseFileUrl });
      return addQuoteToggles(sanitized);
    }
    return stripReplacementChars(message.text_body ?? "");
    // imagesReady : re-rendu une fois les URL du proxy signees.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.html_body, message.text_body, proxyImageSrc, imagesReady, attItems, draft]);

  // Brouillon sans texte ni image : une mention plutot qu'une bande vide.
  const draftIsEmpty = useMemo(() => {
    if (!draft) return false;
    if (/<img\b/i.test(sanitizedBody)) return false;
    return !sanitizedBody.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").trim();
  }, [draft, sanitizedBody]);

  const translatedHtmlBody = useMemo(() => {
    if (!translation || !message.html_body) return "";
    const resolved = resolveCidImages(translation.translatedHtml, attItems ?? []);
    return addQuoteToggles(sanitizeHtml(resolved, { proxyImageSrc, trustedImageSrc: isPocketBaseFileUrl }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translation, message.html_body, proxyImageSrc, imagesReady, attItems]);

  // Images deja visibles dans le corps (cid: ou fichier joint reference) : pas
  // repetees dans la liste des pieces jointes (logos, signatures).
  const listedAttachments = useMemo(() => {
    if (!attItems) return null;
    const cids = referencedCids(message.html_body);
    const body = message.html_body || "";
    return attItems.filter((a) => {
      const cid = normalizeCid(a.contentId);
      if (cid && cids.has(cid)) return false;
      if (a.id && !a.id.startsWith(`${message.id}-`) && body.includes(`/${a.id}/`)) return false;
      return true;
    });
  }, [attItems, message.html_body, message.id]);

  const threadKey = message.thread_id || message.id;
  useEffect(() => {
    if (!attItems) return;
    const images: LightboxImage[] = [];
    const seen = new Set<string>();
    const push = (img: LightboxImage) => {
      if (seen.has(img.url)) return;
      seen.add(img.url);
      images.push(img);
    };
    // Ordre de lecture : images du corps d'abord, puis pieces jointes.
    const cids = referencedCids(message.html_body);
    for (const a of attItems) {
      if (!isImageAttachment(a.filename, a.contentType)) continue;
      const cid = normalizeCid(a.contentId);
      const inBody = (cid && cids.has(cid)) || (message.html_body || "").includes(`/${a.id}/`);
      if (inBody) push({ url: a.url, filename: a.filename, downloadable: true });
    }
    for (const a of listedAttachments ?? []) {
      if (isImageAttachment(a.filename, a.contentType)) push({ url: a.url, filename: a.filename, downloadable: true });
    }
    registerMessageImages(message.id, { threadKey, date: message.date, images });
    return () => registerMessageImages(message.id, null);
  }, [attItems, listedAttachments, message.id, message.date, message.html_body, threadKey]);

  const handleOpenImage = useCallback(
    (url: string) => openImageInThread(threadKey, url),
    [threadKey],
  );

  // Presentation : le fil n'affiche QUE des bulles de texte. La classification
  // ("bubble" / "full") ne decide plus que la pastille HTML sous la bulle : un
  // mail mis en page ("full") la porte, les autres gardent "Voir en HTML" dans
  // le tiroir de l'appui long. Tant que le corps n'est pas charge, l'extrait
  // sert de texte (pas de bascule visible a l'arrivee du corps).
  const presentation: MessagePresentation = useMemo(
    () =>
      classifyMessagePresentation(
        bodyLoaded ? message : { ...message, text_body: message.snippet || " " },
        { isMine, isNewsletterSource }
      ),
    [message, bodyLoaded, isMine, isNewsletterSource]
  );
  const hasHtml = !!message.html_body;
  // Ordinateur : la version HTML recouvre le volet de la conversation.
  const openHtml = () => {
    setHtmlPane(rowRef.current?.closest<HTMLElement>('[data-ref="thread-pane"]') ?? null);
    setHtmlOpen(true);
  };
  // Mail mis en page ("full") : sa version d'origine s'affiche DIRECTEMENT dans
  // le fil, sans bulle ni cadre autour (seul le cadre du contenu du mail reste)
  // et sans pastille "HTML". Les echanges ecrits par une personne gardent la
  // bulle de texte ("Voir en HTML" reste dans le menu du message).
  const inlineHtml = !draft && presentation === "full" && hasHtml;
  const bubbleText = useMemo(() => {
    if (draft) return null;
    if (translation) {
      return extractBubbleText(
        message.html_body
          ? { html_body: translation.translatedHtml, text_body: "" }
          : { text_body: translation.translatedHtml }
      );
    }
    return extractBubbleText(message);
  }, [draft, translation, message]);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const quoteParts = useMemo(
    () => (bubbleText?.quoted ? splitQuoteHeader(bubbleText.quoted) : null),
    [bubbleText]
  );

  const handleCopyText = async () => {
    const text = bubbleText
      ? [bubbleText.body, bubbleText.quoted].filter(Boolean).join("\n\n")
      : "";
    try {
      await navigator.clipboard.writeText(text);
      toast.success(tStatic("message.textCopied"));
    } catch {
      toast.error(tStatic("message.copyError"));
    }
  };

  // Actions d'un message : servies a la fois par le menu du clic droit
  // (ordinateur) et par le tiroir de l'appui long (telephone).
  const moreRows: MoreRow[] = [
    { type: "item", key: "reply", Icon: Reply, label: t("message.reply"), onSelect: handleReply },
    { type: "item", key: "replyAll", Icon: ReplyAll, label: t("compose.replyAll"), onSelect: handleReplyAll },
    { type: "item", key: "forward", Icon: Forward, label: t("message.forward"), onSelect: handleForward },
    { type: "sep", key: "sep1" },
    { type: "item", key: "archive", Icon: Archive, label: t("message.archive"), onSelect: handleArchive },
    {
      type: "item",
      key: "toggleRead",
      Icon: message.is_read ? Mail : MailOpen,
      label: message.is_read ? t("message.markAsUnread") : t("message.markAsRead"),
      onSelect: handleToggleRead,
    },
    { type: "item", key: "delete", Icon: Trash2, label: t("message.moveToTrash"), onSelect: () => setShowDeleteConfirm(true), destructive: true },
    { type: "sep", key: "sep2" },
    { type: "item", key: "block", Icon: Ban, label: t("message.blockSender", { sender: senderName }), onSelect: handleBlock },
    activeFolder === "spam"
      ? { type: "item", key: "notSpam", Icon: ShieldAlert, label: t("message.notSpam"), onSelect: handleNotSpam }
      : { type: "item", key: "spam", Icon: ShieldAlert, label: t("message.reportSpam"), onSelect: handleSpam },
    { type: "sep", key: "sep3" },
    { type: "item", key: "filter", Icon: Filter, label: t("message.filterSimilar"), onSelect: handleFilterSimilar },
    {
      type: "item",
      key: "newsletter",
      Icon: Newspaper,
      label: isNewsletterSource ? t("newsletters.unfollowSource") : t("newsletters.followSource"),
      onSelect: handleToggleNewsletterSource,
    },
    ...(iaDispo ? [{ type: "item" as const, key: "translate", Icon: Languages, label: t("message.translate"), onSelect: handleTranslate }] : []),
    { type: "item", key: "print", Icon: Printer, label: t("message.print"), onSelect: handlePrint },
    { type: "item", key: "download", Icon: Download, label: t("message.downloadMessage"), onSelect: handleDownload },
    { type: "item", key: "original", Icon: Code, label: t("message.showOriginal"), onSelect: () => setSourceOpen(true) },
    { type: "sep", key: "sep4" },
    { type: "item", key: "copyText", Icon: Copy, label: t("message.copyText"), onSelect: () => void handleCopyText() },
    ...(hasHtml
      ? [{ type: "item" as const, key: "viewHtml", Icon: FileCode2, label: t("message.viewHtml"), onSelect: openHtml }]
      : []),
  ];

  // --- Appui long (telephone) -> tiroir du message ---
  // Un simple toucher garde son effet (deplier/replier, ouvrir un lien) ; le
  // doigt qui bouge (defilement) annule. Apres un appui long, le relacher ne
  // doit rien declencher d'autre : touchend preventDefault (pas de clic
  // synthetise) + clic avale en capture par securite.
  const pressRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const pressFiredRef = useRef(false);
  const pressFiredAtRef = useRef(0);
  const cancelPress = useCallback(() => {
    if (pressRef.current) clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);
  const openActions = useCallback(() => {
    pressFiredRef.current = true;
    pressFiredAtRef.current = Date.now();
    setActionsOpen(true);
    try {
      navigator.vibrate?.(15);
    } catch {
      /* vibration indisponible */
    }
  }, []);
  const pressHandlers = draft || !isMobile
    ? {}
    : {
        onTouchStart: (e: React.TouchEvent) => {
          cancelPress();
          pressFiredRef.current = false;
          // Les evenements d'un menu en portail (vues du message) remontent
          // l'arbre React jusqu'ici : seul un toucher DANS la rangee compte.
          // Le bouton des vues, celui des gestes rapides, la pile des
          // destinataires et le visage de l'auteur ouvrent leur propre contenu,
          // pas les actions du message.
          const target = e.target as Element;
          if (
            !rowRef.current?.contains(target) ||
            target.closest?.("[data-ref='thread-message-views'], [data-ref='thread-message-quick-menu'], [data-ref='thread-message-recipients'], [data-ref='thread-message-avatar-button'], [data-ref='thread-message-more']")
          )
            return;
          const touch = e.touches[0];
          if (!touch || e.touches.length > 1) return;
          pressRef.current = {
            x: touch.clientX,
            y: touch.clientY,
            timer: setTimeout(() => {
              pressRef.current = null;
              openActions();
            }, LONG_PRESS_MS),
          };
        },
        onTouchMove: (e: React.TouchEvent) => {
          const start = pressRef.current;
          const touch = e.touches[0];
          if (!start || !touch) return;
          if (
            Math.abs(touch.clientX - start.x) > LONG_PRESS_MOVE_PX ||
            Math.abs(touch.clientY - start.y) > LONG_PRESS_MOVE_PX
          ) {
            cancelPress();
          }
        },
        onTouchEnd: (e: React.TouchEvent) => {
          cancelPress();
          if (pressFiredRef.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        },
        onTouchCancel: cancelPress,
        onClickCapture: (e: React.MouseEvent) => {
          if (Date.now() - pressFiredAtRef.current < 700) {
            e.preventDefault();
            e.stopPropagation();
          }
        },
        // Android emet aussi "contextmenu" a l'appui long : meme tiroir, pas le
        // menu natif du navigateur.
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          if (!actionsOpen) openActions();
        },
      };

  // En-tete d'un message : nom de l'auteur et heure (la date du jour est portee
  // par la pastille de date du fil) et coches de lecture ; rien d'autre (les
  // actions et les details passent par l'appui long / le clic droit).
  // Facon messagerie : ses propres messages n'affichent pas de nom (la bulle
  // foncee a droite suffit), et la suite d'une serie non plus.
  const shownDate = draft ? message.auto_saved_at || message.date : message.date;
  const showSender = !isMine && !seriesContinuation;
  const spamBadge = activeFolder === "spam" && (
    <Badge variant="destructive" className="ml-2 gap-1 px-1.5 py-0 text-[10px] align-middle">
      <ShieldAlert className="size-2.5" />
      {t("folder.spam")}
    </Badge>
  );
  // Telephone, message recu : nom au-dessus, heure en dessous, le visage a
  // gauche des deux (rendu dans la rangee d'en-tete). Ordinateur : sur une ligne.
  const stackHeader = !isMine && !draft;
  const headerBody = (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-baseline gap-2",
        isMine && "justify-end",
        stackHeader && "max-md:flex-col max-md:items-start max-md:gap-0"
      )}
    >
      {showSender ? (
        <span
          data-ref="thread-message-sender"
          className={cn("min-w-0 truncate text-[0.9375rem] font-medium", activeFolder === "spam" && "text-muted-foreground")}
        >
          {senderName}
          {spamBadge}
        </span>
      ) : (
        spamBadge
      )}
      <span className="flex min-w-0 max-w-full items-baseline gap-2">
      {senderAccount && (
        <span
          data-ref="thread-message-account"
          className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] text-muted-foreground"
          title={senderEmail}
        >
          <span
            aria-hidden="true"
            className={cn("size-2 shrink-0 rounded-full", !senderAccount.color && "bg-muted-foreground/50")}
            style={senderAccount.color ? { backgroundColor: senderAccount.color } : undefined}
          />
          <span className="min-w-0 truncate">{senderAccount.label}</span>
          <span aria-hidden="true">·</span>
        </span>
      )}
      <span
        data-ref="thread-message-date"
        className="flex shrink-0 items-center gap-1 text-[0.8125rem] font-normal text-muted-foreground"
        title={formatFullDate(shownDate)}
      >
        {formatMessageTime(shownDate)}
      </span>
      </span>
    </div>
  );

  // Sous la bulle (choix utilisateur 2026-10-18, sur telephone ET ordinateur) :
  // a soi = compte d'envoi, heure et vues, a droite ; recu = visage, puis le
  // nom et l'heure sur deux lignes ; suite d'une serie = l'heure seule.
  const metaTime = (
    <span
      data-ref="thread-message-date"
      className="shrink-0 text-[0.8125rem] font-normal text-muted-foreground"
      title={formatFullDate(shownDate)}
    >
      {formatMessageTime(shownDate)}
    </span>
  );
  const attachIcon = message.has_attachments ? (
    <Paperclip className="text-muted-foreground/60 size-3.5 shrink-0" />
  ) : null;
  // Ordinateur : les icones apparaissent au survol du message (ou au focus
  // clavier), l'une apres l'autre ; appareil sans survol : toujours visibles.
  // Telephone : un petit bouton a chevron, toujours visible, ouvre le tiroir
  // des gestes. Les clics ne remontent pas a la rangee (clic droit / appui long).
  const QUICK_DELAYS = ["group-hover/msg:delay-0", "group-hover/msg:delay-[60ms]", "group-hover/msg:delay-[120ms]"];
  const quickBar = draft ? null : isMobile ? (
    <button
      type="button"
      data-ref="thread-message-quick-menu"
      aria-label={t("message.quickActions")}
      aria-haspopup="dialog"
      aria-expanded={quickOpen}
      onClick={(e) => {
        e.stopPropagation();
        setQuickOpen(true);
      }}
      className={cn(
        "text-muted-foreground bg-muted active:bg-accent inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full pr-1.5 pl-2 transition-colors",
        isMine ? "mr-auto" : "ml-auto"
      )}
    >
      <Reply className="size-3.5" />
      <ChevronDown className="size-3" />
    </button>
  ) : (
    <div
      data-ref="thread-message-quick-actions"
      className={cn("flex shrink-0 items-center gap-0.5", isMine ? "mr-auto" : "ml-auto")}
    >
      {quickActions.map((a, i) => (
        <button
          key={a.key}
          type="button"
          data-ref={`thread-message-quick-${a.key}`}
          aria-label={a.label}
          title={a.label}
          onClick={(e) => {
            e.stopPropagation();
            a.onSelect();
          }}
          className={cn(
            "text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-7 items-center justify-center rounded-full",
            "translate-y-1 opacity-0 transition-[opacity,transform,background-color] duration-200 ease-out",
            "group-hover/msg:translate-y-0 group-hover/msg:opacity-100",
            "group-focus-within/msg:translate-y-0 group-focus-within/msg:opacity-100",
            "[@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100",
            "motion-reduce:translate-y-0 motion-reduce:transition-opacity",
            QUICK_DELAYS[isMine ? quickActions.length - 1 - i : i]
          )}
        >
          <a.Icon className="size-4" />
        </button>
      ))}
    </div>
  );

  // Intervenants : pile de mini-avatars + chevron ; un clic (pile OU visage de
  // l'auteur) ouvre la liste complete De / A / Cc / Cci en menu FLOTTANT,
  // TOUJOURS au-dessus de la ligne (choix utilisateur 2026-10-20 :
  // side="top" + avoidCollisions={false}, jamais retourne vers le bas ; seul un
  // decalage horizontal est permis pour rester dans l'ecran). Meme recette que
  // les vues (MessageViews) : portail z-[100] au-dessus du tiroir de
  // conversation, son propre RemoveScroll pour defiler au doigt, clics et clic
  // droit arretes avant la rangee (appui long / menu contextuel). Envoye (a
  // droite) : menu aligne a droite (align="end") pour ne pas deborder.
  const personRow = (a: { name?: string; address: string }) => (
    <span key={a.address} className="flex min-w-0 items-center gap-2 py-0.5">
      <ContactAvatar name={a.name || a.address} email={a.address} className="size-6 shrink-0" textClassName="text-[10px]" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="min-w-0 truncate">
          {a.name || a.address}
          {myEmails.has(normAddr(a.address)) && (
            <span className="text-muted-foreground"> ({t("message.recipientsYou")})</span>
          )}
        </span>
        {a.name && normAddr(a.name) !== normAddr(a.address) && (
          <span className="text-muted-foreground min-w-0 truncate text-xs">{a.address}</span>
        )}
      </span>
    </span>
  );
  const recipientsStack = draft ? null : (
    <div className="min-w-0 shrink-0 leading-none" data-ref="thread-message-recipients">
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("message.recipientsToggle")}
          title={t("message.recipientsToggle")}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          className={cn(
            "text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1 rounded-full py-0.5 pr-1 pl-0.5 transition-colors",
            isMine && "flex-row-reverse pr-0.5 pl-1"
          )}
        >
          <span data-ref="thread-message-recipients-stack" className="flex items-center -space-x-1.5">
            {stackHead.map((a) => (
              <ContactAvatar
                key={a.address}
                name={a.name || a.address}
                email={a.address}
                className="ring-background size-5 ring-2"
                textClassName="text-[9px]"
              />
            ))}
            {stackRest > 0 && (
              <span className="bg-muted text-muted-foreground ring-background relative inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-medium ring-2">
                +{stackRest}
              </span>
            )}
          </span>
          <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", recipientsOpen && "rotate-180")} />
        </button>
      </PopoverTrigger>
    </div>
  );
  const recipientsMenu = draft ? null : (
    <PopoverContent
      side="top"
      align={isMine ? "end" : "start"}
      avoidCollisions={false}
      sticky="always"
      collisionPadding={8}
      sideOffset={6}
      className="z-[100] w-auto max-w-[min(22rem,calc(100vw-1.5rem))] p-0"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      // Le visage de l'auteur est un second declencheur : son appui ne doit
      // pas fermer le menu juste avant que son clic le rebascule.
      onInteractOutside={(e) => {
        if (avatarTriggerRef.current?.contains(e.target as Node)) e.preventDefault();
      }}
    >
      <RemoveScroll removeScrollBar={false} allowPinchZoom>
        <dl
          data-ref="thread-message-recipients-list"
          className="grid max-h-[min(50vh,20rem)] grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 overflow-y-auto overscroll-contain px-3 py-2.5 text-[0.8125rem]"
        >
          {([
            ["from", t("compose.from"), message.from_address ? [message.from_address] : []],
            ["to", t("compose.to"), message.to_addresses],
            ["cc", t("compose.cc"), message.cc_addresses],
            ["bcc", t("compose.bcc"), message.bcc_addresses],
          ] as const).map(([key, label, list]) => {
            const people = uniqueRecipients([list]);
            if (people.length === 0) return null;
            return (
              <div key={key} className="contents" data-ref={`thread-message-recipients-${key}`}>
                <dt className="text-muted-foreground pt-1">{label}</dt>
                <dd className="flex min-w-0 flex-col">{people.map(personRow)}</dd>
              </div>
            );
          })}
        </dl>
      </RemoveScroll>
    </PopoverContent>
  );
  const authorAvatar = (
    <button
      ref={avatarTriggerRef}
      type="button"
      data-ref="thread-message-avatar-button"
      aria-label={t("message.recipientsToggle")}
      aria-expanded={recipientsOpen}
      onClick={(e) => {
        e.stopPropagation();
        setRecipientsOpen((o) => !o);
      }}
      onContextMenu={(e) => e.stopPropagation()}
      className="shrink-0 rounded-full"
    >
      <ContactAvatar
        data-ref="thread-message-avatar"
        name={senderName}
        email={senderEmail}
        className="size-8"
        textClassName="text-xs"
      />
    </button>
  );
  const senderLabel = (
    <span
      data-ref="thread-message-sender"
      className={cn("min-w-0 truncate text-[0.9375rem] font-medium", activeFolder === "spam" && "text-muted-foreground")}
    >
      {senderName}
    </span>
  );
  const accountTag = senderAccount && (
    <span
      data-ref="thread-message-account"
      className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] text-muted-foreground"
      title={senderEmail}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", !senderAccount.color && "bg-muted-foreground/50")}
        style={senderAccount.color ? { backgroundColor: senderAccount.color } : undefined}
      />
      <span className="min-w-0 truncate">{senderAccount.label}</span>
      <span aria-hidden="true">·</span>
    </span>
  );
  const views = isMine && receipts && receipts.length > 0 ? (
    <MessageViews message={message} receipts={receipts} onOpenChange={onViewsOpenChange} />
  ) : null;

  // Interface IDENTIQUE des deux cotes (choix utilisateur 2026-10-20), en
  // miroir : recu = visage a gauche, puis colonne [nom + pile + chevron] au-dessus
  // de l'heure ; envoye = meme chose alignee a droite, visage au bord droit, avec
  // le compte d'envoi et les vues sur la ligne de l'heure. Ordre nom -> pile ->
  // heure (choix 2026-10-20, ne pas reinverser). Suite d'une serie : pas de
  // visage ni de nom, la pile et l'heure sur une ligne.
  // Le menu s'accroche a TOUTE la rangee (PopoverAnchor), pas a la pile : avec
  // avoidCollisions={false} Radix ne decale plus rien, et un menu aligne sur la
  // pile d'un envoye (au milieu de la rangee) sortait de l'ecran a gauche. Bord
  // de rangee = bord de la colonne du fil, donc toujours dans l'ecran.
  // Apparence Miel (choix utilisateur, carte « Finitions Miel ») : UNE seule
  // rangee centree — [nom][pile][spam][trombone] puis [vues][heure][compte] —
  // et plus MON visage sous mes messages (la pile des destinataires est juste
  // a cote) ; le visage de l'expediteur reste sous les recus. Ordre nom ->
  // pile -> heure conserve ; le nom se raccourcit plutot que de passer a la
  // ligne (le compte d'envoi aussi : il est dans le bloc qui ne retrecit pas).
  const metaInner = seriesContinuation ? (
    <div
      data-ref="thread-message-meta"
      className={cn("mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5", isMine && "flex-row-reverse")}
    >
      {recipientsStack}
      {views}
      {metaTime}
      {isMine && accountTag}
      {spamBadge}
      {attachIcon}
      {quickBar}
    </div>
  ) : isMiel ? (
    <div
      data-ref="thread-message-meta"
      data-layout="row"
      className={cn("mt-1.5 flex min-w-0 items-center gap-2", isMine && "flex-row-reverse")}
    >
      {!isMine && authorAvatar}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 leading-tight",
          isMine && "flex-row-reverse"
        )}
      >
        {/* Une seule ligne : le nom se raccourcit, l'heure et les vues restent. */}
        <span className={cn("flex min-w-0 shrink items-center gap-1.5", isMine && "flex-row-reverse")}>
          {senderLabel}
          {recipientsStack}
          {spamBadge}
          {attachIcon}
        </span>
        <span className={cn("flex shrink-0 items-center gap-1.5", isMine && "flex-row-reverse")}>
          {views}
          {metaTime}
          {isMine && accountTag}
        </span>
      </div>
      {quickBar}
    </div>
  ) : (
    <div
      data-ref="thread-message-meta"
      className={cn("mt-1.5 flex min-w-0 items-start gap-2", isMine && "flex-row-reverse")}
    >
      {authorAvatar}
      <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5 leading-tight", isMine && "items-end")}>
        <span className={cn("flex max-w-full min-w-0 items-center gap-1.5", isMine && "flex-row-reverse")}>
          {senderLabel}
          {recipientsStack}
          {spamBadge}
          {attachIcon}
        </span>
        <span className={cn("flex max-w-full min-w-0 items-center gap-1.5", isMine && "flex-row-reverse")}>
          {isMine ? (
            <>
              {views}
              {metaTime}
              {accountTag}
            </>
          ) : (
            metaTime
          )}
        </span>
      </div>
      {quickBar}
    </div>
  );
  const metaRow = draft ? null : (
    <Popover open={recipientsOpen} onOpenChange={setRecipientsOpen}>
      <PopoverAnchor asChild>{metaInner}</PopoverAnchor>
      {recipientsMenu}
    </Popover>
  );

  const bodySkeleton = (
    <div aria-hidden="true" data-ref="thread-message-body-skeleton" className="flex flex-col gap-2 py-1">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );

  // Le menu du clic droit s'ouvre sous le pointeur : le relachement du bouton
  // qui suit aussitot tombait sur la premiere ligne, que Radix choisit au
  // "pointerup" (Repondre partait et le menu se refermait). On ignore ce
  // relachement-la ; un vrai clic sur une ligne passe par "click".
  const guardContextRelease = (e: React.PointerEvent) => {
    if (Date.now() - contextOpenedAtRef.current < 500) e.preventDefault();
  };

  // Rond ⋮ en haut a droite DANS la bulle (choix utilisateur 2026-10-21) :
  // actions du message. Ordinateur : visible au survol du message (ou au focus
  // clavier, menu ouvert, appareil sans survol), menu deroulant ; telephone :
  // toujours visible, ouvre le meme tiroir que l'appui long. Ses clics ne
  // remontent pas a la rangee (pas de depliage, pas d'appui long).
  // Teinte de la bulle : ouvreuse (bg-mine), a soi (bg-primary) ou neutre.
  // Apparence Miel : TOUTES les bulles sont blanches (--miel-bubble) ; les
  // miennes y gardent un texte FONCE (teinte neutre) et un lisere miel pose
  // par miel.css via data-mine (piste C, choix utilisateur) — en bg-primary
  // leur texte blanc etait invisible sur la bulle blanche.
  const bubbleTone: "opener" | "mine" | "plain" = isConversationOpener
    ? "opener"
    : isMine && !isMiel
      ? "mine"
      : "plain";
  const onDarkBubble = !inlineHtml && bubbleTone !== "plain";
  const moreButtonClass = cn(
    "inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-[opacity,background-color]",
    inlineHtml
      ? "bg-background/90 text-muted-foreground shadow-sm hover:text-foreground"
      : onDarkBubble
        ? bubbleTone === "opener"
          ? "text-mine-foreground/70 hover:bg-mine-foreground/10 hover:text-mine-foreground"
          : "text-primary-foreground/70 hover:bg-primary-foreground/10 hover:text-primary-foreground"
        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
    !isMobile &&
      "opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
  );
  const moreButton = (placement: string) =>
    draft ? null : isMobile ? (
      <button
        type="button"
        data-ref="thread-message-more"
        aria-label={t("message.moreActions")}
        title={t("message.moreActions")}
        aria-haspopup="dialog"
        aria-expanded={actionsOpen}
        onClick={(e) => {
          e.stopPropagation();
          setActionsOpen(true);
        }}
        className={cn(moreButtonClass, placement)}
      >
        <EllipsisVertical className="size-4" />
      </button>
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-ref="thread-message-more"
            aria-label={t("message.moreActions")}
            title={t("message.moreActions")}
            onClick={(e) => e.stopPropagation()}
            className={cn(moreButtonClass, placement)}
          >
            <EllipsisVertical className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="z-[60] w-64"
          data-ref="thread-message-more-list"
          onClick={(e) => e.stopPropagation()}
        >
          {moreRows.map((r) => {
            if (r.type === "sep") return <DropdownMenuSeparator key={r.key} />;
            const { Icon } = r;
            return (
              <DropdownMenuItem
                key={r.key}
                onSelect={r.onSelect}
                variant={r.destructive ? "destructive" : "default"}
                data-ref={`thread-message-more-${r.key}`}
              >
                <Icon />
                {r.label}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setDetailsDialogOpen(true)} data-ref="thread-message-more-details">
            <Info />
            {t("message.details")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

  // Pieces jointes : juste SOUS le corps, AVANT la rangee visage / nom / heure
  // et ses gestes (choix utilisateur 2026-10-20). Ordre d'un message :
  // corps (bulle avec citation) > pieces jointes > metaRow.
  const attachmentsBlock =
    needsAttachments && listedAttachments && attItems && (listedAttachments.length > 0 || (attItems.length === 0 && message.has_attachments)) ? (
      <div className="mt-2" data-ref="thread-message-attachments">
        <AttachmentList message={message} items={listedAttachments} onOpenImage={handleOpenImage} />
      </div>
    ) : null;

  const detailsGrid = <MessageDetailsGrid message={message} senderName={senderName} senderEmail={senderEmail} />;

  const row = (
    <div
      ref={rowRef}
      className={cn("group/msg flex min-w-0 flex-col gap-1 md:flex-row md:gap-2.5", !draft && "message-touch-surface")}
      data-ref="thread-message-row"
      {...pressHandlers}
    >
      {/* Plus de colonne de visage a gauche : le visage, le nom et l'heure
          sont SOUS la bulle (metaRow, choix utilisateur 2026-10-18). */}
      {/* Colonne du message, de LARGEUR FIXE (pas un maximum), la MEME pour
          tous les messages (bulle recue, bulle a soi, brouillon, mail mis en
          page : choix utilisateur 2026-10-17, tout aligne sur deux bords).
          Telephone : 95 % de la RANGEE (w-[95%]), c.-a-d. de la place entre les
          marges du message (px-3). PAS 95cqw : le cqw compte aussi ces marges,
          95cqw depassait la place restante et max-w-full ramenait la bulle a
          100 % (bords touches). Le visage est au-dessus, pas a cote.
          Ordinateur / tablette : la MOITIE de la rangee (md:w-1/2), sans
          plafond en rem : choix utilisateur 2026-10-17, 45-55 % de la largeur
          du fil, pas plus, et la colonne grandit avec l'ecran. L'ancien
          plafond 24rem rendait les messages minuscules sur grand ecran.
          Un mail mis en page plus large est reduit par EmailBodyFrame (applyFit).
          Un des siens = la meme colonne, calee a droite. Tout le message (en-tete,
          traduction, bulle, citation, pastille, rendez-vous, pieces jointes)
          y tient, sur les deux memes bords. La rangee, elle, reste pleine
          largeur : l'appui long et le clic droit couvrent aussi le vide. */}
      <div
        data-ref="thread-message-column"
        className={cn(
          "max-w-full min-w-0 shrink-0 w-[95%] md:w-1/2",
          isMine && "ml-auto"
        )}
      >
        {/* En-tete au-dessus : brouillons seulement (reprise au toucher). */}
        {draft && (
        <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onOpenDraft?.(message.id)}
              aria-label={t("thread.draftOpen")}
              className="flex min-w-0 flex-1 items-center rounded-md py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              data-ref="thread-message-header"
            >
              {headerBody}
            </button>

          {message.has_attachments && (
            <Paperclip className="text-muted-foreground/60 size-3.5 shrink-0" />
          )}

            <Badge
              variant="outline"
              data-ref="thread-draft-badge"
              className="shrink-0 border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground"
            >
              {t("thread.draftLabel")}
            </Badge>
        </div>
        )}

        {draft ? (
          // Brouillon : contenu entier, toujours ouvert (hors accordeon), sans
          // bandeaux ni actions. Le corps est rendu dans un cadre isole qui
          // n'emet pas de clic vers la page : un voile transparent lance la reprise.
          <div className="pt-1 pb-1 text-sm" data-ref="thread-message-content">
            <div data-ref="thread-message-body" className="relative overflow-hidden rounded-2xl border border-dashed border-border">
              {!bodyLoaded ? (
                <div className="px-3 py-2">{bodySkeleton}</div>
              ) : draftIsEmpty ? (
                <p className="text-muted-foreground px-3 py-2 text-sm italic" data-ref="thread-draft-empty">
                  {t("thread.draftEmpty")}
                </p>
              ) : message.html_body ? (
                <EmailBodyFrame html={sanitizedBody} background={DRAFT_PAPER} padding={FRAME_PADDING} />
              ) : (
                <pre className="whitespace-pre-wrap px-3 py-2 font-sans text-sm">{sanitizedBody}</pre>
              )}
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                data-ref="thread-draft-open"
                onClick={() => onOpenDraft?.(message.id)}
                className="absolute inset-0 cursor-pointer"
              />
            </div>
            {needsAttachments && listedAttachments && listedAttachments.length > 0 && (
              <div className="mt-3">
                <AttachmentList message={message} items={listedAttachments} onOpenImage={handleOpenImage} />
              </div>
            )}
          </div>
        ) : (
        <div className="pt-1 pb-1 text-sm" data-ref="thread-message-content">

          {/* Bandeau traduction */}
          {translation ? (
            <div className="bg-muted mb-2 flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                {t("translate.translatedFrom", { source: translation.sourceLabel, target: translation.targetLabel })}
              </span>
              <button
                onClick={handleShowOriginal}
                className="text-foreground shrink-0 font-medium underline-offset-2 hover:underline"
              >
                {t("translate.showOriginal")}
              </button>
            </div>
          ) : detectedLang ? (
            <div className="bg-muted mb-2 flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                {t("translate.messageIn", { language: getLanguageName(detectedLang) })}
              </span>
              <button
                onClick={handleQuickTranslate}
                disabled={quickTranslating}
                className="text-foreground flex shrink-0 items-center gap-1.5 font-medium underline-offset-2 hover:underline disabled:opacity-50"
              >
                {quickTranslating && <Loader2 className="size-3 animate-spin" />}
                {t("translate.translateToApp", { language: getLanguageName(appLanguage) })}
              </button>
            </div>
          ) : null}

          {/* Carte evenement calendrier */}
          {calendarLoading && (
            <div className="bg-muted mb-2 h-28 animate-pulse rounded-2xl" />
          )}
          {calendarEvents.map((event, i) => (
            <CalendarEventCard key={event.uid || i} event={event} />
          ))}

          {/* Corps du message : mail mis en page = sa version d'origine, a nu ;
              sinon une bulle de texte. */}
          <div data-ref="thread-message-body">
            {!bodyReady ? (
              <>
                <div className="w-full rounded-2xl bg-muted px-3 py-2">
                  {bodySkeleton}
                </div>
                {attachmentsBlock}
                {metaRow}
              </>
            ) : inlineHtml ? (
              <>
                {/* Bloc gris AVEC la marge des bulles (FRAME_PADDING, portee
                    dans le cadre, donc de la couleur du papier) : le papier du
                    cadre prend la couleur du bloc (EmailBodyFrame bare).
                    En sombre : liseré gris foncé des bulles, papier blanc. */}
                <div
                  data-ref="thread-message-html-inline"
                  className={cn(
                    "relative overflow-hidden rounded-2xl border",
                    isConversationOpener ? "bg-mine border-mine" : "bg-muted border-muted dark:bg-white"
                  )}
                >
                  {moreButton("absolute top-1.5 right-1.5 z-10")}
                  <EmailBodyFrame
                    html={translation ? translatedHtmlBody : sanitizedBody}
                    bare
                    padding={FRAME_PADDING}
                    onMailto={(email) => openCompose("new", null, email)}
                    onImageClick={handleOpenImage}
                  />
                </div>
                {attachmentsBlock}
                {metaRow}
              </>
            ) : (
              <>
                <div
                  data-ref="thread-message-bubble"
                  data-mine={isMine ? "true" : undefined}
                  className={cn(
                    "w-full rounded-2xl px-3 py-2 text-[0.9375rem] leading-[1.45] whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
                    bubbleTone === "opener"
                      ? "bg-mine text-mine-foreground"
                      : bubbleTone === "mine"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                  )}
                >
                  {moreButton("float-right -mt-0.5 -mr-1.5 ml-1")}
                  {bubbleText?.body ? (
                    <LinkifiedText text={bubbleText.body} />
                  ) : (
                    <span className="italic opacity-70">{t("message.imagesOnly")}</span>
                  )}
                  {/* Historique cite DANS la bulle, tout en bas (choix
                      utilisateur 2026-10-20) : en-tete "Le ... a ecrit", texte
                      deplie et bouton "...". Teintes derivees du fond de la
                      bulle (recue bg-muted, a soi bg-primary, ouvreuse bg-mine). */}
                  {quoteParts && (
                    <div className="mt-2" data-ref="thread-message-quote">
                      <div
                        className={cn(
                          "border-l-2 pl-3 text-sm",
                          bubbleTone === "opener"
                            ? "border-mine-foreground/30 text-mine-foreground/70"
                            : bubbleTone === "mine"
                              ? "border-primary-foreground/30 text-primary-foreground/70"
                              : "border-foreground/15 text-muted-foreground"
                        )}
                      >
                        {quoteParts.header}
                        {quoteOpen && quoteParts.rest && (
                          <div className="mt-1.5">{quoteParts.rest}</div>
                        )}
                      </div>
                      {quoteParts.rest && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setQuoteOpen((v) => !v);
                          }}
                          className={cn(
                            "mt-1.5 inline-flex h-6 items-center rounded-md border px-2 text-sm leading-none tracking-[0.2em] transition-colors",
                            bubbleTone === "opener"
                              ? "border-mine-foreground/30 text-mine-foreground/70 hover:bg-mine-foreground/10"
                              : bubbleTone === "mine"
                                ? "border-primary-foreground/30 text-primary-foreground/70 hover:bg-primary-foreground/10"
                                : "border-foreground/15 text-muted-foreground hover:bg-foreground/5"
                          )}
                          aria-expanded={quoteOpen}
                          aria-label={t("message.showQuotedText")}
                          title={t("message.showQuotedText")}
                          data-ref="thread-message-quote-toggle"
                        >
                          &middot;&middot;&middot;
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {attachmentsBlock}
                {metaRow}
              </>
            )}
          </div>

        </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      data-ref="thread-message"
      data-message-id={message.id}
      data-presentation={draft ? "draft" : presentation}
      data-mine={isMine ? "true" : undefined}
      data-opener={isConversationOpener ? "true" : undefined}
      data-series={seriesContinuation ? "continuation" : "start"}
      className={cn(
        "px-3 py-1.5 md:px-5",
        seriesContinuation && "pt-0"
      )}
      data-draft={draft ? "true" : undefined}
    >
      {draft || isMobile ? (
        row
      ) : (
        // Ordinateur : clic droit = menu des actions au pointeur (la selection
        // du texte a la souris reste possible).
        <ContextMenu
          onOpenChange={(o) => {
            if (o) contextOpenedAtRef.current = Date.now();
          }}
        >
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent className="w-64" data-ref="thread-message-context-menu">
            {moreRows.map((r) => {
              if (r.type === "sep") return <ContextMenuSeparator key={r.key} />;
              const { Icon } = r;
              return (
                <ContextMenuItem
                  key={r.key}
                  onPointerUp={guardContextRelease}
                  onSelect={r.onSelect}
                  className={cn(r.destructive && "text-destructive")}
                  data-ref={`thread-message-action-${r.key}`}
                >
                  <Icon className="size-4" />
                  {r.label}
                </ContextMenuItem>
              );
            })}
            <ContextMenuSeparator />
            <ContextMenuItem
              onPointerUp={guardContextRelease}
              onSelect={() => setDetailsDialogOpen(true)}
              data-ref="thread-message-action-details"
            >
              <Info className="size-4" />
              {t("message.details")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}

      {/* Telephone : tiroir du message (appui long) = ses details puis ses
          actions. Ne glisse que par sa prise ; son propre verrou de defilement
          car il s'ouvre par-dessus le tiroir MODAL de la conversation. */}
      {isMobile && !draft && (
        <Drawer open={actionsOpen} onOpenChange={setActionsOpen} repositionInputs={false} noBodyStyles handleOnly>
          <DrawerContent
            hideGrip
            className="drawer-scroll-native sheet-max-h"
            data-ref="thread-message-more-sheet"
          >
            <DrawerSheetHeader
              title={senderName || t("message.details")}
              handleDataRef="thread-message-more-handle"
            />
            <RemoveScroll removeScrollBar={false} allowPinchZoom className="flex min-h-0 flex-1 flex-col">
              <div
                className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2 pb-[max(1rem,env(safe-area-inset-bottom))] [&>*]:shrink-0"
                data-ref="thread-message-more-body"
              >
                <div className="bg-muted mx-1 mb-2 rounded-2xl px-3.5 py-2.5 text-xs" data-ref="thread-message-details">
                  {detailsGrid}
                </div>
                {moreRows.map((r) => {
                  if (r.type === "sep")
                    return <div key={r.key} className="bg-border my-1 h-px" aria-hidden />;
                  const { Icon } = r;
                  return (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => { setActionsOpen(false); r.onSelect(); }}
                      className={cn(
                        "flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors active:bg-muted",
                        r.destructive && "text-destructive"
                      )}
                      data-ref={`thread-message-action-${r.key}`}
                    >
                      <Icon className={cn("size-4 shrink-0", !r.destructive && "text-muted-foreground")} />
                      {r.label}
                    </button>
                  );
                })}
              </div>
            </RemoveScroll>
          </DrawerContent>
        </Drawer>
      )}

      {/* Telephone : tiroir des gestes rapides (bouton a chevron sous le
          message). Memes regles que le tiroir de l'appui long : prise seule,
          verrou de defilement propre (ouvert par-dessus la conversation). */}
      {isMobile && !draft && (
        <Drawer open={quickOpen} onOpenChange={setQuickOpen} repositionInputs={false} noBodyStyles handleOnly>
          <DrawerContent hideGrip className="drawer-scroll-native sheet-max-h" data-ref="thread-message-quick-sheet">
            <DrawerSheetHeader title={senderName || t("message.quickActions")} handleDataRef="thread-message-quick-handle" />
            <RemoveScroll removeScrollBar={false} allowPinchZoom className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2 pb-[max(1rem,env(safe-area-inset-bottom))] [&>*]:shrink-0">
                {quickActions.map((a) => (
                  <button
                    key={a.key}
                    type="button"
                    onClick={() => { setQuickOpen(false); a.onSelect(); }}
                    className="flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors active:bg-muted"
                    data-ref={`thread-message-quick-sheet-${a.key}`}
                  >
                    <a.Icon className="text-muted-foreground size-4 shrink-0" />
                    {a.label}
                  </button>
                ))}
              </div>
            </RemoveScroll>
          </DrawerContent>
        </Drawer>
      )}

      {!draft && hasHtml && (
        <MessageHtmlView
          open={htmlOpen}
          onClose={() => setHtmlOpen(false)}
          isMobile={isMobile}
          container={htmlPane}
          title={stripReplacementChars(message.subject || "").trim() || senderName}
          html={translation ? translatedHtmlBody : sanitizedBody}
          onMailto={(email) => {
            setHtmlOpen(false);
            openCompose("new", null, email);
          }}
          onImageClick={handleOpenImage}
        />
      )}

      <Dialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen}>
        <DialogContent className="sm:max-w-lg" data-ref="thread-message-details-dialog">
          <DialogHeader>
            <DialogTitle>{t("message.details")}</DialogTitle>
            <DialogDescription className="sr-only">{senderName}</DialogDescription>
          </DialogHeader>
          <div className="text-xs">{detailsGrid}</div>
        </DialogContent>
      </Dialog>

      <MessageSourceDialog
        message={message}
        open={sourceOpen}
        onOpenChange={setSourceOpen}
      />

      <TranslateDialog
        open={showTranslate}
        onOpenChange={setShowTranslate}
        htmlBody={message.html_body || ""}
        textBody={message.text_body || ""}
        onTranslated={handleTranslated}
      />

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("message.deleteConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("message.deleteConfirmDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              {t("message.moveToTrash")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const formatAddress = (a: { name?: string; address: string }) =>
  a.name ? `${a.name} <${a.address}>` : a.address;

/** Details techniques d'un message (De, A, Cc, Cci, Repondre a, date,
 * Message-ID, logiciel, authentification, score spam) : en tete du tiroir de
 * l'appui long (telephone) et dans la fenetre "Details du message" (ordinateur). */
function MessageDetailsGrid({ message, senderName, senderEmail }: { message: Message; senderName: string; senderEmail: string }) {
  const t = useT();
  const headerDetails = useMemo(
    () => (message.raw_headers ? parseHeaderDetails(message.raw_headers) : null),
    [message.raw_headers]
  );
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <span className="text-muted-foreground font-medium">{t("message.detailsFrom")}</span>
      <span className="min-w-0 break-words">{senderName} &lt;{senderEmail}&gt;</span>

      <span className="text-muted-foreground font-medium">{t("message.detailsTo")}</span>
      <span className="min-w-0 break-words">{(message.to_addresses ?? []).map(formatAddress).join(", ")}</span>

      {(message.cc_addresses ?? []).length > 0 && (
        <>
          <span className="text-muted-foreground font-medium">{t("message.detailsCc")}</span>
          <span className="min-w-0 break-words">{message.cc_addresses!.map(formatAddress).join(", ")}</span>
        </>
      )}

      {(message.bcc_addresses ?? []).length > 0 && (
        <>
          <span className="text-muted-foreground font-medium">{t("message.detailsBcc")}</span>
          <span className="min-w-0 break-words">{message.bcc_addresses!.map(formatAddress).join(", ")}</span>
        </>
      )}

      {headerDetails?.replyTo && (
        <>
          <span className="text-muted-foreground font-medium">{t("message.detailsReplyTo")}</span>
          <span className="min-w-0 break-words">{headerDetails.replyTo}</span>
        </>
      )}

      <span className="text-muted-foreground font-medium">{t("message.detailsDate")}</span>
      <span>{formatFullDate(message.date)}</span>

      {(headerDetails?.messageId || message.message_id) && (
        <>
          <span className="text-muted-foreground font-medium">{t("message.detailsMessageId")}</span>
          <span className="truncate font-mono text-[10px]">{headerDetails?.messageId || message.message_id}</span>
        </>
      )}

      {headerDetails?.mailer && (
        <>
          <span className="text-muted-foreground font-medium">{t("message.detailsMailer")}</span>
          <span className="truncate">{headerDetails.mailer}</span>
        </>
      )}

      {headerDetails && headerDetails.auth.length > 0 && (
        <>
          <span className="text-muted-foreground font-medium">{t("message.detailsAuth")}</span>
          <div className="flex flex-wrap gap-1.5">
            {headerDetails.auth.map((a: AuthResult) => (
              <Badge
                key={a.method}
                variant="outline"
                className={cn(
                  "gap-1 px-1.5 py-0 text-[10px] font-mono uppercase",
                  a.result === "pass" && "border-green-500/50 text-green-600 dark:text-green-400",
                  (a.result === "fail" || a.result === "permerror") && "border-red-500/50 text-red-600 dark:text-red-400",
                  (a.result === "softfail" || a.result === "temperror") && "border-yellow-500/50 text-yellow-600 dark:text-yellow-400",
                  (a.result === "neutral" || a.result === "none") && "border-muted-foreground/30 text-muted-foreground"
                )}
              >
                {a.method}: {a.result}
              </Badge>
            ))}
          </div>
        </>
      )}

      {(message.spam_score != null && message.spam_score > 0) && (
        <>
          <span className="text-muted-foreground font-medium">{t("message.detailsSpamScore")}</span>
          <span>{message.spam_score}{message.spam_action ? ` (${message.spam_action})` : ""}</span>
        </>
      )}
    </div>
  );
}
