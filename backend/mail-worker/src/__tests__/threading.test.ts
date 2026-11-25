import { describe, it, expect } from "vitest";
import { calculateThreadId } from "../threading";

describe("calculateThreadId", () => {
  it("utilise la premiere reference comme racine du thread", () => {
    const result = calculateThreadId({
      messageId: "<msg1@example.com>",
      inReplyTo: "<msg2@example.com>",
      references: "<root@example.com> <msg2@example.com>",
    });
    // Le resultat doit etre le hash de <root@example.com>
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[a-f0-9]+$/);
  });

  it("utilise In-Reply-To si pas de references", () => {
    const result = calculateThreadId({
      messageId: "<msg1@example.com>",
      inReplyTo: "<parent@example.com>",
      references: "",
    });
    expect(result).toHaveLength(32);
  });

  it("utilise message_id si pas de references ni In-Reply-To", () => {
    const result = calculateThreadId({
      messageId: "<unique@example.com>",
      inReplyTo: "",
      references: "",
    });
    expect(result).toHaveLength(32);
  });

  it("est deterministe pour les memes entrees", () => {
    const headers = {
      messageId: "<msg@test.com>",
      inReplyTo: "",
      references: "<root@test.com>",
    };
    const r1 = calculateThreadId(headers);
    const r2 = calculateThreadId(headers);
    expect(r1).toBe(r2);
  });

  it("produit des thread_id differents pour des racines differentes", () => {
    const r1 = calculateThreadId({
      messageId: "<a@test.com>",
      inReplyTo: "",
      references: "",
    });
    const r2 = calculateThreadId({
      messageId: "<b@test.com>",
      inReplyTo: "",
      references: "",
    });
    expect(r1).not.toBe(r2);
  });

  it("gere des references multiples correctement", () => {
    const result = calculateThreadId({
      messageId: "<reply@test.com>",
      inReplyTo: "<parent@test.com>",
      references: "<root@test.com> <mid@test.com> <parent@test.com>",
    });
    // Doit utiliser <root@test.com> (premiere reference)
    const rootOnly = calculateThreadId({
      messageId: "<root@test.com>",
      inReplyTo: "",
      references: "",
    });
    expect(result).toBe(rootOnly);
  });
});
