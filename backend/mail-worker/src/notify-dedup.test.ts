import { beforeEach, describe, expect, it, vi } from "vitest";

// Copies d'un meme mail chez l'utilisateur, servies par la lecture SQLite.
let sqliteCopies: Array<{ id: string; account: string; created: string }> | null = [];
let sqliteThrows = false;
let lastVariants: string[] = [];

vi.mock("./sqlite-direct", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sqlite-direct")>();
  return {
    ...actual,
    listMessageCopiesForUserFromSqlite: vi.fn((_userId: string, variants: string[]) => {
      lastVariants = variants;
      if (sqliteThrows) throw new Error("db locked");
      return sqliteCopies;
    }),
  };
});

import { isLaterCopyOnOtherAccount, messageIdVariants } from "./notify-dedup";
import { isLaterCopyOfMailOnOtherAccount } from "./pocketbase";

describe("messageIdVariants", () => {
  it("couvre avec/sans chevrons et la casse", () => {
    const v = messageIdVariants(" <AbC@Mail.com> ");
    expect(v).toEqual(
      expect.arrayContaining(["<AbC@Mail.com>", "AbC@Mail.com", "<abc@mail.com>", "abc@mail.com"])
    );
    expect(v).toHaveLength(4);
  });
  it("Message-ID vide -> aucune variante", () => {
    expect(messageIdVariants("")).toEqual([]);
    expect(messageIdVariants(undefined)).toEqual([]);
    expect(messageIdVariants("<>")).toEqual([]);
  });
});

describe("isLaterCopyOnOtherAccount", () => {
  const salut = { id: "m1", account: "salut", created: "2026-10-06 10:00:00.000Z" };
  const gmail = { id: "m2", account: "gmail", created: "2026-10-06 10:25:00.000Z" };

  it("la copie tardive sur un autre compte ne notifie pas", () => {
    expect(isLaterCopyOnOtherAccount("m2", [salut, gmail])).toBe(true);
  });
  it("la premiere copie notifie", () => {
    expect(isLaterCopyOnOtherAccount("m1", [salut, gmail])).toBe(false);
  });
  it("une seule copie notifie", () => {
    expect(isLaterCopyOnOtherAccount("m1", [salut])).toBe(false);
  });
  it("meme compte : comportement inchange (pas de garde)", () => {
    const same = { ...gmail, account: "salut" };
    expect(isLaterCopyOnOtherAccount("m2", [salut, same])).toBe(false);
  });
  it("copies simultanees : exactement une notifie (id a egalite)", () => {
    const a = { id: "aaa", account: "x", created: "2026-10-06 10:00:00.000Z" };
    const b = { id: "bbb", account: "y", created: "2026-10-06 10:00:00.000Z" };
    const notified = [a, b].filter((c) => !isLaterCopyOnOtherAccount(c.id, [a, b]));
    expect(notified.map((c) => c.id)).toEqual(["aaa"]);
  });
  it("trois comptes : seule la plus ancienne notifie", () => {
    const rezideo = { id: "m0", account: "rezideo", created: "2026-10-06 09:59:59.000Z" };
    const all = [salut, gmail, rezideo];
    expect(all.filter((c) => !isLaterCopyOnOtherAccount(c.id, all)).map((c) => c.id)).toEqual(["m0"]);
  });
  it("self introuvable -> on notifie", () => {
    expect(isLaterCopyOnOtherAccount("absent", [salut, gmail])).toBe(false);
  });
});

describe("isLaterCopyOfMailOnOtherAccount", () => {
  beforeEach(() => {
    sqliteThrows = false;
    sqliteCopies = [
      { id: "m1", account: "salut", created: "2026-10-06 10:00:00.000Z" },
      { id: "m2", account: "gmail", created: "2026-10-06 10:25:00.000Z" },
    ];
  });

  it("detecte la copie tardive via la base", async () => {
    expect(await isLaterCopyOfMailOnOtherAccount("u1", "m2", "<x@y>")).toBe(true);
    expect(lastVariants).toContain("<x@y>");
    expect(await isLaterCopyOfMailOnOtherAccount("u1", "m1", "<x@y>")).toBe(false);
  });
  it("Message-ID vide -> notifie sans interroger", async () => {
    lastVariants = ["sentinel"];
    expect(await isLaterCopyOfMailOnOtherAccount("u1", "m2", "")).toBe(false);
    expect(lastVariants).toEqual(["sentinel"]);
  });
  it("erreur de lecture -> notifie", async () => {
    sqliteThrows = true;
    expect(await isLaterCopyOfMailOnOtherAccount("u1", "m2", "<x@y>")).toBe(false);
  });
});
