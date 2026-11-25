# iMiel — API Reference (for LLM agents)

This document fully describes the iMiel HTTP API. It is written so an LLM
agent can drive a mailbox programmatically (read, search, draft, send, organise)
without using the web UI.

## 1. Base URL

```
https://pb.example.com
```

All endpoints below are relative to this base URL. The API is served directly by
PocketBase (the custom endpoints are registered as PocketBase routes).

## 2. Authentication

The API is **only accessible after login**. Login once, obtain a token, then
send it on every request.

### 2.1 Login

```
POST /api/collections/users/auth-with-password
Content-Type: application/json

{ "identity": "<email>", "password": "<password>" }
```

Response:

```json
{
  "token": "eyJhbGciOi...",
  "record": { "id": "USER_ID", "email": "...", "language": "fr", ... }
}
```

### 2.2 Authenticated requests

Send the token in the `Authorization` header on every subsequent request:

```
Authorization: <token>
```

(PocketBase accepts the raw token; `Bearer <token>` also works.)

### 2.3 Refresh

Tokens expire. On `401`, re-login (2.1) or refresh:

```
POST /api/collections/users/auth-refresh
Authorization: <token>
```

Returns a new `{ token, record }`.

### 2.4 Authorisation model

Every endpoint verifies ownership: a user can only see/modify their own
accounts, folders, messages and drafts. Accessing another user's resource
returns `403`.

## 3. Conventions

### 3.1 Address object

`from`, `to`, `cc`, `bcc` fields use this shape:

```json
{ "name": "Alice Doe", "address": "alice@example.com" }
```

`to`, `cc`, `bcc` are **arrays** of address objects. `from` is a single object.

### 3.2 Folder types

`inbox | sent | drafts | trash | spam | archive | custom`

### 3.3 Message booleans

`is_read, is_starred, is_answered, is_draft, is_sent, has_attachments`

### 3.4 Priority

`low | normal | high`

### 3.5 Errors

Non-2xx responses return JSON. Either PocketBase format
(`{ "code": 400, "message": "...", "data": {...} }`) or
`{ "error": "..." }` for custom endpoints. `401` = re-auth needed,
`403` = not your resource, `404` = not found.

### 3.6 Operation model

Mailbox mutations (move/trash/archive/delete/flags) are applied to the
PocketBase store immediately. The IMAP server is reconciled on the next sync
(automatic cron, ~1–5 min, or trigger manually via §7). Sending goes out over
SMTP synchronously.

## 4. Discovery

Use these first to learn what accounts/folders exist.

### `GET /api/mail/accounts`

Lists the user's mail accounts.

```json
{ "accounts": [
  { "id": "ACC1", "label": "Perso", "email": "me@gmail.com",
    "display_name": "Me", "protocol": "imap", "sync_status": "idle",
    "last_synced_at": "2026-05-18T10:00:00Z", "is_active": true,
    "color": "#3b82f6" }
] }
```

### `GET /api/mail/folders?account_id=ACC1`

Lists folders for an account.

```json
{ "folders": [
  { "id": "FLD1", "name": "INBOX", "path": "INBOX", "type": "inbox",
    "unread_count": 3, "total_count": 120, "sort_order": 0 }
] }
```

## 5. Reading mail

### `GET /api/mail/messages`

List/filter messages. Query parameters (all optional):

| param | description |
|-------|-------------|
| `account_id` | restrict to one account |
| `folder_id` | restrict to one folder (record id) |
| `folder_type` | resolve folder by type (needs `account_id`) |
| `is_read` | `true` / `false` |
| `is_starred` | `true` / `false` |
| `is_answered` | `true` / `false` |
| `is_draft` | `true` / `false` |
| `is_sent` | `true` / `false` |
| `has_attachments` | `true` / `false` |
| `q` | substring match on subject/body (min 2 chars) |
| `page` | default `1` |
| `per_page` | default `50`, max `200` |

Response:

```json
{ "items": [ { "id": "MSG1", "account": "ACC1", "folder": "FLD1",
  "message_id": "<...>", "thread_id": "...", "from": {...}, "to": [...],
  "cc": [...], "subject": "Hello", "snippet": "first 200 chars...",
  "date": "2026-05-18T09:00:00Z", "is_read": false, "is_starred": false,
  "is_answered": false, "is_draft": false, "is_sent": false,
  "has_attachments": false, "priority": "normal", "labels": [] } ],
  "page": 1, "per_page": 50, "total_items": 12, "total_pages": 1 }
```

