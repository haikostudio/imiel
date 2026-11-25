import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeTrackingToken,
  parseTrackingToken,
  injectTrackingPixel,
  uniqueRecipientEmails,
  matchRecipientEmail,
  recipientKeyFromEmail,
  TRACKING_PIXEL_MARKER,
} from "../read-receipts";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("read-receipts par destinataire", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://imiel.example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("signe un token ancien (sans destinataire) et le relit", () => {
    const token = makeTrackingToken("abcdefghijklmno");
    expect(token.split(".")).toHaveLength(2);
    expect(parseTrackingToken(token)).toEqual({
      messageId: "abcdefghijklmno",
      recipientKey: null,
    });
  });

  it("signe un token par destinataire sans mettre l'adresse en clair", () => {
    const token = makeTrackingToken("abcdefghijklmno", "Gabriela@Example.com");
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(token.toLowerCase()).not.toContain("gabriela");
    expect(parseTrackingToken(token)).toEqual({
      messageId: "abcdefghijklmno",
      recipientKey: recipientKeyFromEmail("gabriela@example.com"),
    });
  });

  it("refuse un token dont la signature a change", () => {
    const token = makeTrackingToken("abcdefghijklmno", "a@b.com");
    const broken = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(parseTrackingToken(broken)).toBeNull();
  });

  it("injecte un pixel different selon le destinataire", () => {
    const html = "<html><body><p>Hi</p></body></html>";
    const a = injectTrackingPixel(html, "abcdefghijklmno", "one@test.com");
    const b = injectTrackingPixel(html, "abcdefghijklmno", "two@test.com");
    expect(a).toContain(TRACKING_PIXEL_MARKER);
    expect(a).not.toBe(b);
    expect(a).toContain(makeTrackingToken("abcdefghijklmno", "one@test.com"));
  });

  it("dedoublonne To/Cc/Cci et retrouve l'adresse depuis l'empreinte", () => {
    const message = {
      to_addresses: [
        { address: "a@test.com" },
        { address: "A@test.com" },
      ],
      cc_addresses: [{ name: "Bob", address: "bob@test.com" }],
      bcc_addresses: [{ address: "secret@test.com" }],
    };
    const emails = uniqueRecipientEmails(message);
    expect(emails).toEqual(["a@test.com", "bob@test.com", "secret@test.com"]);
    expect(
      matchRecipientEmail(message, recipientKeyFromEmail("bob@test.com"))
    ).toBe("bob@test.com");
  });
});
