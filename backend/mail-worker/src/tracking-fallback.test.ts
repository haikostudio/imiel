import { beforeEach, describe, expect, it, vi } from "vitest";

// Extraction LLM vide sur une fiche EXISTANTE : le message doit quand meme
// entrer dans la timeline (cas reel : reponse envoyee depuis l'app, invisible
// avant un clic "Reconstruire").
const created: Array<Record<string, unknown>> = [];
const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
const existingMessages = new Set<string>();

vi.mock("./pocketbase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pocketbase")>();
  return {
    ...actual,
    createTrackingEvent: vi.fn(async (data: Record<string, unknown>) => {
      if (existingMessages.has(String(data.message))) throw new Error("UNIQUE");
      existingMessages.add(String(data.message));
      created.push(data);
      return { id: `ev-${created.length}`, ...data };
    }),
    updateTrackingItem: vi.fn(async (id: string, data: Record<string, unknown>) => {
      updates.push({ id, data });
      return { id, ...data };
    }),
    countTrackingEvents: vi.fn(async () => existingMessages.size),
  };
});

import { persistThreadWithoutLlm } from "./tracking";
import type { PBTrackingItem } from "./pocketbase";

function msg(id: string, date: string, isSent: boolean, body: string) {
  return {
    id,
    subject: "Inscription",
    snippet: body,
    text_body: `${body} https://exemple.test/lien`,
    html_body: "",
    from_address: isSent ? { address: "moi@studio.example.com" } : { name: "Support", address: "s@v.com" },
    is_sent: isSent,
    has_attachments: false,
    date,
    account: "acc1",
  };
}

const item = {
  id: "item1",
  title: "Inscription Verotel",
  status: "active",
  thread_id: "thr1",
  thread_ids: ["thr1"],
  last_message_id: "m1",
  last_message_date: "2026-10-02 11:47:00.000Z",
  fields: { reference: "X1" },
} as unknown as PBTrackingItem;

describe("persistThreadWithoutLlm", () => {
  beforeEach(() => {
    created.length = 0;
    updates.length = 0;
    existingMessages.clear();
  });

  it("cree l'evenement manquant sans doublonner ni toucher titre/champs/statut", async () => {
    existingMessages.add("m1"); // deja synthetise par une passe precedente
    const messages = [
      msg("m1", "2026-10-02 11:47:00.000Z", false, "Votre inscription est en cours"),
      msg("m2", "2026-10-02 11:58:23.000Z", true, "Merci, voici les documents"),
    ];
    const n = await persistThreadWithoutLlm("u1", item, "thr1", messages);

    expect(n).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ item: "item1", message: "m2", kind: "update", author: "", label: "" });
    expect(String(created[0].detail)).toBe("Merci, voici les documents");

    expect(updates).toHaveLength(1);
    const data = updates[0].data;
    expect(data).toMatchObject({ last_message_id: "m2", event_count: 2, thread_ids: ["thr1"] });
    expect(data).not.toHaveProperty("title");
    expect(data).not.toHaveProperty("fields");
    expect(data).not.toHaveProperty("status");
    // Envoi de l'utilisateur : pas de badge "non lu".
    expect(data).not.toHaveProperty("is_read");
  });

  it("un message entrant repasse la fiche en non lu", async () => {
    const messages = [msg("m3", "2026-10-03 08:00:00.000Z", false, "Compte valide")];
    await persistThreadWithoutLlm("u1", item, "thr1", messages);
    expect(created[0]).toMatchObject({ message: "m3", author: "Support" });
    expect(updates[0].data).toMatchObject({ is_read: false });
  });

  it("idempotent : rejouer ne cree rien de plus", async () => {
    const messages = [msg("m4", "2026-10-03 09:00:00.000Z", false, "Relance")];
    await persistThreadWithoutLlm("u1", item, "thr1", messages);
    const again = await persistThreadWithoutLlm("u1", item, "thr1", messages);
    expect(again).toBe(0);
    expect(created).toHaveLength(1);
  });
});
