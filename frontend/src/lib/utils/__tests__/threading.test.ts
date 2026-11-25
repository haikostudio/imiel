import { describe, it, expect } from "vitest";
import {
  calculateThreadId,
  groupMessagesByThread,
  normalizeSubject,
  isSameThread,
} from "../threading";
import type { Message } from "@/lib/pocketbase";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg1",
    collectionId: "",
    collectionName: "messages",
    created: "",
    updated: "",
    account: "acc1",
    folder: "folder1",
    message_id: "<msg1@example.com>",
    in_reply_to: "",
    references: [],
    thread_id: "",
    from_address: { name: "Alice", address: "alice@example.com" },
    to_addresses: [{ name: "Bob", address: "bob@example.com" }],
    cc_addresses: [],
    bcc_addresses: [],
    subject: "Test Subject",
    text_body: "Hello",
    html_body: "<p>Hello</p>",
    snippet: "Hello",
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

describe("calculateThreadId", () => {
  it("utilise thread_id s'il est defini", () => {
    const msg = makeMessage({ thread_id: "existing-thread" });
    expect(calculateThreadId(msg)).toBe("existing-thread");
  });

  it("utilise la premiere reference si disponible", () => {
    const msg = makeMessage({
      thread_id: "",
      references: ["<root@example.com>", "<reply@example.com>"],
    });
    expect(calculateThreadId(msg)).toBe("<root@example.com>");
  });

  it("utilise in_reply_to si pas de references", () => {
    const msg = makeMessage({
      thread_id: "",
      references: [],
      in_reply_to: "<parent@example.com>",
    });
    expect(calculateThreadId(msg)).toBe("<parent@example.com>");
  });

  it("utilise message_id si rien d'autre n'est disponible", () => {
    const msg = makeMessage({
      thread_id: "",
      references: [],
      in_reply_to: "",
      message_id: "<unique@example.com>",
    });
    expect(calculateThreadId(msg)).toBe("<unique@example.com>");
  });
});

describe("groupMessagesByThread", () => {
  it("regroupe les messages par thread_id", () => {
    const msgs = [
      makeMessage({
        id: "a",
        thread_id: "t1",
        date: "2025-06-15T10:00:00Z",
      }),
      makeMessage({
        id: "b",
        thread_id: "t1",
        date: "2025-06-15T11:00:00Z",
      }),
      makeMessage({
        id: "c",
        thread_id: "t2",
        subject: "Different Subject",
        date: "2025-06-15T12:00:00Z",
      }),
    ];
    const groups = groupMessagesByThread(msgs);

    expect(Object.keys(groups)).toHaveLength(2);
    expect(groups["t1"]).toHaveLength(2);
    expect(groups["t2"]).toHaveLength(1);
  });

  it("trie les messages par date ASC dans chaque thread", () => {
    const msgs = [
      makeMessage({
        id: "b",
        thread_id: "t1",
        date: "2025-06-15T11:00:00Z",
      }),
      makeMessage({
        id: "a",
        thread_id: "t1",
        date: "2025-06-15T09:00:00Z",
      }),
    ];
    const groups = groupMessagesByThread(msgs);

    expect(groups["t1"][0].id).toBe("a");
    expect(groups["t1"][1].id).toBe("b");
  });

  it("retourne un objet vide pour un tableau vide", () => {
    expect(groupMessagesByThread([])).toEqual({});
  });
});

describe("normalizeSubject", () => {
  it("supprime le prefixe Re:", () => {
    expect(normalizeSubject("Re: Hello")).toBe("Hello");
  });

  it("supprime le prefixe Fwd:", () => {
    expect(normalizeSubject("Fwd: Hello")).toBe("Hello");
  });

  it("supprime le prefixe Fw:", () => {
    expect(normalizeSubject("Fw: Hello")).toBe("Hello");
  });

  it("supprime le prefixe Tr:", () => {
    expect(normalizeSubject("Tr: Bonjour")).toBe("Bonjour");
  });

  it("supprime le prefixe Rep:", () => {
    expect(normalizeSubject("Rép: Bonjour")).toBe("Bonjour");
  });

  it("est insensible a la casse", () => {
    expect(normalizeSubject("RE: Hello")).toBe("Hello");
    expect(normalizeSubject("re: Hello")).toBe("Hello");
    expect(normalizeSubject("FWD: Hello")).toBe("Hello");
  });

  it("ne modifie pas un sujet sans prefixe", () => {
    expect(normalizeSubject("Hello World")).toBe("Hello World");
  });

  it("gere une chaine vide", () => {
    expect(normalizeSubject("")).toBe("");
  });
});

describe("isSameThread", () => {
  it("retourne true si meme thread_id", () => {
    const a = makeMessage({ thread_id: "t1" });
    const b = makeMessage({ thread_id: "t1" });
    expect(isSameThread(a, b)).toBe(true);
  });

  it("retourne false si thread_id et sujets differents", () => {
    const a = makeMessage({ thread_id: "t1", subject: "A" });
    const b = makeMessage({ thread_id: "t2", subject: "B" });
    expect(isSameThread(a, b)).toBe(false);
  });

  it("retourne true si meme sujet normalise et participants communs", () => {
    const a = makeMessage({
      message_id: "<a@test>",
      thread_id: "",
      references: [],
      in_reply_to: "",
      subject: "Re: Hello",
      from_address: { name: "Alice", address: "alice@test.com" },
      to_addresses: [{ address: "bob@test.com" }],
    });
    const b = makeMessage({
      message_id: "<b@test>",
      thread_id: "",
      references: [],
      in_reply_to: "",
      subject: "Hello",
      from_address: { name: "Bob", address: "bob@test.com" },
      to_addresses: [{ address: "alice@test.com" }],
    });
    expect(isSameThread(a, b)).toBe(true);
  });

  it("retourne false si meme sujet mais pas de participants communs", () => {
    const a = makeMessage({
      message_id: "<a@test>",
      thread_id: "",
      references: [],
      in_reply_to: "",
      subject: "Hello",
      from_address: { address: "alice@test.com" },
      to_addresses: [{ address: "bob@test.com" }],
    });
    const b = makeMessage({
      message_id: "<b@test>",
      thread_id: "",
      references: [],
      in_reply_to: "",
      subject: "Hello",
      from_address: { address: "charlie@test.com" },
      to_addresses: [{ address: "dave@test.com" }],
    });
    expect(isSameThread(a, b)).toBe(false);
  });
});
