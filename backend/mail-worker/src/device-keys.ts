/**
 * Cles d'appareil signees (application iPhone : widgets + actions de
 * notification, sans session web). Methode "cle-appareil-signee" :
 *
 * - Table `device_keys` SANS secret : (user, key_id, nonce, last_ts, revoked_at).
 * - secret = HMAC-SHA256(secret serveur, "device:<user>:<key_id>:<nonce>")
 *   identifiant public = "<user>.<key_id>.<nonce>", rendu UNE fois a l'emission
 *   (route AVEC session PocketBase), garde par l'app dans le trousseau partage
 *   app <-> widget.
 * - Chaque requete : en-tetes X-Device-Id, X-Device-Ts (ms), X-Device-Sig =
 *   hex(HMAC(secret, "<ts>.<id>.<sha256 hex du corps BRUT>")).
 * - Serveur : recalcul + comparaison a temps constant + fraicheur +-5 min AVANT
 *   toute lecture en base ; puis cle non revoquee, du bon utilisateur, et ts
 *   STRICTEMENT croissant (anti-rejeu, garde memoire atomique dans le process).
 *
 * Le secret serveur derive d'ENCRYPTION_KEY (deja secret du worker, comme le
 * pixel de lecture) : le changer invalide toutes les cles -> l'app en
 * redemande une a l'ouverture (401).
 */
import crypto from "crypto";
import { pbAdminFetch } from "./pocketbase";

export const DEVICE_TS_WINDOW_MS = 5 * 60 * 1000;
export const MAX_LIVE_KEYS_PER_USER = 10;

function serverSecret(): Buffer {
  const base = process.env.DEVICE_KEY_SECRET || process.env.ENCRYPTION_KEY || "";
  if (!base) throw new Error("DEVICE_KEY_SECRET / ENCRYPTION_KEY manquant");
  return crypto.createHmac("sha256", base).update("haikomail-device-keys-v1").digest();
}

export function deviceSecret(userId: string, keyId: string, nonce: string): string {
  return crypto
    .createHmac("sha256", serverSecret())
    .update(`device:${userId}:${keyId}:${nonce}`)
    .digest("base64url");
}

export function signDeviceRequest(secret: string, ts: number, deviceId: string, rawBody: Buffer | string): string {
  const bodyHash = crypto.createHash("sha256").update(rawBody || "").digest("hex");
  return crypto.createHmac("sha256", secret).update(`${ts}.${deviceId}.${bodyHash}`).digest("hex");
}

export interface ParsedDeviceId {
  userId: string;
  keyId: string;
  nonce: string;
}

export function parseDeviceId(id: string): ParsedDeviceId | null {
  const parts = String(id || "").split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[a-z0-9]{6,64}$/i.test(p))) return null;
  return { userId: parts[0], keyId: parts[1], nonce: parts[2] };
}

/**
 * Verification CRYPTOGRAPHIQUE seule (aucune lecture en base) : signature +
 * fraicheur. Rend l'identifiant decoupe, ou la raison du refus.
 */
export function verifyDeviceSignature(
  headers: { id?: string; ts?: string; sig?: string },
  rawBody: Buffer | string,
  now: number = Date.now()
): { ok: true; parsed: ParsedDeviceId; ts: number } | { ok: false; reason: string } {
  const parsed = parseDeviceId(headers.id || "");
  if (!parsed) return { ok: false, reason: "bad device id" };
  const ts = Number(headers.ts);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > DEVICE_TS_WINDOW_MS) return { ok: false, reason: "stale timestamp" };
  const sig = String(headers.sig || "");
  if (!/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, reason: "bad signature" };
  const expected = signDeviceRequest(deviceSecret(parsed.userId, parsed.keyId, parsed.nonce), ts, headers.id!, rawBody);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig.toLowerCase(), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  return { ok: true, parsed, ts };
}

interface DeviceKeyRecord {
  id: string;
  user: string;
  key_id: string;
  nonce: string;
  platform: string;
  device_name: string;
  last_ts: number;
  revoked_at: string;
  created: string;
}

// Plus grand ts accepte par cle, dans CE process : la verification et la
// mise a jour sont synchrones ici (pas d'await entre les deux) -> deux requetes
// identiques simultanees ne passent jamais toutes les deux.
const lastTsSeen = new Map<string, number>();

