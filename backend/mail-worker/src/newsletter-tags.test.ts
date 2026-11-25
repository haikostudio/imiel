import { describe, expect, it } from "vitest";
import {
  canonicalTags,
  cleanTag,
  computeNewsletterStats,
  foldTag,
  isoWeekKey,
  mondayOf,
  parseTagsLine,
  renameTagInList,
} from "./newsletter-tags";
import { parseAlertsLine, parseTitleLine } from "./newsletter";
import { buildDigestContent, digestWindow } from "./newsletter-digest";
import { isDigestMessageId, digestMessageId } from "./digest-id";

describe("parseTagsLine", () => {
  it("retire la ligne TAGS placee apres TITRE, sans toucher TITRE ni ALERTES", () => {
    const raw = "TITRE: Semaine IA\nTAGS: GPT, Gemini ; securite\n<p><strong>Resume :</strong> x</p>\nALERTES: 1";
    const t = parseTitleLine(raw);
    expect(t.title).toBe("Semaine IA");
    const g = parseTagsLine(t.html);
    expect(g.tags).toEqual(["GPT", "Gemini", "securite"]);
    expect(g.html.startsWith("<p><strong>Resume")).toBe(true);
    const a = parseAlertsLine(g.html, [{ id: "a1", name: "IA" }]);
    expect(a.matched.map((m) => m.id)).toEqual(["a1"]);
    expect(a.html).not.toMatch(/TAGS|ALERTES/);
  });
  it("tolere balises et 'Etiquettes :', et une ligne placee plus loin", () => {
    expect(parseTagsLine("<p><strong>Etiquettes :</strong> Grok</p><p>a</p>").tags).toEqual(["Grok"]);
    const far = parseTagsLine("<p>a</p>\nTAGS: Claude, Open source\n<p>b</p>");
    expect(far.tags).toEqual(["Claude", "Open source"]);
    expect(far.html).not.toContain("TAGS");
  });
  it("sans ligne : HTML intact", () => {
    expect(parseTagsLine("<p>a</p>")).toEqual({ html: "<p>a</p>", tags: [] });
  });
});

describe("canonicalTags", () => {
  it("aligne sur l'ecriture existante a la casse / aux accents pres", () => {
    expect(canonicalTags(["gpt", "SÉCURITÉ", "Gemini"], ["GPT", "Securite"])).toEqual(["GPT", "Securite", "Gemini"]);
  });
  it("ne fusionne pas des sujets differents (GPT et GPT-5)", () => {
    expect(canonicalTags(["GPT-5", "gpt"], ["GPT"])).toEqual(["GPT-5", "GPT"]);
  });
  it("dedoublonne, nettoie et borne a 5", () => {
    expect(canonicalTags(["#ia", "IA", " ", "aucune", "a", "b", "c", "d", "e"])).toEqual(["Ia", "A", "B", "C", "D"]);
  });
  it("majuscule pour un theme en minuscules, ecriture gardee sinon", () => {
    expect(cleanTag("génération d'images")).toBe("Génération d'images");
    expect(cleanTag("iOS")).toBe("iOS");
    expect(foldTag("  Génération   d'images ")).toBe("generation d'images");
  });
});

describe("renameTagInList", () => {
  it("renomme et fusionne sans doublon", () => {
    expect(renameTagInList(["ChatGPT", "GPT", "Securite"], "chatgpt", "GPT")).toEqual(["GPT", "Securite"]);
    expect(renameTagInList(["A", "B"], "c", "D")).toEqual(["A", "B"]);
  });
});

describe("computeNewsletterStats", () => {
  const posts = [
    { message_date: "2026-10-05 10:00:00.000Z", tags: ["GPT", "Securite"] },
    { message_date: "2026-10-06 10:00:00.000Z", tags: ["gpt"] },
    { message_date: "2026-10-06 22:30:00.000Z", tags: [] }, // 7 oct a Paris
    { message_date: "2026-09-29 10:00:00.000Z", tags: ["Securite"] }, // periode precedente
    { message_date: "2026-09-01 10:00:00.000Z", tags: ["Grok"] }, // hors champ
  ];
  const s = computeNewsletterStats(posts, "2026-10-05", "2026-10-11");
  it("compte par jour de Paris et la periode precedente", () => {
    expect(s.total).toBe(3);
    expect(s.prevTotal).toBe(1);
    expect(s.untagged).toBe(1);
    expect(s.perDay.find((d) => d.date === "2026-10-07")?.count).toBe(1);
    expect(s.perDay).toHaveLength(7);
  });
  it("classe les sujets (casse confondue) avec leur tendance", () => {
    expect(s.tags[0]).toMatchObject({ tag: "GPT", count: 2, prevCount: 0, delta: 2 });
    expect(s.tags.find((t) => t.tag === "Securite")).toMatchObject({ count: 1, prevCount: 1, delta: 0 });
    expect(s.tags.find((t) => t.tag === "Grok")).toBeUndefined();
    expect(s.rising.map((t) => t.tag)).toEqual(["GPT"]);
  });
  it("series par jour sur une courte periode, par semaine au-dela", () => {
    expect(s.series.granularity).toBe("day");
    expect(s.series.points.find((p) => p.date === "2026-10-06")?.GPT).toBe(1);
    const long = computeNewsletterStats(posts, "2026-08-01", "2026-10-11");
    expect(long.series.granularity).toBe("week");
    expect(long.series.points[0].date).toBe(mondayOf("2026-08-01"));
  });
});

describe("semaines et resume du lundi", () => {
  it("semaine ISO", () => {
    expect(isoWeekKey(new Date("2026-10-12T10:00:00Z"))).toBe("2026-W42");
    expect(isoWeekKey(new Date("2027-01-01T10:00:00Z"))).toBe("2026-W53");
  });
  it("fenetre : lundi apres 8 h et mardi, jamais le reste de la semaine", () => {
    // Lundi 12 oct 2026, 07:30 Paris = 05:30Z
    expect(digestWindow(new Date("2026-10-12T05:30:00Z"))).toBeNull();
    expect(digestWindow(new Date("2026-10-12T06:30:00Z"))).toEqual({ week: "2026-W41", from: "2026-10-05", to: "2026-10-11" });
    expect(digestWindow(new Date("2026-10-13T20:00:00Z"))?.week).toBe("2026-W41");
    expect(digestWindow(new Date("2026-10-14T09:00:00Z"))).toBeNull();
  });
  it("contenu echappe, version texte avec le lien", () => {
    const stats = computeNewsletterStats(
      [{ message_date: "2026-10-05 10:00:00.000Z", tags: ["<script>x</script>"] }],
      "2026-10-05",
      "2026-10-11"
    );
    const c = buildDigestContent(stats);
    expect(c.html).not.toContain("<script>x");
    expect(c.html).toContain("&lt;script&gt;");
    expect(c.text).toContain("/#/newsletters/stats");
    expect(c.html).not.toMatch(/<style|@media|display:\s*flex/);
  });
  it("Message-ID reconnu a la synchronisation", () => {
    expect(isDigestMessageId(digestMessageId("2026-W41", "u1"))).toBe(true);
    expect(isDigestMessageId("<abc@gmail.com>")).toBe(false);
  });
});
