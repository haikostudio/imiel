// Gestion des labels utilisateur cote worker : cache en memoire (par userId)
// et find-or-create avec palette de couleurs stable (hash du nom).
//
// pbFetch est prive a pocketbase.ts, donc on passe par l'API REST PocketBase
// directement via un mini-wrapper qui reutilise le token admin partage.

const COLOR_PALETTE = [
  "#3b82f6", // bleu
  "#22c55e", // vert
  "#f59e0b", // orange
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#ec4899", // rose
  "#ef4444", // rouge
  "#14b8a6", // teal
  "#eab308", // jaune
  "#a855f7", // pourpre
  "#10b981", // emerald
  "#f97316", // orange fonce
  "#6366f1", // indigo
  "#84cc16", // lime
  "#0ea5e9", // sky
];

function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length];
}

export interface PBLabel {
  id: string;
  user: string;
  name: string;
  color: string;
  is_secondary: boolean;
  created: string;
  updated: string;
}

// Categories considerees comme "secondaires" (sortent de l'inbox par defaut).
// L'utilisateur peut basculer ce flag depuis la sidebar.
const DEFAULT_SECONDARY_NAMES = new Set([
  "newsletter", "newsletters",
  "promotion", "promotions",
  "notification", "notifications",
  "reseaux sociaux", "reseau social",
  "marketing", "publicite",
]);

function isDefaultSecondary(name: string): boolean {
  return DEFAULT_SECONDARY_NAMES.has(name.trim().toLowerCase());
}

interface UserLabelCache {
  byName: Map<string, PBLabel>; // key = name.toLowerCase()
  loadedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const userCache = new Map<string, UserLabelCache>();

function getPocketBaseUrl(): string {
  return process.env.POCKETBASE_URL || "http://127.0.0.1:8090";
}

// Token admin : on cherche d'abord dans pocketbase.ts via une fonction
// d'authentification dediee. Plutot que de dupliquer, on appelle l'endpoint
// auth-with-password directement avec memoization locale.
let adminToken: string | null = null;
let tokenExpiry = 0;

async function getAdminToken(): Promise<string> {
  if (adminToken && Date.now() < tokenExpiry) return adminToken;

  const email = process.env.PB_ADMIN_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL;
  const password =
    process.env.PB_ADMIN_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD required for labels.ts");
  }

  const res = await fetch(
    `${getPocketBaseUrl()}/api/collections/_superusers/auth-with-password`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: email, password }),
    }
  );
  if (!res.ok) {
    throw new Error(`Labels admin auth failed: ${res.status}`);
  }
  const data = (await res.json()) as { token: string };
  adminToken = data.token;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  return adminToken;
}

async function pbRequest(
  path: string,
  options: { method?: string; body?: unknown; params?: Record<string, string> } = {}
): Promise<unknown> {
  const token = await getAdminToken();
  let url = `${getPocketBaseUrl()}${path}`;
  if (options.params) {
    url += `?${new URLSearchParams(options.params).toString()}`;
  }
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PB ${options.method || "GET"} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function loadLabels(userId: string): Promise<UserLabelCache> {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached;

  const result = (await pbRequest("/api/collections/labels/records", {
    params: { filter: `user="${userId}"`, perPage: "200" },
  })) as { items: PBLabel[] };

  const byName = new Map<string, PBLabel>();
  for (const lbl of result.items) {
    byName.set(lbl.name.toLowerCase(), lbl);
  }
  const fresh: UserLabelCache = { byName, loadedAt: Date.now() };
  userCache.set(userId, fresh);
  return fresh;
}

export function invalidateLabelCache(userId: string): void {
  userCache.delete(userId);
}

/** Liste les noms de labels existants d'un user (lecture cache, refresh si stale). */
export async function listLabelNames(userId: string): Promise<string[]> {
  const cache = await loadLabels(userId);
  return Array.from(cache.byName.values()).map((l) => l.name);
}

/**
 * Vrai si AU MOINS UN des labels donnes est secondaire (is_secondary=true).
 * Aligne sur la semantique exclude_secondary de la vue inbox (mail-list.pb.js) :
 * un message portant ne serait-ce qu'un label secondaire (Newsletter,
 * Promotion, Notification...) est MASQUE de l'inbox -> il ne merite pas de
 * notification push.
 * Liste vide -> false (mail non labellise = visible = notifiable). Un label
 * inconnu du cache est traite comme NON-secondaire (prudent : mieux vaut
 * notifier que rater un vrai mail).
 */
export async function hasAnySecondaryLabel(
  userId: string,
  labelIds: string[]
): Promise<boolean> {
  if (labelIds.length === 0) return false;
  const cache = await loadLabels(userId);
  const byId = new Map<string, PBLabel>();
  for (const lbl of cache.byName.values()) byId.set(lbl.id, lbl);
  return labelIds.some((id) => byId.get(id)?.is_secondary === true);
}

/**
 * Charge les overrides de labels pour un thread (decision explicite de
 * l'utilisateur depuis la vue conversation). Retourne deux sets d'ids :
 *   - included : labels a TOUJOURS appliquer aux messages du thread
 *   - excluded : labels a JAMAIS appliquer aux messages du thread
 * Pas de cache : un override change rarement et il faut le lire frais a
 * chaque nouveau message du thread pour eviter de re-coller un label que
 * l'utilisateur vient de retirer.
 */
export async function loadThreadLabelOverrides(
  userId: string,
  threadId: string
): Promise<{ included: Set<string>; excluded: Set<string> }> {
  if (!threadId) return { included: new Set(), excluded: new Set() };
  const result = (await pbRequest("/api/collections/thread_labels/records", {
    params: {
      filter: `user="${userId}" && thread_id="${threadId.replace(/"/g, '\\"')}"`,
      perPage: "200",
    },
  })) as { items: Array<{ label: string; mode: "included" | "excluded" }> };

  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const ov of result.items) {
    if (ov.mode === "included") included.add(ov.label);
    else if (ov.mode === "excluded") excluded.add(ov.label);
  }
  return { included, excluded };
}

/**
 * Resout une liste de noms en ids de labels. Cree les labels manquants
 * avec une couleur derivee du nom. Tolere la concurrence (re-fetch si
 * collision sur l'index unique).
 */
export async function resolveLabelIds(
  userId: string,
  names: string[]
): Promise<string[]> {
  if (names.length === 0) return [];
  const cache = await loadLabels(userId);
  const ids: string[] = [];

  for (const rawName of names) {
    const name = rawName.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const existing = cache.byName.get(key);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    try {
      const created = (await pbRequest("/api/collections/labels/records", {
        method: "POST",
        body: {
          user: userId,
          name,
          color: colorForName(name),
          is_secondary: isDefaultSecondary(name),
        },
      })) as PBLabel;
      cache.byName.set(key, created);
      ids.push(created.id);
    } catch (err) {
      // Index unique (user, name) -> collision : un autre process a cree le label
      // entre-temps. On rafraichit le cache et on relit.
      console.warn(`resolveLabelIds: create failed for "${name}", retrying:`, err);
      userCache.delete(userId);
      const fresh = await loadLabels(userId);
      const retry = fresh.byName.get(key);
      if (retry) ids.push(retry.id);
    }
  }

  return ids;
}