async function findKey(userId: string, keyId: string): Promise<DeviceKeyRecord | null> {
  const res = (await pbAdminFetch("/api/collections/device_keys/records", {
    params: { filter: `user="${userId}" && key_id="${keyId}"`, perPage: "1" },
  })) as { items: DeviceKeyRecord[] };
  return res.items[0] || null;
}

/**
 * Authentifie une requete signee. Rend l'utilisateur, ou le statut HTTP de
 * refus (401). Une requete rejouee (meme ts ou plus ancien) est refusee.
 */
export async function authenticateDeviceRequest(
  headers: { id?: string; ts?: string; sig?: string },
  rawBody: Buffer | string
): Promise<{ userId: string; keyRecordId: string } | { status: 401; reason: string }> {
  const v = verifyDeviceSignature(headers, rawBody);
  if (!v.ok) return { status: 401, reason: v.reason };
  const { userId, keyId, nonce } = v.parsed;
  const rec = await findKey(userId, keyId).catch(() => null);
  if (!rec || rec.user !== userId || rec.nonce !== nonce || rec.revoked_at) {
    return { status: 401, reason: "unknown or revoked key" };
  }
  const mapKey = `${userId}:${keyId}`;
  const floor = Math.max(Number(rec.last_ts) || 0, lastTsSeen.get(mapKey) || 0);
  if (v.ts <= floor) return { status: 401, reason: "replayed request" };
  lastTsSeen.set(mapKey, v.ts);
  void pbAdminFetch(`/api/collections/device_keys/records/${rec.id}`, {
    method: "PATCH",
    body: { last_ts: v.ts },
  }).catch(() => {});
  return { userId, keyRecordId: rec.id };
}

function randomId(bytes = 12): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Emet une cle pour `userId` (deja authentifie par SESSION). Revoque les plus
 * anciennes au-dela du plafond, et l'ancienne cle du MEME appareil.
 */
export async function issueDeviceKey(
  userId: string,
  opts: { platform: string; deviceName: string }
): Promise<{ deviceId: string; secret: string; keyRecordId: string }> {
  const live = (await pbAdminFetch("/api/collections/device_keys/records", {
    params: { filter: `user="${userId}" && revoked_at = ""`, sort: "-created", perPage: "100" },
  })) as { items: DeviceKeyRecord[] };
  const now = new Date().toISOString().replace("T", " ");
  const toRevoke = live.items.filter(
    (k, i) => i >= MAX_LIVE_KEYS_PER_USER - 1 || (opts.deviceName && k.device_name === opts.deviceName)
  );
  for (const k of toRevoke) {
    await pbAdminFetch(`/api/collections/device_keys/records/${k.id}`, {
      method: "PATCH",
      body: { revoked_at: now },
    }).catch(() => {});
  }
  const keyId = randomId(9);
  const nonce = randomId(9);
  const rec = (await pbAdminFetch("/api/collections/device_keys/records", {
    method: "POST",
    body: {
      user: userId,
      key_id: keyId,
      nonce,
      platform: opts.platform.slice(0, 32),
      device_name: opts.deviceName.slice(0, 200),
      last_ts: 0,
    },
  })) as DeviceKeyRecord;
  return { deviceId: `${userId}.${keyId}.${nonce}`, secret: deviceSecret(userId, keyId, nonce), keyRecordId: rec.id };
}

/** Revoque une cle (deconnexion) + retire ses jetons de notification. */
export async function revokeDeviceKey(userId: string, keyRecordId: string): Promise<void> {
  await pbAdminFetch(`/api/collections/device_keys/records/${keyRecordId}`, {
    method: "PATCH",
    body: { revoked_at: new Date().toISOString().replace("T", " ") },
  });
  const tokens = (await pbAdminFetch("/api/collections/push_tokens/records", {
    params: { filter: `user="${userId}" && device_key="${keyRecordId}"`, perPage: "20" },
  })) as { items: { id: string }[] };
  for (const t of tokens.items) {
    await pbAdminFetch(`/api/collections/push_tokens/records/${t.id}`, { method: "DELETE" }).catch(() => {});
  }
}

export function __resetDeviceKeysForTests(): void {
  lastTsSeen.clear();
}
