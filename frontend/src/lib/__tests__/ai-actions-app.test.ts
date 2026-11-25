import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pbMocks = vi.hoisted(() => {
  const col = () => ({
    getFullList: vi.fn(async () => [] as unknown[]),
    getFirstListItem: vi.fn(async () => ({ id: "f-trash" })),
    getOne: vi.fn(async () => ({ id: "m1", account: "a1" })),
    create: vi.fn(async (d: Record<string, unknown>) => ({ id: "new1", ...d })),
    update: vi.fn(async () => ({})),
    delete: vi.fn(async () => true),
  });
  return { accounts: col(), labels: col(), folders: col(), messages: col(), aiActions: col(), updateMessageViaWorker: vi.fn(async () => {}) };
});

vi.mock("@/lib/pocketbase", () => ({
  default: { send: vi.fn(), collection: () => pbMocks.aiActions, authStore: { record: null } },
  accounts: () => pbMocks.accounts,
  labels: () => pbMocks.labels,
  folders: () => pbMocks.folders,
  messages: () => pbMocks.messages,
  contacts: () => pbMocks.aiActions,
  calendarGroups: () => pbMocks.aiActions,
  trackingItems: () => pbMocks.aiActions,
  trackingEvents: () => pbMocks.aiActions,
  filterRules: () => pbMocks.aiActions,
  users: () => pbMocks.aiActions,
  getCurrentUserId: () => "u1",
  updateMessageViaWorker: pbMocks.updateMessageViaWorker,
  updateMessageFlags: vi.fn(),
  deleteMessageViaWorker: vi.fn(),
}));
vi.mock("@/lib/hooks/useAccounts", () => ({ loadAccounts: vi.fn(async () => {}) }));
vi.mock("@/lib/hooks/useLabels", () => ({ loadLabels: vi.fn(async () => {}) }));
vi.mock("@/lib/hooks/useNewsletterSources", () => ({ reloadNewsletterSources: vi.fn(async () => {}) }));
vi.mock("@/lib/hooks/useSettings", () => ({ applyUiScale: vi.fn(), blockSender: vi.fn(), unblockSender: vi.fn(), notifySettingsUpdated: vi.fn() }));
vi.mock("@/lib/mail-list-api", () => ({ clearMailListPageCache: vi.fn() }));
vi.mock("@/lib/stores/mail-store", () => ({
  useMailStore: { getState: () => ({ invalidateMessages: vi.fn(), invalidateFolders: vi.fn(), openCompose: vi.fn(), activeAccountId: null }) },
}));

import { executeAiAction, recordAiAction } from "@/lib/ai-actions";
import type { AccountCreatePayload, AiAction, MailActionPayload } from "@/lib/ai-actions-types";

const account: AccountCreatePayload = {
  provider: "infomaniak", providerName: "Infomaniak", oauth: "", email: "hello@voyage-example.com", display_name: "", label: "hello@voyage-example.com",
  imap_host: "mail.infomaniak.com", imap_port: 993, imap_security: "ssl", imap_username: "hello@voyage-example.com",
  smtp_host: "mail.infomaniak.com", smtp_port: 465, smtp_security: "ssl", smtp_username: "hello@voyage-example.com", password: "pw-123",
};
const act = (kind: AiAction["kind"], payload: AiAction["payload"]): AiAction => ({ id: "x", kind, groupId: "g", payload, status: "pending" });

function mockTest(ok: { imap: boolean; smtp: boolean }) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as { type: "imap" | "smtp" };
    return new Response(JSON.stringify(ok[body.type] ? { success: true } : { success: false, error: "AUTHENTICATIONFAILED" }));
  }));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("ajout de compte", () => {
  it("connexion refusee : rien n'est cree", async () => {
    mockTest({ imap: false, smtp: true });
    await expect(executeAiAction(act("account_create", account))).rejects.toThrow(/rien n'a ete cree/);
    expect(pbMocks.accounts.create).not.toHaveBeenCalled();
  });

  it("connexion verifiee : compte cree avec le meme mot de passe en IMAP et SMTP", async () => {
    mockTest({ imap: true, smtp: true });
    const res = await executeAiAction(act("account_create", account));
    expect(pbMocks.accounts.create).toHaveBeenCalledWith(expect.objectContaining({
      user: "u1", email: "hello@voyage-example.com", protocol: "imap", imap_password: "pw-123", smtp_password: "pw-123", is_active: true,
    }));
    expect(res.created).toEqual([{ type: "account", id: "new1" }]);
  });

  it("sans mot de passe : demande la saisie", async () => {
    await expect(executeAiAction(act("account_create", { ...account, password: "" }))).rejects.toThrow(/mot de passe requis/);
  });

  it("l'historique ne garde jamais le mot de passe", async () => {
    await recordAiAction(act("account_create", account), { created: [] });
    expect(JSON.stringify(pbMocks.aiActions.create.mock.calls[0][0])).not.toContain("pw-123");
  });
});

describe("gestes sur les mails", () => {
  it("corbeille : dossier corbeille du compte de chaque mail", async () => {
    const p: MailActionPayload = { op: "trash", messages: [{ id: "m1", thread_id: "t1", subject: "Hello", from: "A", date: "2026-11-01" }] };
    const res = await executeAiAction(act("mail_action", p));
    expect(pbMocks.folders.getFirstListItem).toHaveBeenCalledWith('account = "a1" && type = "trash"');
    expect(pbMocks.updateMessageViaWorker).toHaveBeenCalledWith("m1", { folder: "f-trash" });
    expect(res.label).toMatch(/1 mail/);
  });
});
