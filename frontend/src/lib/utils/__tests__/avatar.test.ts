import { describe, it, expect } from "vitest";
import { getInitials, getAvatarColor } from "../avatar";

describe("getInitials", () => {
  it("retourne les initiales d'un nom complet", () => {
    expect(getInitials("Jean Dupont")).toBe("JD");
  });

  it("retourne les 2 premieres lettres d'un nom simple", () => {
    expect(getInitials("Alice")).toBe("AL");
  });

  it("retourne les 2 premieres lettres avant @ pour un email", () => {
    expect(getInitials("alice@example.com")).toBe("AL");
  });

  it("retourne '?' pour une chaine vide", () => {
    expect(getInitials("")).toBe("?");
  });

  it("retourne '?' pour null", () => {
    expect(getInitials(null)).toBe("?");
  });

  it("retourne '?' pour undefined", () => {
    expect(getInitials(undefined)).toBe("?");
  });

  it("retourne '?' pour une chaine d'espaces", () => {
    expect(getInitials("   ")).toBe("?");
  });

  it("gere un nom avec plusieurs espaces", () => {
    expect(getInitials("Jean  Pierre  Dupont")).toBe("JD");
  });

  it("retourne en majuscules", () => {
    expect(getInitials("jean dupont")).toBe("JD");
  });

  it("gere un email avec un seul caractere avant @", () => {
    expect(getInitials("a@test.com")).toBe("A");
  });
});

describe("getAvatarColor", () => {
  it("retourne un gris pour null", () => {
    expect(getAvatarColor(null)).toBe("hsl(0, 0%, 65%)");
  });

  it("retourne un gris pour undefined", () => {
    expect(getAvatarColor(undefined)).toBe("hsl(0, 0%, 65%)");
  });

  it("retourne un gris pour une chaine vide", () => {
    expect(getAvatarColor("")).toBe("hsl(0, 0%, 65%)");
  });

  it("retourne une couleur HSL valide", () => {
    const color = getAvatarColor("test@example.com");
    expect(color).toMatch(/^hsl\(\d+, 65%, 55%\)$/);
  });

  it("est deterministe (meme email = meme couleur)", () => {
    const color1 = getAvatarColor("alice@test.com");
    const color2 = getAvatarColor("alice@test.com");
    expect(color1).toBe(color2);
  });

  it("genere des couleurs differentes pour des emails differents", () => {
    const color1 = getAvatarColor("alice@test.com");
    const color2 = getAvatarColor("bob@test.com");
    expect(color1).not.toBe(color2);
  });
});
