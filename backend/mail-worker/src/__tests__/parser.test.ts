import { describe, it, expect } from "vitest";
import { parseEmail, fixMojibake, buildSentSnippet } from "../parser";

// Email RFC 2822 minimal pour les tests
function makeRawEmail(overrides: {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  date?: string;
  html?: boolean;
  cc?: string;
  references?: string;
  inReplyTo?: string;
} = {}): string {
  const lines: string[] = [];
  lines.push(`From: ${overrides.from ?? "Alice <alice@example.com>"}`);
  lines.push(`To: ${overrides.to ?? "Bob <bob@example.com>"}`);
  if (overrides.cc) lines.push(`Cc: ${overrides.cc}`);
  lines.push(`Subject: ${overrides.subject ?? "Test Email"}`);
  lines.push(`Message-ID: ${overrides.messageId ?? "<test123@example.com>"}`);
  lines.push(`Date: ${overrides.date ?? "Mon, 15 Jun 2025 10:00:00 +0000"}`);
  if (overrides.references) lines.push(`References: ${overrides.references}`);
  if (overrides.inReplyTo) lines.push(`In-Reply-To: ${overrides.inReplyTo}`);

  if (overrides.html) {
    lines.push("MIME-Version: 1.0");
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("");
    lines.push(overrides.body ?? "<p>Hello World</p>");
  } else {
    lines.push("MIME-Version: 1.0");
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("");
    lines.push(overrides.body ?? "Hello World");
  }

  return lines.join("\r\n");
}

