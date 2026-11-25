// Sender trust : exploite l'historique de l'utilisateur pour court-circuiter
// la classification spam quand l'expediteur est manifestement legitime.
//
// Heuristiques :
// - "trusted"  : l'utilisateur a deja envoye au moins 1 mail a cette adresse
//                OU le contact agrege >= TRUSTED_CONTACT_COUNT messages.
// - "known"    : l'utilisateur a deja recu >= KNOWN_DOMAIN_COUNT mails de ce
//                domaine dans des dossiers non-spam.
// - "unknown"  : aucun signal -> on laisse Rspamd / LLM trancher.
//
// Le cache est lie a la duree de vie du process (TTL court) pour eviter de
// retaper PocketBase a chaque mail d'une meme sync.

import type { PBAccount } from "./pocketbase";
import {
  getSenderTrustCountsFromSqlite,
  countDomainInboxFromSqlite,
} from "./sqlite-direct";

const TRUSTED_CONTACT_COUNT = 5;
const KNOWN_DOMAIN_COUNT = 5;
const CACHE_TTL_MS = 5 * 60 * 1000;

export type TrustLevel = "trusted" | "known" | "unknown";

export interface SenderTrust {
  level: TrustLevel;
  /** Nombre de mails envoyes par l'utilisateur a cet expediteur. */
  sentToCount: number;
  /** Nombre de mails recus de cet expediteur dans des dossiers non-spam. */
  receivedInboxCount: number;
  /** Compteur agrege issu de la table contacts (recus + envoyes). */
  contactMessageCount: number;
  /** Le domaine est-il deja vu en boite normale (>= KNOWN_DOMAIN_COUNT). */
  knownDomain: boolean;
}

interface CacheEntry {
  trust: SenderTrust;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(userId: string, email: string): string {
  return userId + "|" + email;
}

function getPocketBaseUrl(): string {
  return process.env.POCKETBASE_URL || "http://127.0.0.1:8090";
}

let adminToken: string | null = null;
let tokenExpiry = 0;

async function getAdminToken(): Promise<string> {
  if (adminToken && Date.now() < tokenExpiry) return adminToken;
  const email =
    process.env.PB_ADMIN_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL;
  const password =
    process.env.PB_ADMIN_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are required");
  }
  const res = await fetch(
    getPocketBaseUrl() +
      "/api/collections/_superusers/auth-with-password",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: email, password }),
    }
  );
  if (!res.ok) {
    throw new Error("PocketBase admin auth failed: " + res.status);
  }
  const data = (await res.json()) as { token: string };
  adminToken = data.token;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  return adminToken;
}

async function countMessages(filter: string): Promise<number> {
  const token = await getAdminToken();
  const url =
    getPocketBaseUrl() +
    "/api/collections/messages/records?perPage=1&fields=id&filter=" +
    encodeURIComponent(filter);
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return 0;
  const data = (await res.json()) as { totalItems?: number };
  return data.totalItems || 0;
}

async function countContactMessages(
  userId: string,
  email: string
): Promise<number> {
  const token = await getAdminToken();
  const filter = 'user="' + userId + '" && email="' + email + '"';
  const url =
    getPocketBaseUrl() +
    "/api/collections/contacts/records?perPage=1&fields=message_count&filter=" +
    encodeURIComponent(filter);
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return 0;
  const data = (await res.json()) as {
    items?: { message_count?: number }[];
  };
  return data.items?.[0]?.message_count || 0;
}

/**
 * Calcule la confiance accordee a un expediteur. Resultat cache 5 minutes.
 * Echec PocketBase -> retourne "unknown" (mode degrade prudent).
 */
