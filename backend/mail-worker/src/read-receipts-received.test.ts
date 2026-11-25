import { beforeEach, describe, expect, it, vi } from "vitest";

// Base simulee : une liste d'evenements en memoire.
const store: { kind: string; message: string; recipient: string }[] = [];

vi.mock("./pocketbase", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./pocketbase")>();
  return {
    ...orig,
    getMessage: vi.fn(async (id: string) => ({
      id,
      account: "acc1",
      // Envoye il y a une heure : seule la signature du scanner compte.
      date: new Date(Date.now() - 3600_000).toISOString(),
      to_addresses: [{ name: "Paul", address: "paul@example.com" }],
      cc_addresses: [],
      bcc_addresses: [],
    })),
    getAccount: vi.fn(async () => ({ id: "acc1", user: "u1" })),
    getLastOpenReceipt: vi.fn(async (message: string) =>
      store.find((r) => r.kind === "opened" && r.message === message) ? { date: new Date(0).toISOString() } : null
    ),
    hasReceivedReceipt: vi.fn(async (message: string, recipient?: string) =>
      store.some((r) => r.kind === "received" && r.message === message && r.recipient === (recipient || ""))
    ),
    createReadReceipt: vi.fn(async (data: { kind: string; message: string; recipient?: string }) => {
      store.push({ kind: data.kind, message: data.message, recipient: data.recipient || "" });
      return null;
    }),
  };
});

import { recordOpenReceipt } from "./read-receipts";

const SCANNER_UA =
  "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy) Chrome/42.0.2311.135";
const READER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

describe("scan de livraison = reception", () => {
  beforeEach(() => {
    store.length = 0;
  });

  it("un scan cree UN seul \"received\", puis une vraie lecture cree un \"opened\"", async () => {
    await recordOpenReceipt({ messageId: "m1", userAgent: SCANNER_UA, ip: "74.125.0.1" });
    await recordOpenReceipt({ messageId: "m1", userAgent: SCANNER_UA, ip: "74.125.0.2" });
    expect(store.filter((r) => r.kind === "received")).toHaveLength(1);
    expect(store.filter((r) => r.kind === "opened")).toHaveLength(0);

    await recordOpenReceipt({ messageId: "m1", userAgent: READER_UA, ip: "1.2.3.4" });
    expect(store.filter((r) => r.kind === "opened")).toHaveLength(1);
    expect(store.filter((r) => r.kind === "received")).toHaveLength(1);
  });
});