### `GET /api/mail/message/{id}`

Full single message (adds `text_body`, `html_body`, `bcc`, `in_reply_to`,
`references`, `raw_headers`, `attachments`, `draft_reply_to`,
`auto_saved_at`).

```json
{ "message": { "id": "MSG1", ..., "text_body": "...", "html_body": "<p>...</p>",
  "attachments": [ ... ] } }
```

### `GET /api/mail/thread/{threadId}`

All messages of a conversation, ordered by date ascending.

```json
{ "thread_id": "...", "message_count": 3, "messages": [ { ... } ] }
```

### `GET /api/mail/search?q=term&account_id=&folder_id=&page=&per_page=`

Full-text search (subject + body). `q` min 2 chars. Same item shape and
pagination as `/api/mail/messages`.

### `GET /api/mail/search-contacts?q=term&limit=20`

Search known contacts by name/email.

```json
{ "contacts": [ { "name": "Alice", "address": "alice@example.com", "count": 8 } ] }
```

### `GET /api/mail/list`

Fast SQL-direct listing used by the UI hot path. It returns the same compact
message shape as `/api/mail/messages`, with pagination, but applies ownership in
one SQL query instead of PocketBase per-record access checks.

Common query parameters:

| param | description |
|-------|-------------|
| `account_id` | account id, or `all` for all accounts |
| `folder_id` | restrict to one folder id |
| `folder_type` | restrict to a standard folder type |
| `view` | virtual view: `starred`, `all_mail`, `unread` |
| `label_id` | restrict to messages carrying a label id |
| `exclude_secondary` | `true` to hide messages with secondary labels |
| `is_read`, `is_starred`, `has_attachments` | boolean filters |
| `from_text`, `body_text` | LIKE filters |
| `page`, `per_page` | pagination |

`view=unread` lists unread messages across folders, excluding spam, trash and
drafts. Use it for the dedicated Unread/Non lus sidebar entry.

Ordering is total: `date DESC, id DESC` (stable pagination, even when several
messages share the same second). `search_text` (LIKE on subject / sender /
recipients) is kept only as a fallback for direct API calls: the application
search goes through the worker (`POST /search/mail`, below).

Performance contract (migration 067): the endpoint never reads a row of
`messages` (inline bodies) and never sorts the whole mailbox. Target folders are
resolved first, one sub-query per folder follows `(folder, is_draft, date, id)`
and stops at `LIMIT`; filters and `COUNT` are served by the narrow index
`idx_msg_list_keys`, displayed columns by the covering index
`idx_msg_list_cover`. A filtered column must be in the former, a projected
column in the latter. Replayable check on a COPY of the database:
`node scripts/verifier-liste-mails.mjs` (times through PocketBase, cold and
warm, and row-by-row comparison with a reference dump).

### `POST /search/mail` (mail-worker)

Mail search used by the UI: one engine for the command palette and for the
"See all" list, paginated server-side, no result cap. Reached from the browser
as `/worker/search/mail`.

```json
{ "userId": "USER", "accountId": "ACC1", "query": "inovi from:labo is:unread",
  "page": 1, "perPage": 50,
  "scope": { "folderIds": ["F1"], "isDraft": false, "excludeSecondary": true } }
```

- `query` is the text as typed. Every word counts (no stop-word list) and is a
  word PREFIX (`inovi` finds `Labo`); case and accents are ignored; an address
  or a hyphenated word is matched as consecutive words. Operators: `from:`
  `to:` `subject:` `has:attachment` `is:unread` `is:starred` `after:YYYY-MM-DD`
  `before:YYYY-MM-DD`.
- A simple query (<= 3 words, no `?`) is sorted newest first; when no word
  matches, the semantic engine is tried before answering "nothing". A question
  in natural language goes through the hybrid relevance engine (top 200).
- `scope` mirrors the list parameters (`view`, `folderIds`, `folderType`,
  `labelId`, `isDraft`, `excludeSecondary`, `unread`, `starred`,
  `hasAttachments`, `priority`, `fromText`). Omitted = the whole mailbox.
  Blocked senders are never returned.

