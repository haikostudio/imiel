import { describe, expect, it } from "vitest";
import { newsletterSynthesisText, reorderNewsletterSummary } from "../newsletter-summary";

const OLD = [
  "<p><strong>Source :</strong> ImmoSoleil, immobilier en Espagne.</p>",
  "<p><strong>Resume :</strong> Les prix montent &amp; la demande aussi.</p>",
  "<p><strong>Au sommaire :</strong></p>",
  "<ul><li><strong>Marche</strong> hausse de 5%.</li></ul>",
  "<p><strong>A retenir :</strong></p>",
  "<ul><li>+5% sur un an</li><li>Taux a 3%</li></ul>",
].join("\n");

describe("reorderNewsletterSummary", () => {
  it("met Resume, A retenir, Au sommaire puis Source", () => {
    const out = reorderNewsletterSummary(OLD);
    const order = ["Resume", "A retenir", "Au sommaire", "Source"].map((l) => out.indexOf(`<strong>${l}`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // la liste "A retenir" suit son titre
    expect(out.indexOf("+5% sur un an")).toBeLessThan(out.indexOf("<strong>Au sommaire"));
  });

  it("est idempotent", () => {
    const once = reorderNewsletterSummary(OLD);
    expect(reorderNewsletterSummary(once)).toBe(once);
  });

  it("gere les libelles anglais", () => {
    const html =
      "<p><strong>Source:</strong> X</p><p><strong>Summary:</strong> Big news.</p><p><strong>In this issue:</strong></p><ul><li>a</li></ul><p><strong>Key takeaways:</strong></p><ul><li>b</li></ul>";
    const out = reorderNewsletterSummary(html);
    expect(out.indexOf("Key takeaways")).toBeLessThan(out.indexOf("In this issue"));
    expect(newsletterSynthesisText(html)).toBe("Big news.");
  });

  it("laisse intact un format inattendu", () => {
    const html = "Texte libre <p>para</p>";
    expect(reorderNewsletterSummary(html)).toBe(html);
  });
});

describe("newsletterSynthesisText", () => {
  it("rend la synthese sans libelle ni source", () => {
    expect(newsletterSynthesisText(OLD)).toBe("Les prix montent & la demande aussi.");
  });

  it("retombe sur le texte hors Source sans paragraphe Resume", () => {
    const html = "<p><strong>Source :</strong> X</p><p>Contenu utile</p>";
    expect(newsletterSynthesisText(html)).toBe("Contenu utile");
  });
});
