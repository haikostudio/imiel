/**
 * Cles d'API de l'onglet Connectivite.
 *
 * Une cle `hkm_...` ouvre le connecteur MCP en ligne (POST /mcp) pour la boite
 * de SON proprietaire, avec des droits "read" (consulter, chercher) ou "full"
 * (tout, envoi et suppression compris). Seule l'empreinte SHA-256 est gardee
 * (champ cache `key_hash`) : la cle entiere n'est montree qu'a la creation.
 *
 * La recherche de la cle se fait A CHAQUE requete (aucun cache) : une cle
 * supprimee est refusee immediatement. Seul le jeton utilisateur fabrique par
 * impersonation est mis en cache, et il n'est jamais rendu sans cle valide.
 */

import { createHash, randomBytes } from "crypto";
import {
  createApiKeyRecord,
  findApiKeyByHash,
  impersonateUser,
  listAllApiKeys,
  updateApiKeyRecord,
  type PBApiKey,
} from "./pocketbase";
import { sendPushToUser } from "./push";

export const API_KEY_PREFIX = "hkm_";
/** Une cle sans usage depuis ce delai est signalee (une seule fois). */
export const API_KEY_INACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** last_used n'est reecrit qu'une fois par minute et par cle. */
const TOUCH_INTERVAL_MS = 60 * 1000;
/** Duree du jeton utilisateur fabrique pour le connecteur. */
const IMPERSONATE_SEC = 15 * 60;

export type ApiKeyScope = "read" | "full";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function isApiKeyScope(v: unknown): v is ApiKeyScope {
  return v === "read" || v === "full";
}

/** Cree une cle et rend la cle ENTIERE (seule fois ou elle existe en clair). */
export async function createApiKey(
  userId: string,
  name: string,
  scope: ApiKeyScope
): Promise<{ key: string; record: PBApiKey }> {
  const key = generateApiKey();
  const record = await createApiKeyRecord({
    user: userId,
    name: name.trim().slice(0, 80) || "Cle",
    scope,
    key_hash: hashApiKey(key),
    prefix: key.slice(0, API_KEY_PREFIX.length + 6),
  });
  return { key, record };
}

export interface ResolvedApiKey {
  keyId: string;
  userId: string;
  scope: ApiKeyScope;
  /** Jeton PocketBase de l'utilisateur, pour l'API headless. */
  userToken: string;
}

const lastTouch = new Map<string, number>();
const tokenCache = new Map<string, { token: string; expires: number }>();

async function userTokenFor(userId: string): Promise<string> {
  const hit = tokenCache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.token;
  const token = await impersonateUser(userId, IMPERSONATE_SEC);
  // Marge de 2 minutes avant l'expiration reelle.
  tokenCache.set(userId, { token, expires: Date.now() + (IMPERSONATE_SEC - 120) * 1000 });
  return token;
}

/** Cle presentee (en-tete Authorization) -> proprietaire + droits, ou null. */
export async function resolveApiKey(authorization: string | undefined): Promise<ResolvedApiKey | null> {
  const raw = (authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!raw.startsWith(API_KEY_PREFIX) || raw.length < 20) return null;
  const rec = await findApiKeyByHash(hashApiKey(raw));
  if (!rec || !isApiKeyScope(rec.scope)) return null;

  const now = Date.now();
  // Ecriture si la base est perimee (> 1 min) ou si une alerte est posee ; le
  // repere en memoire evite seulement les rafales de quelques secondes.
  const dbLast = Date.parse((rec.last_used || "").replace(" ", "T"));
  const stale = !Number.isFinite(dbLast) || now - dbLast > TOUCH_INTERVAL_MS || !!rec.inactive_notified_at;
  if (stale && now - (lastTouch.get(rec.id) || 0) > 5_000) {
    lastTouch.set(rec.id, now);
    // Un usage remet le compteur d'inactivite a zero (nouvelle alerte possible
    // apres 30 jours de silence).
    updateApiKeyRecord(rec.id, {
      last_used: new Date(now).toISOString(),
      inactive_notified_at: "",
    }).catch((err) => console.warn("[api-keys] touch failed:", (err as Error).message));
  }

  return { keyId: rec.id, userId: rec.user, scope: rec.scope, userToken: await userTokenFor(rec.user) };
}

/** Dernier signe de vie d'une cle : derniere utilisation, sinon sa creation. */
export function lastActivity(rec: Pick<PBApiKey, "last_used" | "created">): number {
  const t = Date.parse((rec.last_used || rec.created || "").replace(" ", "T"));
  return Number.isFinite(t) ? t : Date.now();
}

/** La cle doit-elle etre signalee maintenant ? (une seule fois par silence) */
export function shouldNotifyInactive(
  rec: Pick<PBApiKey, "last_used" | "created" | "inactive_notified_at">,
  now = Date.now()
): boolean {
  if (rec.inactive_notified_at) return false;
  return now - lastActivity(rec) >= API_KEY_INACTIVE_DAYS * DAY_MS;
}

/**
 * Controle periodique : une notification par cle restee 30 jours sans servir.
 * Rend le nombre de notifications envoyees.
 */
export async function notifyInactiveApiKeys(): Promise<number> {
  const keys = await listAllApiKeys();
  let sent = 0;
  for (const rec of keys) {
    if (!shouldNotifyInactive(rec)) continue;
    // Marque AVANT d'envoyer : un echec de push ne doit pas faire harceler.
    await updateApiKeyRecord(rec.id, { inactive_notified_at: new Date().toISOString() });
    await sendPushToUser(rec.user, {
      title: "\u{1F511} Cle d'acces inutilisee",
      body: `La cle "${rec.name}" n'a pas servi depuis ${API_KEY_INACTIVE_DAYS} jours. Supprimez-la si plus aucun outil n'en a besoin.`,
      url: "/#/settings?tab=connectivity",
      tag: `api-key-inactive-${rec.id}`,
    }).catch((err) => console.warn("[api-keys] push failed:", (err as Error).message));
    sent++;
  }
  if (sent) console.log(`[api-keys] ${sent} cle(s) inactive(s) signalee(s)`);
  return sent;
}
