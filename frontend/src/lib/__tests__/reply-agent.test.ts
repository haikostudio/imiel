import { describe, expect, it } from "vitest";
import {
  addressNames,
  authorAddresses,
  formatThread,
  hasReplyAllExtra,
  isMine,
  lastReceivedMessage,
  messageAddressNames,
  ownMessageRecipients,
  parseSseBuffer,
  pickReplyTarget,
  replyAllRecipients,
  selectExchanges,
  stripQuoted,
  type ExchangeCandidate,
  type ThreadMessage,
} from "../reply-agent";

const ME = ["moi@studio.example.com", "moi@gmail.com"];

function msg(p: Partial<ExchangeCandidate> & { id: string }): ExchangeCandidate {
  return { subject: "s", date: "2026-01-01 10:00:00.000Z", text_body: "x", ...p };
}

describe("authorAddresses", () => {
  it("reprend les autres adresses d'une fiche contact au meme nom complet", () => {
    const addrs = authorAddresses(
      { name: "Jane Doe", address: "Jane@Acme.com" },
      [
        { name: "Jane Doe", email: "jane.doe@gmail.com" },
        { name: "jane  doe", email: "jd@perso.fr" },
        { name: "John Doe", email: "john@acme.com" },
      ],
      ME
    );
    expect(addrs.sort()).toEqual(["jane.doe@gmail.com", "jane@acme.com", "jd@perso.fr"]);
  });

  it("ignore un nom trop vague (un seul mot) et mes propres adresses", () => {
    const addrs = authorAddresses(
      { name: "Support", address: "support@shop.com" },
      [
        { name: "Support", email: "support@other.com" },
        { name: "Support", email: "moi@gmail.com" },
      ],
      ME
    );
    expect(addrs).toEqual(["support@shop.com"]);
  });
});

