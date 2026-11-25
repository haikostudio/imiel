/**
 * Notifications de l'application iPhone (APNs, HTTP/2 + jeton ES256 signe avec
 * la cle d'equipe .p8). Variables du worker :
 *   APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8_BASE64 (contenu .p8 en base64),
 *   APNS_BUNDLE_ID (defaut studio.haiko.imiel).
 * L'URL de chaque appareil (production ou sandbox) est stockee dans
 * push_tokens.endpoint a l'enregistrement : rien a deviner a l'envoi.
 */
import crypto from "crypto";
import http2 from "http2";

export interface ApnsMessage {
  title: string;
  body: string;
  /** Regroupe / remplace (apns-collapse-id, 64 octets max). */
  collapseId?: string;
  /** Categorie d'actions (ex. INVITATION : Accepter / Refuser). */
  category?: string;
  threadId?: string;
  /** Donnees libres lues par l'app (url, eventId...). */
  data?: Record<string, unknown>;
}

export function apnsConfigured(): boolean {
  return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_KEY_P8_BASE64);
}

let cachedJwt: { token: string; at: number } | null = null;

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

/** Jeton fournisseur APNs (valable 60 min, renouvele toutes les 50). */
export function apnsJwt(now: number = Date.now()): string {
  if (cachedJwt && now - cachedJwt.at < 50 * 60 * 1000) return cachedJwt.token;
  const keyId = process.env.APNS_KEY_ID || "";
  const teamId = process.env.APNS_TEAM_ID || "";
  const p8 = Buffer.from(process.env.APNS_KEY_P8_BASE64 || "", "base64").toString("utf8");
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const signingInput = `${header}.${claims}`;
  const sig = crypto.sign("sha256", Buffer.from(signingInput), { key: p8, dsaEncoding: "ieee-p1363" });
  const token = `${signingInput}.${b64url(sig)}`;
  cachedJwt = { token, at: now };
  return token;
}

/** Corps APNs : alerte + categorie + relance des widgets (content-available). */
export function buildApnsPayload(msg: ApnsMessage): Record<string, unknown> {
  return {
    aps: {
      alert: { title: msg.title, body: msg.body },
      sound: "default",
      "mutable-content": 1,
      // Reveille l'app en arriere-plan : elle recharge les widgets.
      "content-available": 1,
      ...(msg.category ? { category: msg.category } : {}),
      ...(msg.threadId ? { "thread-id": msg.threadId } : {}),
    },
    ...(msg.data || {}),
  };
}

export interface ApnsResult {
  endpoint: string;
  ok: boolean;
  status: number;
  /** Jeton mort (desinstallation) : a supprimer. */
  gone: boolean;
  reason?: string;
}

/** Envoie a plusieurs appareils (une connexion HTTP/2 par hote). */
export async function sendApns(endpoints: string[], msg: ApnsMessage): Promise<ApnsResult[]> {
  if (!apnsConfigured() || endpoints.length === 0) return [];
  const topic = process.env.APNS_BUNDLE_ID || "studio.haiko.imiel";
  const payload = JSON.stringify(buildApnsPayload(msg));
  const byHost = new Map<string, string[]>();
  for (const ep of endpoints) {
    try {
      const u = new URL(ep);
      const list = byHost.get(u.origin) || [];
      list.push(ep);
      byHost.set(u.origin, list);
    } catch {
      /* endpoint invalide : ignore */
    }
  }
  const results: ApnsResult[] = [];
  for (const [origin, eps] of byHost) {
    const client = http2.connect(origin);
    client.on("error", () => {});
    try {
      await Promise.all(
        eps.map(
          (ep) =>
            new Promise<void>((resolve) => {
              const path = new URL(ep).pathname;
              const req = client.request({
                ":method": "POST",
                ":path": path,
                authorization: `bearer ${apnsJwt()}`,
                "apns-topic": topic,
                "apns-push-type": "alert",
                "apns-priority": "10",
                ...(msg.collapseId ? { "apns-collapse-id": msg.collapseId.slice(0, 64) } : {}),
                "content-type": "application/json",
              });
              let status = 0;
              let body = "";
              req.setTimeout(10_000, () => req.close());
              req.on("response", (h) => {
                status = Number(h[":status"]) || 0;
              });
              req.on("data", (c) => (body += c));
              req.on("end", () => {
                let reason = "";
                try {
                  reason = (JSON.parse(body || "{}") as { reason?: string }).reason || "";
                } catch {
                  /* corps vide */
                }
                results.push({
                  endpoint: ep,
                  ok: status === 200,
                  status,
                  gone: status === 410 || reason === "BadDeviceToken" || reason === "Unregistered",
                  reason,
                });
                resolve();
              });
              req.on("error", (err) => {
                results.push({ endpoint: ep, ok: false, status: 0, gone: false, reason: err.message });
                resolve();
              });
              req.end(payload);
            })
        )
      );
    } finally {
      client.close();
    }
  }
  return results;
}

export function __resetApnsForTests(): void {
  cachedJwt = null;
}
