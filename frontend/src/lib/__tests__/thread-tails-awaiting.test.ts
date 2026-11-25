import { describe, it, expect, vi } from "vitest";
import { makeMessage } from "@/lib/hooks/__tests__/test-helpers";

vi.mock("@/lib/pocketbase", () => ({
  default: {},
  messages: () => ({}),
  retryUpdate: vi.fn(),
  updateMessageFlags: vi.fn(),
}));

import { applyThreadTails, buildThreadsFromMessages } from "@/lib/hooks/useThreads";
import {
  formatWaitingDuration,
  getAwaitingReplySince,
  isAutomatedAddress,
  isAutomatedLabelName,
} from "@/lib/utils/awaiting-reply";

const ME = new Set(["contact@studio.example.com", "chrisdupont@gmail.com"]);
const KNOWN = new Set(["paul.lefort@cabinet-example.com", "julien.marc@banque-example.fr"]);
const paul = { name: "Paul Lefort", address: "paul.lefort@cabinet-example.com" };
const me = { name: "Haiko", address: "contact@studio.example.com" };

// Cas reel (fil cfcfd33d...) : mail d'Paul recu en DOUBLE (compte salut@
// redirige vers gmail), puis reponse envoyee depuis salut@.
const received1 = makeMessage({
  id: "r1", thread_id: "T", message_id: "<a@cabinet>", subject: "Atelier Ajout de docs",
  from_address: paul, to_addresses: [me], date: "2026-09-23T08:29:39Z", is_answered: true,
});
const receivedGmail = makeMessage({
  id: "r2g", account: "gmail", thread_id: "T", message_id: "<b@cabinet>", subject: "Re: Atelier Ajout de docs",
  from_address: paul, to_addresses: [me], date: "2026-09-23T17:20:26Z", is_answered: false,
});
const receivedSalut = makeMessage({
  id: "r2s", account: "salut", thread_id: "T", message_id: "<b@cabinet>", subject: "Re: Atelier Ajout de docs",
  from_address: paul, to_addresses: [me], date: "2026-09-23T17:20:26Z", is_answered: true,
});
const myReply = makeMessage({
  id: "s2", thread_id: "T", message_id: "<c@haiko>", subject: "Re: Atelier Ajout de docs",
  from_address: me, to_addresses: [paul], date: "2026-09-23T18:47:36Z", is_sent: true,
  snippet: "C'est en prod",
});

describe("applyThreadTails", () => {
  it("la ligne affiche la reponse envoyee (absente de la vue) comme dernier message", () => {
    const threads = applyThreadTails(
      buildThreadsFromMessages([received1, receivedGmail]),
      new Map([["T", myReply]])
    );
    expect(threads).toHaveLength(1);
    expect(threads[0].displayMessage.id).toBe("s2");
    expect(threads[0].displayMessage.snippet).toBe("C'est en prod");
    // L'action "ouvrir" reste ancree sur le dernier message de la vue.
    expect(threads[0].lastMessage.id).toBe("r2g");
    expect(threads[0].participantNames.map((p) => p.address)).toContain("contact@studio.example.com");
  });

  it("sans tail plus recent, rien ne change", () => {
    const threads = applyThreadTails(buildThreadsFromMessages([received1, receivedGmail]), new Map());
    expect(threads[0].displayMessage.id).toBe("r2g");
  });

  it("unit le flag repondu des copies multi-comptes (page + tail)", () => {
    const [t1] = buildThreadsFromMessages([receivedGmail, receivedSalut]);
    expect(t1.displayAnswered).toBe(true);
    const [t2] = applyThreadTails(
      buildThreadsFromMessages([receivedGmail]),
      new Map([["T", { ...receivedSalut }]])
    );
    expect(t2.displayMessage.message_id).toBe("<b@cabinet>");
    expect(t2.displayAnswered).toBe(true);
  });

  it("trie par date du dernier message reel", () => {
    const other = makeMessage({ id: "o", thread_id: "O", subject: "Autre", date: "2026-09-23T18:00:00Z", from_address: { name: "X", address: "x@y.fr" } });
    const threads = applyThreadTails(
      buildThreadsFromMessages([receivedGmail, other]),
      new Map([["T", myReply]])
    );
    expect(threads.map((t) => t.id)).toEqual(["T", "O"]);
  });
});