```json
{ "items": [ { "id": "...", "folder_type": "inbox", "subject": "..." } ],
  "page": 1, "perPage": 50, "totalItems": 12, "totalPages": 1,
  "counts": { "inbox": 10, "sent": 2 }, "mode": "keyword",
  "indexing": { "ready": true, "done": 38726, "total": 38726 } }
```

`items` have the shape of `/api/mail/list` items plus `folder_type`. `503`
means the worker index is unavailable (the UI then falls back to PocketBase
LIKE search). `GET /search/status` returns the index state.

The full-text index is owned by the worker (`search-index.ts`, SQLite file next
to the vector cache, `SEARCH_INDEX_PATH` to override): subject, sender,
recipients and READABLE body (HTML tags, styles and scripts stripped, entities
decoded). It is synchronised with `data.db` (read-only) by id difference and is
rebuilt in the background when missing (about 70 s for 38 700 mails; during the
first build, searches answer on the most recent mails and `indexing.ready` is
`false`). Replayable check on a copy: `npx tsx scripts/verifier-recherche.ts`
in `backend/mail-worker`.

### `GET /api/mail/sidebar-counts?account_id=ACC1`

Fast sidebar counters. `account_id` is optional and can be `all`.

```json
{ "inboxUnread": 3, "inboxTotal": 120, "starred": 4, "unread": 9,
  "sent": 50, "drafts": 1, "trash": 0, "allMail": 170, "spam": 2 }
```

## 6. Drafts

### `POST /api/mail/draft` — create

```json
POST /api/mail/draft
{
  "account_id": "ACC1",
  "to": [ { "name": "Alice", "address": "alice@example.com" } ],
  "cc": [], "bcc": [],
  "subject": "Hi",
  "text_body": "Plain text",
  "html_body": "<p>HTML</p>",
  "in_reply_to": "", "references": [],
  "priority": "normal"
}
```

Only `account_id` is required. Response:

```json
{ "status": "created", "draft_id": "MSG2", "draft": { ...full message... } }
```

### `GET /api/mail/draft/{draftId}` — read

`{ "draft": { ...full message... } }`

### `PATCH /api/mail/draft/{draftId}` — update (partial)

Send only the fields to change (same body shape as create, no `account_id`
needed). `{ "status": "updated", "draft_id": "...", "draft": {...} }`

### `GET /api/mail/drafts/{accountId}` — list

```json
{ "drafts": [ { "id": "MSG2", "to": [...], "subject": "Hi",
  "snippet": "...", "auto_saved_at": "...", "draft_reply_to": "" } ] }
```

### `POST /api/mail/auto-save` — upsert (UI auto-save; create or update)

Body: `account_id` (required), optional `draft_id` to update an existing
draft, plus any draft fields. Returns `{ status, draft_id, auto_saved_at }`.

### `DELETE /api/mail/draft/{draftId}` — discard

`{ "status": "deleted" }`

## 7. Sending

### `POST /api/mail/send`

Send a new mail or an existing draft.

```json
{ "account_id": "ACC1",
  "to": [ {"address":"alice@example.com"} ], "cc": [], "bcc": [],
  "subject": "Hello", "text_body": "...", "html_body": "<p>...</p>" }
```

Or send an existing draft: `{ "account_id": "ACC1", "message_id": "MSG2" }`.

Response: `{ "status": "sent", "message_id": "<rfc-message-id>" }`.

### `POST /api/mail/reply`

Reply to a message; builds the References chain and marks the original
answered.

```json
{ "original_message_id": "MSG1",
  "to": [ {"address":"alice@example.com"} ], "cc": [], "bcc": [],
  "subject": "Re: Hello",
  "text_body": "...", "html_body": "<p>...</p>" }
```

`subject` defaults to `Re: <original subject>`. Response:
`{ "status": "sent", "message_id": "...", "reply_record_id": "MSG3" }`.

### `POST /api/mail/schedule` — scheduled send ("send later")

Set, reschedule or cancel the delivery time of an existing draft. The draft
stays `is_draft=true` until due; a 1-minute cron (`mail_scheduled_send`) then
sends it through the same path as a manual send. Backed by `messages.scheduled_at`
(migration 048).

