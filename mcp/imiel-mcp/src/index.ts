#!/usr/bin/env node
/**
 * iMiel Pro — MCP server (local, stdio).
 *
 * Two modes, chosen by environment variables:
 *
 *   IMIEL_API_KEY   (recommended) A key created in Settings > Connectivity.
 *                       The program is then a thin stdio <-> HTTP relay to the
 *                       online connector (<IMIEL_URL>/worker/mcp): tools and
 *                       rights (read-only / full access) come from the server.
 *
 *   IMIEL_EMAIL + IMIEL_PASSWORD   Legacy login: tools run locally
 *                       against the headless API with full access.
 *
 *   IMIEL_URL       Base URL (default: https://imiel.example.com)
 *
 * Transport: stdio. Only stderr is used for logging (stdout is the protocol).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

// Noms IMIEL_* ; les anciens HAIKOMAIL_* (configurations existantes) restent lus.
const env = (name: string): string => process.env[`IMIEL_${name}`] || process.env[`HAIKOMAIL_${name}`] || "";
const BASE_URL = (env("URL") || "https://imiel.example.com").replace(/\/+$/, "");
const API_KEY = env("API_KEY").trim();
const EMAIL = env("EMAIL");
const PASSWORD = env("PASSWORD");

if (API_KEY) {
  // Relay mode: every JSON-RPC message goes to the online connector as is.
  const remote = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/worker/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
  });
  const local = new StdioServerTransport();
  local.onmessage = (msg) => {
    remote.send(msg).catch((err) => console.error("[imiel-mcp] relay error:", err));
  };
  remote.onmessage = (msg) => {
    local.send(msg).catch((err) => console.error("[imiel-mcp] stdout error:", err));
  };
  remote.onerror = (err) => console.error("[imiel-mcp] remote error:", err);
  local.onclose = () => {
    void remote.close();
    process.exit(0);
  };
  Promise.all([remote.start(), local.start()])
    .then(() => console.error(`[imiel-mcp] relaying to ${BASE_URL}/worker/mcp`))
    .catch((err) => {
      console.error("[imiel-mcp] fatal:", err);
      process.exit(1);
    });
} else if (!EMAIL || !PASSWORD) {
  console.error("[imiel-mcp] set IMIEL_API_KEY (or IMIEL_EMAIL and IMIEL_PASSWORD).");
  process.exit(1);
}

let token: string | null = null;

async function login(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/collections/users/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Login failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { token: string };
  token = data.token;
  console.error("[imiel-mcp] authenticated");
}

/**
 * Authenticated API call. Lazily logs in, retries once on 401.
 */
