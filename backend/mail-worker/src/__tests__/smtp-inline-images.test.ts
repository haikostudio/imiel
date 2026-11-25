import { describe, it, expect } from "vitest";
import { linkInlineImages } from "../smtp";

const att = { id: "abc123", content_id: "u1@imiel", is_inline: true };

describe("linkInlineImages", () => {
  it("remplace l'URL du fichier joint par cid: en gardant taille et alignement", () => {
    const html = '<p>x</p><img src="/api/files/attachments/abc123/photo_x.png" data-size="medium" style="display:block;width:50%">';
    expect(linkInlineImages(html, [att])).toBe(
      '<p>x</p><img src="cid:u1@imiel" data-size="medium" style="display:block;width:50%">',
    );
  });

  it("accepte une URL absolue et un autre attribut avant src", () => {
    const html = "<img alt=\"a\" src='https://pb.example/api/files/pbc_1/abc123/p.jpg?token='>";
    expect(linkInlineImages(html, [att])).toBe("<img alt=\"a\" src='cid:u1@imiel'>");
  });

  it("ne touche ni les pieces jointes classiques ni les autres images", () => {
    const html = '<img src="/api/files/attachments/zzz/p.png"><img src="https://x/y.png">';
    expect(linkInlineImages(html, [att, { id: "zzz", content_id: "", is_inline: false }])).toBe(html);
  });
});