```json
{ "draft_id": "MSG7", "scheduled_at": "2026-07-20T09:00:00.000Z" }
```

`scheduled_at` is an ISO string (parsed server-side, stored normalised). Pass
`scheduled_at: null` (or `""`) to cancel and revert to a plain draft. Response:
`{ "status": "ok", "scheduled_at": "..." }`.

## 8. Mailbox actions

### `POST /api/mail/message/{id}/action`

Single endpoint for all message state changes.

```json
{ "action": "<action>", "folder_id": "...", "priority": "..." }
```

| action | effect | extra body |
|--------|--------|------------|
| `read` / `unread` | set `is_read` | — |
| `star` / `unstar` | set `is_starred` | — |
| `answered` / `unanswered` | set `is_answered` | — |
| `archive` | move to the account's `archive` folder | — |
| `trash` | move to `trash` | — |
| `spam` | move to `spam` | — |
| `inbox` | move to `inbox` | — |
| `move` | move to an arbitrary folder | `folder_id` (required) |
| `priority` | set priority | `priority`: low\|normal\|high |

Response: `{ "status": "ok", "action": "...", "message": { ...summary... } }`.

### `PATCH /api/mail/message-flags/{id}` — quick flag toggle

Body: `{ "is_read": true, "is_starred": false }` (either/both).
`{ "success": true }`. (Equivalent to `read`/`star` actions; used by the UI.)

### `DELETE /api/mail/message/{id}` — permanent delete

Removes the message record entirely. `{ "status": "deleted" }`
(`already_deleted: true` if it was gone).

## 9. AI mail-analysis agent (thread notes / "briefs")

The app has an AI agent that writes private personal notes about a
conversation (context, key points, decisions, pending items, next step).
One note per (user, thread), stored server-side. Notes are HTML
(`<p> <br> <strong> <em> <ul> <ol> <li>` only).

### `GET /api/mail/briefs` — list all notes (discovery)

```json
{ "briefs": [
  { "id": "BRF1", "thread_id": "abc", "snippet": "Contexte: ...",
    "message_count": 5, "last_message_date": "2026-05-18T09:00:00Z",
    "updated": "2026-05-18T09:05:00Z" }
] }
```

### `GET /api/mail/thread/{threadId}/brief` — read the note

```json
{ "brief": { "id": "BRF1", "thread_id": "abc",
  "content": "<p><strong>Contexte</strong> ...</p>",
  "message_count": 5, "last_message_id": "MSG9",
  "last_message_date": "...", "created": "...", "updated": "..." } }
```

`404` if no note exists yet for that thread.

### `POST /api/mail/thread/{threadId}/brief` — (re)generate the note

Runs the AI agent over the thread and stores the result.

```json
{ "language": "fr", "force": false }
```

- `language`: `fr` (default) | `en` | `de` | `it`.
- `force`: `false` (default) = incremental — only messages newer than the
  last analysed one are sent, with the previous note, and the agent updates
  it. `true` = recompute from the entire thread.

Response: `{ "status": "created|updated|unchanged", "brief": { ... } }`
(`unchanged` = nothing new since last generation).

### `DELETE /api/mail/thread/{threadId}/brief` — delete the note

`{ "status": "deleted" }` (`already_deleted: true` if none existed).

> The agent calls OpenRouter server-side; the server must have
> `OPENROUTER_API_KEY` configured (or the user must set their own
> `openrouter_api_key`), else `500`. Generation can take a few seconds.

## 9b. Thread context pack (one-shot for agents)

### `GET /api/mail/thread/{threadId}/context`

Returns the thread messages **and** the AI brief in a single call. Use this
instead of chaining `/thread/{id}` + `/thread/{id}/brief` when you only need
enough context to decide what to do.

```json
{ "thread_id": "abc", "message_count": 3,
  "messages": [ { "id": "MSG1", "from": {...}, "to": [...], "subject": "...",
                  "text_body": "...", "html_body": "<p>...</p>",
                  "date": "...", "is_read": true, ... } ],
  "brief": { "id": "BRF1", "content": "<p>...</p>", "message_count": 3,
             "last_message_id": "MSG3", "last_message_date": "...",
             "created": "...", "updated": "..." } }
```

