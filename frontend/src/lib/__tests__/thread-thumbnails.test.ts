import { describe, expect, it } from "vitest";
import { INLINE_PHOTO_MIN_BYTES, isImageFile, pickThumbnailItems } from "../utils/thread-thumbnails";

const att = (filename: string, size: number | undefined, isInline: boolean, contentType?: string) => ({
  filename,
  size,
  isInline,
  contentType,
});

describe("pickThumbnailItems", () => {
  it("garde toutes les images jointes et ecarte les autres fichiers", () => {
    const items = [att("photo.jpg", 900_000, false), att("devis.pdf", 50_000, false), att("scan", 30_000, false, "image/png")];
    expect(pickThumbnailItems(items).map((i) => i.filename)).toEqual(["photo.jpg", "scan"]);
  });

  it("ecarte les petites images du texte (logos de signature) mais garde les vraies photos", () => {
    const items = [
      att("image001.png", 4_200, true),
      att("linkedin.png", 1_100, true),
      att("inline-photo.jpg", 350_000, true),
      att("sans-taille.png", undefined, true),
      att("haiko-logo.png", 43_608, true),
      att("Facebook-Like.jpeg", 30_000, true),
    ];
    expect(pickThumbnailItems(items).map((i) => i.filename)).toEqual(["inline-photo.jpg"]);
  });

  it("garde une petite image JOINTE (pas inline)", () => {
    expect(pickThumbnailItems([att("icone.png", INLINE_PHOTO_MIN_BYTES - 1, false)])).toHaveLength(1);
  });

  it("ne donne qu'une vignette a une image repetee dans plusieurs messages", () => {
    const items = [att("Plan.JPG", 200_000, false), att("plan.jpg", 200_000, false), att("plan.jpg", 210_000, false)];
    expect(pickThumbnailItems(items)).toHaveLength(2);
  });
});

describe("isImageFile", () => {
  it("reconnait le type ou l'extension", () => {
    expect(isImageFile("a.HEIC")).toBe(true);
    expect(isImageFile("doc.pdf", "application/pdf")).toBe(false);
    expect(isImageFile("png")).toBe(false);
    expect(isImageFile("x", "image/webp")).toBe(true);
  });
});
