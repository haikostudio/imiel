import type http from "http";
import { WebSocketServer, WebSocket } from "ws";

// --- Types ---

interface WsClient {
  ws: WebSocket;
  userId: string;
  clientId: string;
}

interface PbSseEvent {
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

type WsOutMessage = PbSseEvent | ActionMessage | { type: "auth-ok"; userId: string } | { type: "auth-error"; error: string };

// --- State ---

const clients = new Map<string, WsClient>(); // clientId -> WsClient
const userClients = new Map<string, Set<string>>(); // userId -> Set<clientId>

const PING_INTERVAL_MS = 30_000;
const AUTH_TIMEOUT_MS = 5_000;
const SSE_RECONNECT_BASE_MS = 1_000;
const SSE_RECONNECT_MAX_MS = 30_000;

let sseAbortController: AbortController | null = null;

// --- PocketBase helpers ---

function getPocketBaseUrl(): string {
  return process.env.POCKETBASE_URL || "http://127.0.0.1:8090";
}

let adminToken: string | null = null;
let tokenExpiry = 0;

async function getAdminToken(): Promise<string> {
  if (adminToken && Date.now() < tokenExpiry) return adminToken;

  const email = process.env.PB_ADMIN_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL;
  const password = process.env.PB_ADMIN_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("PB admin credentials required for WS hub");

  const res = await fetch(`${getPocketBaseUrl()}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  if (!res.ok) throw new Error(`PB admin auth failed: ${res.status}`);

  const data = (await res.json()) as { token: string };
  adminToken = data.token;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  return adminToken;
}

/** Validate a user token and return the userId */
async function validateUserToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${getPocketBaseUrl()}/api/collections/users/auth-refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { record: { id: string } };
    return data.record?.id || null;
  } catch {
    return null;
  }
}

// --- Broadcast ---

function broadcast(userId: string, msg: WsOutMessage, excludeClientId?: string): void {
  const clientIds = userClients.get(userId);
  if (!clientIds) return;
  const data = JSON.stringify(msg);
  for (const cid of clientIds) {
    if (cid === excludeClientId) continue;
    const client = clients.get(cid);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

function broadcastToAll(msg: PbSseEvent | ActionMessage): void {
  // Broadcast to all connected clients; the client filters by relevance.
  const data = JSON.stringify(msg);
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

/** Broadcast a sync status event to all connected clients (client filters by accountId). */
export function broadcastSyncEvent(
  accountId: string,
  status: string,
  extra?: Record<string, unknown>
): void {
  broadcastToAll({
    type: "action",
    action: "sync-status",
    accountId,
    status,
    ...extra,
  });
}

// --- PocketBase SSE subscription (server-side) ---

async function subscribeToPbSse(): Promise<void> {
  let attempt = 0;

  async function connect(): Promise<void> {
    try {
      const token = await getAdminToken();
      sseAbortController = new AbortController();

      // Step 1: Create SSE connection
      const sseRes = await fetch(`${getPocketBaseUrl()}/api/realtime`, {
        headers: { Accept: "text/event-stream" },
        signal: sseAbortController.signal,
      });

      if (!sseRes.ok || !sseRes.body) {
        throw new Error(`SSE connection failed: ${sseRes.status}`);
      }

      // Step 2: Read the client ID from the first SSE message
      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let clientId: string | null = null;

      // Read until we get the client ID
      while (!clientId) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream ended before client ID");
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        for (const line of lines) {
          if (line.startsWith("id:")) {
            clientId = line.slice(3).trim();
          }
          if (line.startsWith("data:")) {
            try {
              const data = JSON.parse(line.slice(5).trim());
              if (data.clientId) clientId = data.clientId;
            } catch { /* ignore */ }
          }
        }
        // Keep only incomplete last line in buffer
        buffer = lines[lines.length - 1] || "";
      }

      console.log(`[WS Hub] SSE connected to PB, clientId=${clientId}`);

      // Step 3: Subscribe to collections.
      // IMPORTANT: PocketBase's POST /api/realtime REPLACES the full
      // subscription set on each call (it is not additive). Sending the
      // collections one at a time would leave only the last one subscribed
      // ("labels"), so `messages` create/update events would never reach the
      // hub and the UI would never refresh in real time. Send them all in a
      // single request.
      await fetch(`${getPocketBaseUrl()}/api/realtime`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          clientId,
          subscriptions: ["messages", "folders", "accounts", "labels"],
        }),
      });

      console.log("[WS Hub] Subscribed to messages, folders, accounts, labels");
      attempt = 0;

      // Step 4: Read SSE events continuously
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (!part.trim()) continue;
          let eventName = "";
          let eventData = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            if (line.startsWith("data:")) eventData = line.slice(5).trim();
          }

          if (!eventData) continue;

          try {
            const parsed = JSON.parse(eventData);
            // PB SSE sends events like: event: "messages", data: { action: "update", record: {...} }
            if (eventName && parsed.action && parsed.record) {
              const msg: PbSseEvent = {
                type: "pb",
                collection: eventName,
                action: parsed.action,
                record: parsed.record,
              };
              broadcastToAll(msg);
            }
          } catch {
            // Ignore parse errors (heartbeat messages etc.)
          }
        }
      }

      // If we reach here, the stream ended normally
      throw new Error("SSE stream ended unexpectedly");
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        console.log("[WS Hub] SSE connection aborted (shutdown)");
        return;
      }
      attempt++;
      const delay = Math.min(SSE_RECONNECT_BASE_MS * 2 ** (attempt - 1), SSE_RECONNECT_MAX_MS);
      console.warn(`[WS Hub] SSE disconnected, reconnecting in ${delay}ms...`, err instanceof Error ? err.message : "");
      await new Promise((resolve) => setTimeout(resolve, delay));
      return connect();
    }
  }

  connect();
}

// --- WebSocket Server ---

export function initWsHub(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  console.log("[WS Hub] WebSocket server initialized on /ws");

  // Ping/pong heartbeat
  const pingInterval = setInterval(() => {
    for (const client of clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }, PING_INTERVAL_MS);

  wss.on("close", () => clearInterval(pingInterval));

  wss.on("connection", (ws) => {
    const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let authenticated = false;

    // Auth timeout: close if not authenticated within 5s
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        ws.send(JSON.stringify({ type: "auth-error", error: "Auth timeout" }));
        ws.close(4001, "Auth timeout");
      }
    }, AUTH_TIMEOUT_MS);

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "auth" && msg.token) {
          const userId = await validateUserToken(msg.token);
          if (!userId) {
            ws.send(JSON.stringify({ type: "auth-error", error: "Invalid token" }));
            ws.close(4002, "Invalid token");
            return;
          }

          clearTimeout(authTimer);
          authenticated = true;

          // Register client
          clients.set(clientId, { ws, userId, clientId });
          if (!userClients.has(userId)) {
            userClients.set(userId, new Set());
          }
          userClients.get(userId)!.add(clientId);

          ws.send(JSON.stringify({ type: "auth-ok", userId }));
          console.log(`[WS Hub] Client authenticated: ${clientId} (user=${userId}), total=${clients.size}`);
          return;
        }

        if (!authenticated) return;

        // Forward actions to other clients of the same user
        if (msg.type === "action") {
          const client = clients.get(clientId);
          if (client) {
            broadcast(client.userId, msg, clientId);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      const client = clients.get(clientId);
      if (client) {
        const userSet = userClients.get(client.userId);
        if (userSet) {
          userSet.delete(clientId);
          if (userSet.size === 0) userClients.delete(client.userId);
        }
        clients.delete(clientId);
        console.log(`[WS Hub] Client disconnected: ${clientId}, total=${clients.size}`);
      }
    });

    ws.on("error", () => {
      ws.close();
    });
  });

  // Start PB SSE subscription
  subscribeToPbSse();
}
