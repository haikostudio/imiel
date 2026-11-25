import { describe, it, expect } from "vitest";
import { makeMessage } from "@/lib/hooks/__tests__/test-helpers";
import { mergeMailListPage } from "@/lib/mail-list-merge";
import type { Message } from "@/lib/pocketbase";

const byDateDesc = (a: Message, b: Message) =>
  new Date(b.date).getTime() - new Date(a.date).getTime();

const msg = (id: string, date: string, overrides: Partial<Message> = {}) =>
  makeMessage({ id, date, message_id: `<${id}@test.com>`, thread_id: id, ...overrides });

describe("mergeMailListPage", () => {
  it("garde la meme liste (identite) quand rien n'a change", () => {
    const prev = [msg("a", "2026-08-05T10:00:00Z"), msg("b", "2026-08-05T09:00:00Z")];
    const fresh = [msg("a", "2026-08-05T10:00:00Z"), msg("b", "2026-08-05T09:00:00Z")];

    const res = mergeMailListPage(prev, fresh, { complete: true, comparator: byDateDesc });

    expect(res.items).toBe(prev);
    expect(res.addedIds).toEqual([]);
    expect(res.removedIds).toEqual([]);
  });

  it("insere un nouveau mail en tete sans toucher aux autres lignes", () => {
    const a = msg("a", "2026-08-05T10:00:00Z");
    const prev = [a];
    const fresh = [msg("new", "2026-08-05T11:00:00Z"), msg("a", "2026-08-05T10:00:00Z")];

    const res = mergeMailListPage(prev, fresh, { complete: true, comparator: byDateDesc });

    expect(res.items.map((m) => m.id)).toEqual(["new", "a"]);
    expect(res.addedIds).toEqual(["new"]);
    // Ligne inchangee : meme objet, pas de redessin inutile
    expect(res.items[1]).toBe(a);
  });

  it("met a jour en place une ligne modifiee (lu/non lu)", () => {
    const prev = [msg("a", "2026-08-05T10:00:00Z", { is_read: false })];
    const fresh = [msg("a", "2026-08-05T10:00:00Z", { is_read: true })];

    const res = mergeMailListPage(prev, fresh, { complete: true, comparator: byDateDesc });

    expect(res.items).toHaveLength(1);
    expect(res.items[0].is_read).toBe(true);
    expect(res.addedIds).toEqual([]);
  });

  it("retire un mail disparu cote serveur", () => {
    const prev = [msg("a", "2026-08-05T10:00:00Z"), msg("b", "2026-08-05T09:00:00Z")];
    const fresh = [msg("a", "2026-08-05T10:00:00Z")];

    const res = mergeMailListPage(prev, fresh, { complete: true, comparator: byDateDesc });

    expect(res.items.map((m) => m.id)).toEqual(["a"]);
    expect(res.removedIds).toEqual(["b"]);
  });

  it("ne touche pas aux mails plus anciens que la page rafraichie", () => {
    // La page fraiche est pleine : elle ne couvre que les mails recents.
    const prev = [
      msg("a", "2026-08-05T10:00:00Z"),
      msg("vieux", "2026-01-01T10:00:00Z"),
    ];
    const fresh = [msg("a", "2026-08-05T10:00:00Z")];

    const res = mergeMailListPage(prev, fresh, { complete: false, comparator: byDateDesc });

    expect(res.items.map((m) => m.id)).toEqual(["a", "vieux"]);
    expect(res.removedIds).toEqual([]);
  });

  it("garde un mail a la date exacte de la derniere ligne rafraichie", () => {
    // Envoi en masse : plusieurs mails partagent la meme seconde. Celui qui
    // deborde sur la page suivante ne doit pas etre pris pour un mail supprime.
    const prev = [
      msg("a", "2026-08-05T10:00:00Z"),
      msg("b", "2026-08-05T09:00:00Z"),
      msg("c", "2026-08-05T09:00:00Z"),
    ];
    const fresh = [msg("a", "2026-08-05T10:00:00Z"), msg("b", "2026-08-05T09:00:00Z")];

    const res = mergeMailListPage(prev, fresh, { complete: false, comparator: byDateDesc });

    expect(res.items.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(res.removedIds).toEqual([]);
  });

  it("ne retire pas un message insere localement (brouillon en cours)", () => {
    const prev = [msg("draft1", "2026-08-05T12:00:00Z"), msg("a", "2026-08-05T10:00:00Z")];
    const fresh = [msg("a", "2026-08-05T10:00:00Z")];

    const res = mergeMailListPage(prev, fresh, {
      complete: true,
      comparator: byDateDesc,
      protectedIds: new Set(["draft1"]),
    });

    expect(res.items.map((m) => m.id)).toEqual(["draft1", "a"]);
    expect(res.removedIds).toEqual([]);
  });

  it("n'ajoute pas un message deja charge dans une autre page", () => {
    const prev = [msg("a", "2026-08-05T10:00:00Z")];
    const fresh = [msg("a", "2026-08-05T10:00:00Z"), msg("b", "2026-08-05T09:00:00Z")];

    const res = mergeMailListPage(prev, fresh, {
      complete: true,
      comparator: byDateDesc,
      skipIds: new Set(["b"]),
    });

    expect(res.items).toBe(prev);
  });

  it("vide la liste quand le serveur ne renvoie plus rien", () => {
    const prev = [msg("a", "2026-08-05T10:00:00Z")];

    const res = mergeMailListPage(prev, [], { complete: true, comparator: byDateDesc });

    expect(res.items).toEqual([]);
    expect(res.removedIds).toEqual(["a"]);
  });
});
