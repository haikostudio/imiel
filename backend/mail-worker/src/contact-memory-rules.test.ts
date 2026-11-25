import { describe, expect, it } from "vitest";
import {
  canonAddr,
  directionWith,
  isAutomatedAddress,
  isRealExchange,
  mailsAfter,
  mergeMemory,
  normalizeAiMemory,
  relatedParticipants,
  selectPersonMails,
  type ContactMemoryData,
  type MemoryMail,
} from "./contact-memory-rules";

const ME = new Set(["chrisdupont@gmail.com", "contact@studio.example.com"]);
const OLIVIER = new Set(["admin@atelier-example.ch"]);

function mail(p: Partial<MemoryMail>): MemoryMail {
  return {
    id: p.id || Math.random().toString(36).slice(2),
    message_id: p.message_id ?? "",
    thread_id: "t",
    subject: "s",
    date: "2026-10-01 10:00:00.000Z",
    from: null,
    to: [],
    cc: [],
    is_sent: false,
    folder_type: "inbox",
    bulk: false,
    secondary: false,
    text: "",
    ...p,
  };
}

describe("canonAddr / automates", () => {
  it("retire l'etiquette + et la casse", () => {
    expect(canonAddr(" ChrisDupont+candidat@Gmail.com ")).toBe("chrisdupont@gmail.com");
  });
  it("reconnait les automates", () => {
    expect(isAutomatedAddress("no-reply@sncf.fr")).toBe(true);
    expect(isAutomatedAddress("notifications@github.com")).toBe(true);
    expect(isAutomatedAddress("paul.lefort@cabinet-example.com")).toBe(false);
    expect(isAutomatedAddress("admin@atelier-example.ch")).toBe(false);
  });
});

describe("isRealExchange", () => {
  it("garde mes mails et les mails humains", () => {
    expect(isRealExchange(mail({ from: { address: "chrisdupont@gmail.com" } }), ME)).toBe(true);
    expect(isRealExchange(mail({ from: { address: "paul.lefort@cabinet-example.com" } }), ME)).toBe(true);
  });
  it("ecarte les envois en masse, labels newsletter/promo, automates, spam", () => {
    expect(isRealExchange(mail({ from: { address: "admin@atelier-example.ch" }, bulk: true }), ME)).toBe(false);
    expect(isRealExchange(mail({ from: { address: "shop@x.ch" }, secondary: true }), ME)).toBe(false);
    expect(isRealExchange(mail({ from: { address: "noreply@x.ch" } }), ME)).toBe(false);
    expect(isRealExchange(mail({ from: { address: "a@b.ch" }, folder_type: "spam" }), ME)).toBe(false);
  });
});

describe("directionWith / selectPersonMails", () => {
  const fromOlivier = mail({
    id: "1",
    message_id: "<a>",
    date: "2026-10-19 13:11:19.000Z",
    from: { address: "admin@atelier-example.ch" },
    to: [{ address: "chrisdupont@gmail.com" }, { address: "paul.lefort@cabinet-example.com" }],
    cc: [{ address: "eva.morel@association-example.org", name: "eva.morel@association-example.org" }],
  });
  const dup = { ...fromOlivier, id: "1b" };
  const mine = mail({
    id: "2",
    date: "2026-10-19 14:02:29.000Z",
    from: { address: "chrisdupont@gmail.com" },
    to: [{ address: "admin@atelier-example.ch" }],
  });
  const herveCcOlivier = mail({
    id: "3",
    date: "2026-10-12 14:16:09.000Z",
    from: { address: "paul.lefort@cabinet-example.com", name: "Paul Lefort" },
    to: [{ address: "chrisdupont@gmail.com" }],
    cc: [{ address: "admin@atelier-example.ch" }],
  });
  const platformNotif = mail({ id: "4", from: { address: "admin@atelier-example.ch" }, bulk: true });

  it("donne le sens de chaque mail", () => {
    expect(directionWith(fromOlivier, OLIVIER, ME)).toBe("in");
    expect(directionWith(mine, OLIVIER, ME)).toBe("out");
    expect(directionWith(herveCcOlivier, OLIVIER, ME)).toBe("group");
  });

  it("garde les vrais echanges sans doublons, du plus recent au plus ancien", () => {
    const sel = selectPersonMails([herveCcOlivier, fromOlivier, platformNotif, dup, mine], OLIVIER, ME);
    expect(sel.map((m) => m.id)).toEqual(["2", "1", "3"]);
  });

  it("trouve les personnes du meme dossier, sans moi ni la personne", () => {
    const rel = relatedParticipants([fromOlivier, herveCcOlivier, mine], OLIVIER, ME);
    expect(rel.map((r) => r.address)).toEqual(["paul.lefort@cabinet-example.com", "eva.morel@association-example.org"]);
    expect(rel[0]).toMatchObject({ name: "Paul Lefort", count: 2 });
    expect(rel[1].name).toBe("");
  });
});