`brief` is `null` if no note has been generated yet for this thread.

## 9c. Semantic memory (vector embeddings)

iMiel keeps a per-user vector index of every indexed message (local
`all-MiniLM-L6-v2`, 384-dim cosine). These endpoints expose it. `userId` is
**always** taken from the auth token — clients cannot pass another user.

### `POST /api/mail/search-semantic`

Vector search across the user's mail (metadata only, fast).

```json
{ "query": "invoice from Acme last quarter",
  "account_id": "ACC1",   // optional
  "limit": 8 }            // optional, default 8, max 50
```

Response: `{ "results": [ { "message_id": "MSG1", "score": 0.81,
"subject": "...", "from": "...", "date": "...", "snippet": "..." } ] }`.

### `POST /api/mail/search-context`

Same as above plus the full message bodies in the response — designed as
agent memory: feed the results straight to an LLM in one round-trip.

```json
{ "query": "what did Alice decide about the migration?",
  "account_id": "ACC1",
  "limit": 6 }
```

Response: `{ "results": [ { "message_id": "MSG1", "score": 0.79, "from": {...},
"subject": "...", "date": "...", "text_body": "...", "html_body": "..." } ] }`.

### `GET /api/mail/embeddings/status`

Indexing status (total messages, indexed count, model, backfill progress).
Use it to know if the semantic memory is ready before searching.

```json
{ "total": 1240, "indexed": 1184, "model": "all-MiniLM-L6-v2",
  "backfill": { "running": false, "processed": 1184, "total": 1240,
                "errors": 0, "started_at": "...", "finished_at": "..." } }
```

### `POST /api/mail/embeddings/backfill`

Trigger background indexing of the user's existing mail (catch up). Safe to
call repeatedly. `{ "started": true, "state": { ... } }`.

> Indexing also runs automatically as mail is synced — the backfill endpoint
> is only for catching up on existing mail or recovering after a wipe.

## 9d. Labels

Labels organise mail. Each message carries a `labels` array (label record ids).
Some labels are *secondary* (`is_secondary: true`): their messages are excluded
from the inbox listing.

### `GET /api/mail/label-counts?account_id=ACC1`

Unread/total counts per label for the sidebar.

```json
{ "items": [ { "id": "LBL1", "name": "Factures", "color": "#f59e0b",
  "is_secondary": false, "total": 42, "unread": 3 } ] }
```

### `GET /api/mail/thread/{threadId}/labels`

Effective labels of a conversation (with any thread-level overrides applied).

### `POST /api/mail/thread/{threadId}/label/{labelId}` — body `{ "mode": "included" | "excluded" }`

Force (`included`) or remove (`excluded`) a label for the whole thread,
overriding the per-message labels.

### `DELETE /api/mail/thread/{threadId}/label/{labelId}`

Clear the thread-level override for that label.

> Labels are created/assigned automatically by the AI categorizer at sync time
> (when enabled), and can also be managed manually through the standard
> `labels` PocketBase collection.

## 10. Sync

### `POST /api/mail/sync`

Trigger an immediate IMAP/POP3 sync for an account.

```json
{ "account_id": "ACC1" }
```

`{ "status": "sync_started" }` or `{ "status": "already_syncing" }`.

## 11. Calendar

Calendar data lives in PocketBase collections `calendar_groups` and
`calendar_events`; mutations are handled by the mail-worker so Google Calendar
can be updated when the group is linked to Google.

### `POST /calendar/sync/{accountId}`

Trigger Google Calendar sync for one account. The worker uses incremental
`sync_token` when available.

### `POST /calendar/event`

Create a calendar event.

```json
{ "group": "GRP1", "title": "Demo", "description": "", "location": "",
  "start": "2026-06-13T14:00:00.000Z",
  "end": "2026-06-13T15:00:00.000Z",
  "all_day": false,
  "reminders": [540, 180, 30] }
```

`reminders` is optional. Values are offsets in minutes before `start`.
An empty or missing list means worker defaults: 9h, 3h and 30min before start.

### `PATCH /calendar/event/{id}`

Partial update. Changing `start` or `reminders` resets `reminders_sent` so the
new reminders can fire.

### `DELETE /calendar/event/{id}`

