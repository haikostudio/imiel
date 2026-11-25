// Helpers SERVER-ONLY pour exposer les binaires de l'app de bureau (Tauri)
// publies en Release GitHub. Le repo est PRIVE : on lit l'API GitHub avec un
// token cote serveur, et pour le telechargement on redirige le navigateur vers
// l'URL signee temporaire renvoyee par GitHub (le token ne fuite jamais cote
// client).

const REPO = process.env.GITHUB_RELEASES_REPO || "haikostudio/imiel";
const TOKEN =
  process.env.GITHUB_RELEASES_TOKEN || process.env.GITHUB_TOKEN || "";
const TAG_PREFIX = process.env.GITHUB_RELEASES_TAG_PREFIX || "desktop-v";

export type DesktopPlatform = "windows" | "mac" | "linux";

export interface DesktopAsset {
  name: string;
  kind: string; // exe | msi | dmg | appimage | deb
  size: number;
  id: number;
}

export interface LatestRelease {
  available: boolean;
  reason?: string;
  version?: string;
  tag?: string;
  publishedAt?: string | null;
  assets?: Record<DesktopPlatform, DesktopAsset[]>;
}

interface GhAsset {
  id: number;
  name: string;
  size: number;
}
interface GhRelease {
  draft: boolean;
  tag_name: string;
  published_at: string | null;
  assets: GhAsset[];
}

function classify(
  name: string,
): { platform: DesktopPlatform; kind: string } | null {
  const n = name.toLowerCase();
  if (n.endsWith(".exe")) return { platform: "windows", kind: "exe" };
  if (n.endsWith(".msi")) return { platform: "windows", kind: "msi" };
  if (n.endsWith(".dmg")) return { platform: "mac", kind: "dmg" };
  if (n.endsWith(".app.tar.gz")) return { platform: "mac", kind: "app" };
  if (n.endsWith(".appimage")) return { platform: "linux", kind: "appimage" };
  if (n.endsWith(".deb")) return { platform: "linux", kind: "deb" };
  if (n.endsWith(".rpm")) return { platform: "linux", kind: "rpm" };
  return null;
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "imiel-desktop",
  };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

export function hasReleasesToken(): boolean {
  return !!TOKEN;
}

let cache: { at: number; data: GhRelease | null } | null = null;
const CACHE_MS = 60_000;

async function fetchLatestRaw(): Promise<GhRelease | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases?per_page=30`,
    { headers: ghHeaders(), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`github-${res.status}`);
  const releases = (await res.json()) as GhRelease[];
  const rel =
    releases.find(
      (r) => !r.draft && (r.tag_name || "").startsWith(TAG_PREFIX),
    ) || null;
  cache = { at: Date.now(), data: rel };
  return rel;
}

export async function getLatestRelease(): Promise<LatestRelease> {
  if (!TOKEN) return { available: false, reason: "no-token" };
  let rel: GhRelease | null;
  try {
    rel = await fetchLatestRaw();
  } catch (e) {
    return { available: false, reason: (e as Error).message };
  }
  if (!rel) return { available: false, reason: "no-release" };

  const assets: Record<DesktopPlatform, DesktopAsset[]> = {
    windows: [],
    mac: [],
    linux: [],
  };
  for (const a of rel.assets || []) {
    const c = classify(a.name);
    if (!c) continue;
    assets[c.platform].push({
      name: a.name,
      kind: c.kind,
      size: a.size,
      id: a.id,
    });
  }
  return {
    available: true,
    version: (rel.tag_name || "").replace(TAG_PREFIX, ""),
    tag: rel.tag_name,
    publishedAt: rel.published_at,
    assets,
  };
}

// Resout l'URL de telechargement directe (signee) d'un asset, en suivant la
// redirection de l'API GitHub avec le token serveur.
export async function resolveAssetDownloadUrl(
  platform: DesktopPlatform,
  kind?: string | null,
): Promise<string | null> {
  if (!TOKEN) return null;
  const latest = await getLatestRelease();
  if (!latest.available || !latest.assets) return null;
  const list = latest.assets[platform] || [];
  if (list.length === 0) return null;
  // Ordre de preference par plateforme (installeur "grand public" d'abord).
  const order: Record<DesktopPlatform, string[]> = {
    windows: ["exe", "msi"],
    mac: ["dmg", "app"],
    linux: ["appimage", "deb", "rpm"],
  };
  let asset: DesktopAsset | undefined;
  if (kind) asset = list.find((a) => a.kind === kind);
  if (!asset) {
    for (const k of order[platform]) {
      asset = list.find((a) => a.kind === k);
      if (asset) break;
    }
  }
  if (!asset) asset = list[0];

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`,
    {
      headers: { ...ghHeaders(), Accept: "application/octet-stream" },
      redirect: "manual",
    },
  );
  const loc = res.headers.get("location");
  return loc || null;
}
