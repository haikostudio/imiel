import { describe, it, expect } from "vitest";
import {
  buildReplyQuote,
  buildForwardQuote,
  splitQuotedBody,
  joinQuotedBody,
  QUOTE_MARKER_CLASS,
} from "./quote";

const msg = {
  from_address: { name: "Alice", address: "alice@example.com" },
  to_addresses: [{ address: "bob@example.com" }],
  subject: "Volvo EX30",
  date: "2026-07-08T09:36:00Z",
  html_body: "<p>Contenu original</p>",
};

describe("quote", () => {
  it("buildReplyQuote enveloppe dans .haiko-quote et garde le corps original", () => {
    const q = buildReplyQuote(msg, "fr");
    expect(q).toContain(`class="${QUOTE_MARKER_CLASS}"`);
    expect(q).toContain("Contenu original");
    expect(q).toContain("a ecrit");
  });

  it("buildForwardQuote inclut l'en-tete et le corps", () => {
    const q = buildForwardQuote(msg, "en");
    expect(q).toContain(`class="${QUOTE_MARKER_CLASS}"`);
    expect(q).toContain("Forwarded message");
    expect(q).toContain("Volvo EX30");
    expect(q).toContain("Contenu original");
  });

  it("split apres join restitue la partie redigee et la citation", () => {
    const quote = buildReplyQuote(msg, "fr");
    const typed = "<p>Ma reponse</p>";
    const joined = joinQuotedBody(typed, quote);
    const { body, quote: extracted } = splitQuotedBody(joined);
    expect(body).toBe(typed);
    expect(extracted).toContain(QUOTE_MARKER_CLASS);
    expect(extracted).toContain("Contenu original");
  });

  it("splitQuotedBody renvoie une citation vide sans marqueur (ancien brouillon)", () => {
    const { body, quote } = splitQuotedBody("<p>juste du texte</p>");
    expect(body).toBe("<p>juste du texte</p>");
    expect(quote).toBe("");
  });

  it("joinQuotedBody sans citation renvoie le corps tel quel", () => {
    expect(joinQuotedBody("<p>x</p>", "")).toBe("<p>x</p>");
  });
});