async function api(
  method: string,
  path: string,
  opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
): Promise<unknown> {
  if (!token) await login();

  const url = new URL(BASE_URL + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const doFetch = () =>
    fetch(url, {
      method,
      headers: {
        Authorization: token as string,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await doFetch();
  if (res.status === 401) {
    await login();
    res = await doFetch();
  }

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

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

const addressSchema = z
  .array(z.object({ name: z.string().optional(), address: z.string() }))
  .describe("Array of recipients, each { address, name? }");

const server = new McpServer({ name: "imiel", version: "1.0.0" });

// --- Discovery ---------------------------------------------------------------

server.tool(
  "list_accounts",
  "List the user's mail accounts (id, email, sync status). Call this first.",
  {},
  async () => {
    try {
      return ok(await api("GET", "/api/mail/accounts"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "list_folders",
  "List folders for an account (id, name, type, unread/total counts).",
  { account_id: z.string() },
  async ({ account_id }) => {
    try {
      return ok(await api("GET", "/api/mail/folders", { query: { account_id } }));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Reading -----------------------------------------------------------------

server.tool(
  "list_messages",
  "List/filter messages. Combine filters to narrow results (e.g. unread inbox).",
  {
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
  async (args) => {
    try {
      return ok(await api("GET", "/api/mail/messages", { query: args }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_message",
  "Get one message with full content (text_body, html_body, headers, attachments).",
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api("GET", `/api/mail/message/${encodeURIComponent(id)}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_thread",
  "Get all messages of a conversation, ordered oldest-first.",
  { thread_id: z.string() },
  async ({ thread_id }) => {
    try {
      return ok(await api("GET", `/api/mail/thread/${encodeURIComponent(thread_id)}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "search_messages",
  "Full-text search across subject and body. Query min 2 characters.",
  {
    q: z.string().min(2),
    account_id: z.string().optional(),
    folder_id: z.string().optional(),
    page: z.number().int().positive().optional(),
    per_page: z.number().int().positive().max(100).optional(),
  },
  async (args) => {
    try {
      return ok(await api("GET", "/api/mail/search", { query: args }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "search_contacts",
  "Search known contacts by name or email.",
  { q: z.string().min(2), limit: z.number().int().positive().max(50).optional() },
  async (args) => {
    try {
      return ok(await api("GET", "/api/mail/search-contacts", { query: args }));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Drafts ------------------------------------------------------------------

server.tool(
  "create_draft",
  "Create a new draft. Only account_id is required.",
  {
    account_id: z.string(),
    to: addressSchema.optional(),
    cc: addressSchema.optional(),
    bcc: addressSchema.optional(),
    subject: z.string().optional(),
    text_body: z.string().optional(),
    html_body: z.string().optional(),
    in_reply_to: z.string().optional(),
    references: z.array(z.string()).optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
  },
  async (args) => {
    try {
      return ok(await api("POST", "/api/mail/draft", { body: args }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_draft",
  "Get a draft's full content.",
  { draft_id: z.string() },
  async ({ draft_id }) => {
    try {
      return ok(await api("GET", `/api/mail/draft/${encodeURIComponent(draft_id)}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "update_draft",
  "Update a draft (partial — send only the fields to change).",
  {
    draft_id: z.string(),
    to: addressSchema.optional(),
    cc: addressSchema.optional(),
    bcc: addressSchema.optional(),
    subject: z.string().optional(),
    text_body: z.string().optional(),
    html_body: z.string().optional(),
    in_reply_to: z.string().optional(),
    references: z.array(z.string()).optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
  },
  async ({ draft_id, ...body }) => {
    try {
      return ok(await api("PATCH", `/api/mail/draft/${encodeURIComponent(draft_id)}`, { body }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "list_drafts",
  "List drafts for an account.",
  { account_id: z.string() },
  async ({ account_id }) => {
    try {
      return ok(await api("GET", `/api/mail/drafts/${encodeURIComponent(account_id)}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "delete_draft",
  "Discard (delete) a draft.",
  { draft_id: z.string() },
  async ({ draft_id }) => {
    try {
      return ok(await api("DELETE", `/api/mail/draft/${encodeURIComponent(draft_id)}`));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Sending -----------------------------------------------------------------

server.tool(
  "send_mail",
  "Send a new email, or send an existing draft by passing message_id.",
  {
    account_id: z.string(),
    message_id: z.string().optional().describe("Existing draft record id to send"),
    to: addressSchema.optional(),
    cc: addressSchema.optional(),
    bcc: addressSchema.optional(),
    subject: z.string().optional(),
    text_body: z.string().optional(),
    html_body: z.string().optional(),
  },
  async (args) => {
    try {
      return ok(await api("POST", "/api/mail/send", { body: args }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "reply_mail",
  "Reply to a message. Builds the References chain and marks the original answered.",
  {
    original_message_id: z.string(),
    to: addressSchema.optional(),
    cc: addressSchema.optional(),
    bcc: addressSchema.optional(),
    subject: z.string().optional().describe("Defaults to 'Re: <original subject>'"),
    text_body: z.string().optional(),
    html_body: z.string().optional(),
  },
  async (args) => {
    try {
      return ok(await api("POST", "/api/mail/reply", { body: args }));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Mailbox actions ---------------------------------------------------------

server.tool(
  "message_action",
  "Change a message's state: read/unread, star/unstar, answered/unanswered, " +
    "archive/trash/spam/inbox, move (folder_id), priority.",
  {
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
  async ({ id, ...body }) => {
    try {
      return ok(await api("POST", `/api/mail/message/${encodeURIComponent(id)}/action`, { body }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "delete_message",
  "Permanently delete a message.",
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api("DELETE", `/api/mail/message/${encodeURIComponent(id)}`));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- AI mail-analysis agent (thread notes / "briefs") -----------------------

server.tool(
  "list_thread_briefs",
  "List all AI-generated notes (one per analysed conversation) for the user.",
  {},
  async () => {
    try {
      return ok(await api("GET", "/api/mail/briefs"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_thread_brief",
  "Get the AI-generated note (analysis/summary) for a conversation. " +
    "Pair with get_thread to read the conversation itself.",
  { thread_id: z.string() },
  async ({ thread_id }) => {
    try {
      return ok(await api("GET", `/api/mail/thread/${encodeURIComponent(thread_id)}/brief`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "generate_thread_brief",
  "Run the AI agent to (re)generate the note for a conversation. " +
    "Incremental by default (only new messages); pass force=true to recompute " +
    "the whole thread. Stores and returns the note.",
  {
    thread_id: z.string(),
    language: z.enum(["fr", "en", "de", "it"]).optional().describe("Note language (default fr)"),
    force: z.boolean().optional().describe("Recompute from the full thread"),
  },
  async ({ thread_id, ...body }) => {
    try {
      return ok(
        await api("POST", `/api/mail/thread/${encodeURIComponent(thread_id)}/brief`, { body }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "delete_thread_brief",
  "Delete the AI-generated note for a conversation.",
  { thread_id: z.string() },
  async ({ thread_id }) => {
    try {
      return ok(await api("DELETE", `/api/mail/thread/${encodeURIComponent(thread_id)}/brief`));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Semantic memory (embeddings) -------------------------------------------

server.tool(
  "search_semantic",
  "Vector-search the mailbox by meaning (not keywords). Returns ranked message " +
    "metadata. Use search_context if you also want the message bodies in one call.",
  {
    query: z.string().min(2),
    account_id: z.string().optional().describe("Restrict to one account"),
    limit: z.number().int().positive().max(50).optional().describe("Default 8"),
  },
  async (args) => {
    try {
      return ok(await api("POST", "/api/mail/search-semantic", { body: args }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "search_context",
  "Vector-search + full message content in one round-trip. Designed as " +
    "agent memory: feed the results directly to an LLM.",
  {
    query: z.string().min(2),
    account_id: z.string().optional(),
    limit: z.number().int().positive().max(20).optional().describe("Default 8"),
  },
  async (args) => {
    try {
      return ok(await api("POST", "/api/mail/search-context", { body: args }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "embeddings_status",
  "Indexing status of the user's semantic memory (total messages, indexed, " +
    "backfill progress). Tells you if the memory is ready for search.",
  {},
  async () => {
    try {
      return ok(await api("GET", "/api/mail/embeddings/status"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "embeddings_backfill",
  "Trigger background indexing of the user's mailbox (catch up the semantic " +
    "memory on existing messages). Safe to call repeatedly.",
  {},
  async () => {
    try {
      return ok(await api("POST", "/api/mail/embeddings/backfill"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_thread_context",
  "Thread messages + the AI brief in a single call. Prefer this over chaining " +
    "get_thread + get_thread_brief when you only need to decide what to do.",
  { thread_id: z.string() },
  async ({ thread_id }) => {
    try {
      return ok(
        await api("GET", `/api/mail/thread/${encodeURIComponent(thread_id)}/context`),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Sync --------------------------------------------------------------------

server.tool(
  "sync_account",
  "Trigger an immediate IMAP/POP3 sync for an account.",
  { account_id: z.string() },
  async ({ account_id }) => {
    try {
      return ok(await api("POST", "/api/mail/sync", { body: { account_id } }));
    } catch (e) {
      return fail(e);
    }
  },
);

// --- Boot --------------------------------------------------------------------

async function main() {
  if (API_KEY) return;
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[imiel-mcp] ready");
}

main().catch((err) => {
  console.error("[imiel-mcp] fatal:", err);
  process.exit(1);
});
