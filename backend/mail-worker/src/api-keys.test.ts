import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, shouldNotifyInactive, API_KEY_PREFIX } from "./api-keys";
import { toolNamesForScope } from "./mcp-tools";

const DAY = 86_400_000;

describe("cles d'API", () => {
  it("cle hkm_ et empreinte stable de 64 signes", () => {
    const k = generateApiKey();
    expect(k.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(k.length).toBeGreaterThan(40);
    expect(hashApiKey(k)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashApiKey(` ${k} `)).toBe(hashApiKey(k));
    expect(generateApiKey()).not.toBe(k);
  });
  it("alerte apres 30 jours de silence, une seule fois", () => {
    const now = Date.parse("2026-10-16T10:00:00Z");
    const old = new Date(now - 31 * DAY).toISOString().replace("T", " ");
    const recent = new Date(now - 2 * DAY).toISOString().replace("T", " ");
    expect(shouldNotifyInactive({ last_used: "", created: old, inactive_notified_at: "" }, now)).toBe(true);
    expect(shouldNotifyInactive({ last_used: recent, created: old, inactive_notified_at: "" }, now)).toBe(false);
    expect(shouldNotifyInactive({ last_used: old, created: old, inactive_notified_at: recent }, now)).toBe(false);
  });
});

describe("outils du connecteur", () => {
  it("une cle en lecture seule ne voit aucun outil d'ecriture", () => {
    const read = toolNamesForScope("read");
    const full = toolNamesForScope("full");
    expect(full).toHaveLength(26);
    for (const w of ["send_mail", "reply_mail", "delete_message", "message_action", "create_draft", "delete_draft", "update_draft", "sync_account"]) {
      expect(read).not.toContain(w);
      expect(full).toContain(w);
    }
    expect(read).toContain("search_messages");
    expect(read).toContain("get_thread");
  });
});
