import { describe, expect, it } from "vitest";
import {
  isSignatureEmpty,
  joinSignature,
  signatureImageUrl,
  splitSignature,
  toEmailSignatureHtml,
  wrapSignature,
} from "@/lib/signature";
import { joinQuotedBody, splitQuotedBody } from "@/lib/utils/quote";

describe("signature", () => {
  it("considere vide une signature sans texte ni image", () => {
    expect(isSignatureEmpty("")).toBe(true);
    expect(isSignatureEmpty("<p></p><p>&nbsp;</p>")).toBe(true);
    expect(isSignatureEmpty('<p><img src="x.png"></p>')).toBe(false);
    expect(isSignatureEmpty("<p>Alice</p>")).toBe(false);
  });

  it("ne pose aucun bloc pour une signature vide", () => {
    expect(wrapSignature("<p></p>")).toBe("");
    expect(joinSignature("<p>Bonjour</p>", "")).toBe("<p>Bonjour</p>");
  });

  it("fait l'aller-retour corps + signature + citation sans doublon", () => {
    const quote = '<div class="haiko-quote"><p>Le 1, Bob a ecrit :</p><blockquote><div class="haiko-signature"><p>Bob</p></div></blockquote></div>';
    const full = joinQuotedBody(joinSignature("<p>Bonjour</p>", "<p><b>Alice</b></p>"), quote);
    const q = splitQuotedBody(full);
    expect(q.quote).toContain("Bob a ecrit");
    const s = splitSignature(q.body);
    expect(s.body).toBe("<p>Bonjour</p>");
    expect(s.signature).toBe("<p><b>Alice</b></p>");
    // Re-joindre redonne le meme corps : jamais de seconde signature.
    const again = joinQuotedBody(joinSignature(s.body, s.signature), q.quote);
    expect(again.match(/haiko-signature/g)?.length).toBe(2); // la sienne + celle citee de Bob
  });

  it("convertit la grille et les images au format messageries", () => {
    const html = toEmailSignatureHtml(
      '<table style="min-width: 50px"><colgroup><col></colgroup><tbody><tr><td colspan="1" rowspan="1"><p><img src="https://a/logo.png" width="120"></p></td><td><p style="text-align: center">Alice</p></td></tr></tbody></table>'
    );
    expect(html).not.toContain("colgroup");
    expect(html).toContain('role="presentation"');
    expect(html).toContain("vertical-align:top;padding:0 16px 0 0;");
    expect(html).toContain("padding:0 0 0 0;");
    expect(html).toContain("width:120px;");
    expect(html).toContain("margin:0;text-align:center;");
    // Idempotent
    expect(toEmailSignatureHtml(html)).toBe(html);
  });

  it("construit une URL publique absolue pour les images", () => {
    expect(
      signatureImageUrl({ id: "abc", collectionId: "col1" }, "logo 1.png", "https://mail.example.com/")
    ).toBe("https://mail.example.com/api/files/col1/abc/logo%201.png");
  });
});
