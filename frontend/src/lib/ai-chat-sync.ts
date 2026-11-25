/**
 * Conversation de l'assistant IA partagee entre les appareils.
 *
 * Source de verite : la collection PocketBase `ai_chat_messages` (une
 * conversation par utilisateur, regles = proprietaire). Chaque message porte
 * un `client_id` pose par l'appareil qui l'a cree (UNIQUE par utilisateur) :
 * une ecriture rejouee ou la reprise de l'ancien historique local ne cree
 * jamais de doublon. Les autres appareils recoivent les changements par
 * l'abonnement temps reel PocketBase (le hub WebSocket du worker ne relaie
 * que le courrier).
 *
 * L'ancien historique `localStorage` est verse UNE fois par navigateur puis
 * retire : il ne sert plus de reference.
 */
import pb, { getCurrentUserId } from "@/lib/pocketbase";
import type { AiAction } from "@/lib/ai-actions-types";
import type { ChatAttachmentMeta } from "@/lib/ai-chat-attachments";

export const LEGACY_HISTORY_KEY = "imiel:aiChatHistory";
const COLLECTION = "ai_chat_messages";
/** Messages charges a l'ouverture (les plus recents). */
export const CHAT_LOAD_LIMIT = 200;

export interface SyncedChatMessage<M = unknown> {
  id: string; // client_id
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
  meta?: M;
  actions?: AiAction[];
  attachments?: ChatAttachmentMeta[];
}

interface ChatRecord {
  id: string;
  user: string;
  client_id: string;
  role: "user" | "assistant";
  content: string;
  at: number;
  meta: unknown;
  actions: AiAction[] | null;
  attachments: ChatAttachmentMeta[] | null;
  updated: string;
}

export function newChatMessageId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function fromRecord<M>(r: ChatRecord): SyncedChatMessage<M> {
  return {
    id: r.client_id,
    role: r.role,
    content: r.content || "",
    createdAt: r.at || undefined,
    meta: r.meta && typeof r.meta === "object" ? (r.meta as M) : undefined,
    actions: Array.isArray(r.actions) && r.actions.length ? r.actions : undefined,
    attachments: Array.isArray(r.attachments) && r.attachments.length ? r.attachments : undefined,
  };
}

/** Tri stable par date de creation (les messages sans date restent en place). */
export function sortChat<T extends { createdAt?: number }>(list: T[]): T[] {
  return list
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (a.m.createdAt ?? 0) - (b.m.createdAt ?? 0) || a.i - b.i)
    .map((x) => x.m);
}

/** Remplace (meme id) ou insere a sa place chronologique. */
export function upsertChat<T extends { id: string; createdAt?: number }>(list: T[], msg: T): T[] {
  const idx = list.findIndex((m) => m.id === msg.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = msg;
    return next;
  }
  return sortChat([...list, msg]);
}

// client_id -> id PocketBase, pour mettre a jour sans relire.
const recordIds = new Map<string, string>();
// Ecritures serialisees PAR message : deux mises a jour rapprochees d'une
// carte (en cours -> faite) ne s'inversent jamais cote serveur.
const queues = new Map<string, Promise<unknown>>();

export async function loadChat<M>(): Promise<SyncedChatMessage<M>[]> {
  const res = await pb.collection(COLLECTION).getList<ChatRecord>(1, CHAT_LOAD_LIMIT, { sort: "-at,-created" });
  const now = Date.now();
  return res.items
    .reverse()
    .map((r) => {
      recordIds.set(r.client_id, r.id);
      const msg = fromRecord<M>(r);
      // Une carte restee "en cours" depuis longtemps (onglet ferme en plein
      // travail) : on ne la rejoue pas a l'aveugle, on dit de verifier.
      const stale = now - new Date(r.updated.replace(" ", "T")).getTime() > 5 * 60_000;
      if (stale && msg.actions?.some((a) => a.status === "running")) {
        msg.actions = msg.actions.map((a) =>
          a.status === "running" ? { ...a, status: "error" as const, error: "Interrompue : verifier dans l'application" } : a
        );
      }
      return msg;
    });
}

async function writeMessage(msg: SyncedChatMessage): Promise<void> {
  const user = getCurrentUserId();
  if (!user) return;
  const body = {
    content: msg.content.slice(0, 100_000),
    at: msg.createdAt ?? Date.now(),
    meta: msg.meta ?? null,
    actions: msg.actions ?? null,
    // Jamais le binaire : nom, type, taille, miniature.
    attachments: msg.attachments?.map(({ name, type, size, kind, thumb }) => ({ name, type, size, kind, ...(thumb ? { thumb } : {}) })) ?? null,
  };
  const known = recordIds.get(msg.id);
  if (known) {
    await pb.collection(COLLECTION).update(known, body);
    return;
  }
  try {
    const rec = await pb.collection(COLLECTION).create<ChatRecord>({ ...body, user, client_id: msg.id, role: msg.role });
    recordIds.set(msg.id, rec.id);
  } catch (err) {
    // Deja cree (autre onglet, reprise rejouee) : on met a jour l'existant.
    const existing = await pb
      .collection(COLLECTION)
      .getFirstListItem<ChatRecord>(pb.filter("client_id = {:cid}", { cid: msg.id }))
      .catch(() => null);
    if (!existing) throw err;
    recordIds.set(msg.id, existing.id);
    await pb.collection(COLLECTION).update(existing.id, body);
  }
}

