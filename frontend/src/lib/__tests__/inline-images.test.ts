import { describe, it, expect } from "vitest";
import { normalizeCid, referencedCids, resolveCidImages, inlineImageStyle } from "../inline-images";

const items = [
  { id: "a1", filename: "logo.png", url: "/api/files/attachments/a1/logo.png", contentId: "<Logo@Mail>" },
  { id: "a2", filename: "doc.pdf", url: "/api/files/attachments/a2/doc.pdf" },
];

describe("images integrees", () => {
  it("normalise un Content-ID", () => {
    expect(normalizeCid(" <Abc@X> ")).toBe("abc@x");
  });

  it("releve les cid references par le corps", () => {
    expect([...referencedCids('<img src="cid:logo@mail"><img src=\'cid:ii_1%40x\'>')]).toEqual(["logo@mail", "ii_1@x"]);
  });

  it("remplace cid: par l'URL du fichier joint, et laisse les inconnus", () => {
    const html = '<img width="80" src="cid:logo@mail"><img src="cid:inconnu@x">';
    expect(resolveCidImages(html, items)).toBe(
      '<img width="80" src="/api/files/attachments/a1/logo.png"><img src="cid:inconnu@x">',
    );
  });

  it("ecrit taille et alignement en style inline", () => {
    expect(inlineImageStyle("medium", "center")).toContain("width:50%");
    expect(inlineImageStyle("medium", "center")).toContain("margin-left:auto;margin-right:auto");
    expect(inlineImageStyle("original", "left")).not.toMatch(/(^|;)width:/);
  });
});