export async function getSenderTrust(
  account: PBAccount,
  senderEmail: string | undefined | null
): Promise<SenderTrust> {
  const empty: SenderTrust = {
    level: "unknown",
    sentToCount: 0,
    receivedInboxCount: 0,
    contactMessageCount: 0,
    knownDomain: false,
  };
  if (!senderEmail) return empty;
  const email = senderEmail.toLowerCase().trim();
  if (!email.includes("@")) return empty;

  // L'utilisateur ne se met jamais en spam tout seul.
  if (email === (account.email || "").toLowerCase().trim()) {
    return {
      level: "trusted",
      sentToCount: 0,
      receivedInboxCount: 0,
      contactMessageCount: 0,
      knownDomain: true,
    };
  }

  const userId = account.user;
  const key = cacheKey(userId, email);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.trust;

  // 1) mails envoyes par l'utilisateur ou ce destinataire apparait.
  const sentFilter =
    'account.user="' +
    userId +
    '" && is_sent=true && (to_addresses ~ "' +
    email +
    '" || cc_addresses ~ "' +
    email +
    '")';

  // 2) mails recus dans des dossiers non-spam.
  const inboxFilter =
    'account.user="' +
    userId +
    '" && from_address ~ "' +
    email +
    '" && folder.type != "spam"';

  let sentToCount = 0;
  let receivedInboxCount = 0;
  let contactMessageCount = 0;
  // Chemin rapide : SQL direct (~0.1-0.8s les 3 compteurs, zero charge PB).
  // Les COUNT via l'API PB (`~` = LIKE non indexe) prenaient 1.4-11s chacun
  // et depassaient le timeout -> chaque nouveau mail attendait ~16-24s AVANT
  // d'etre insere. Fallback HTTP si la DB directe est indisponible.
  const direct = getSenderTrustCountsFromSqlite(userId, email);
  if (direct) {
    sentToCount = direct.sentToCount;
    receivedInboxCount = direct.receivedInboxCount;
    contactMessageCount = direct.contactMessageCount;
  } else {
    try {
      [sentToCount, receivedInboxCount, contactMessageCount] = await Promise.all([
        countMessages(sentFilter),
        countMessages(inboxFilter),
        countContactMessages(userId, email),
      ]);
    } catch (err) {
      console.warn("Sender trust lookup failed:", err);
      return empty;
    }
  }

  // Le domaine compte si plusieurs adresses distinctes y vivent. Pour rester
  // peu couteux on approxime via le total messages du domaine (inbox seul).
  let knownDomain = false;
  const at = email.indexOf("@");
  const domain = at >= 0 ? email.slice(at + 1) : "";
  if (domain && receivedInboxCount < KNOWN_DOMAIN_COUNT) {
    const directDomain = countDomainInboxFromSqlite(userId, domain);
    if (directDomain !== null) {
      knownDomain = directDomain >= KNOWN_DOMAIN_COUNT;
    } else {
      try {
        const domainFilter =
          'account.user="' +
          userId +
          '" && from_address ~ "@' +
          domain +
          '" && folder.type != "spam"';
        const domainCount = await countMessages(domainFilter);
        knownDomain = domainCount >= KNOWN_DOMAIN_COUNT;
      } catch {
        // ignore
      }
    }
  } else if (receivedInboxCount >= KNOWN_DOMAIN_COUNT) {
    knownDomain = true;
  }

  let level: TrustLevel = "unknown";
  if (sentToCount >= 1 || contactMessageCount >= TRUSTED_CONTACT_COUNT) {
    level = "trusted";
  } else if (
    receivedInboxCount >= KNOWN_DOMAIN_COUNT ||
    knownDomain
  ) {
    level = "known";
  }

  const trust: SenderTrust = {
    level,
    sentToCount,
    receivedInboxCount,
    contactMessageCount,
    knownDomain,
  };
  cache.set(key, { trust, expiresAt: now + CACHE_TTL_MS });
  return trust;
}

/** Invalide une entree (utile apres un apprentissage manuel). */
export function invalidateSenderTrust(
  userId: string,
  senderEmail: string
): void {
  cache.delete(cacheKey(userId, senderEmail.toLowerCase().trim()));
}
