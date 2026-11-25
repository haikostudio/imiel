"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, CheckCheck, ChevronDown, CircleAlert, Copy, FileText, History, Loader2, MessageSquare, Mic, Paperclip, Search, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import { IconCircleButton } from "@/components/ui/kit";
import { useMailStore } from "@/lib/stores/mail-store";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import { useT, type Locale } from "@/lib/i18n";
import { getOpenRouterKey } from "@/lib/ai-settings";
import pb, { getCurrentUserId } from "@/lib/pocketbase";
import { AiActionCard } from "@/components/ai/AiActionCard";
import { AiActionHistory } from "@/components/ai/AiActionHistory";
import { executeAiAction, recordAiAction, summarizeAction } from "@/lib/ai-actions";
import { scrubSecrets } from "@/lib/ai-actions-fields";
import type { AiAction, AiActionPayload, AiCreatedRef } from "@/lib/ai-actions-types";
import { cn } from "@/lib/utils";
import {
  formatChatMessageTime,
  formatChatMessageTimeFull,
} from "@/lib/utils/date";
import type { ReactNode } from "react";
import { RecorderErrorBar, RecordingBar, useRecorder } from "@/components/ai/ChatRecorder";
import {
  ACCEPT_ATTRIBUTE,
  MAX_ATTACHMENTS,
  formatBytes,
  prepareAttachment,
  toMeta,
  type ChatAttachment,
  type ChatAttachmentMeta,
} from "@/lib/ai-chat-attachments";
import {
  chatFingerprint,
  clearChat,
  loadChat,
  migrateLegacyHistory,
  newChatMessageId,
  saveChatMessage,
  subscribeChat,
  upsertChat,
} from "@/lib/ai-chat-sync";

const INLINE_MD =
  /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*\n]+)\*|(?:^|(?<=\s))_([^_\n]+)_/g;

// Parse les marqueurs inline (gras, italique, code, liens) en noeuds React.
// React echappe le texte par defaut, pas d'injection HTML brut.
function inlineNodes(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_MD)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const key = `${keyBase}-${idx}`;
    if (m[1] !== undefined) {
      out.push(<strong key={key}>{m[1]}</strong>);
    } else if (m[2] !== undefined) {
      out.push(
        <code key={key} className="rounded bg-background px-1 py-0.5 text-xs">
          {m[2]}
        </code>
      );
    } else if (m[3] !== undefined && m[4] !== undefined) {
      out.push(
        <a
          key={key}
          href={m[4]}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          {m[3]}
        </a>
      );
    } else if (m[5] !== undefined) {
      out.push(<em key={key}>{m[5]}</em>);
    } else if (m[6] !== undefined) {
      out.push(<em key={key}>{m[6]}</em>);
    }
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Rendu markdown minimal (titres, gras/italique, listes, liens, code) en
// elements React.
function renderMarkdown(src: string): ReactNode {
  const lines = src.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let listItems: ReactNode[] | null = null;
  let listOrdered = false;
  let k = 0;

  const flushList = () => {
    if (!listItems) return;
    const items = listItems;
    const key = `l${k++}`;
    blocks.push(
      listOrdered ? (
        <ol key={key} className="my-1 list-decimal pl-5">
          {items}
        </ol>
      ) : (
        <ul key={key} className="my-1 list-disc pl-5">
          {items}
        </ul>
      )
    );
    listItems = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushList();
      blocks.push(
        <p key={`h${k++}`} className="mt-2 mb-1 font-semibold first:mt-0">
          {inlineNodes(m[2], `h${k}`)}
        </p>
      );
      continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (listItems && listOrdered) flushList();
      listOrdered = false;
      listItems = listItems || [];
      listItems.push(
        <li key={`li${k++}`} className="my-0.5">
          {inlineNodes(m[1], `li${k}`)}
        </li>
      );
      continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (listItems && !listOrdered) flushList();
      listOrdered = true;
      listItems = listItems || [];
      listItems.push(
        <li key={`li${k++}`} className="my-0.5">
          {inlineNodes(m[1], `li${k}`)}
        </li>
      );
      continue;
    }
    if (line.trim() === "") {
      flushList();
      continue;
    }
    flushList();
    blocks.push(
      <p key={`p${k++}`} className="my-1 first:mt-0 last:mb-0">
        {inlineNodes(line, `p${k}`)}
      </p>
    );
  }
  flushList();
  return blocks;
}

interface ChatSource {
  id: string;
  thread_id: string;
  subject: string;
  from: string;
  date: string;
}

// Etape du deroule visible (recherche, proposition, relance) : envoyee par le
// serveur en direct, gardee dans meta pour la retrouver sur un autre appareil.
interface ChatStep {
  id: string;
  name: string;
  state: "running" | "done" | "error";
  detail?: string;
  count?: number | null;
}

interface ChatMeta {
  steps?: ChatStep[];
  hits: number;
  mode: "focused" | "wide";
  window: { from: string; to: string; label?: string } | null;
  coverage: {
    earliest: string | null;
    latest: string | null;
    total: number;
    indexed: number;
  } | null;
  sources: ChatSource[];
  // Si non-null, le RAG a echoue (worker down, timeout) : on doit le
  // signaler dans un bandeau rouge plutot que de laisser le LLM mentir.
  error?: string | null;
}

