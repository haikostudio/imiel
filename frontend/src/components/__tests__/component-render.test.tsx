/**
 * Tests de rendu des composants.
 *
 * Ces tests verifient que chaque composant se monte sans erreur runtime.
 * C'est exactement ce type de test qui aurait detecté le bug TipTap
 * (immediatelyRender manquant dans ComposeEditor).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

// --- Mocks globaux ---

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/mail/inbox",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock next/link
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// Mock hash-router
vi.mock("@/lib/hash-router", () => ({
  HashLink: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useHashRouter: () => ({
    pathname: "/mail/inbox",
    params: { folder: "inbox" },
    route: "mail",
    search: "",
    navigate: vi.fn(),
  }),
}));

// Mock PocketBase
vi.mock("@/lib/pocketbase", () => {
  const mockCollection = () => ({
    getFullList: vi.fn().mockResolvedValue([]),
    getList: vi.fn().mockResolvedValue({ items: [], totalPages: 0 }),
    getOne: vi.fn().mockResolvedValue({}),
    getFirstListItem: vi.fn().mockResolvedValue({ id: "folder1" }),
    create: vi.fn().mockResolvedValue({ id: "new1" }),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(() => {}),
  });

  return {
    default: {
      collection: mockCollection,
      authStore: { isValid: true, record: { id: "user1" } },
      autoCancellation: vi.fn(),
      files: { getURL: vi.fn().mockReturnValue("") },
    },
    accounts: mockCollection,
    folders: mockCollection,
    messages: mockCollection,
    labels: mockCollection,
    pushTokens: mockCollection,
    users: mockCollection,
    isAuthenticated: vi.fn().mockReturnValue(true),
    getCurrentUserId: vi.fn().mockReturnValue("user1"),
    login: vi.fn(),
    logout: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    getFileUrl: vi.fn().mockReturnValue(""),
    subscribeWithRetry: (fn: () => Promise<() => void>) => {
      fn().catch(() => {});
      return () => {};
    },
    contacts: mockCollection,
  };
});

// Mock sonner
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  Toaster: () => null,
}));

// --- Imports des composants (apres les mocks) ---
import { ComposeEditor } from "@/components/mail/ComposeEditor";
import { ComposeDialog } from "@/components/mail/ComposeDialog";
import { MessageRow } from "@/components/mail/MessageRow";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { FolderNav } from "@/components/layout/FolderNav";
import { AccountSwitcher } from "@/components/layout/AccountSwitcher";
import { SearchCommand } from "@/components/mail/SearchCommand";
import { useMailStore } from "@/lib/stores/mail-store";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import type { Message } from "@/lib/pocketbase";

// --- Fixtures ---

function makeMessage(overrides: Partial<Message> = {}): Message {
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

// --- Wrapper avec providers ---

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

function renderWithProviders(ui: React.ReactElement, options?: RenderOptions) {
  return render(ui, { wrapper: Wrapper, ...options });
}

// --- Reset store avant chaque test ---

beforeEach(() => {
  useMailStore.setState({
    activeAccountId: "acc1",
    activeFolderIds: ["folder1"],
    activeFolder: "inbox",
    selectedMessageId: null,
    selectedThreadId: null,
    searchQuery: "",
    searchOpen: false,
    composeInstances: [],
    focusedComposeId: null,
    sidebarCollapsed: false,
  });
});

// =============================================================
// Tests de rendu
// =============================================================

describe("ComposeEditor", () => {
  it("se monte sans erreur", () => {
    const { container } = render(<ComposeEditor />);
    expect(container).toBeTruthy();
  });

  it("se monte avec du contenu initial", () => {
    const { container } = render(
      <ComposeEditor content="<p>Hello</p>" />
    );
    expect(container).toBeTruthy();
  });

  it("se monte avec un placeholder custom", () => {
    const { container } = render(
      <ComposeEditor placeholder="Tapez ici..." />
    );
    expect(container).toBeTruthy();
  });

  it("se monte avec un callback onChange", () => {
    const onChange = vi.fn();
    const { container } = render(<ComposeEditor onChange={onChange} />);
    expect(container).toBeTruthy();
  });
});

describe("ComposeDialog", () => {
  it("se monte sans erreur (ferme)", () => {
    const { container } = render(<ComposeDialog />);
    expect(container).toBeTruthy();
  });

  it("se monte avec une instance ouverte", () => {
    useMailStore.getState().openCompose("new");
    const { container } = renderWithProviders(<ComposeDialog />);
    expect(container).toBeTruthy();
  });

  it("ouvre la bande d'en-tete depliee (champs visibles, resume replie)", () => {
    useMailStore.getState().openCompose("new");
    renderWithProviders(<ComposeDialog />);
    const header = document.querySelector('[data-ref="compose-form-header"]');
    expect(header?.getAttribute("data-collapsed")).toBe("false");
    expect(document.querySelector('[data-ref="compose-form-subject"]')).toBeTruthy();
    expect(document.querySelector('[data-ref="compose-form-header-summary"]')).toBeTruthy();
  });

  it("affiche le bon titre pour chaque mode", () => {
    useMailStore.getState().openCompose("reply", "msg1");
    renderWithProviders(<ComposeDialog />);
    expect(screen.getByText("Repondre")).toBeTruthy();
  });

  it("affiche 'Transferer' en mode forward", () => {
    useMailStore.getState().openCompose("forward", "msg1");
    renderWithProviders(<ComposeDialog />);
    expect(screen.getByText("Transferer")).toBeTruthy();
  });

  it("affiche 'Repondre a tous' en mode reply-all", () => {
    useMailStore.getState().openCompose("reply-all", "msg1");
    renderWithProviders(<ComposeDialog />);
    expect(screen.getByText("Repondre a tous")).toBeTruthy();
  });
});

describe("MessageRow", () => {
  const defaultProps = {
    message: makeMessage(),
    selected: false,
    checked: false,
    onSelect: vi.fn(),
    onCheck: vi.fn(),
    onStar: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onMarkRead: vi.fn(),
  };

  it("se monte sans erreur", () => {
    renderWithProviders(<MessageRow {...defaultProps} />);
    expect(screen.getByText("Alice Dupont")).toBeTruthy();
    expect(screen.getByText("Sujet de test")).toBeTruthy();
  });

  it("affiche le point non-lu pour les messages non lus", () => {
    renderWithProviders(<MessageRow {...defaultProps} />);
    const dot = document.querySelector('[data-ref="message-row-unread-dot"]');
    expect(dot).toBeTruthy();
  });

  it("n'affiche pas le point non-lu pour les messages lus", () => {
    renderWithProviders(
      <MessageRow
        {...defaultProps}
        message={makeMessage({ is_read: true })}
      />
    );
    const dot = document.querySelector('[data-ref="message-row-unread-dot"]');
    expect(dot).toBeNull();
  });

  it("affiche le badge de compte quand showAccountBadge est true", () => {
    renderWithProviders(
      <MessageRow
        {...defaultProps}
        showAccountBadge
        accountName="Perso"
      />
    );
    expect(screen.getByText("Perso")).toBeTruthy();
  });

  it("affiche '(Sans objet)' si pas de sujet", () => {
    renderWithProviders(
      <MessageRow
        {...defaultProps}
        message={makeMessage({ subject: "" })}
      />
    );
    expect(screen.getByText("(Sans objet)")).toBeTruthy();
  });

  it("appelle onSelect au clic", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<MessageRow {...defaultProps} onSelect={onSelect} />);

    await user.click(screen.getByRole("row"));
    expect(onSelect).toHaveBeenCalledWith("msg1", "t1");
  });

  it("appelle onCheck au clic sur la checkbox", async () => {
    const onCheck = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<MessageRow {...defaultProps} onCheck={onCheck} />);

    const checkbox = screen.getByRole("checkbox");
    await user.click(checkbox);
    expect(onCheck).toHaveBeenCalledWith("msg1", true);
  });
});

describe("Header", () => {
  it("se monte sans erreur", () => {
    const { container } = renderWithProviders(<Header />);
    expect(container).toBeTruthy();
  });

  it("affiche le bouton de recherche", () => {
    renderWithProviders(<Header />);
    const btn = document.querySelector('[data-ref="header-search"]');
    expect(btn).toBeTruthy();
  });

  it("affiche le bouton menu mobile", () => {
    renderWithProviders(<Header />);
    const btn = document.querySelector('[data-ref="header-mobile-menu"]');
    expect(btn).toBeTruthy();
  });
});

describe("Sidebar", () => {
  it("se monte sans erreur", () => {
    renderWithProviders(<Sidebar />);
    expect(screen.getByText("Nouveau message")).toBeTruthy();
  });

  it("affiche les labels (apparence Minimaliste)", () => {
    useSettingsStore.setState({ design: "minimal" });
    try {
      renderWithProviders(<Sidebar />);
      expect(screen.getByText("Labels")).toBeTruthy();
    } finally {
      useSettingsStore.setState({ design: "miel" });
    }
  });

  it("n'affiche pas les labels en apparence Miel (ils passent dans le filtre de la liste)", () => {
    useSettingsStore.setState({ design: "miel" });
    renderWithProviders(<Sidebar />);
    expect(screen.queryByText("Labels")).toBeNull();
  });

  it("ouvre le compose au clic sur Nouveau message", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Sidebar />);

    await user.click(screen.getByText("Nouveau message"));
    expect(useMailStore.getState().composeInstances).toHaveLength(1);
  });
});

describe("FolderNav", () => {
  it("se monte sans erreur", () => {
    renderWithProviders(<FolderNav />);
    expect(screen.getByText("Boite de reception")).toBeTruthy();
    expect(screen.getByText("Envoyes")).toBeTruthy();
    expect(screen.getByText("Brouillons")).toBeTruthy();
    expect(screen.getByText("Corbeille")).toBeTruthy();
    expect(screen.getByText("Spam")).toBeTruthy();
    expect(screen.getByText("Tous les messages")).toBeTruthy();
  });

  it("affiche le lien Favoris", () => {
    renderWithProviders(<FolderNav />);
    expect(screen.getByText("Favoris")).toBeTruthy();
  });
});

describe("AccountSwitcher", () => {
  it("se monte sans erreur", () => {
    renderWithProviders(<AccountSwitcher />);
    const label = document.querySelector(
      '[data-ref="sidebar-account-switcher-label"]'
    );
    expect(label).toBeTruthy();
  });
});

describe("SearchCommand", () => {
  it("se monte sans erreur (ferme)", () => {
    const { container } = renderWithProviders(<SearchCommand />);
    expect(container).toBeTruthy();
  });

  it("se monte avec searchOpen=true", () => {
    useMailStore.setState({ searchOpen: true });
    renderWithProviders(<SearchCommand />);
    const input = document.querySelector('[data-ref="search-input"]');
    expect(input).toBeTruthy();
  });
});
