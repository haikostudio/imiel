/**
 * WebSocket channel for real-time sync between browser tabs and the mail-worker hub.
 * The mail-worker subscribes to PocketBase SSE server-side and relays events via WebSocket.
 * Local actions (markAsRead, etc.) are also broadcast to other clients.
 */

import { useMailStore } from "@/lib/stores/mail-store";
import type { SidebarCounts } from "@/lib/stores/mail-store";
import type { DraftData, SavedAttachment } from "@/lib/hooks/useAutoSave";

// --- Types ---

interface PbEventMessage {
  type: "pb";
  collection: string;
  action: string;
  record: Record<string, unknown>;
}

interface ActionMessage {
  type: "action";
  action: string;
  [key: string]: unknown;
}

interface AuthOkMessage {
  type: "auth-ok";
  userId: string;
}

interface AuthErrorMessage {
  type: "auth-error";
  error: string;
}

type WsInMessage = PbEventMessage | ActionMessage | AuthOkMessage | AuthErrorMessage;

// --- PB event listeners ---

type PbEventCallback = (collection: string, action: string, record: Record<string, unknown>) => void;
const pbEventListeners = new Set<PbEventCallback>();

// --- Sync status listeners ---

export interface SyncStatusEvent {
  accountId: string;
  status: string;
  newMessages?: number;
  error?: string;
}

type SyncStatusCallback = (event: SyncStatusEvent) => void;
const syncStatusListeners = new Set<SyncStatusCallback>();

/** Register a listener for sync-status events from the mail-worker. Returns an unsubscribe function. */
export function onSyncStatus(cb: SyncStatusCallback): () => void {
  syncStatusListeners.add(cb);
  return () => {
    syncStatusListeners.delete(cb);
  };
}

function handleSyncStatus(
  msg: ActionMessage,
  store: ReturnType<typeof useMailStore.getState>
): void {
  const event: SyncStatusEvent = {
    accountId: msg.accountId as string,
    status: msg.status as string,
    newMessages: msg.newMessages as number | undefined,
    error: msg.error as string | undefined,
  };

  for (const cb of syncStatusListeners) {
    try { cb(event); } catch { /* ignore */ }
  }

  if (event.status === "idle" && event.newMessages && event.newMessages > 0) {
    store.signalNewMessages();
    store.invalidateFolders();
  }
  // Pas d'invalidateMessages() ici : la fin d'un cycle de sync (idle/error)
  // ne doit pas forcer un rechargement complet de la liste. Les nouveaux
  // messages arrivent via `pb`/`signalNewMessages` (fetch incremental),
  // les updates via `notifyMessageUpdate`, les suppressions via
  // `notifyMessageRemoval`. Invalider ici recreait toute la liste a chaque
  // safety poll (~1 min) et a chaque event IDLE.
}

// --- State ---

/** Current active WebSocket instance. Only this one should send/receive. */
let activeWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let intentionalClose = false;
// Keepalive applicatif : certains proxys/timeouts d'inactivite ne tiennent pas
// compte des frames de controle WS (ping/pong) et coupent la connexion au bout
// de ~60s. On envoie une vraie donnee (JSON) regulierement pour garder le
// socket chaud cote intermediaires.
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
// Distingue la 1ere connexion (chargement initial = deja un fetch) des
// reconnexions (ou il faut rattraper les events manques pendant la coupure).
let hasConnectedBefore = false;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 25_000;
const FOREGROUND_REFRESH_THROTTLE_MS = 10_000;
let lastForegroundRefreshAt = 0;

// --- URL ---

function getWsUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (envUrl) return envUrl;

  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    // In production (non-localhost), route through the app origin (proxied by custom server)
    // Use /ws (not /worker/ws) to avoid conflict with Next.js rewrites on /worker/:path*
    if (host !== "localhost" && host !== "127.0.0.1") {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${window.location.host}/ws`;
    }
  }

  // Local development: connect directly to mail-worker
  return "ws://127.0.0.1:4001/ws";
}

// --- Auth token ---

function getAuthToken(): string | null {
  try {
    const raw = localStorage.getItem("pocketbase_auth");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.token || null;
  } catch {
    return null;
  }
}

// --- Message dispatch ---

function handleMessage(msg: WsInMessage): void {
  const store = useMailStore.getState();

  switch (msg.type) {
    case "pb":
      handlePbEvent(msg, store);
      break;
    case "action":
      handleAction(msg, store);
      break;
    case "auth-ok":
      console.log(`[WS Channel] Authenticated as user ${msg.userId}`);
      reconnectAttempt = 0;
      // Rattrapage : si on s'est deja connecte auparavant, c'est une
      // reconnexion -> des events (nouveaux mails, updates) ont pu etre rates
      // pendant la coupure. On refait un fetch incremental + recompte les
      // dossiers pour auto-reparer la liste sans refresh manuel.
      if (hasConnectedBefore) {
        store.signalNewMessages();
        store.invalidateFolders();
      }
      hasConnectedBefore = true;
      break;
    case "auth-error":
      console.warn(`[WS Channel] Auth failed: ${msg.error}`);
      break;
  }
}

function handlePbEvent(
  msg: PbEventMessage,
  store: ReturnType<typeof useMailStore.getState>
): void {
  const { collection, action, record } = msg;

  for (const cb of pbEventListeners) {
    try { cb(collection, action, record); } catch { /* ignore */ }
  }

  switch (collection) {
    case "messages":
      if (action === "create") {
        console.log("[WS Channel] messages.create ->", (record as { id?: string }).id);
        store.signalNewMessages();
      } else if (action === "update") {
        store.notifyMessageUpdate(record.id as string, record as Record<string, unknown>);
      } else if (action === "delete") {
        store.notifyMessageRemoval(record.id as string);
      }
      break;
    case "folders":
      store.invalidateFolders();
      break;
    // `accounts` updates are dominated by sync-status churn (sync_status,
    // last_synced_at written by the worker every sync cycle). Invalidating
    // here forced a full message-list reload every minute. Message/folder
    // data changes already arrive via the `messages`/`folders` events.
  }
}

function handleAction(
  msg: ActionMessage,
  store: ReturnType<typeof useMailStore.getState>
): void {
  switch (msg.action) {
    case "message-update":
      store.notifyMessageUpdate(
        msg.id as string,
        msg.changes as Record<string, unknown>
      );
      break;
    case "message-removal":
      store.notifyMessageRemoval(msg.id as string);
      break;
    case "sender-removal":
      store.notifySenderRemoval(msg.email as string);
      break;
    case "sidebar-adjust":
      store.adjustSidebarCount(
        msg.key as keyof SidebarCounts,
        msg.delta as number
      );
      break;
    case "invalidate-folders":
      store.invalidateFolders();
      break;
    case "invalidate-messages":
      store.invalidateMessages();
      break;
    case "signal-new":
      store.signalNewMessages();
      break;
    case "sync-status":
      handleSyncStatus(msg, store);
      break;
    case "open-compose":
      ignoreNextComposeChange = true;
      store.openCompose(
        msg.mode as "new" | "reply" | "reply-all" | "forward" | "edit",
        (msg.replyToMessageId as string) || null,
        (msg.initialTo as string) || null
      );
      break;
    case "close-compose":
      ignoreNextComposeChange = true;
      store.closeCompose(msg.instanceId as string | undefined);
      break;
    case "compose-minimized": {
      ignoreNextComposeChange = true;
      const targetId = msg.instanceId as string;
      const targetMinimized = msg.minimized as boolean;
      const inst = store.composeInstances.find((i) => i.id === targetId);
      if (inst && inst.minimized !== targetMinimized) {
        store.toggleComposeMinimized(targetId);
      }
      break;
    }
    case "compose-title-label":
      ignoreNextComposeChange = true;
      store.updateComposeTitleLabel(msg.instanceId as string, msg.titleLabel as string);
      break;
    case "focus-compose":
      ignoreNextComposeChange = true;
      store.focusCompose(msg.instanceId as string);
      break;
    case "draft-content-update": {
      const draftData = msg.data as DraftData;
      store.notifyDraftContentUpdate(
        msg.draftId as string,
        draftData,
        msg.sourceId as string,
        msg.attachments as SavedAttachment[] | undefined,
        msg.fromAccountId as string | undefined
      );
      // Mettre a jour la liste avec la date pour le tri
      const snippet = (draftData.html_body ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 200);
      store.notifyMessageUpdate(msg.draftId as string, {
        ...draftData,
        snippet,
        is_draft: true,
        date: (msg.date as string) || new Date().toISOString(),
      });
      break;
    }
    case "draft-insert": {
      const insertData = msg.data as DraftData;
      const insertSnippet = (msg.snippet as string) || (insertData.html_body ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 200);
      store.notifyMessageInsert({
        id: msg.draftId as string,
        date: (msg.date as string) || new Date().toISOString(),
        subject: insertData.subject ?? "",
        snippet: insertSnippet,
        is_draft: true,
        is_read: true,
        is_starred: false,
        is_sent: false,
        from_address: { name: "", address: "" },
        to_addresses: insertData.to_addresses ?? [],
        cc_addresses: insertData.cc_addresses ?? [],
        bcc_addresses: insertData.bcc_addresses ?? [],
        html_body: insertData.html_body ?? "",
        text_body: insertData.text_body ?? "",
        account: (msg.fromAccountId as string) || "",
      });
      // Aussi incrementer le compteur sidebar
      store.adjustSidebarCount("drafts" as keyof SidebarCounts, 1);
      break;
    }
    case "draft-lifecycle":
      store.notifyDraftLifecycle(
        msg.draftId as string,
        msg.event as "deleted" | "sent",
        msg.sourceId as string
      );
      break;
  }
}

// --- Connection ---

function connect(): void {
  if (typeof window === "undefined") return;

  const token = getAuthToken();
  if (!token) {
    scheduleReconnect();
    return;
  }

  const url = getWsUrl();

  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  // Track this socket as the active one
  activeWs = socket;

  socket.onopen = () => {
    // Guard: if this socket was replaced (React StrictMode cleanup), ignore
    if (activeWs !== socket) {
      socket.close();
      return;
    }
    console.log("[WS Channel] Connected to", url);
    import("./boot-perf").then(({ bootMark }) => bootMark("ws:connected"));
    socket.send(JSON.stringify({ type: "auth", token }));

    // Keepalive : garde le socket actif a travers les proxys (le hub ignore
    // les messages non reconnus apres auth).
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      if (activeWs === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, KEEPALIVE_INTERVAL_MS);
  };

  socket.onmessage = (event) => {
    // Guard: ignore messages from stale sockets
    if (activeWs !== socket) return;
    try {
      const msg = JSON.parse(event.data as string) as WsInMessage;
      handleMessage(msg);
    } catch {
      // Ignore malformed messages
    }
  };

  socket.onclose = () => {
    // Only reconnect if this is still the active socket
    if (activeWs === socket) {
      activeWs = null;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (!intentionalClose) {
        scheduleReconnect();
      }
    }
  };

  socket.onerror = () => {
    // onclose will fire after onerror
  };
}

function scheduleReconnect(): void {
  if (intentionalClose) return;
  if (reconnectTimer) return;

  reconnectAttempt++;
  const delay = Math.min(
    RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1),
    RECONNECT_MAX_MS
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// --- Public API ---

/** Broadcast openCompose to other tabs. Call after store.openCompose(). */
export function broadcastOpenCompose(mode: string, replyToMessageId?: string | null, initialTo?: string | null): void {
  sendAction({ action: "open-compose", mode, replyToMessageId: replyToMessageId || "", initialTo: initialTo || "" });
}

/** Broadcast closeCompose to other tabs. Call after store.closeCompose(). */
export function broadcastCloseCompose(instanceId?: string): void {
  sendAction({ action: "close-compose", instanceId: instanceId || "" });
}

// --- Compose sync via store subscription ---

let ignoreNextComposeChange = false;
let prevComposeIds: string[] = [];
let prevComposeMinimized: Record<string, boolean> = {};
let prevComposeTitleLabels: Record<string, string | undefined> = {};
let prevFocusedComposeId: string | null = null;

function snapshotComposeState(state: ReturnType<typeof useMailStore.getState>): void {
  prevComposeIds = state.composeInstances.map((i) => i.id);
  prevComposeMinimized = {};
  prevComposeTitleLabels = {};
  for (const inst of state.composeInstances) {
    prevComposeMinimized[inst.id] = inst.minimized;
    prevComposeTitleLabels[inst.id] = inst.titleLabel;
  }
  prevFocusedComposeId = state.focusedComposeId;
}

function watchComposeChanges(): () => void {
  snapshotComposeState(useMailStore.getState());

  return useMailStore.subscribe((state) => {
    if (ignoreNextComposeChange) {
      ignoreNextComposeChange = false;
      snapshotComposeState(state);
      return;
    }

    const currentIds = state.composeInstances.map((i) => i.id);
    const prevIds = prevComposeIds;

    // Detect new compose instances
    for (const inst of state.composeInstances) {
      if (!prevIds.includes(inst.id)) {
        sendAction({
          action: "open-compose",
          mode: inst.mode,
          replyToMessageId: inst.replyToMessageId || "",
          initialTo: inst.initialTo || "",
        });
      }
    }

    // Detect closed compose instances
    for (const id of prevIds) {
      if (!currentIds.includes(id)) {
        sendAction({ action: "close-compose", instanceId: id });
      }
    }

    // Detect minimized state changes
    for (const inst of state.composeInstances) {
      if (prevComposeMinimized[inst.id] !== undefined && prevComposeMinimized[inst.id] !== inst.minimized) {
        sendAction({
          action: "compose-minimized",
          instanceId: inst.id,
          minimized: inst.minimized,
        });
      }
    }

    // Detect titleLabel changes
    for (const inst of state.composeInstances) {
      if (prevComposeTitleLabels[inst.id] !== inst.titleLabel && inst.titleLabel !== undefined) {
        sendAction({
          action: "compose-title-label",
          instanceId: inst.id,
          titleLabel: inst.titleLabel,
        });
      }
    }

    // Detect focusedComposeId changes
    if (state.focusedComposeId !== prevFocusedComposeId && state.focusedComposeId) {
      sendAction({
        action: "focus-compose",
        instanceId: state.focusedComposeId,
      });
    }

    snapshotComposeState(state);
  });
}

/** Initialize the WebSocket channel. Call once from AuthenticatedLayout. Returns cleanup function. */
export function initWsChannel(): () => void {
  import("./boot-perf").then(({ bootMark }) => bootMark("ws:init"));
  intentionalClose = false;
  reconnectAttempt = 0;
  connect();

  // Watch compose changes to sync across tabs
  const unsubCompose = watchComposeChanges();

  const handleForeground = () => {
    if (document.visibilityState !== "visible") return;

    if (!activeWs) {
      reconnectAttempt = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    }

    const now = Date.now();
    if (now - lastForegroundRefreshAt < FOREGROUND_REFRESH_THROTTLE_MS) return;
    lastForegroundRefreshAt = now;

    const store = useMailStore.getState();
    store.invalidateMessages();
    store.invalidateFolders();
  };
  document.addEventListener("visibilitychange", handleForeground);
  window.addEventListener("focus", handleForeground);
  window.addEventListener("pageshow", handleForeground);

  return () => {
    unsubCompose();
    intentionalClose = true;
    hasConnectedBefore = false;
    document.removeEventListener("visibilitychange", handleForeground);
    window.removeEventListener("focus", handleForeground);
    window.removeEventListener("pageshow", handleForeground);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (activeWs) {
      const old = activeWs;
      activeWs = null; // Clear first so callbacks ignore this socket
      old.close();
    }
  };
}

/** Send an action to other connected clients via the WS hub. */
export function sendAction(msg: Omit<ActionMessage, "type">): void {
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({ type: "action", ...msg }));
  }
}

/** Check if the WebSocket is currently connected. */
export function isWsConnected(): boolean {
  return activeWs !== null && activeWs.readyState === WebSocket.OPEN;
}

/** Register a listener for PocketBase collection events. Returns unsubscribe function. */
export function onPbEvent(cb: PbEventCallback): () => void {
  pbEventListeners.add(cb);
  return () => { pbEventListeners.delete(cb); };
}