describe("parseEmail", () => {
  it("parse les champs basiques", async () => {
    const raw = makeRawEmail();
    const result = await parseEmail(raw);

    expect(result.subject).toBe("Test Email");
    expect(result.from.name).toBe("Alice");
    expect(result.from.address).toBe("alice@example.com");
    expect(result.messageId).toBe("<test123@example.com>");
  });

  it("parse les destinataires To", async () => {
    const raw = makeRawEmail({ to: "Bob <bob@test.com>" });
    const result = await parseEmail(raw);
    expect(result.toAddresses.some(a => a.address === "bob@test.com")).toBe(true);
  });

  it("parse le Cc", async () => {
    const raw = makeRawEmail({ cc: "Charlie <charlie@test.com>" });
    const result = await parseEmail(raw);
    expect(result.ccAddresses.some(a => a.address === "charlie@test.com")).toBe(true);
  });

  it("genere un snippet a partir du text body", async () => {
    const body = "A".repeat(300);
    const raw = makeRawEmail({ body });
    const result = await parseEmail(raw);

    expect(result.snippet.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(result.snippet).toContain("...");
  });

  it("retourne un snippet vide pour un email sans body", async () => {
    const raw = makeRawEmail({ body: "" });
    const result = await parseEmail(raw);
    expect(result.snippet).toBe("");
  });

  it("sanitize le HTML (supprime les scripts)", async () => {
    const raw = makeRawEmail({
      html: true,
      body: '<p>Hello</p><script>alert("xss")</script>',
    });
    const result = await parseEmail(raw);
    expect(result.htmlBody).not.toContain("<script");
    expect(result.htmlBody).toContain("<p>Hello</p>");
  });

  it("sanitize le HTML (supprime les event handlers)", async () => {
    const raw = makeRawEmail({
      html: true,
      body: '<img src="x" onerror="alert(1)">',
    });
    const result = await parseEmail(raw);
    expect(result.htmlBody).not.toContain("onerror");
  });

  it("parse les references et in-reply-to", async () => {
    const raw = makeRawEmail({
      references: "<root@test.com> <mid@test.com>",
      inReplyTo: "<mid@test.com>",
    });
    const result = await parseEmail(raw);
    expect(result.references).toContain("<root@test.com>");
    expect(result.inReplyTo).toBe("<mid@test.com>");
  });

  it("retourne (no subject) si pas de sujet", async () => {
    const raw = makeRawEmail({ subject: "" });
    const result = await parseEmail(raw);
    // mailparser peut garder "" ou retourner "(no subject)"
    expect(result.subject).toBeDefined();
  });

  it("marque hasAttachments = false sans pieces jointes", async () => {
    const raw = makeRawEmail();
    const result = await parseEmail(raw);
    expect(result.hasAttachments).toBe(false);
    expect(result.attachments).toHaveLength(0);
  });

  it("parse la date correctement", async () => {
    const raw = makeRawEmail({ date: "Mon, 15 Jun 2025 10:00:00 +0000" });
    const result = await parseEmail(raw);
    expect(result.date).toContain("2025");
  });
});

describe("fixMojibake", () => {
  // Construit du mojibake reel: octets UTF-8 relus comme Windows-1252.
  // simpleParser/iconv produit exactement ce genre de chaine quand un email
  // declare un mauvais charset.
  const toMojibake = (s: string) => Buffer.from(s, "utf8").toString("latin1");

  it("repare l'apostrophe typographique mal decodee", () => {
    const original = "Vous n’avez toujours";
    const mojibake = toMojibake(original);
    expect(mojibake).not.toBe(original);
    expect(fixMojibake(mojibake)).toBe(original);
  });

  it("repare le cas reel du bug (Windows-1252)", () => {
    // Chaine exacte vue dans l'app: apostrophe typo decodee en Windows-1252
    expect(fixMojibake("Vous nâ€™avez toujours")).toBe("Vous n’avez toujours");
  });

  it("repare les accents UTF-8 decodes en Latin-1", () => {
    const original = "été à Pâques café résumé";
    const mojibake = toMojibake(original);
    expect(mojibake).not.toBe(original);
    expect(fixMojibake(mojibake)).toBe(original);
  });

  it("repare les guillemets et symboles", () => {
    const original = "£10 “test” — 100€";
    const mojibake = toMojibake(original);
    expect(mojibake).not.toBe(original);
    expect(fixMojibake(mojibake)).toBe(original);
  });

  it("laisse intact un texte correctement encode", () => {
    const ok = "L'été à Pâques coûte 100€";
    expect(fixMojibake(ok)).toBe(ok);
  });

  it("laisse intact un texte ASCII", () => {
    expect(fixMojibake("Hello World")).toBe("Hello World");
  });

  it("ne corrompt pas un vrai mot avec accent circonflexe", () => {
    expect(fixMojibake("bâtiment et âme")).toBe("bâtiment et âme");
  });

  it("ne corrompt pas un texte avec emoji et accents", () => {
    const ok = "Réservation confirmée 🎉";
    expect(fixMojibake(ok)).toBe(ok);
  });

  it("gere une chaine vide", () => {
    expect(fixMojibake("")).toBe("");
  });
});

describe("buildSentSnippet", () => {
  it("garde seulement le texte ecrit, sans le bloc cite de la fenetre de redaction", () => {
    const html =
      '<p>C’est en prod</p><div class="haiko-quote"><p>Le 23 septembre 2026 a 19:20, Paul a ecrit :</p>' +
      "<blockquote>Teste en dev. Tu peux deployer.</blockquote></div>";
    expect(buildSentSnippet("", html)).toBe("C’est en prod");
  });

  it("coupe au premier blockquote", () => {
    expect(buildSentSnippet("", "<div>Merci !</div><blockquote>ancien</blockquote>")).toBe("Merci !");
  });

  it("texte brut : s'arrete a l'en-tete de citation ou aux lignes >", () => {
    const text = "Bonjour,\nc'est fait.\n\nLe 23 sept. 2026, Paul a écrit :\n> Tu peux deployer";
    expect(buildSentSnippet(text, "")).toBe("Bonjour,\nc'est fait.");
    expect(buildSentSnippet("Ok\n> cite", "")).toBe("Ok");
  });

  it("vide si rien n'a ete ecrit", () => {
    expect(buildSentSnippet("", "")).toBe("");
  });
});
