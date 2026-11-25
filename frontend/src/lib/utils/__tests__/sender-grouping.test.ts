import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/pocketbase";
import { buildThread } from "@/lib/hooks/useThreads";
import {
  applySenderGrouping,
  isSenderGrouped,
  mergeSendersIntoGroup,
  parseSenderGroups,
  removeSenderGroup,
  senderGroupAvatars,
  threadSenderAddress,
} from "../sender-grouping";

function msg(id: string, thread: string, from: string, date: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    thread_id: thread,
    from_address: { name: from.split("@")[0], address: from },
    date,
    subject: `Sujet ${thread}`,
    is_read: true,
    is_sent: false,
    ...extra,
  } as unknown as Message;
}

describe("groupes d'expediteurs", () => {
  it("garde les anciennes entrees a une adresse", () => {
    expect(parseSenderGroups(["a@x.com", "B@y.com"])).toEqual([["a@x.com"], ["b@y.com"]]);
    expect(isSenderGrouped(["a@x.com"], "A@x.com")).toBe(true);
  });

  it("reunit plusieurs adresses et absorbe un groupe existant", () => {
    const entries = mergeSendersIntoGroup(["old@x.com", "news@t.com"], ["info@t.com", "news@t.com"]);
    expect(entries).toEqual(["old@x.com", "news@t.com|info@t.com"]);
    expect(isSenderGrouped(entries, "info@t.com")).toBe(true);
  });

  it("defait le groupe entier", () => {
    expect(removeSenderGroup(["a@x.com", "n@t.com|i@t.com"], "i@t.com")).toEqual(["a@x.com"]);
  });

  it("fusionne les conversations de deux adresses en une ligne qui remonte", () => {
    const t1 = buildThread([msg("1", "t1", "news@t.com", "2026-09-01T10:00:00Z")], "t1");
    const t2 = buildThread([msg("2", "t2", "info@t.com", "2026-09-02T10:00:00Z")], "t2");
    const t3 = buildThread([msg("3", "t3", "autre@z.com", "2026-09-03T10:00:00Z")], "t3");
    const groups = ["news@t.com|info@t.com"];
    let out = applySenderGrouping([t1, t2, t3], groups, { unreadFirst: false });
    expect(out.map((t) => t.id)).toEqual(["t3", "sg:news@t.com"]);
    // Nouveau mail d'une des adresses : le groupe passe en tete.
    const t4 = buildThread([msg("4", "t4", "info@t.com", "2026-09-04T10:00:00Z")], "t4");
    out = applySenderGrouping([t1, t2, t3, t4], groups, { unreadFirst: false });
    expect(out[0].id).toBe("sg:news@t.com");
    expect(out[0].subject).toBe("info");
  });

  it("releve l'expediteur recu, pas la reponse de l'utilisateur", () => {
    const th = buildThread(
      [
        msg("1", "t", "client@c.com", "2026-09-01T10:00:00Z"),
        msg("2", "t", "moi@m.com", "2026-09-02T10:00:00Z", { is_sent: true }),
      ],
      "t"
    );
    expect(threadSenderAddress(th)).toBe("client@c.com");
  });
});

describe("senderGroupAvatars", () => {
  const me = new Set(["moi@x.com"]);

  it("rend les deux interlocuteurs les plus presents, sans l'utilisateur", () => {
    const t = buildThread(
      [
        msg("1", "a", "anne@a.com", "2026-01-01T10:00:00Z"),
        msg("2", "a", "moi@x.com", "2026-01-02T10:00:00Z"),
        msg("3", "b", "bob@a.com", "2026-01-03T10:00:00Z"),
        msg("4", "b", "anne@a.com", "2026-01-04T10:00:00Z"),
        msg("5", "c", "carl@a.com", "2026-01-05T10:00:00Z"),
        msg("6", "c", "autre@x.com", "2026-01-06T10:00:00Z", { is_sent: true }),
      ],
      "sg:anne@a.com"
    );
    expect(senderGroupAvatars(t, me).map((p) => p.address)).toEqual(["anne@a.com", "carl@a.com"]);
  });

  it("un seul avatar quand une seule personne est en face", () => {
    const t = buildThread(
      [
        msg("1", "a", "anne@a.com", "2026-01-01T10:00:00Z"),
        msg("2", "a", "MOI@x.com", "2026-01-02T10:00:00Z"),
      ],
      "sg:anne@a.com"
    );
    expect(senderGroupAvatars(t, me)).toEqual([{ name: "anne", address: "anne@a.com" }]);
  });

  it("ne double pas une personne qui ecrit depuis deux adresses", () => {
    const t = buildThread(
      [
        msg("1", "a", "paul@a.com", "2026-01-01T10:00:00Z", { from_address: { name: "Paul R", address: "paul@a.com" } } as Partial<Message>),
        msg("2", "b", "paul@b.ch", "2026-01-02T10:00:00Z", { from_address: { name: "Paul R", address: "paul@b.ch" } } as Partial<Message>),
      ],
      "sg:paul@a.com"
    );
    expect(senderGroupAvatars(t, me)).toHaveLength(1);
  });

  it("retombe sur l'adresse de tete du groupe sans autre auteur", () => {
    const t = buildThread([msg("1", "a", "moi@x.com", "2026-01-01T10:00:00Z")], "sg:anne@a.com");
    t.subject = "Anne";
    expect(senderGroupAvatars(t, me)).toEqual([{ name: "Anne", address: "anne@a.com" }]);
  });
});