interface ApiMessage {
  // Identifiant partage entre appareils (client_id de ai_chat_messages).
  id: string;
  role: "user" | "assistant";
  content: string;
  // Timestamp (ms) cree au moment d'envoyer / recevoir le message. Sert a
  // afficher la datetime sous chaque bulle. Optionnel pour retrocompat avec
  // l'historique localStorage des versions precedentes.
  createdAt?: number;
  // Meta de recherche RAG associee a une reponse assistant (bandeau au-dessus).
  meta?: ChatMeta;
  // Actions proposees dans cette reponse (cartes Accepter/Refuser), avec leur
  // etat : conserve dans l'historique local pour survivre a la reouverture.
  actions?: AiAction[];
  // Pieces jointes : metadonnees + miniature seulement (jamais le binaire).
  attachments?: ChatAttachmentMeta[];
}

/** Champs de premier niveau modifies par l'utilisateur via "Modifier". */
function changedKeys(before: AiActionPayload | undefined, after: AiActionPayload): string[] {
  if (!before) return [];
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  return Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/**
 * Resultat des cartes resume pour l'assistant : ajoute au contenu du message
 * assistant renvoye au modele, qui sait ainsi ce qui a ete accepte, modifie,
 * refuse ou a echoue.
 */
function describeActions(actions: AiAction[] | undefined): string {
  if (!actions || actions.length === 0) return "";
  const parts = actions.map((a) => {
    const state =
      a.status === "done"
        ? `acceptee et faite${a.resultLabel ? ` (${a.resultLabel})` : ""}`
        : a.status === "refused"
          ? "refusee par l'utilisateur (rien n'a ete fait)"
          : a.status === "error"
            ? `echec : ${a.error || "erreur"}`
            : a.status === "running"
              ? "en cours d'execution"
              : "en attente de decision";
    const edits = a.edited ? ` ; modifiee par l'utilisateur (${changedKeys(a.original, a.payload).join(", ")})` : "";
    return `${summarizeAction(a)} -> ${state}${edits}`;
  });
  return `\n\n[Actions: ${parts.join(" | ")}]`;
}

const STORAGE_KEY_WIDTH = "imiel:aiChatWidth";
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 400;

// Lit l'ANCIEN historique local (avant la conversation partagee) pour sa
// reprise unique dans ai_chat_messages.
function parseLegacyHistory(raw: string): Omit<ApiMessage, "id">[] {
  try {
    {
      const parsed = JSON.parse(raw) as Array<{
        role?: string;
        content?: unknown;
        createdAt?: unknown;
        meta?: unknown;
      }>;
      // Sanitize : anciens historiques pouvaient contenir des messages
      // d'outils (ancienne archi tool-calling). On ne garde que les
      // echanges user/assistant lisibles.
      return (parsed as Array<{ role?: string; content?: unknown; createdAt?: unknown; meta?: unknown; actions?: unknown; attachments?: unknown }>)
        .filter(
          (m): m is { role: "user" | "assistant"; content: string; createdAt?: unknown; meta?: unknown; actions?: unknown; attachments?: unknown } =>
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            (m.content.trim() !== "" ||
              (Array.isArray(m.actions) && m.actions.length > 0) ||
              (Array.isArray(m.attachments) && m.attachments.length > 0))
        )
        .map((m) => ({
          role: m.role,
          content: m.content,
          createdAt:
            typeof m.createdAt === "number" && Number.isFinite(m.createdAt)
              ? m.createdAt
              : undefined,
          meta:
            m.meta && typeof m.meta === "object" ? (m.meta as ChatMeta) : undefined,
          attachments: Array.isArray(m.attachments)
            ? (m.attachments as ChatAttachmentMeta[]).filter((a) => a && typeof a.name === "string")
            : undefined,
          // Une action restee "running" (onglet ferme en plein travail) : on ne
          // la rejoue pas a l'aveugle, on dit qu'il faut verifier.
          actions: Array.isArray(m.actions)
            ? (m.actions as AiAction[]).map((a) =>
                a.status === "running"
                  ? { ...a, status: "error" as const, error: "Interrompue : verifier dans l'application" }
                  : a
              )
            : undefined,
        }));
    }
  } catch {
    // ignore
  }
  return [];
}

// Deroule des etapes d'une reponse, juste sous le message envoye : deplie et
// anime pendant le travail, replie en une ligne ("3 etapes") ensuite.
function ChatSteps({
  steps,
  live,
  labelOf,
  t,
}: {
  steps: ChatStep[];
  live: boolean;
  labelOf: (name: string) => string;
  t: ReturnType<typeof useT>;
}) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    setOpen(live);
  }, [live]);
  return (
    <div className="w-full max-w-[90%] text-[11px] text-muted-foreground" data-ref="ai-chat-steps" data-open={open ? "1" : "0"}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
        aria-expanded={open}
        data-ref="ai-chat-steps-toggle"
      >
        <ChevronDown className={cn("size-3 transition-transform", open ? "" : "-rotate-90")} />
        {t("aiChat.stepsCount", { count: String(steps.length) })}
      </button>
      {open && (
        <ol className="mt-0.5 space-y-0.5 border-l border-border pl-2.5 ml-2">
          {steps.map((s) => (
            <li key={s.id} className="flex items-start gap-1.5" data-state={s.state}>
              {s.state === "running" ? (
                <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin text-muted-foreground" />
              ) : s.state === "error" ? (
                <CircleAlert className="mt-0.5 size-3 shrink-0 text-destructive" />
              ) : (
                <Check className="mt-0.5 size-3 shrink-0 text-foreground" />
              )}
              <span className="min-w-0 break-words">
                <span className={s.state === "running" ? "text-foreground" : ""}>{labelOf(s.name)}</span>
                {s.detail && <span className="opacity-70"> · {s.detail}</span>}
                {s.state === "error" ? (
                  <span className="text-destructive"> · {t("aiChat.stepFailed")}</span>
                ) : s.state === "done" && typeof s.count === "number" ? (
                  <span className="opacity-70">
                    {" "}· {s.count > 0 ? t("aiChat.stepResults", { count: String(s.count) }) : t("aiChat.stepNoResult")}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function AiChatPanel() {
  const t = useT();
  const stepLabel = (name: string) => {
    const key = `aiChat.step.${name}`;
    const label = t(key);
    return label && label !== key ? label : t("aiChat.step.other");
  };
  const aiChatOpen = useMailStore((s) => s.aiChatOpen);
  const setAiChatOpen = useMailStore((s) => s.setAiChatOpen);
  const setAiChatWidth = useMailStore((s) => s.setAiChatWidth);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const language = useSettingsStore((s) => s.language) as Locale;

  const [history, setHistory] = useState<ApiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"thinking" | "searching" | "writing" | null>(null);
  // Reponse en cours d'ecriture : son deroule reste deplie tant qu'elle vit.
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isDesktop, setIsDesktop] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dictee : le texte transcrit s'AJOUTE au champ, rien n'est envoye.
  const recorder = useRecorder((text) => {
    setInput((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")} ${text}` : text));
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }, language);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const w = Number(localStorage.getItem(STORAGE_KEY_WIDTH));
    if (w >= MIN_WIDTH && w <= MAX_WIDTH) setWidth(w);
  }, []);

  // Conversation partagee entre appareils : reprise unique de l'ancien
  // historique local, lecture, puis ecoute en direct. Un message en cours de
  // redaction sur CET appareil (reponse qui s'ecrit) n'est pas ecrase par une
  // relecture : il est enregistre a la fin du flux.
  const streamingIdRef = useRef<string | null>(null);
  const fingerprintRef = useRef("");
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    const reload = async () => {
      try {
        fingerprintRef.current = await chatFingerprint().catch(() => fingerprintRef.current);
        const list = await loadChat<ChatMeta>();
        if (cancelled) return;
        setHistory((prev) => {
          const live = streamingIdRef.current ? prev.find((m) => m.id === streamingIdRef.current) : undefined;
          return live ? upsertChat(list as ApiMessage[], live) : (list as ApiMessage[]);
        });
      } catch (err) {
        console.warn("[ai-chat] lecture impossible", err);
      }
    };
    reloadRef.current = reload;
    void (async () => {
      await migrateLegacyHistory((raw) => parseLegacyHistory(raw)).catch(() => false);
      if (cancelled) return;
      await reload();
      if (cancelled) return;
      try {
        const fn = await subscribeChat<ChatMeta>(
          (e) => {
            if (e.action === "delete") {
              setHistory((prev) => prev.filter((m) => m.id !== e.id));
            } else if (e.message.id !== streamingIdRef.current) {
              setHistory((prev) => upsertChat(prev, e.message as ApiMessage));
            }
          },
          () => void reload()
        );
        if (cancelled) fn();
        else unsub = fn;
      } catch {
        // Temps reel indisponible : la relecture au retour sur l'onglet suffit.
      }
    })();
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      unsub?.();
    };
  }, []);

  // Filet du direct : panneau ouvert et onglet visible, on compare toutes les
  // 4 s une empreinte minuscule de la conversation ; si elle a bouge (message,
  // reponse, carte, vidage fait ailleurs) on relit. Couvre un canal temps reel
  // retenu par un proxy ou coupe sans le dire.
  useEffect(() => {
    if (!aiChatOpen) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible" || streamingIdRef.current) return;
      chatFingerprint()
        .then((fp) => {
          if (fp !== fingerprintRef.current) void reloadRef.current();
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [aiChatOpen]);

  // Publie la largeur du panneau : les fenetres de composition (desktop) se
  // rangent a sa gauche quand il est ouvert.
  useEffect(() => {
    setAiChatWidth(width);
  }, [width, setAiChatWidth]);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  // Met a jour une action (carte) ou qu'elle soit dans l'historique, et
  // persiste : l'etat des cartes survit a la reouverture de la conversation.
  const patchAction = useCallback((actionId: string, patch: Partial<AiAction>) => {
    setHistory((prev) => {
      let changed: ApiMessage | undefined;
      const next = prev.map((m) => {
        if (!m.actions?.some((a) => a.id === actionId)) return m;
        changed = { ...m, actions: m.actions.map((a) => (a.id === actionId ? { ...a, ...patch } : a)) };
        return changed;
      });
      // Reponse encore en train de s'ecrire : elle sera enregistree a la fin.
      if (changed && changed.id !== streamingIdRef.current) {
        const toSave = changed;
        queueMicrotask(() => void saveChatMessage(toSave));
      }
      return next;
    });
  }, []);

  const acceptAction = useCallback(
    async (action: AiAction, edited?: AiActionPayload) => {
      const payload = edited ?? action.payload;
      const isEdited = !!edited && JSON.stringify(edited) !== JSON.stringify(action.payload);
      const effective: AiAction = {
        ...action,
        payload,
        original: isEdited ? action.original ?? action.payload : action.original,
        edited: action.edited || isEdited,
      };
      patchAction(action.id, { status: "running", payload, original: effective.original, edited: effective.edited, error: undefined });
      // Une fois la carte tranchee, le mot de passe d'un compte ne reste ni
      // dans la conversation (synchronisee entre appareils) ni dans l'historique.
      const scrubbed = {
        payload: scrubSecrets(action.kind, payload) as AiActionPayload,
        original: scrubSecrets(action.kind, effective.original),
      };
      try {
        const res = await executeAiAction(effective);
        const historyId = await recordAiAction(effective, { created: res.created });
        patchAction(action.id, { status: "done", resultLabel: res.label, created: res.created, historyId, ...scrubbed });
      } catch (err) {
        const message = (err as Error).message || t("aiAction.failed");
        // Lot partiellement fait : ce qui a ete cree reste annulable.
        const created = ((err as { created?: AiCreatedRef[] }).created || []) as AiCreatedRef[];
        const historyId = created.length ? await recordAiAction(effective, { created, error: message }) : undefined;
        patchAction(action.id, { status: "error", error: message, created, historyId, ...scrubbed });
      }
    },
    [patchAction, t]
  );

  // "Tout accepter" : sequentiel, une erreur n'arrete pas les suivantes.
  const acceptAll = useCallback(
    async (actions: AiAction[]) => {
      for (const a of actions.filter((x) => x.status === "pending")) {
        await acceptAction(a);
      }
    },
    [acceptAction]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, loading, status, toolStatus]);

  useEffect(() => {
    if (aiChatOpen) inputRef.current?.focus();
  }, [aiChatOpen]);

  // Le panneau ferme (desktop : le composant reste monte et rend null) ou la
  // vue Historique ouverte : la dictee en cours est jetee et le micro relache.
  const cancelRecording = recorder.cancel;
  useEffect(() => {
    if (!aiChatOpen || view !== "chat") cancelRecording();
  }, [aiChatOpen, view, cancelRecording]);

  // Mobile : on adapte la HAUTEUR du drawer a la zone visible quand le clavier
  // est ouvert. Mesure live sur l'appareil : a l'ouverture du clavier, le
  // navigateur scrolle la couche et innerHeight retrecit -> seul
  // documentElement.clientHeight reste stable. Le drawer (vaul) est ancre en
  // bas (bottom:0), qui sur cet iOS tombe pile au sommet du clavier. Donc en
  // mettant sa hauteur = visualViewport.height, son header se cale en haut de
  // l'ecran et le champ juste au-dessus du clavier, sans que vaul ait a pousser
  // le contenu (repositionInputs desactive). On vise l'element par data-slot
  // (vaul le monte dans un portail).
  useEffect(() => {
    if (isDesktop || !aiChatOpen) return;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const el = document.querySelector(
        '[data-slot="drawer-content"]'
      ) as HTMLElement | null;
      const docH = document.documentElement.clientHeight;
      const open = vv.height < docH - 60;
      if (el) el.style.height = open ? `${Math.round(vv.height)}px` : "";
      setKbOpen((prev) => (prev === open ? prev : open));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    schedule();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule, true);
      const el = document.querySelector(
        '[data-slot="drawer-content"]'
      ) as HTMLElement | null;
      if (el) el.style.height = "";
      setKbOpen(false);
    };
  }, [isDesktop, aiChatOpen]);

  // Redimensionnement (desktop uniquement)
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX))
        );
        setWidth(next);
      };
      const onUp = (ev: MouseEvent) => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        const next = Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX))
        );
        try {
          localStorage.setItem(STORAGE_KEY_WIDTH, String(next));
        } catch {
          // ignore
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [width]
  );

  async function copyMessage(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      toast.success(t("aiChat.copied"));
    } catch {
      // Pas de clipboard (http, contexte non-securise) : silencieux
    }
  }

  // Pendant le stream, la conversation est reconstruite a chaque jeton : on y
  // reprend l'etat COURANT des cartes (un clic Accepter peut arriver avant la
  // fin de la reponse) pour ne jamais l'ecraser.
  // La reponse remplace sa version precedente SANS toucher au reste de la
  // conversation (des messages d'un autre appareil peuvent arriver pendant).
  function mergeLiveActions(msg: ApiMessage, prev: ApiMessage[]): ApiMessage[] {
    const before = prev.find((m) => m.id === msg.id);
    const live = new Map<string, AiAction>();
    for (const a of before?.actions || []) live.set(a.id, a);
    const merged = msg.actions && live.size ? { ...msg, actions: msg.actions.map((a) => live.get(a.id) ?? a) } : msg;
    return upsertChat(prev, merged);
  }

  async function runConversation(messages: ApiMessage[], outgoing: ChatAttachment[] = []) {
    setLoading(true);
    setError(null);
    setStatus("thinking");

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messages.map((m, i) => ({
            role: m.role,
            content: m.role === "assistant" ? `${m.content}${describeActions(m.actions)}` : m.content,
            // Le binaire ne part qu'avec le message qui l'a joint ; les
            // anciens messages ne transmettent que les noms des fichiers.
            ...(m.attachments?.length
              ? {
                  attachments:
                    i === messages.length - 1 && outgoing.length
                      ? outgoing.map(({ name, type, kind, data, text }) => ({ name, type, kind, data, text }))
                      : m.attachments.map(({ name, type, kind }) => ({ name, type, kind })),
                }
              : {}),
          })),
          authToken: pb.authStore.token,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          language,
          today: new Date().toISOString().slice(0, 10),
          userId: getCurrentUserId(),
          accountId: activeAccountId,
          apiKey: getOpenRouterKey(),
        }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error || `HTTP ${res.status}`
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      let meta: ChatMeta | undefined;
      let actions: AiAction[] = [];
      let steps: ChatStep[] = [];
      const assistantStart = Date.now();
      const assistantId = newChatMessageId();
      streamingIdRef.current = assistantId;
      setStreamingId(assistantId);
      const withSteps = (): ChatMeta | undefined =>
        meta || steps.length
          ? ({ ...(meta || {}), ...(steps.length ? { steps } : {}) } as ChatMeta)
          : undefined;
      let reply: ApiMessage = { id: assistantId, role: "assistant", content: "", createdAt: assistantStart };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          let evt: {
            type?: string;
            delta?: string;
            message?: string;
            hits?: number;
            mode?: "focused" | "wide";
            window?: ChatMeta["window"];
            coverage?: ChatMeta["coverage"];
            sources?: ChatSource[];
          };
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          if (evt.type === "meta") {
            meta = {
              hits: evt.hits ?? 0,
              mode: evt.mode ?? "focused",
              window: evt.window ?? null,
              coverage: evt.coverage ?? null,
              sources: evt.sources ?? [],
              error: (evt as { error?: string | null }).error ?? null,
            };
            setStatus("searching");
            reply = { id: assistantId, role: "assistant", content: acc, createdAt: assistantStart, meta: withSteps(), actions: actions.length ? actions : undefined };
            const snap = reply;
            setHistory((prev) => mergeLiveActions(snap, prev));
          } else if (evt.type === "token" && evt.delta) {
            // Le temoin reste allume : du texte peut preceder d'autres recherches.
            setStatus("writing");
            acc += evt.delta;
            reply = { id: assistantId, role: "assistant", content: acc, createdAt: assistantStart, meta: withSteps(), actions: actions.length ? actions : undefined };
            const snap = reply;
            setHistory((prev) => mergeLiveActions(snap, prev));
          } else if (evt.type === "step") {
            const step = (evt as { step?: ChatStep }).step;
            if (step?.id) {
              const known = steps.find((x) => x.id === step.id);
              steps = known
                ? steps.map((x) => (x.id === step.id ? { ...x, ...step, detail: step.detail || x.detail } : x))
                : [...steps, step];
              const running = steps.filter((x) => x.state === "running").pop();
              setToolStatus(running ? stepLabel(running.name) : null);
              reply = { id: assistantId, role: "assistant", content: acc, createdAt: assistantStart, meta: withSteps(), actions: actions.length ? actions : undefined };
              const snap = reply;
              setHistory((prev) => mergeLiveActions(snap, prev));
            }
          } else if (evt.type === "unfinished") {
            acc += `${acc ? "\n\n" : ""}${t("aiChat.unfinished")}`;
            reply = { id: assistantId, role: "assistant", content: acc, createdAt: assistantStart, meta: withSteps(), actions: actions.length ? actions : undefined };
            const snap = reply;
            setHistory((prev) => mergeLiveActions(snap, prev));
          } else if (evt.type === "action") {
            const action = (evt as { action?: AiAction }).action;
            if (action) {
              actions = [...actions, action];
              reply = { id: assistantId, role: "assistant", content: acc, createdAt: assistantStart, meta: withSteps(), actions };
              const snap = reply;
              setHistory((prev) => mergeLiveActions(snap, prev));
            }
          } else if (evt.type === "error") {
            throw new Error(evt.message || t("aiChat.error"));
          }
        }
      }

      if (acc.trim() === "" && actions.length === 0) {
        throw new Error(t("aiChat.error"));
      }
      // Fin du flux : la reponse (avec l'etat COURANT de ses cartes) part aux
      // autres appareils.
      streamingIdRef.current = null;
      setHistory((prev) => {
        const merged = mergeLiveActions(reply, prev);
        const final = merged.find((m) => m.id === assistantId);
        if (final) queueMicrotask(() => void saveChatMessage(final));
        return merged;
      });
    } catch (err) {
      setError((err as Error).message || t("aiChat.error"));
    } finally {
      streamingIdRef.current = null;
      setStreamingId(null);
      setLoading(false);
      setStatus(null);
      setToolStatus(null);
    }
  }

  function handleSend() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || loading || preparing > 0 || recorder.recording) return;
    const outgoing = attachments;
    setInput("");
    setAttachments([]);
    const userMsg: ApiMessage = {
      id: newChatMessageId(),
      role: "user",
      content: text,
      createdAt: Date.now(),
      ...(outgoing.length ? { attachments: outgoing.map(toMeta) } : {}),
    };
    const next: ApiMessage[] = upsertChat(history, userMsg);
    setHistory(next);
    void saveChatMessage(userMsg);
    runConversation(next, outgoing);
  }

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      toast.error(t("aiChat.attachLimit", { max: String(MAX_ATTACHMENTS) }));
      return;
    }
    if (files.length > room) toast.error(t("aiChat.attachLimit", { max: String(MAX_ATTACHMENTS) }));
    const batch = files.slice(0, room);
    setPreparing((n) => n + batch.length);
    for (const file of batch) {
      const res = await prepareAttachment(file);
      setPreparing((n) => n - 1);
      if (res.ok) {
        setAttachments((prev) => (prev.length < MAX_ATTACHMENTS ? [...prev, res.attachment] : prev));
      } else {
        toast.error(
          t(
            res.reason === "unsupported"
              ? "aiChat.attachUnsupported"
              : res.reason === "tooLarge"
                ? "aiChat.attachTooLarge"
                : "aiChat.attachUnreadable",
            { name: file.name }
          )
        );
      }
    }
  }

  function handleClear() {
    setHistory([]);
    setError(null);
    // Vide la conversation partout : les autres appareils recoivent les
    // suppressions en direct.
    clearChat().catch(() => toast.error(t("aiChat.error")));
  }

  const visible = history.filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      (m.content.trim() !== "" || (m.actions?.length ?? 0) > 0 || (m.attachments?.length ?? 0) > 0)
  );

  // En-tete (partage desktop / mobile)
  const headerEl = (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <Bot className="size-4" />
      <span className="flex-1 text-sm font-medium">
        {view === "history" ? t("aiAction.history") : t("aiChat.title")}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setView(view === "history" ? "chat" : "history")}
        title={view === "history" ? t("aiAction.backToChat") : t("aiAction.history")}
        data-ref="ai-chat-history-toggle"
      >
        {view === "history" ? <MessageSquare className="size-4" /> : <History className="size-4" />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleClear}
        title={t("aiChat.clear")}
        data-ref="ai-chat-clear"
      >
        <Trash2 className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setAiChatOpen(false)}
        title={t("aiChat.close")}
        data-ref="ai-chat-close"
      >
        <X className="size-4" />
      </Button>
    </div>
  );

  // Liste des messages (le scrollport)
  const messagesEl = (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      data-ref="ai-chat-messages"
    >
      <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
        {t("aiChat.system")}
      </div>

          {visible.map((m) => (
            <div
              key={m.id}
              className={cn(
                "group flex flex-col gap-1",
                m.role === "user" ? "items-end" : "items-start"
              )}
            >
              <span className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {m.role === "user" ? t("aiChat.you") : t("aiChat.assistant")}
              </span>

              {/* Bandeau RAG au-dessus des reponses assistant (transparence
                  sur ce que le chat a cherche et trouve). Rouge si erreur. */}
              {m.role === "assistant" && m.meta?.steps && m.meta.steps.length > 0 && (
                <ChatSteps steps={m.meta.steps} live={m.id === streamingId} labelOf={stepLabel} t={t} />
              )}

              {m.role === "assistant" && m.meta && m.meta.mode !== undefined && (
                <div
                  className={cn(
                    "w-full max-w-[90%] rounded-md border border-dashed px-2.5 py-1.5 text-[11px]",
                    m.meta.error
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-border bg-muted/60 text-muted-foreground"
                  )}
                >
                  <div className="flex items-start gap-1.5">
                    <Search
                      className={cn(
                        "mt-0.5 size-3 shrink-0",
                        m.meta.error ? "text-destructive" : "text-foreground"
                      )}
                    />
                    <div className="flex-1 space-y-0.5">
                      <div>
                        {m.meta.error
                          ? t("aiChat.searchFailed", { error: m.meta.error })
                          : m.meta.hits > 0
                            ? t("aiChat.searchedHits", {
                                count: String(m.meta.hits),
                              })
                            : t("aiChat.searchedNoResults")}
                        {!m.meta.error &&
                          m.meta.mode === "wide" &&
                          m.meta.hits > 0 && (
                            <span className="ml-1 opacity-70">
                              ({t("aiChat.searchedWide")})
                            </span>
                          )}
                      </div>
                      {m.meta.window && (
                        <div className="opacity-70">
                          {t("aiChat.searchedWindow", {
                            label:
                              m.meta.window.label ||
                              `${m.meta.window.from} -> ${m.meta.window.to}`,
                          })}
                        </div>
                      )}
                      {m.meta.coverage &&
                        m.meta.coverage.earliest &&
                        m.meta.coverage.latest && (
                          <div className="opacity-60">
                            {t("aiChat.coverage", {
                              earliest: m.meta.coverage.earliest.slice(0, 10),
                              latest: m.meta.coverage.latest.slice(0, 10),
                              indexed: String(m.meta.coverage.indexed),
                              total: String(m.meta.coverage.total),
                            })}
                          </div>
                        )}
                    </div>
                  </div>
                </div>
              )}

              {m.attachments && m.attachments.length > 0 && (
                <div className="flex max-w-[90%] flex-wrap justify-end gap-1.5" data-ref="ai-chat-message-attachments">
                  {m.attachments.map((a, i) =>
                    a.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={i}
                        src={a.thumb}
                        alt={a.name}
                        title={a.name}
                        className="size-16 rounded-md border object-cover"
                      />
                    ) : (
                      <span
                        key={i}
                        title={a.name}
                        className="flex max-w-48 items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs"
                      >
                        <FileText className="size-3.5 shrink-0" />
                        <span className="truncate">{a.name}</span>
                      </span>
                    )
                  )}
                </div>
              )}

              {m.content.trim() !== "" && (
              <div
                className={cn(
                  "relative max-w-[90%] rounded-lg px-3 py-2 pr-9 text-sm",
                  m.role === "user"
                    ? "whitespace-pre-wrap bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                )}
              >
                {m.role === "user"
                  ? m.content
                  : renderMarkdown((m.content as string) || "")}

                {/* Bouton copier en bas a droite de la bulle. Hover sur
                    desktop, visible en permanence sur mobile (group/tap). */}
                <button
                  type="button"
                  onClick={() => copyMessage(m.content)}
                  title={t("aiChat.copy")}
                  aria-label={t("aiChat.copy")}
                  className={cn(
                    "absolute bottom-1 right-1 flex size-6 items-center justify-center rounded-md transition-opacity",
                    "opacity-0 group-hover:opacity-100 focus:opacity-100",
                    isDesktop ? "" : "opacity-70",
                    m.role === "user"
                      ? "text-white/80 hover:bg-white/15"
                      : "text-muted-foreground hover:bg-background hover:text-foreground"
                  )}
                  data-ref="ai-chat-copy"
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
              )}

              {m.actions && m.actions.length > 0 && (
                <>
                  {m.actions.filter((a) => a.status === "pending").length >= 2 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      onClick={() => acceptAll(m.actions || [])}
                      data-ref="ai-action-accept-all"
                    >
                      <CheckCheck className="size-3.5" />
                      {t("aiAction.acceptAll", {
                        count: String(m.actions.filter((a) => a.status === "pending").length),
                      })}
                    </Button>
                  )}
                  {m.actions.map((a) => (
                    <AiActionCard
                      key={a.id}
                      action={a}
                      onAccept={(edited) => acceptAction(a, edited)}
                      onRefuse={() =>
                        patchAction(a.id, {
                          status: "refused",
                          payload: scrubSecrets(a.kind, a.payload) as AiActionPayload,
                          original: scrubSecrets(a.kind, a.original),
                        })
                      }
                    />
                  ))}
                </>
              )}

              {/* Datetime sous chaque bulle. Hover (title) = date complete. */}
              {m.createdAt && (
                <time
                  dateTime={new Date(m.createdAt).toISOString()}
                  title={formatChatMessageTimeFull(m.createdAt, language)}
                  className="px-1 text-[10px] text-muted-foreground"
                >
                  {formatChatMessageTime(m.createdAt, language)}
                </time>
              )}
            </div>
          ))}

          {loading && (
            // Temoin de travail : visible du debut a la fin REELLE du tour
            // (entre deux morceaux de texte comme entre deux recherches).
            <div
              className="flex w-fit items-center gap-2.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground"
              role="status"
              aria-live="polite"
              data-ref="ai-chat-working"
            >
              <span className="flex items-center gap-1" aria-hidden>
                {[0, 150, 300].map((d) => (
                  <span key={d} className="size-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${d}ms` }} />
                ))}
              </span>
              {toolStatus
                ? `${toolStatus}...`
                : status === "writing"
                  ? `${t("aiChat.writing")}...`
                  : status === "searching"
                    ? t("aiChat.searching")
                    : t("aiChat.thinking")}
            </div>
          )}

      {error && (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
    </div>
  );

  // Zone de saisie (partagee). Haut : vignettes des pieces jointes. Milieu :
  // champ (trombone DANS le champ, a droite) ou bandeau de dictee, micro a
  // droite. Bas : Envoyer pleine largeur.
  const inputExpanded = inputFocused || input.trim() !== "";
  const canSend =
    !loading && preparing === 0 && !recorder.recording && (input.trim() !== "" || attachments.length > 0);
  const inputEl = (
    <div
      className={cn(
        "shrink-0 border-t bg-background px-3 pt-2 transition-colors",
        dragOver && "bg-muted/60"
      )}
      style={{
        // Clavier ouvert : pas de safe-area (le champ est deja au sommet du
        // clavier, le home indicator est masque) -> pas de marge inutile.
        paddingBottom: kbOpen
          ? "0.5rem"
          : "calc(0.75rem + env(safe-area-inset-bottom, 0px))",
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        setDragOver(false);
        void addFiles(Array.from(e.dataTransfer.files));
      }}
      data-ref="ai-chat-composer"
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = "";
          void addFiles(files);
        }}
        data-ref="ai-chat-file-input"
      />

      {(attachments.length > 0 || preparing > 0) && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1" data-ref="ai-chat-attachments">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="relative flex h-14 shrink-0 items-center gap-2 rounded-md border bg-muted/60 pr-7"
              title={`${a.name} (${formatBytes(a.size)})`}
              data-ref="ai-chat-attachment"
            >
              {a.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.thumb} alt={a.name} className="h-full w-14 rounded-l-md object-cover" />
              ) : (
                <span className="flex h-full w-10 items-center justify-center">
                  <FileText className="size-5" />
                </span>
              )}
              {!a.thumb && (
                <span className="flex max-w-32 flex-col text-xs leading-tight">
                  <span className="truncate">{a.name}</span>
                  <span className="text-[10px] text-muted-foreground">{formatBytes(a.size)}</span>
                </span>
              )}
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                title={t("aiChat.attachRemove")}
                aria-label={t("aiChat.attachRemove")}
                className="absolute right-0.5 top-0.5 flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow-sm hover:text-foreground"
                data-ref="ai-chat-attachment-remove"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          {preparing > 0 && (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border bg-muted/60">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}

      {recorder.error && (
        <RecorderErrorBar message={recorder.error} onRetry={recorder.retry} onDiscard={recorder.discardError} />
      )}

      {recorder.recording ? (
        <RecordingBar
          levels={recorder.levels}
          seconds={recorder.seconds}
          onValidate={() => void recorder.finish(true)}
          onDiscard={() => void recorder.finish(false)}
        />
      ) : (
        <div className="flex items-end gap-2">
          <div className="relative min-w-0 flex-1">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && isDesktop) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files || []);
                if (files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
              placeholder={recorder.working ? t("aiChat.dictationWorking") : t("aiChat.placeholder")}
              rows={1}
              className={cn(
                // Texte reduit ; pas de zoom iOS au focus : le viewport de l'app
                // fixe maximumScale=1. pr-10 laisse la place au trombone.
                "w-full min-w-0 resize-none pr-10 text-sm transition-[min-height] duration-200 md:text-[0.8125rem]",
                inputExpanded ? "max-h-56 min-h-28" : "max-h-56 min-h-11"
              )}
              data-ref="ai-chat-input"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= MAX_ATTACHMENTS}
              title={t("aiChat.attach")}
              aria-label={t("aiChat.attach")}
              className="absolute right-1.5 top-1.5 flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              data-ref="ai-chat-attach"
            >
              {preparing > 0 ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
            </button>
          </div>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="size-11 shrink-0"
            onClick={() => void recorder.start()}
            disabled={recorder.working || loading}
            title={t("aiChat.dictate")}
            aria-label={t("aiChat.dictate")}
            data-ref="ai-chat-mic"
          >
            {recorder.working ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
          </Button>
        </div>
      )}

      <Button
        type="button"
        onClick={handleSend}
        // Garde le focus du champ au toucher : le clavier ne se referme pas
        // avant l'envoi (sinon le bouton "saute" sous le doigt).
        onMouseDown={(e) => e.preventDefault()}
        disabled={!canSend}
        className="mt-2 h-11 w-full rounded-xl"
        data-ref="ai-chat-send"
      >
        {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        {t("aiChat.send")}
      </Button>
    </div>
  );

  // Mobile : bottom sheet draggable (vaul). Ouverture progressive depuis le bas,
  // fermeture par glissement vers le bas ou tap sur le fond. `repositionInputs`
  // (defaut vaul) gere le clavier iOS en deplaçant le contenu pour garder le
  // champ visible -> plus de couche fixe a compenser a la main.
  if (!isDesktop) {
    return (
      <Drawer
        open={aiChatOpen}
        onOpenChange={setAiChatOpen}
        repositionInputs={false}
        // L'app verrouille deja son scroll (body fixed inset:0 overflow:hidden).
        // On empeche vaul de toucher aux styles du body : son setPositionFixed
        // (body position:fixed + offset de scroll) entrait en conflit et
        // decalait l'app vers le bas -> bande blanche sous la status bar.
        noBodyStyles
        // Seule la prise (poignee + titre) fait glisser le tiroir : la liste
        // des messages garde le defilement natif.
        handleOnly
      >
        <DrawerContent hideGrip className="drawer-scroll-native sheet-h-full flex flex-col" data-ref="ai-chat-panel">
          <DrawerSheetHeader
            title={view === "history" ? t("aiAction.history") : t("aiChat.title")}
            className="border-b"
            wideActions
            actions={
              <>
                <IconCircleButton
                  plain
                  onClick={() => setView(view === "history" ? "chat" : "history")}
                  aria-label={view === "history" ? t("aiAction.backToChat") : t("aiAction.history")}
                  title={view === "history" ? t("aiAction.backToChat") : t("aiAction.history")}
                  data-ref="ai-chat-history-toggle"
                >
                  {view === "history" ? <MessageSquare className="size-5" strokeWidth={1.8} /> : <History className="size-5" strokeWidth={1.8} />}
                </IconCircleButton>
                <IconCircleButton
                  plain
                  onClick={handleClear}
                  aria-label={t("aiChat.clear")}
                  title={t("aiChat.clear")}
                  data-ref="ai-chat-clear"
                >
                  <Trash2 className="size-5" strokeWidth={1.8} />
                </IconCircleButton>
              </>
            }
          />
          {view === "history" ? <AiActionHistory /> : messagesEl}
          {view === "chat" && inputEl}
        </DrawerContent>
      </Drawer>
    );
  }

  // Desktop : panneau lateral redimensionnable
  if (!aiChatOpen) return null;
  return (
    <aside
      data-ref="ai-chat-panel"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l bg-background"
    >
      <div
        onMouseDown={startResize}
        className="absolute inset-y-0 left-0 z-10 w-1 -translate-x-1/2 cursor-col-resize hover:bg-border"
        data-ref="ai-chat-resize"
      />
      {headerEl}
      {view === "history" ? <AiActionHistory /> : messagesEl}
      {view === "chat" && inputEl}
    </aside>
  );
}
