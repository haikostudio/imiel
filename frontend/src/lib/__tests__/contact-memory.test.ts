import { describe, expect, it } from "vitest";
import { conversationParticipants, formatWhoIsWho, type MemoryLike } from "../contact-memory";

function mem(p: Partial<MemoryLike>): MemoryLike {
  return {
    key: "",
    name: "",
    role: "",
    organization: "",
    relation: "",
    facts: [],
    related: [],
    user_notes: "",
    addresses: [],
    ...p,
  };
}

describe("formatWhoIsWho", () => {
  it("vide quand aucune fiche n'a de contenu", () => {
    expect(formatWhoIsWho({ me: mem({ key: "me" }), person: null, others: [] }, "Olivier")).toBe("");
  });

  it("donne MOI, l'interlocuteur, puis les personnes liees enrichies de leur fiche", () => {
    const out = formatWhoIsWho(
      {
        me: mem({ key: "me", role: "Developpeur de la plateforme", user_notes: "Je fais toute la technique." }),
        person: mem({
          key: "admin@atelier-example.ch",
          name: "Olivier Girard",
          addresses: ["admin@atelier-example.ch"],
          role: "Coordinateur",
          relation: "Client de MOI",
          facts: ["Travaille le lundi"],
          related: [
            { name: "Paul Lefort", address: "paul.lefort@cabinet-example.com", role: "Client, transmet les demandes" },
            { name: "Eva", address: "", role: "" },
          ],
        }),
        others: [
          mem({ key: "paul.lefort@cabinet-example.com", name: "Paul", role: "Chef de projet cote client" }),
          mem({ key: "x@y.ch", name: "Autre", role: "Comptable" }),
        ],
      },
      "Olivier"
    );
    expect(out).toContain("MOI (l'utilisateur, au nom de qui tu ecris) :\n  - Note de l'utilisateur (fait foi) : Je fais toute la technique.");
    expect(out).toContain("Olivier Girard <admin@atelier-example.ch> (l'interlocuteur) :");
    expect(out).toContain("- Paul Lefort <paul.lefort@cabinet-example.com> : Client, transmet les demandes\n  - Role : Chef de projet cote client");
    expect(out).toContain("- Eva : role inconnu");
    expect(out).toContain("Autre <x@y.ch> :\n  - Role : Comptable");
    // Paul n'est pas repete en fiche separee
    expect(out.match(/Chef de projet cote client/g)).toHaveLength(1);
  });
});

describe("conversationParticipants", () => {
  it("rend les participants sans moi ni doublons", () => {
    expect(
      conversationParticipants(
        [
          {
            from_address: { address: "Admin@atelier-example.ch" },
            to_addresses: [{ address: "me@x.ch" }, { address: "paul.lefort@cabinet-example.com" }],
            cc_addresses: [{ address: "eva@asso-example.org" }],
          },
          { from_address: { address: "me@x.ch" }, to_addresses: [{ address: "admin@atelier-example.ch" }] },
        ],
        ["ME@x.ch"]
      )
    ).toEqual(["admin@atelier-example.ch", "paul.lefort@cabinet-example.com", "eva@asso-example.org"]);
  });
});