describe("selectExchanges", () => {
  const author = ["jane@acme.com", "jane.doe@gmail.com"];

  it("garde les deux sens, ecarte le reste, trie du plus recent et borne", () => {
    const list = [
      msg({ id: "a", from_address: { address: "jane@acme.com" }, date: "2026-01-02 10:00:00.000Z" }),
      msg({ id: "b", from_address: { address: "moi@gmail.com" }, to_addresses: [{ address: "Jane.Doe@gmail.com" }], date: "2026-01-05 10:00:00.000Z" }),
      msg({ id: "c", from_address: { address: "moi@gmail.com" }, to_addresses: [{ address: "autre@x.com" }], cc_addresses: [{ address: "jane@acme.com" }], date: "2026-01-04 10:00:00.000Z" }),
      msg({ id: "d", from_address: { address: "moi@gmail.com" }, to_addresses: [{ address: "autre@x.com" }] }),
      msg({ id: "e", from_address: { address: "inconnu@x.com" }, to_addresses: [{ address: "jane@acme.com" }] }),
      msg({ id: "f", from_address: { address: "jane@acme.com" }, is_draft: true }),
    ];
    const out = selectExchanges(list, author, ME, 20);
    expect(out.map((e) => [e.id, e.direction])).toEqual([
      ["b", "out"],
      ["c", "out"],
      ["a", "in"],
    ]);
    expect(selectExchanges(list, author, ME, 2).map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("ecarte les doublons d'un meme mail recu sur deux comptes relies", () => {
    const list = [
      msg({ id: "a1", message_id: "<m1@acme>", from_address: { address: "jane@acme.com" } }),
      msg({ id: "a2", message_id: "<m1@acme>", from_address: { address: "jane@acme.com" } }),
    ];
    expect(selectExchanges(list, author, ME)).toHaveLength(1);
  });

  it("limite par defaut a 20 echanges", () => {
    const list = Array.from({ length: 30 }, (_, i) =>
      msg({ id: `m${i}`, from_address: { address: "jane@acme.com" }, date: `2026-01-${String(i + 1).padStart(2, "0")} 10:00:00.000Z` })
    );
    const out = selectExchanges(list, author, ME);
    expect(out).toHaveLength(20);
    expect(out[0].id).toBe("m29");
  });
});

describe("stripQuoted", () => {
  it("coupe l'historique cite", () => {
    const text = "Merci, c'est parfait.\nA bientot\n\nLe 3 janv. 2026, Jane a écrit :\n> ancienne question";
    expect(stripQuoted(text)).toBe("Merci, c'est parfait.\nA bientot");
    expect(stripQuoted("Sure!\nOn Mon, Jan 5, 2026 Jane wrote:\n> hi")).toBe("Sure!");
  });
});

describe("parseSseBuffer", () => {
  it("rend les evenements complets et garde le morceau inacheve", () => {
    const buf =
      'data: {"type":"step","step":"collect","pct":5}\n\n' +
      'data: {"type":"done","html":"<p>Hi</p>","language":"en"}\n\n' +
      'data: {"type":"st';
    const { events, rest } = parseSseBuffer(buf);
    expect(events).toEqual([
      { type: "step", step: "collect", pct: 5 },
      { type: "done", html: "<p>Hi</p>", language: "en" },
    ]);
    expect(rest).toBe('data: {"type":"st');
    const next = parseSseBuffer(rest + 'ep","step":"write","pct":60}\n\n');
    expect(next.events).toEqual([{ type: "step", step: "write", pct: 60 }]);
    expect(next.rest).toBe("");
  });
});

describe("conversation : qui a ecrit quoi", () => {
  const apple = { name: "Jacky", address: "support@apple.com" };
  const me = { name: "Haiko", address: "moi@gmail.com" };
  const t = (p: Partial<ThreadMessage> & { id: string }): ThreadMessage => ({
    subject: "Assistance",
    text_body: "x",
    ...p,
  });

  it("isMine : envoye depuis l'app ou depuis une de mes adresses", () => {
    expect(isMine(t({ id: "a", from_address: { address: "moi@studio.example.com" } }), ME)).toBe(true);
    expect(isMine(t({ id: "b", is_sent: true, from_address: { address: "alias@ailleurs.fr" } }), ME)).toBe(true);
    expect(isMine(t({ id: "c", from_address: apple }), ME)).toBe(false);
  });

  it("dernier message a moi -> relance adressee a l'interlocuteur", () => {
    const target = pickReplyTarget(
      [
        t({ id: "1", from_address: me, to_addresses: [apple], date: "2026-10-01 09:00:00.000Z" }),
        t({ id: "2", from_address: apple, to_addresses: [me], date: "2026-10-02 09:00:00.000Z" }),
        t({ id: "3", from_address: me, to_addresses: [apple], date: "2026-10-03 09:00:00.000Z" }),
      ],
      ME
    );
    expect(target.mode).toBe("followup");
    expect(target.lastIncoming?.id).toBe("2");
    expect(target.lastMine?.id).toBe("3");
    expect(target.interlocutor?.address).toBe("support@apple.com");
  });

  it("dernier message recu -> reponse a son auteur", () => {
    const target = pickReplyTarget(
      [
        t({ id: "2", from_address: apple, to_addresses: [me], date: "2026-10-04 09:00:00.000Z" }),
        t({ id: "1", from_address: me, to_addresses: [apple], date: "2026-10-03 09:00:00.000Z" }),
      ],
      ME
    );
    expect(target.mode).toBe("reply");
    expect(target.last?.id).toBe("2");
    expect(target.interlocutor?.name).toBe("Jacky");
  });

  it("is_sent depuis une adresse hors comptes compte comme moi ; brouillons ignores", () => {
    const target = pickReplyTarget(
      [
        t({ id: "1", from_address: apple, date: "2026-10-01 09:00:00.000Z" }),
        t({ id: "2", is_sent: true, from_address: { address: "alias@ailleurs.fr" }, to_addresses: [apple], date: "2026-10-02 09:00:00.000Z" }),
        t({ id: "3", is_draft: true, from_address: apple, date: "2026-10-05 09:00:00.000Z" }),
      ],
      ME
    );
    expect(target.mode).toBe("followup");
    expect(target.last?.id).toBe("2");
  });

  it("premier envoi sans reponse : l'interlocuteur est le destinataire", () => {
    const target = pickReplyTarget(
      [t({ id: "1", from_address: me, to_addresses: [{ address: "moi@studio.example.com" }, apple], date: "2026-10-01 09:00:00.000Z" })],
      ME
    );
    expect(target.mode).toBe("followup");
    expect(target.lastIncoming).toBeNull();
    expect(target.interlocutor?.address).toBe("support@apple.com");
  });

  it("formatThread etiquette MOI / auteur, dedoublonne et garde les plus recents", () => {
    const msgs = [
      t({ id: "1", message_id: "<a>", from_address: apple, to_addresses: [me], date: "2026-10-01 09:00:00.000Z", text_body: "Votre demande est recue.\n\nLe 1 oct. a ecrit :\n> vieux" }),
      t({ id: "1b", message_id: "<a>", from_address: apple, to_addresses: [me], date: "2026-10-01 09:00:00.000Z" }),
      t({ id: "2", from_address: me, to_addresses: [apple], date: "2026-10-02 09:00:00.000Z", text_body: "Merci, j'attends le changement d'adresse." }),
    ];
    const out = formatThread(msgs, ME);
    expect(out.indexOf("Jacky -> MOI")).toBeLessThan(out.indexOf("MOI -> Jacky"));
    expect(out).not.toContain("vieux");
    expect(out.match(/Jacky -> MOI/g)).toHaveLength(1);
    const short = formatThread(msgs, ME, 60);
    expect(short).toContain("MOI -> Jacky");
    expect(short).not.toContain("Jacky -> MOI");
  });
});

describe("ownMessageRecipients", () => {
  it("vise les destinataires de mon message, sans moi, To puis Cc", () => {
    const r = ownMessageRecipients(
      {
        id: "1",
        from_address: { address: "moi@gmail.com" },
        to_addresses: [{ address: "Support@apple.com" }, { address: "moi@studio.example.com" }],
        cc_addresses: [{ address: "support@apple.com" }, { address: "chef@acme.com" }],
      },
      ME
    );
    expect(r).toEqual({ to: ["Support@apple.com"], cc: ["chef@acme.com"] });
  });

  it("envoye a moi seul : repli sur mon adresse", () => {
    const r = ownMessageRecipients(
      { id: "1", from_address: { address: "moi@gmail.com" }, to_addresses: [{ address: "moi@studio.example.com" }] },
      ME
    );
    expect(r).toEqual({ to: ["moi@gmail.com"], cc: [] });
  });
});

describe("replyAllRecipients", () => {
  const recu: ThreadMessage = {
    id: "r",
    from_address: { name: "Marie", address: "Marie@Acme.com" },
    to_addresses: [
      { address: "moi@studio.example.com" },
      { address: "paul@acme.com" },
      { address: "MOI@gmail.com" },
    ],
    cc_addresses: [{ address: "lea@acme.com" }, { address: "Paul@acme.com" }, { address: "moi@gmail.com" }],
  };

  it("auteur et autres A en A, copies en Cc, toutes mes adresses retirees", () => {
    expect(replyAllRecipients(recu, ME)).toEqual({
      to: ["Marie@Acme.com", "paul@acme.com"],
      cc: ["lea@acme.com"],
    });
  });

  it("une adresse en A et en Cc reste en A (casse ignoree)", () => {
    const r = replyAllRecipients(recu, ME);
    expect(r.cc.map((a) => a.toLowerCase())).not.toContain("paul@acme.com");
  });

  it("mon propre message : ses destinataires d'origine", () => {
    const mien: ThreadMessage = {
      id: "m",
      is_sent: true,
      from_address: { address: "moi@studio.example.com" },
      to_addresses: [{ address: "marie@acme.com" }],
      cc_addresses: [{ address: "lea@acme.com" }],
    };
    expect(replyAllRecipients(mien, ME)).toEqual({ to: ["marie@acme.com"], cc: ["lea@acme.com"] });
  });

  it("hasReplyAllExtra : faux quand seul l'auteur reste", () => {
    expect(hasReplyAllExtra(recu, ME)).toBe(true);
    expect(
      hasReplyAllExtra({ id: "x", from_address: { address: "a@b.c" }, to_addresses: [{ address: "moi@gmail.com" }] }, ME)
    ).toBe(false);
  });
});

describe("lastReceivedMessage", () => {
  const recu: ThreadMessage = { id: "1", date: "2026-01-01 10:00:00.000Z", from_address: { address: "marie@acme.com" } };
  const mien: ThreadMessage = { id: "2", date: "2026-01-02 10:00:00.000Z", is_sent: true, from_address: { address: "moi@gmail.com" } };
  const brouillon: ThreadMessage = { id: "3", date: "2026-01-03 10:00:00.000Z", is_draft: true, from_address: { address: "x@y.z" } };

  it("mon message est le dernier : vise le dernier recu", () => {
    expect(lastReceivedMessage([mien, recu, brouillon], ME)?.id).toBe("1");
  });

  it("aucun message recu : le dernier message (relance)", () => {
    const mien2 = { ...mien, id: "4", date: "2026-01-05 10:00:00.000Z" };
    expect(lastReceivedMessage([mien, mien2], ME)?.id).toBe("4");
  });

  it("fil vide : null", () => {
    expect(lastReceivedMessage([], ME)).toBeNull();
  });
});

describe("noms des destinataires pre-remplis", () => {
  it("cas Atelier : l'adresse admin porte le nom d'Olivier", () => {
    const m: ThreadMessage = {
      id: "nz7ecz53o641n2a",
      from_address: {
        name: "Olivier Girard - Coordinateur Plateforme Atelier60",
        address: "admin@atelier-example.ch",
      },
      to_addresses: [
        { name: "", address: "chrisdupont@gmail.com" },
        { name: "Paul Lefort", address: "paul.lefort@cabinet-example.com" },
      ],
      cc_addresses: [{ name: "Eva, Morel", address: "eva.morel@association-example.org" }],
    };
    const names = messageAddressNames(m);
    expect(names["admin@atelier-example.ch"]).toBe("Olivier Girard - Coordinateur Plateforme Atelier60");
    expect(names["paul.lefort@cabinet-example.com"]).toBe("Paul Lefort");
    // Une virgule dans le nom ne touche pas la valeur envoyee (adresses seules).
    expect(names["eva.morel@association-example.org"]).toBe("Eva, Morel");
    expect(names["chrisdupont@gmail.com"]).toBeUndefined();
    // Repondre et Repondre a tous : auteur + autres A en A, copie en Cc.
    expect(replyAllRecipients(m, ["chrisdupont@gmail.com"])).toEqual({
      to: ["admin@atelier-example.ch", "paul.lefort@cabinet-example.com"],
      cc: ["eva.morel@association-example.org"],
    });
  });

  it("ignore un nom vide, egal a l'adresse ou entre guillemets seuls", () => {
    expect(
      addressNames([
        { name: "paul@exemple.test", address: "paul@exemple.test" },
        { name: '"Lea Martin"', address: "lea@exemple.test" },
        { name: "  ", address: "marc@exemple.test" },
        null,
      ])
    ).toEqual({ "lea@exemple.test": "Lea Martin" });
  });
});
