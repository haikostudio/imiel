import { describe, expect, it } from "vitest";
import { parseAlertsLine, stripMetaOpening } from "../newsletter";

describe("stripMetaOpening", () => {
  it("retire l'ouverture 'Cette edition ... explore'", () => {
    const out = stripMetaOpening(
      "<p><strong>Resume :</strong> Cette édition de la newsletter explore les nouveaux modèles d'IA.</p>"
    );
    expect(out).toBe("<p><strong>Resume :</strong> Les nouveaux modèles d'IA.</p>");
  });
  it("retire 'Cette newsletter met en lumiere'", () => {
    const out = stripMetaOpening(
      "<p><strong>Resume :</strong> Cette newsletter met en lumière la hausse des taux.</p>"
    );
    expect(out).toContain("La hausse des taux.");
  });
  it("laisse un resume direct intact", () => {
    const html = "<p><strong>Resume :</strong> OpenAI lance GPT-6 et baisse ses prix.</p>";
    expect(stripMetaOpening(html)).toBe(html);
  });
});

describe("parseAlertsLine", () => {
  const topics = [
    { id: "a", name: "IA" },
    { id: "b", name: "Immobilier" },
  ];
  it("extrait les sujets et retire la ligne", () => {
    const r = parseAlertsLine("<p>x</p>\nALERTES: 2, 1, 2", topics);
    expect(r.html).toBe("<p>x</p>");
    expect(r.matched.map((t) => t.id)).toEqual(["b", "a"]);
  });
  it("aucune -> rien", () => {
    const r = parseAlertsLine("<p>x</p>\nALERTES: aucune", topics);
    expect(r.html).toBe("<p>x</p>");
    expect(r.matched).toEqual([]);
  });
  it("sans ligne -> html inchange", () => {
    expect(parseAlertsLine("<p>x</p>", topics).html).toBe("<p>x</p>");
  });
});
