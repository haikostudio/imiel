import { createHash } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// Version pour tous : agenda Google seul, client « ordinateur », PKCE.
describe("connexion Google de la version pour tous", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function charger(edition: string) {
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
    vi.stubEnv("IMIEL_EDITION", edition);
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-editeur.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_DESKTOP_CLIENT_ID", "client-ordinateur.apps.googleusercontent.com");
    vi.resetModules();
    return import("./oauth");
  }

  it("ne demande QUE l'agenda, avec PKCE et le client ordinateur, retour sur 127.0.0.1", async () => {
    const o = await charger("tous");
    const url = new URL(o.generateGoogleAuthUrl("u1", "http://127.0.0.1:41977"));
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar");
    expect(scopes).not.toContain("https://mail.google.com/");
    expect(url.searchParams.get("client_id")).toBe("client-ordinateur.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:41977/api/oauth/google/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const etat = o.decodeState(url.searchParams.get("state")!);
    expect(etat.userId).toBe("u1");
    expect(etat.origin).toBe("http://127.0.0.1:41977");
    const defi = createHash("sha256").update(etat.verifier!).digest("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(defi);
  });

  it("l'instance de l'editeur garde la connexion d'avant (courrier + agenda, sans PKCE)", async () => {
    const o = await charger("");
    const url = new URL(o.generateGoogleAuthUrl("u1", "https://mail.example.com"));
    expect(url.searchParams.get("scope")).toContain("https://mail.google.com/");
    expect(url.searchParams.get("client_id")).toBe("client-editeur.apps.googleusercontent.com");
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(o.decodeState(url.searchParams.get("state")!)).toEqual({ userId: "u1", origin: "https://mail.example.com" });
  });
});
