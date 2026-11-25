import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ keys: [] as Record<string, unknown>[], calls: 0, seq: 0 }));

vi.mock("./pocketbase", () => ({
  pbAdminFetch: vi.fn(async (path: string, opts: { method?: string; params?: Record<string, string>; body?: Record<string, unknown> } = {}) => {
    db.calls++;
    if (path === "/api/collections/device_keys/records" && (!opts.method || opts.method === "GET")) {
      const f = opts.params?.filter || "";
      const user = /user="([^"]+)"/.exec(f)?.[1];
      const key = /key_id="([^"]+)"/.exec(f)?.[1];
      const live = f.includes('revoked_at = ""');
      return {
        items: db.keys.filter((k) => k.user === user && (!key || k.key_id === key) && (!live || !k.revoked_at)),
      };
    }
    if (path === "/api/collections/device_keys/records" && opts.method === "POST") {
      const rec = { id: `k${++db.seq}`, revoked_at: "", ...opts.body };
      db.keys.push(rec);
      return rec;
    }
    if (path.startsWith("/api/collections/device_keys/records/") && opts.method === "PATCH") {
      const rec = db.keys.find((k) => k.id === path.split("/").pop());
      Object.assign(rec!, opts.body);
      return rec;
    }
    if (path === "/api/collections/push_tokens/records") return { items: [] };
    return {};
  }),
}));

import {
  authenticateDeviceRequest,
  issueDeviceKey,
  revokeDeviceKey,
  signDeviceRequest,
  __resetDeviceKeysForTests,
} from "./device-keys";
import { apnsJwt, buildApnsPayload, __resetApnsForTests } from "./apns";

process.env.ENCRYPTION_KEY = "a".repeat(64);

const canonical = (method: string, path: string, body = "") => Buffer.from(`${method} ${path}\n${body}`);

function signed(deviceId: string, secret: string, ts: number, body: Buffer) {
  return { id: deviceId, ts: String(ts), sig: signDeviceRequest(secret, ts, deviceId, body) };
}

describe("cle d'appareil signee", () => {
  beforeEach(() => {
    db.keys.length = 0;
    db.calls = 0;
    __resetDeviceKeysForTests();
  });

  it("signature juste acceptee, puis rejeu refuse", async () => {
    const { deviceId, secret } = await issueDeviceKey("user000000000001", { platform: "ios", deviceName: "iPhone" });
    const body = canonical("GET", "/device/widgets");
    const ts = Date.now();
    const h = signed(deviceId, secret, ts, body);
    await expect(authenticateDeviceRequest(h, body)).resolves.toMatchObject({ userId: "user000000000001" });
    await expect(authenticateDeviceRequest(h, body)).resolves.toMatchObject({ status: 401, reason: "replayed request" });
  });

  it("corps modifie, horodatage perime, identifiant d'un autre compte : refus SANS lecture en base", async () => {
    const { deviceId, secret } = await issueDeviceKey("user000000000001", { platform: "ios", deviceName: "iPhone" });
    db.calls = 0;
    const body = canonical("POST", "/device/invitations/ev1/respond", '{"response":"accepted"}');
    const ts = Date.now();
    const h = signed(deviceId, secret, ts, body);
    const tampered = canonical("POST", "/device/invitations/ev1/respond", '{"response":"declined"}');
    await expect(authenticateDeviceRequest(h, tampered)).resolves.toMatchObject({ status: 401, reason: "bad signature" });
    const old = signed(deviceId, secret, ts - 6 * 60_000, body);
    await expect(authenticateDeviceRequest(old, body)).resolves.toMatchObject({ status: 401, reason: "stale timestamp" });
    const [, keyId, nonce] = deviceId.split(".");
    const otherUser = `user000000000002.${keyId}.${nonce}`;
    await expect(authenticateDeviceRequest({ ...h, id: otherUser }, body)).resolves.toMatchObject({ status: 401, reason: "bad signature" });
    expect(db.calls).toBe(0);
  });

  it("cle revoquee : refus", async () => {
    const { deviceId, secret } = await issueDeviceKey("user000000000001", { platform: "ios", deviceName: "iPhone" });
    await revokeDeviceKey("user000000000001", String(db.keys[0].id));
    const body = canonical("GET", "/device/widgets");
    await expect(authenticateDeviceRequest(signed(deviceId, secret, Date.now(), body), body)).resolves.toMatchObject({
      status: 401,
      reason: "unknown or revoked key",
    });
  });

  it("une nouvelle cle du meme appareil revoque l'ancienne", async () => {
    await issueDeviceKey("user000000000001", { platform: "ios", deviceName: "iPhone de C" });
    await issueDeviceKey("user000000000001", { platform: "ios", deviceName: "iPhone de C" });
    expect(db.keys.filter((k) => !k.revoked_at)).toHaveLength(1);
  });

  it("aucun secret en base", async () => {
    const { secret } = await issueDeviceKey("user000000000001", { platform: "ios", deviceName: "x" });
    expect(JSON.stringify(db.keys)).not.toContain(secret);
  });
});

describe("APNs", () => {
  it("jeton fournisseur ES256 verifiable avec la cle publique", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.env.APNS_KEY_ID = "T3HPQK4TRF";
    process.env.APNS_TEAM_ID = "ABCDE12345";
    process.env.APNS_KEY_P8_BASE64 = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    __resetApnsForTests();
    const jwt = apnsJwt(1_800_000_000_000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "T3HPQK4TRF" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: "ABCDE12345", iat: 1_800_000_000 });
    const ok = crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });

  it("charge : categorie INVITATION + relance des widgets", () => {
    const p = buildApnsPayload({ title: "Nouvelle invitation", body: "x", category: "INVITATION", data: { eventId: "e1" } }) as {
      aps: Record<string, unknown>;
      eventId: string;
    };
    expect(p.aps.category).toBe("INVITATION");
    expect(p.aps["content-available"]).toBe(1);
    expect(p.eventId).toBe("e1");
  });
});
