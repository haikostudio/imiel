import { describe, expect, it } from "vitest";
import { hostnameOf, localRequestAllowed } from "./local-mode";

const APP = "http://127.0.0.1:47100";

describe("mode local : gardes Host/Origin", () => {
  it("lit le nom d'hote sans le port", () => {
    expect(hostnameOf("127.0.0.1:47101")).toBe("127.0.0.1");
    expect(hostnameOf("LocalHost:9")).toBe("localhost");
    expect(hostnameOf("[::1]:80")).toBe("[::1]");
    expect(hostnameOf(undefined)).toBe("");
  });

  it("accepte l'interface locale et les appels serveur sans Origin", () => {
    expect(localRequestAllowed("127.0.0.1:47101", APP, APP).ok).toBe(true);
    expect(localRequestAllowed("127.0.0.1:47101", undefined, APP).ok).toBe(true);
    expect(localRequestAllowed("localhost:47101", "", APP).ok).toBe(true);
  });

  it("refuse une page web d'une autre origine (CSRF)", () => {
    const v = localRequestAllowed("127.0.0.1:47101", "https://site-malveillant.example", APP);
    expect(v.ok).toBe(false);
  });

  it("refuse un nom d'hote etranger (DNS rebinding)", () => {
    const v = localRequestAllowed("attaque.example:47101", undefined, APP);
    expect(v.ok).toBe(false);
  });

  it("refuse Origin null (iframe sandbox, fichier local)", () => {
    expect(localRequestAllowed("127.0.0.1:47101", "null", APP).ok).toBe(false);
  });
});
