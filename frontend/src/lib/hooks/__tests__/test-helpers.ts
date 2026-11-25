import { vi } from "vitest";
import type { Message, Account, Folder } from "@/lib/pocketbase";

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg1",
    collectionId: "messages",
    collectionName: "messages",
    created: "2025-06-15T10:00:00Z",
    updated: "2025-06-15T10:00:00Z",
    account: "acc1",
    folder: "folder1",
    message_id: "<msg1@test.com>",
    in_reply_to: "",
    references: [],
    thread_id: "t1",
    from_address: { name: "Alice Dupont", address: "alice@test.com" },
    to_addresses: [{ name: "Bob Martin", address: "bob@test.com" }],
    cc_addresses: [],
    bcc_addresses: [],
    subject: "Sujet de test",
    text_body: "Corps du message",
    html_body: "<p>Corps du message</p>",
    snippet: "Corps du message",
    date: "2025-06-15T10:00:00Z",
    is_read: false,
    is_starred: false,
    is_answered: false,
    is_draft: false,
    is_sent: false,
    has_attachments: false,
    priority: "normal",
    labels: [],
    uid: 1,
    attachments: [],
    draft_reply_to: "",
    auto_saved_at: "",
    ...overrides,
  } as Message;
}

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc1",
    collectionId: "accounts",
    collectionName: "accounts",
    created: "2025-06-15T10:00:00Z",
    updated: "2025-06-15T10:00:00Z",
    user: "user1",
    label: "Perso",
    email: "alice@test.com",
    display_name: "Alice Dupont",
    protocol: "imap" as const,
    imap_host: "imap.test.com",
    imap_port: 993,
    imap_security: "ssl" as const,
    imap_username: "alice",
    imap_password: "pass",
    smtp_host: "smtp.test.com",
    smtp_port: 587,
    smtp_security: "starttls" as const,
    smtp_username: "alice",
    smtp_password: "pass",
    check_interval: 5,
    signature: "-- Cordialement",
    sync_status: "idle" as const,
    sync_error: "",
    last_synced_at: "2025-06-15T10:00:00Z",
    is_active: true,
    ...overrides,
  } as Account;
}

export function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: "folder1",
    collectionId: "folders",
    collectionName: "folders",
    created: "2025-06-15T10:00:00Z",
    updated: "2025-06-15T10:00:00Z",
    account: "acc1",
    name: "Inbox",
    path: "INBOX",
    type: "inbox" as const,
    unread_count: 5,
    total_count: 100,
    sort_order: 0,
    ...overrides,
  } as Folder;
}

export function createMockCollection() {
  return {
    getFullList: vi.fn().mockResolvedValue([]),
    getList: vi.fn().mockResolvedValue({ items: [], totalPages: 0, totalItems: 0 }),
    getOne: vi.fn().mockResolvedValue({}),
    getFirstListItem: vi.fn().mockResolvedValue({ id: "folder1" }),
    create: vi.fn().mockResolvedValue({ id: "new1" }),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(() => {}),
  };
}