Delete an event locally and, if applicable, in Google Calendar.

## 12. Push (optional)

- `POST /api/push/register` — body `{ endpoint, p256dh, auth_key, device_name }`
- `POST /api/push/unregister` — body `{ endpoint }`

Calendar reminders also use web push. Reminder payloads include:
`data.type = "calendar_reminder"`, `data.eventId`, and a hash URL
`/#/calendar?event=<id>`.

## 13. Typical agent workflow

1. `POST /api/collections/users/auth-with-password` → store `token`.
2. `GET /api/mail/accounts` → pick `account_id`.
3. `GET /api/mail/folders?account_id=…` → know folder ids/types.
4. `GET /api/mail/messages?account_id=…&folder_type=inbox&is_read=false`
   → list unread.
5. For each interesting thread, `GET /api/mail/thread/{threadId}/context`
   → messages + AI brief in one call. If the brief is missing or stale,
   `POST /api/mail/thread/{threadId}/brief` (incremental by default).
6. Optionally `POST /api/mail/search-context { query }` → recall past mail
   semantically (agent long-term memory).
7. `POST /api/mail/reply` or `POST /api/mail/draft` → respond.
8. `POST /api/mail/message/{id}/action {"action":"archive"}` → tidy up.

## 13b. WhatsApp and client-task detection — REMOVED

Both features were removed (migration `061_drop_whatsapp_and_task_suggestions`
drops `task_suggestions`, `whatsapp_accounts`, `whatsapp_chats`,
`whatsapp_messages`). Only the Beluga Build (HaikoDev) link remains:
`GET /tasks/config`, `GET /tasks/haikodev-projects`, `GET /tasks/link-suggestions`
(worker) and the `project_links` collection.

On deploy, the Baileys pairing state lived OUTSIDE the database in the Docker
volume `wa_state`: once the new worker is up, remove it by hand
(`docker volume ls | grep wa_state` then `docker volume rm <name>`).

## 14. PocketBase raw collections (advanced)

Beyond the custom endpoints above, standard PocketBase REST is available at
`/api/collections/{collection}/records` (filtered by access rules to the
authenticated user): `accounts`, `folders`, `messages`, `attachments`,
`labels`, `message_labels`, `thread_labels`, `filter_rules`, `contacts`,
`thread_briefs`, `mail_embeddings`, `calendar_groups`, `calendar_events`,
`push_tokens`. Prefer the custom endpoints — they enforce ownership and return
LLM-friendly shapes.


## Connectivity: API keys and online MCP connector

- `POST /worker/api-keys` (mail-worker `/api-keys`) — create a key. Header
  `Authorization: <PocketBase user token>`, body `{ "name": "...", "scope": "read" | "full" }`.
  Returns `{ key, id, name, scope, prefix }`; the full key `hkm_...` is shown
  ONCE (only its sha256 is stored, field `key_hash`, hidden).
- List / delete: PocketBase collection `api_keys` (owner rules; create/update
  are worker-only). A deleted key is refused on the next request.
- `POST /worker/mcp` — MCP Streamable HTTP, stateless, JSON responses.
  Header `Authorization: Bearer hkm_...`. A `read` key only lists read/search
  tools (writing tools are not registered); a `full` key lists all 26 tools of
  `backend/mail-worker/src/mcp-tools.ts`. Tools call this API with a short user
  token obtained by PocketBase impersonation (never superuser rights).
- A key unused for 30 days triggers ONE push (`inactive_notified_at`); any use
  resets the counter.

## Newsletter tags, statistics and weekly digest (mail-worker)

All routes take the PocketBase user token in `Authorization` (owner read from
the token, never from the body).

- `GET /worker/newsletters/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` — Paris days,
  inclusive (400 days max): `{ total, prevTotal, untagged, perDay[], tags[{tag,count,prevCount,delta}], rising[], series{granularity,tags,points} }`.
- `GET /worker/newsletters/tags` — tags already used (suggestions).
- `POST /worker/newsletters/tags/rename` `{ from, to }` — renames on every
  newsletter; a name equal to another existing tag MERGES both.
- `POST /worker/newsletters/digest/send` — sends the digest of the last full
  week now (still at most once per ISO week, `users.newsletter_digest_week`).
