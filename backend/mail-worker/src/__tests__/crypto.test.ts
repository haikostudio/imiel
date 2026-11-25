import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encrypt, decrypt } from "../crypto";

// Cle de test valide : 32 bytes = 64 hex chars
const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("crypto", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("encrypt", () => {
    it("retourne un format iv:tag:ciphertext", () => {
      const result = encrypt("hello");
      const parts = result.split(":");
      expect(parts).toHaveLength(3);
    });

    it("produit des sorties differentes pour le meme plaintext (IV aleatoire)", () => {
      const r1 = encrypt("test");
      const r2 = encrypt("test");
      expect(r1).not.toBe(r2);
    });

    it("chiffre une chaine vide", () => {
      const result = encrypt("");
      expect(result.split(":")).toHaveLength(3);
    });

    it("chiffre du texte avec des caracteres speciaux", () => {
      const result = encrypt("héllo wörld! éàü");
      expect(result.split(":")).toHaveLength(3);
    });
  });

  describe("decrypt", () => {
    it("dechiffre correctement un texte chiffre", () => {
      const plaintext = "Hello World!";
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it("dechiffre une chaine vide", () => {
      const encrypted = encrypt("");
      expect(decrypt(encrypted)).toBe("");
    });

    it("dechiffre du texte avec des caracteres UTF-8", () => {
      const plaintext = "Bonjour le monde! éàü 你好";
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it("retourne le texte tel quel si pas au format chiffre", () => {
      expect(decrypt("invalid")).toBe("invalid");
      expect(decrypt("plainpassword")).toBe("plainpassword");
    });

    it("echoue avec une IV invalide", () => {
      expect(() => decrypt("a:b:c")).toThrow();
    });
  });

  describe("validation de la cle", () => {
    it("echoue sans ENCRYPTION_KEY", () => {
      vi.stubEnv("ENCRYPTION_KEY", "");
      expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY environment variable is required");
    });

    it("echoue avec une cle trop courte", () => {
      vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef");
      expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY must be 64 hex characters");
    });
  });
});