describe("normalizeAiMemory", () => {
  it("ramene chaque champ a sa forme", () => {
    const ai = normalizeAiMemory({
      name: "Olivier Girard",
      role: ["Coordinateur", "Plateforme"],
      organisation: "Atelier60",
      relation: "Client",
      facts: ["a", "A", "", "b"],
      related: [{ name: "Paul", email: "paul.lefort@cabinet-example.com", role: "donneur d'ordre" }, "x", { role: "?" }],
      me_role: "Developpeur",
    });
    expect(ai.role).toBe("Coordinateur ; Plateforme");
    expect(ai.organization).toBe("Atelier60");
    expect(ai.facts).toEqual(["a", "b"]);
    expect(ai.related).toEqual([{ name: "Paul", address: "paul.lefort@cabinet-example.com", role: "donneur d'ordre" }]);
    expect(normalizeAiMemory(null).facts).toEqual([]);
  });
});

describe("mergeMemory", () => {
  const base: ContactMemoryData = {
    name: "Olivier",
    addresses: ["admin@atelier-example.ch"],
    role: "Developpeur de la plateforme",
    organization: "Atelier60",
    relation: "",
    facts: ["Paul gere la technique"],
    related: [{ name: "Eva", address: "eva@asso-example.org", role: "Directrice Asso" }],
    user_notes: "C'est MOI qui fais la technique.",
    locked: ["role"],
    dismissed: ["Paul gere la technique"],
  };

  it("respecte les corrections de l'utilisateur", () => {
    const next = mergeMemory(base, {
      name: "Olivier Girard",
      role: "Technicien",
      organization: "",
      relation: "Client de MOI",
      facts: ["Paul gere la technique", "Suppression automatique des profils demandee"],
      related: [
        { name: "Paul Lefort", address: "paul.lefort@cabinet-example.com", role: "Client" },
        { name: "", address: "eva@asso-example.org", role: "" },
        { name: "Moi-meme", address: "admin@atelier-example.ch", role: "x" },
      ],
      me_role: "",
    });
    expect(next.role).toBe("Developpeur de la plateforme"); // champ corrige
    expect(next.organization).toBe("Atelier60"); // IA vide -> ancienne valeur
    expect(next.relation).toBe("Client de MOI");
    expect(next.name).toBe("Olivier Girard"); // nom signe prefere au nom affiche
    expect(mergeMemory({ ...base, locked: ["name"] }, { ...normalizeAiMemory({ name: "X" }) }).name).toBe("Olivier");
    expect(next.facts).toEqual(["Suppression automatique des profils demandee"]); // fait retire ne revient pas
    expect(next.user_notes).toBe(base.user_notes);
    expect(next.related).toEqual([
      { name: "Eva", address: "eva@asso-example.org", role: "Directrice Asso" },
      { name: "Paul Lefort", address: "paul.lefort@cabinet-example.com", role: "Client" },
    ]);
  });
});

describe("mailsAfter", () => {
  it("ne garde que les mails posterieurs a la derniere analyse", () => {
    const list = [{ date: "2026-10-19 13:11:19.000Z" }, { date: "2026-10-12 14:16:09.000Z" }];
    expect(mailsAfter(list, "2026-10-12 14:16:09.000Z")).toHaveLength(1);
    expect(mailsAfter(list, "")).toHaveLength(2);
    expect(mailsAfter(list, "2026-10-19 13:11:19.000Z")).toHaveLength(0);
  });
});
