import { AI_MODELS, pricedCatalog, type AiModel, type AiModelPrice } from "@/lib/ai-models";

// Prix du jour des modeles du menu IA, relus chez OpenRouter (catalogue public,
// sans cle) une fois par 24 h et gardes en memoire du serveur. Un id absent du
// catalogue du fournisseur est retire de la liste ; si le fournisseur ne repond
// pas, les prix de repli de ai-models.ts servent.

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

interface LiveCatalog {
  at: number;
  models: AiModelPrice[];
  live: boolean;
}

let cache: LiveCatalog | null = null;
let pending: Promise<LiveCatalog> | null = null;

async function fetchLive(): Promise<LiveCatalog> {
  try {
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: { id?: string; pricing?: { prompt?: string; completion?: string } }[];
    };
    const byId = new Map((data.data || []).map((m) => [m.id, m] as const));
    if (byId.size === 0) throw new Error("empty catalog");
    const models: AiModel[] = [];
    for (const m of AI_MODELS) {
      const live = byId.get(m.id);
      if (!live) continue;
      const input = Number(live.pricing?.prompt) * 1_000_000;
      const output = Number(live.pricing?.completion) * 1_000_000;
      models.push({
        ...m,
        input: Number.isFinite(input) && input >= 0 ? input : m.input,
        output: Number.isFinite(output) && output >= 0 ? output : m.output,
      });
    }
    return { at: Date.now(), models: pricedCatalog(models), live: true };
  } catch (err) {
    console.warn("[ai-models] catalogue OpenRouter indisponible:", (err as Error).message);
    // Repli : prix statiques, re-essai dans une heure plutot que 24 h.
    return { at: Date.now() - CACHE_MS + 60 * 60 * 1000, models: pricedCatalog(), live: false };
  }
}

export async function getModelCatalog(): Promise<LiveCatalog> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  if (!pending) {
    pending = fetchLive().finally(() => {
      pending = null;
    });
  }
  cache = await pending;
  return cache;
}

/** Ids retires du catalogue du fournisseur (connus seulement une fois le catalogue relu). */
export function isWithdrawn(id: string): boolean {
  if (!cache && !pending) void getModelCatalog();
  return !!cache?.live && !cache.models.some((m) => m.id === id);
}
