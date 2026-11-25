import { describe, expect, it } from "vitest";
import { cleanNewsletterTitle, parseAlertsLine, parseTitleLine } from "./newsletter";

describe("parseTitleLine", () => {
  it("retire la ligne TITRE de tete et garde le HTML", () => {
    const r = parseTitleLine("TITRE: 🏖️ Les nouvelles de la Costa Blanca\n<p><strong>Resume :</strong> x</p>");
    expect(r.title).toBe("🏖️ Les nouvelles de la Costa Blanca");
    expect(r.html).toBe("<p><strong>Resume :</strong> x</p>");
  });
  it("tolere balises, gras et casse", () => {
    expect(parseTitleLine("<p><strong>Titre :</strong> Bonjour</p>\n<p>a</p>").title).toBe("Bonjour");
    expect(parseTitleLine("**TITRE:** \"Bonjour\"\n<p>a</p>").title).toBe("Bonjour");
    expect(parseTitleLine("<h2>TITRE: Salut</h2><p>a</p>").title).toBe("Salut");
  });
  it("sans ligne de titre : HTML intact, titre vide", () => {
    const html = "<p><strong>Resume :</strong> rien</p>";
    expect(parseTitleLine(html)).toEqual({ html, title: "" });
  });
  it("se combine avec la ligne ALERTES de fin", () => {
    const t = parseTitleLine("TITRE: Marches\n<p>x</p>\nALERTES: 1");
    const a = parseAlertsLine(t.html, [{ id: "a", name: "Bourse" }]);
    expect(t.title).toBe("Marches");
    expect(a.html).toBe("<p>x</p>");
    expect(a.matched.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("cleanNewsletterTitle", () => {
  it("rejette le vide et (sans sujet), coupe les titres trop longs", () => {
    expect(cleanNewsletterTitle("  ")).toBe("");
    expect(cleanNewsletterTitle("(sans sujet)")).toBe("");
    expect(cleanNewsletterTitle("a".repeat(300)).length).toBe(160);
  });
});
