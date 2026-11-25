/**
 * Outils du connecteur MCP d'iMiel : la SEULE liste, servie en ligne par
 * POST /mcp (cle `hkm_...`). Le programme local (mcp/imiel-mcp) relaie
 * vers ce point quand il recoit IMIEL_API_KEY.
 *
 * Chaque outil est marque `write` s'il modifie la boite (brouillons, envoi,
 * classement, suppression, generation IA, synchronisation). Une cle "read"
 * n'ENREGISTRE PAS ces outils : ils n'apparaissent meme pas dans la liste.
 *
 * Les outils appellent l'API headless PocketBase (pb_hooks /api/mail/*) avec
 * le jeton de l'UTILISATEUR, sauf la recherche plein texte qui passe par le
 * moteur du worker (runMailSearch, MEM-4640), avec repli sur /api/mail/search.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runMailSearch } from "./mail-search";
import { pocketBaseUrl } from "./pocketbase";

export interface McpContext {
  userId: string;
  userToken: string;
  scope: "read" | "full";
}

type Query = Record<string, string | number | boolean | undefined>;

async function api(
  ctx: McpContext,
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown } = {}
): Promise<unknown> {
  const url = new URL(pocketBaseUrl() + path);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: ctx.userToken,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

const addressSchema = z
  .array(z.object({ name: z.string().optional(), address: z.string() }))
  .describe("Array of recipients, each { address, name? }");

const draftFields = {
  to: addressSchema.optional(),
  cc: addressSchema.optional(),
  bcc: addressSchema.optional(),
  subject: z.string().optional(),
  text_body: z.string().optional(),
  html_body: z.string().optional(),
  in_reply_to: z.string().optional(),
  references: z.array(z.string()).optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
};

const enc = encodeURIComponent;

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ToolDef {
  name: string;
  description: string;
  shape: Record<string, z.ZodTypeAny>;
  write: boolean;
  run: (ctx: McpContext, args: any) => Promise<unknown>;
}

export const MCP_TOOLS: ToolDef[] = [
  // --- Discovery ---
  {
    name: "list_accounts",
    description: "List the user's mail accounts (id, email, sync status). Call this first.",
    shape: {},
    write: false,
    run: (ctx) => api(ctx, "GET", "/api/mail/accounts"),
  },
  {
    name: "list_folders",
    description: "List folders for an account (id, name, type, unread/total counts).",
    shape: { account_id: z.string() },
    write: false,
    run: (ctx, { account_id }) => api(ctx, "GET", "/api/mail/folders", { query: { account_id } }),
  },
  // --- Reading ---
  {
    name: "list_messages",
    description: "List/filter messages. Combine filters to narrow results (e.g. unread inbox).",
    shape: {
      account_id: z.string().optional(),
      folder_id: z.string().optional(),
      folder_type: z
        .enum(["inbox", "sent", "drafts", "trash", "spam", "archive", "custom"])
        .optional()
        .describe("Resolve folder by type (needs account_id)"),
      is_read: z.boolean().optional(),
      is_starred: z.boolean().optional(),
      is_answered: z.boolean().optional(),
      is_draft: z.boolean().optional(),
      is_sent: z.boolean().optional(),
      has_attachments: z.boolean().optional(),
      q: z.string().optional().describe("Substring match on subject/body (min 2 chars)"),
      page: z.number().int().positive().optional(),
      per_page: z.number().int().positive().max(200).optional(),
    },
    write: false,
    run: (ctx, args) => api(ctx, "GET", "/api/mail/messages", { query: args }),
  },
  {
    name: "get_message",
    description: "Get one message with full content (text_body, html_body, headers, attachments).",
    shape: { id: z.string() },
    write: false,
    run: (ctx, { id }) => api(ctx, "GET", `/api/mail/message/${enc(id)}`),
  },
  {
    name: "get_thread",
    description: "Get all messages of a conversation, ordered oldest-first.",
    shape: { thread_id: z.string() },
    write: false,
    run: (ctx, { thread_id }) => api(ctx, "GET", `/api/mail/thread/${enc(thread_id)}`),
  },
  {
    name: "search_messages",
    description:
      "Full-text search across the mailbox (subject, body, sender). Supports operators " +
      "from: to: subject: has:attachment is:unread is:starred after:YYYY-MM-DD before:YYYY-MM-DD. " +
      "Query min 2 characters.",
    shape: {
      q: z.string().min(2),
      account_id: z.string().optional(),
      folder_id: z.string().optional(),
      page: z.number().int().positive().optional(),
      per_page: z.number().int().positive().max(100).optional(),
    },
    write: false,
    run: async (ctx, args) => {
      if (!args.folder_id) {
        const found = await runMailSearch({
          userId: ctx.userId,
          accountId: args.account_id,
          query: args.q,
          page: args.page,
          perPage: args.per_page,
        }).catch(() => null);
        if (found) return found;
      }
      return api(ctx, "GET", "/api/mail/search", { query: args });
    },
  },
  {
    name: "search_contacts",
    description: "Search known contacts by name or email.",
    shape: { q: z.string().min(2), limit: z.number().int().positive().max(50).optional() },
    write: false,
    run: (ctx, args) => api(ctx, "GET", "/api/mail/search-contacts", { query: args }),
  },
  // --- Drafts ---
  {
    name: "create_draft",
    description: "Create a new draft. Only account_id is required.",
    shape: { account_id: z.string(), ...draftFields },
    write: true,
    run: (ctx, args) => api(ctx, "POST", "/api/mail/draft", { body: args }),
  },
  {
    name: "get_draft",
    description: "Get a draft's full content.",
    shape: { draft_id: z.string() },
    write: false,
    run: (ctx, { draft_id }) => api(ctx, "GET", `/api/mail/draft/${enc(draft_id)}`),
  },
  {
    name: "update_draft",
    description: "Update a draft (partial — send only the fields to change).",
    shape: { draft_id: z.string(), ...draftFields },
    write: true,
    run: (ctx, { draft_id, ...body }) => api(ctx, "PATCH", `/api/mail/draft/${enc(draft_id)}`, { body }),
  },
  {
    name: "list_drafts",
    description: "List drafts for an account.",
    shape: { account_id: z.string() },
    write: false,
    run: (ctx, { account_id }) => api(ctx, "GET", `/api/mail/drafts/${enc(account_id)}`),
  },
  {
    name: "delete_draft",
    description: "Discard (delete) a draft.",
    shape: { draft_id: z.string() },
    write: true,
    run: (ctx, { draft_id }) => api(ctx, "DELETE", `/api/mail/draft/${enc(draft_id)}`),
  },
  // --- Sending ---
  {
    name: "send_mail",
    description: "Send a new email, or send an existing draft by passing message_id.",
    shape: {
      account_id: z.string(),
      message_id: z.string().optional().describe("Existing draft record id to send"),
      to: addressSchema.optional(),
      cc: addressSchema.optional(),
      bcc: addressSchema.optional(),
      subject: z.string().optional(),
      text_body: z.string().optional(),
      html_body: z.string().optional(),
    },
    write: true,
    run: (ctx, args) => api(ctx, "POST", "/api/mail/send", { body: args }),
  },
  {
    name: "reply_mail",
    description: "Reply to a message. Builds the References chain and marks the original answered.",
    shape: {
      original_message_id: z.string(),
      to: addressSchema.optional(),
      cc: addressSchema.optional(),
      bcc: addressSchema.optional(),
      subject: z.string().optional().describe("Defaults to 'Re: <original subject>'"),
      text_body: z.string().optional(),
      html_body: z.string().optional(),
    },
    write: true,
    run: (ctx, args) => api(ctx, "POST", "/api/mail/reply", { body: args }),
  },
  // --- Mailbox actions ---
  {
    name: "message_action",
    description:
      "Change a message's state: read/unread, star/unstar, answered/unanswered, " +
      "archive/trash/spam/inbox, move (folder_id), priority.",
    shape: {
      id: z.string(),
      action: z.enum([
        "read",
        "unread",
        "star",
        "unstar",
        "answered",
        "unanswered",
        "archive",
        "trash",
        "spam",
        "inbox",
        "move",
        "priority",
      ]),
      folder_id: z.string().optional().describe("Target folder id (required for action=move)"),
      priority: z.enum(["low", "normal", "high"]).optional().describe("Required for action=priority"),
    },
    write: true,
    run: (ctx, { id, ...body }) => api(ctx, "POST", `/api/mail/message/${enc(id)}/action`, { body }),
  },
  {
    name: "delete_message",
    description: "Permanently delete a message.",
    shape: { id: z.string() },
    write: true,
    run: (ctx, { id }) => api(ctx, "DELETE", `/api/mail/message/${enc(id)}`),
  },
  // --- AI notes (thread briefs) ---
  {
    name: "list_thread_briefs",
    description: "List all AI-generated notes (one per analysed conversation) for the user.",
    shape: {},
    write: false,
    run: (ctx) => api(ctx, "GET", "/api/mail/briefs"),
  },
  {
    name: "get_thread_brief",
    description:
      "Get the AI-generated note (analysis/summary) for a conversation. " +
      "Pair with get_thread to read the conversation itself.",
    shape: { thread_id: z.string() },
    write: false,
    run: (ctx, { thread_id }) => api(ctx, "GET", `/api/mail/thread/${enc(thread_id)}/brief`),
  },
  {
    name: "generate_thread_brief",
    description:
      "Run the AI agent to (re)generate the note for a conversation. " +
      "Incremental by default (only new messages); pass force=true to recompute " +
      "the whole thread. Stores and returns the note.",
    shape: {
      thread_id: z.string(),
      language: z.enum(["fr", "en", "de", "it"]).optional().describe("Note language (default fr)"),
      force: z.boolean().optional().describe("Recompute from the full thread"),
    },
    write: true,
    run: (ctx, { thread_id, ...body }) => api(ctx, "POST", `/api/mail/thread/${enc(thread_id)}/brief`, { body }),
  },
  {
    name: "delete_thread_brief",
    description: "Delete the AI-generated note for a conversation.",
    shape: { thread_id: z.string() },
    write: true,
    run: (ctx, { thread_id }) => api(ctx, "DELETE", `/api/mail/thread/${enc(thread_id)}/brief`),
  },
  // --- Semantic memory ---
  {
    name: "search_semantic",
    description:
      "Vector-search the mailbox by meaning (not keywords). Returns ranked message " +
      "metadata. Use search_context if you also want the message bodies in one call.",
    shape: {
      query: z.string().min(2),
      account_id: z.string().optional().describe("Restrict to one account"),
      limit: z.number().int().positive().max(50).optional().describe("Default 8"),
    },
    write: false,
    run: (ctx, args) => api(ctx, "POST", "/api/mail/search-semantic", { body: args }),
  },
  {
    name: "search_context",
    description:
      "Vector-search + full message content in one round-trip. Designed as " +
      "agent memory: feed the results directly to an LLM.",
    shape: {
      query: z.string().min(2),
      account_id: z.string().optional(),
      limit: z.number().int().positive().max(20).optional().describe("Default 8"),
    },
    write: false,
    run: (ctx, args) => api(ctx, "POST", "/api/mail/search-context", { body: args }),
  },
  {
    name: "embeddings_status",
    description:
      "Indexing status of the user's semantic memory (total messages, indexed, " +
      "backfill progress). Tells you if the memory is ready for search.",
    shape: {},
    write: false,
    run: (ctx) => api(ctx, "GET", "/api/mail/embeddings/status"),
  },
  {
    name: "embeddings_backfill",
    description:
      "Trigger background indexing of the user's mailbox (catch up the semantic " +
      "memory on existing messages). Safe to call repeatedly.",
    shape: {},
    write: true,
    run: (ctx) => api(ctx, "POST", "/api/mail/embeddings/backfill"),
  },
  {
    name: "get_thread_context",
    description:
      "Thread messages + the AI brief in a single call. Prefer this over chaining " +
      "get_thread + get_thread_brief when you only need to decide what to do.",
    shape: { thread_id: z.string() },
    write: false,
    run: (ctx, { thread_id }) => api(ctx, "GET", `/api/mail/thread/${enc(thread_id)}/context`),
  },
  // --- Sync ---
  {
    name: "sync_account",
    description: "Trigger an immediate IMAP/POP3 sync for an account.",
    shape: { account_id: z.string() },
    write: true,
    run: (ctx, { account_id }) => api(ctx, "POST", "/api/mail/sync", { body: { account_id } }),
  },
];

/** Noms des outils servis pour un niveau de droits (sert aussi aux tests). */
export function toolNamesForScope(scope: "read" | "full"): string[] {
  return MCP_TOOLS.filter((t) => scope === "full" || !t.write).map((t) => t.name);
}

/** Serveur MCP d'UNE requete (mode sans etat), outils filtres par les droits. */
export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "imiel", version: "2.0.0" });
  for (const tool of MCP_TOOLS) {
    if (tool.write && ctx.scope !== "full") continue;
    // Cast : le typage generique du SDK (zod) explose sur une table d'outils.
    (server.registerTool as (...a: any[]) => unknown).call(
      server,
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.shape,
        annotations: { readOnlyHint: !tool.write, destructiveHint: tool.write },
      },
      (async (args: unknown) => {
        try {
          const data = await tool.run(ctx, args || {});
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
        }
      })
    );
  }
  return server;
}
