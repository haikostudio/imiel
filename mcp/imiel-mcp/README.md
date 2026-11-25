# imiel-mcp

MCP server that gives an LLM agent full control of a iMiel mailbox:
discover accounts/folders, read & search mail, manage drafts, send/reply, and
organise the mailbox (read, star, archive, trash, move, priority, delete).

It can relay to the online connector with an API key (recommended) or log in
with email/password (legacy). See `../../docs/API.md` for the underlying HTTP API.

## Install & build

```bash
cd mcp/imiel-mcp
npm install
npm run build
```

## Online connector (recommended, nothing to install)

The mailbox exposes the same tools online, over MCP Streamable HTTP:

- URL: `https://imiel.example.com/worker/mcp`
- Header: `Authorization: Bearer hkm_...` — a key created in
  **Settings > Connectivity**. A key is either **read-only** (only reading and
  search tools are listed) or **full access** (all tools below).

```bash
claude mcp add --transport http imiel https://imiel.example.com/worker/mcp \
  --header "Authorization: Bearer hkm_..."
```

```json
{ "mcpServers": { "imiel": { "type": "http", "url": "https://imiel.example.com/worker/mcp",
  "headers": { "Authorization": "Bearer hkm_..." } } } }
```

The single source of the tool list is `backend/mail-worker/src/mcp-tools.ts`.

## Configuration of this local program

| var | required | default |
|-----|----------|---------|
| `IMIEL_URL` | no | `https://imiel.example.com` |
| `IMIEL_API_KEY` | recommended | — (key from Settings > Connectivity) |
| `IMIEL_EMAIL` | legacy | — |
| `IMIEL_PASSWORD` | legacy | — |

With `IMIEL_API_KEY`, the program is a thin stdio <-> HTTP relay to the
online connector (tools and rights come from the server). Without it, it logs
in with email/password and runs the legacy local tools with full access.

```json
{
  "mcpServers": {
    "imiel": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/imiel-mcp/dist/index.js"],
      "env": { "IMIEL_URL": "https://imiel.example.com", "IMIEL_API_KEY": "hkm_..." }
    }
  }
}
```

## Tools

| tool | purpose |
|------|---------|
| `list_accounts` | list mail accounts (call first) |
| `list_folders` | folders of an account |
| `list_messages` | list/filter messages |
| `get_message` | full message content |
| `get_thread` | all messages of a conversation |
| `search_messages` | full-text search (read) |
| `search_contacts` | find contacts by name/email |
| `create_draft` | create a draft |
| `get_draft` | read a draft |
| `update_draft` | update a draft (partial) |
| `list_drafts` | list drafts of an account |
| `delete_draft` | discard a draft |
| `send_mail` | send a new mail or an existing draft |
| `reply_mail` | reply (builds References chain) |
| `message_action` | read/star/answered/archive/trash/spam/inbox/move/priority |
| `delete_message` | permanently delete |
| `list_thread_briefs` | list all AI-generated conversation notes |
| `get_thread_brief` | read the AI note for a conversation |
| `generate_thread_brief` | run the AI agent to (re)generate a note |
| `delete_thread_brief` | delete the AI note for a conversation |
| `get_thread_context` | thread messages + AI brief in one round-trip |
| `search_semantic` | vector search (meaning, not keywords) — metadata only |
| `search_context` | vector search + full message content (agent memory) |
| `embeddings_status` | indexing status / backfill progress |
| `embeddings_backfill` | trigger background indexing of the mailbox |
| `sync_account` | trigger an IMAP/POP3 sync |

## AI memory model

iMiel exposes two complementary memories an agent can use:

1. **Per-thread notes** (`thread_briefs`) — `list_thread_briefs`,
   `get_thread_brief`, `generate_thread_brief`. Long-term, structured note
   per conversation; `generate_thread_brief` is incremental (only new
   messages are sent, the previous note is updated).
2. **Semantic memory across the whole mailbox** (vector embeddings) —
   `search_semantic` / `search_context`. Backed by a local `all-MiniLM-L6-v2`
   model (384-dim cosine). Use `embeddings_status` to verify it is ready and
   `embeddings_backfill` to catch it up if needed.

Typical agent loop:

```
list_accounts -> list_folders -> list_messages(unread)
  for each interesting thread:
    get_thread_context (messages + brief)
    if brief is stale or absent: generate_thread_brief
  search_context("question or topic") to recall related past mail
  reply_mail / create_draft / message_action
```

## Notes

- Mailbox mutations apply to the server store immediately; the IMAP server is
  reconciled on the next sync (auto cron, or call `sync_account`).
- Recipients are arrays of `{ address, name? }`.
- `generate_thread_brief` runs the AI agent server-side (project LLM
  gateway). The iMiel server must have `LLM_API_KEY` configured.
- Attachments are not supported through this MCP (text/HTML bodies only).
- Credentials are read from the environment only; nothing is written to disk.