/** Enregistre (cree ou met a jour) un message. Best effort : jamais bloquant pour l'ecran. */
export function saveChatMessage(msg: SyncedChatMessage): Promise<void> {
  const prev = queues.get(msg.id) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined)
    .then(() => writeMessage(msg))
    .catch((err) => {
      console.warn("[ai-chat] enregistrement impossible", err);
    });
  queues.set(msg.id, run);
  void run.finally(() => {
    if (queues.get(msg.id) === run) queues.delete(msg.id);
  });
  return run;
}

/** Vide la conversation sur TOUS les appareils. */
export async function clearChat(): Promise<void> {
  const items = await pb.collection(COLLECTION).getFullList<ChatRecord>({ fields: "id,client_id" });
  for (const r of items) {
    await pb.collection(COLLECTION).delete(r.id).catch(() => undefined);
    recordIds.delete(r.client_id);
  }
}

export type ChatEvent<M> =
  | { action: "upsert"; message: SyncedChatMessage<M> }
  | { action: "delete"; id: string };

/**
 * Ecoute les changements des autres appareils. `onResync` est appele a chaque
 * (re)connexion du canal temps reel : les evenements manques pendant une
 * coupure se rattrapent en relisant la conversation.
 */
export async function subscribeChat<M>(
  onEvent: (e: ChatEvent<M>) => void,
  onResync: () => void
): Promise<() => void> {
  const userId = getCurrentUserId();
  const unsubRecords = await pb.collection(COLLECTION).subscribe<ChatRecord>("*", (e) => {
    if (!e.record || e.record.user !== userId) return;
    if (e.action === "delete") {
      recordIds.delete(e.record.client_id);
      onEvent({ action: "delete", id: e.record.client_id });
    } else {
      recordIds.set(e.record.client_id, e.record.id);
      onEvent({ action: "upsert", message: fromRecord<M>(e.record) });
    }
  });
  // Deja connecte ici : l'ecouteur ne part qu'aux RE-connexions suivantes.
  const unsubConnect = await pb.realtime.subscribe("PB_CONNECT", () => onResync());
  return () => {
    void unsubRecords();
    void unsubConnect();
  };
}

/**
 * Empreinte BON MARCHE de la conversation (nombre de messages + derniere
 * modification) : filet de securite quand le canal temps reel ne delivre
 * rien (proxy qui retient le flux, coupure muette). Une empreinte qui change
 * declenche une relecture complete.
 */
export async function chatFingerprint(): Promise<string> {
  const res = await pb.collection(COLLECTION).getList<{ id: string; updated: string }>(1, 1, {
    sort: "-updated",
    fields: "id,updated",
  });
  return `${res.totalItems}|${res.items[0]?.updated ?? ""}`;
}

function legacyId(m: { role: string; content: string; createdAt?: number }, index: number): string {
  // Identifiant DETERMINISTE : la meme conversation reprise deux fois (onglet
  // rouvert avant la fin, deux onglets) retombe sur les memes messages.
  let h = 5381;
  const s = `${m.role}|${m.createdAt ?? index}|${m.content}`;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `legacy_${m.createdAt ?? `i${index}`}_${h.toString(36)}`;
}

/**
 * Verse l'ancien historique local dans la conversation partagee, sans doublon,
 * puis le retire du navigateur. Rend true si quelque chose a ete repris.
 */
export async function migrateLegacyHistory(
  parse: (raw: string) => Array<Omit<SyncedChatMessage, "id">>
): Promise<boolean> {
  if (typeof window === "undefined" || !getCurrentUserId()) return false;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_HISTORY_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  const legacy = parse(raw);
  const base = Date.now() - legacy.length * 1000;
  let failed = false;
  for (let i = 0; i < legacy.length; i++) {
    const m = legacy[i];
    const id = legacyId(m, i);
    // Anciens messages sans date : ordre conserve, places avant maintenant.
    const createdAt = m.createdAt ?? base + i;
    try {
      await writeMessage({ ...m, id, createdAt });
    } catch {
      failed = true;
    }
  }
  // Echec partiel : la copie locale reste, la reprise sera rejouee (sans
  // doublon grace aux identifiants deterministes).
  if (!failed) {
    try {
      localStorage.removeItem(LEGACY_HISTORY_KEY);
    } catch {
      // ignore
    }
  }
  return legacy.length > 0;
}
