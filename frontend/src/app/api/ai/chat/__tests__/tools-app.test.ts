import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns", () => {
  const promises = { resolveMx: vi.fn(async (d: string) => (d === "voyage-example.com" ? [{ exchange: "mta-gw.infomaniak.ch", priority: 5 }] : [])) };
  return { default: { promises }, promises };
});

import { buildAppAction, runAppReadTool } from "../tools-app";
import type { AccountCreatePayload, RecordPayload } from "@/lib/ai-actions-types";

const ctx = { userId: "u1", authToken: "tok" };

/** Faux PocketBase : rend des enregistrements par collection et note les URL. */
function mockPb(data: Record<string, unknown[]>, user: Record<string, unknown> = {}) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const m = /\/api\/collections\/([^/]+)\/records(\/[^?]+)?/.exec(url);
    const col = m?.[1] || "";
    if (col === "users" && m?.[2]) return new Response(JSON.stringify({ id: "u1", ...user }), { status: 200 });
    return new Response(JSON.stringify({ items: data[col] || [] }), { status: 200 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("propose_account_create", () => {
  beforeEach(() => { mockPb({ accounts: [] }); });

  it("remplit Infomaniak pour un domaine perso nomme dans la demande", async () => {
    const a = await buildAppAction("propose_account_create", { email: "hello@voyage-example.com", provider: "Infomaniak" }, ctx, "g");
    const p = a.payload as AccountCreatePayload;
    expect(a.kind).toBe("account_create");
    expect(p).toMatchObject({
      provider: "infomaniak", oauth: "", imap_host: "mail.infomaniak.com", imap_port: 993, imap_security: "ssl",
      smtp_host: "mail.infomaniak.com", smtp_port: 587, smtp_security: "starttls", imap_username: "hello@voyage-example.com", password: "",
    });
  });

  it("garde un mot de passe ecrit par l'utilisateur, jamais un mot de passe invente", async () => {
    const given = await buildAppAction("propose_account_create", { email: "a@ik.me", password: "Vrai-123" }, { ...ctx, userText: "ajoute a@ik.me mot de passe Vrai-123" }, "g");
    expect((given.payload as AccountCreatePayload).password).toBe("Vrai-123");
    const invented = await buildAppAction("propose_account_create", { email: "a@ik.me", password: "Invente-1" }, { ...ctx, userText: "ajoute a@ik.me" }, "g");
    expect((invented.payload as AccountCreatePayload).password).toBe("");
    const copied = await buildAppAction("propose_account_create", { email: "a@ik.me", provider: "Infomaniak", password: "Infomaniak" }, { ...ctx, userText: "configure a@ik.me (Infomaniak)" }, "g");
    expect((copied.payload as AccountCreatePayload).password).toBe("");
    const email = await buildAppAction("propose_account_create", { email: "a@ik.me", password: "a@ik.me" }, { ...ctx, userText: "configure a@ik.me, mot de passe pareil" }, "g");
    expect((email.payload as AccountCreatePayload).password).toBe("");
  });

  it("reconnait Infomaniak par les serveurs MX sans fournisseur cite", async () => {
    const a = await buildAppAction("propose_account_create", { email: "hello@voyage-example.com" }, ctx, "g");
    expect((a.payload as AccountCreatePayload).provider).toBe("infomaniak");
  });

  it("Gmail passe par la connexion Google", async () => {
    const a = await buildAppAction("propose_account_create", { email: "x@gmail.com" }, ctx, "g");
    expect((a.payload as AccountCreatePayload).oauth).toBe("google");
  });

  it("fournisseur inconnu : demande au modele de se renseigner", async () => {
    await expect(buildAppAction("propose_account_create", { email: "a@inconnu.example" }, ctx, "g")).rejects.toThrow(/fournisseur non reconnu/);
  });

  it("refuse un compte deja configure", async () => {
    mockPb({ accounts: [{ id: "a1", email: "hello@voyage-example.com" }] });
    await expect(buildAppAction("propose_account_create", { email: "hello@voyage-example.com", provider: "infomaniak" }, ctx, "g")).rejects.toThrow(/deja configure/);
  });
});

describe("list_app_data", () => {
  it("ne demande jamais les mots de passe des comptes", async () => {
    const calls = mockPb({ accounts: [{ id: "a1", email: "a@b.c", imap_host: "h" }] });
    const r = (await runAppReadTool("list_app_data", { what: ["accounts"] }, ctx)) as { accounts: unknown[] };
    expect(r.accounts).toHaveLength(1);
    const url = decodeURIComponent(calls.find((c) => c.includes("/accounts/"))!);
    expect(url).toContain("fields=");
    expect(url).not.toMatch(/password|oauth_/);
    expect(JSON.stringify(r)).not.toMatch(/password/);
  });
});

describe("cartes avant -> apres", () => {
  it("suppression d'etiquette : liste ce qui part", async () => {
    mockPb({ labels: [{ id: "l1", name: "Factures", color: "#f00", is_secondary: false }] });
    const a = await buildAppAction("propose_labels", { op: "delete", items: [{ id: "l1" }, { id: "inconnu" }] }, ctx, "g");
    expect(a.kind).toBe("label_delete");
    expect((a.payload as RecordPayload).items).toEqual([{ id: "l1", title: "Factures", after: {} }]);
  });

  it("modification d'etiquette : avant et apres", async () => {
    mockPb({ labels: [{ id: "l1", name: "Factures", color: "#f00", is_secondary: false }] });
    const a = await buildAppAction("propose_labels", { op: "update", items: [{ id: "l1", name: "Compta" }] }, ctx, "g");
    expect((a.payload as RecordPayload).items[0]).toMatchObject({ before: { name: "Factures" }, after: { name: "Compta" } });
  });

  it("reglages : seuls les champs de la liste blanche passent", async () => {
    mockPb({}, { theme: "light", openrouter_api_key: "" });
    const a = await buildAppAction("propose_settings", { theme: "dark", openrouter_api_key: "sk-x", cerveau_api_key: "k" }, ctx, "g");
    const it0 = (a.payload as RecordPayload).items[0];
    expect(it0.after).toEqual({ theme: "dark" });
    expect(it0.before).toEqual({ theme: "light" });
  });

  it("dossiers systeme intouchables", async () => {
    mockPb({ accounts: [{ id: "a1", email: "a@b.c" }], folders: [{ id: "f1", name: "INBOX", type: "inbox", account: "a1" }] });
    await expect(buildAppAction("propose_folders", { op: "delete", items: [{ id: "f1" }] }, ctx, "g")).rejects.toThrow(/systeme/);
  });

  it("signature : refuse un script", async () => {
    mockPb({ accounts: [{ id: "a1", email: "a@b.c", signature: "" }] });
    await expect(buildAppAction("propose_signature", { account_id: "a1", html: "<p onclick=\"x()\">a</p>" }, ctx, "g")).rejects.toThrow(/refuse/);
    const ok = await buildAppAction("propose_signature", { account_id: "a1", html: "<p><strong>Chris</strong></p>" }, ctx, "g");
    expect(ok.kind).toBe("signature_set");
  });
});

describe("garde-fou carte imaginaire", async () => {
  const { claimsCardWithoutAction } = await import("../tools");
  it("reconnait une carte annoncee sans appel", () => {
    expect(claimsCardWithoutAction("Une carte vous sera présentée pour validation.")).toBe(true);
    expect(claimsCardWithoutAction("[Actions: Proposition de signature en attente de validation.]")).toBe(true);
    expect(claimsCardWithoutAction("Proposition de création de l'étiquette en attente.")).toBe(true);
  });
  it("laisse passer une reponse normale", () => {
    expect(claimsCardWithoutAction("Le compte hello@voyage-example.com est deja configure dans iMiel.")).toBe(false);
    expect(claimsCardWithoutAction("Vous avez refuse la carte proposee, rien n'a ete fait.")).toBe(false);
  });
});