describe("getAwaitingReplySince", () => {
  const now = new Date("2026-09-23T19:20:26Z").getTime();

  it("mail recu, adresse a moi, non repondu -> attend depuis sa date", () => {
    expect(getAwaitingReplySince(receivedGmail, { myEmails: ME, correspondents: KNOWN, now })).toBe(receivedGmail.date);
  });

  it("une copie repondue suffit a eteindre le rappel", () => {
    expect(getAwaitingReplySince(receivedGmail, { myEmails: ME, correspondents: KNOWN, now, answered: true })).toBeNull();
  });

  it("dernier message envoye par moi -> pas d'attente", () => {
    expect(getAwaitingReplySince(myReply, { myEmails: ME, correspondents: KNOWN, now })).toBeNull();
  });

  it("en copie seulement -> pas d'attente", () => {
    const cc = { ...receivedGmail, to_addresses: [{ name: "Z", address: "z@z.fr" }], cc_addresses: [me] };
    expect(getAwaitingReplySince(cc, { myEmails: ME, correspondents: KNOWN, now })).toBeNull();
  });

  it("no-reply, notifications, newsletters, spam, etiquette auto -> pas d'attente", () => {
    const bot = (address: string) => ({ ...receivedGmail, from_address: { name: "Bot", address } });
    expect(getAwaitingReplySince(bot("noreply@github.com"), { myEmails: ME, correspondents: KNOWN, now })).toBeNull();
    expect(getAwaitingReplySince(bot("notifications@linkedin.com"), { myEmails: ME, correspondents: KNOWN, now })).toBeNull();
    expect(getAwaitingReplySince(bot("hello@news.marque.fr"), { myEmails: ME, correspondents: KNOWN, now })).toBeNull();
    expect(getAwaitingReplySince(receivedGmail, { myEmails: ME, correspondents: KNOWN, now, isSpam: true })).toBeNull();
    const labelled = { ...receivedGmail, labels: ["L1"] };
    expect(
      getAwaitingReplySince(labelled, { myEmails: ME, correspondents: KNOWN, now, labelName: () => "Newsletter" })
    ).toBeNull();
    expect(
      getAwaitingReplySince(labelled, { myEmails: ME, correspondents: KNOWN, now, labelName: () => "Travail" })
    ).toBe(receivedGmail.date);
  });

  it("seulement pour un correspondant : jamais les alertes ni confirmations", () => {
    const from = (address: string) => ({ ...receivedGmail, from_address: { name: "X", address } });
    // Alerte immobiliere / banque / service : jamais ecrit -> pas de rappel.
    expect(getAwaitingReplySince(from("property-alerts@immo-newsletter.example.com"), { myEmails: ME, correspondents: KNOWN, now })).toBeNull();
    expect(getAwaitingReplySince(from("contact@banque-example.fr"), { myEmails: ME, correspondents: KNOWN, now })).toBeNull();
    expect(getAwaitingReplySince(from("service@studio.example.com"), { myEmails: ME, correspondents: KNOWN, now })).toBeNull();
    // Collegue nominatif d'une entreprise ou j'ai deja ecrit -> rappel.
    expect(getAwaitingReplySince(from("thierry.lebrun@banque-example.fr"), { myEmails: ME, correspondents: KNOWN, now })).toBe(receivedGmail.date);
    // Inconnu sur un domaine grand public -> pas de rappel.
    expect(getAwaitingReplySince(from("inconnu@gmail.com"), { myEmails: ME, correspondents: KNOWN, now })).toBeNull();
    // Liste pas encore chargee -> aucun rappel.
    expect(getAwaitingReplySince(receivedGmail, { myEmails: ME, correspondents: null, now })).toBeNull();
  });

  it("au-dela de 30 jours, la date normale revient", () => {
    const old = { ...receivedGmail, date: "2026-07-01T10:00:00Z" };
    expect(getAwaitingReplySince(old, { myEmails: ME, correspondents: KNOWN, now })).toBeNull();
  });

  it("reconnaissance des adresses et etiquettes automatiques", () => {
    expect(isAutomatedAddress("no-reply@x.com")).toBe(true);
    expect(isAutomatedAddress("mailer-daemon@googlemail.com")).toBe(true);
    expect(isAutomatedAddress("paul.lefort@cabinet-example.com")).toBe(false);
    expect(isAutomatedAddress("newsroom@journal.fr")).toBe(false);
    expect(isAutomatedAddress("property-alerts@immo-newsletter.example.com")).toBe(true);
    expect(isAutomatedLabelName("Réseaux Sociaux")).toBe(true);
    expect(isAutomatedLabelName("Travail")).toBe(false);
  });
});

describe("formatWaitingDuration", () => {
  const since = "2026-09-23T10:00:00Z";
  const at = (iso: string) => new Date(iso).getTime();
  it("minutes, heures, jours, semaines", () => {
    expect(formatWaitingDuration(since, "fr", at("2026-09-23T10:00:20Z"))).toBe("1 min");
    expect(formatWaitingDuration(since, "fr", at("2026-09-23T10:45:00Z"))).toBe("45 min");
    expect(formatWaitingDuration(since, "fr", at("2026-09-23T12:10:00Z"))).toBe("2 h");
    expect(formatWaitingDuration(since, "fr", at("2026-09-26T10:00:00Z"))).toBe("3 j");
    expect(formatWaitingDuration(since, "en", at("2026-10-10T10:00:00Z"))).toBe("2 w");
  });
});
