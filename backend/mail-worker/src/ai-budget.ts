/**
 * Passage UNIQUE du worker vers OpenRouter + plafond de depense journalier.
 *
 * Pourquoi : chaque module (categorizer, classifier, tracking,
 * newsletter, cerveau) appelait OpenRouter en direct, sans
 * compteur commun. Un redemarrage du worker declenchait des rafales (top-up de
 * categorisation, rattrapage IMAP) invisibles cote app (~4 $/jour constates).
 *
 * - `aiFetch(source, init)` remplace `fetch(OPENROUTER_URL, init)` : il ajoute
 *   `usage: { include: true }` au corps pour que la reponse porte `usage.cost`
 *   (USD), additionne ce cout au total du JOUR (Europe/Paris) et logue
 *   `[ai] source=... model=... cost=...`.
 * - Plafond : au-dela de `limitUsd` (defaut AI_DAILY_BUDGET_USD, 1 $), tout appel
 *   AUTOMATIQUE est refuse SANS partir (reponse synthetique HTTP 429 : les
 *   appelants traitent deja `!res.ok` comme un echec). Les appels declenches A LA
 *   MAIN (route enveloppee dans `runAsManual`) passent toujours, mais comptent.
 * - Le cumul vit dans un fichier JSON sur un volume PERSISTANT (a cote du cache
 *   vecteurs) : un compteur en memoire se remettrait a zero a chaque restart,
 *   precisement le cas vise.
 */
import { AsyncLocalStorage } from "async_hooks";
import fs from "fs";
import path from "path";
import { noReasoning } from "./ai-models";
import { legacyRenamed } from "./renamed-file";

/**
 * Cle OpenRouter "de service" (traitements de fond sans cle utilisateur
 * explicite). Instance de l'editeur : OPENROUTER_API_KEY. App d'ordinateur
 * (version pour tous) : AUCUNE cle de l'editeur n'est embarquee (DEC-331) ;
 * la cle saisie par l'utilisateur local est reprise ici (voir
 * startLocalUserKeyRefresh dans index.ts). Vide = IA eteinte.
 */
let localUserKey = "";
export function setLocalUserOpenRouterKey(key: string): void {
  localUserKey = (key || "").trim();
}
export function serverOpenRouterKey(): string {
  return process.env.OPENROUTER_API_KEY || localUserKey || "";
}

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const TIMEZONE = "Europe/Paris";
const DEFAULT_LIMIT_USD = (() => {
  const v = Number(process.env.AI_DAILY_BUDGET_USD);
  return Number.isFinite(v) && v >= 0 ? v : 1;
})();
// Repli si OpenRouter ne renvoie pas `usage.cost` : estimation pessimiste.
const FALLBACK_USD_PER_TOKEN = 2 / 1_000_000;

const STATE_PATH =
  process.env.AI_BUDGET_STATE_PATH ||
  legacyRenamed(
    path.join(path.dirname(process.env.EMBEDDINGS_CACHE_PATH || "/tmp/imiel-vectors.db"), "imiel-ai-spend.json")
  );

interface SourceStat {
  calls: number;
  costUsd: number;
  blocked: number;
}

interface BudgetState {
  day: string;
  totalUsd: number;
  limitUsd: number | null; // null = defaut de l'environnement
  bySource: Record<string, SourceStat>;
}

const manualCtx = new AsyncLocalStorage<boolean>();

/** Execute `fn` comme une action demandee A LA MAIN (non bloquee par le plafond). */
export function runAsManual<T>(fn: () => T): T {
  return manualCtx.run(true, fn);
}

export function parisDay(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Instant du prochain minuit Europe/Paris (changement de `parisDay`). */
export function nextParisMidnight(now: Date = new Date()): Date {
  const today = parisDay(now);
  let lo = now.getTime();
  let hi = lo + 26 * 3600_000;
  // Recherche dichotomique du premier instant dont le jour change (a la milliseconde, ~27 tours).
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (parisDay(new Date(mid)) === today) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

let state: BudgetState | null = null;

function load(): BudgetState {
  if (!state) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as BudgetState;
    } catch {
      state = { day: parisDay(), totalUsd: 0, limitUsd: null, bySource: {} };
    }
  }
  const today = parisDay();
  if (state.day !== today) {
    state = { day: today, totalUsd: 0, limitUsd: state.limitUsd ?? null, bySource: {} };
    save();
  }
  return state;
}

function save(): void {
  if (!state) return;
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch (err) {
    console.warn(`[ai] budget: ecriture ${STATE_PATH} impossible:`, (err as Error).message);
  }
}

function stat(s: BudgetState, source: string): SourceStat {
  return (s.bySource[source] ||= { calls: 0, costUsd: 0, blocked: 0 });
}

export function getLimitUsd(): number {
  const s = load();
  return s.limitUsd ?? DEFAULT_LIMIT_USD;
}

export function setLimitUsd(limit: number | null): void {
  const s = load();
  s.limitUsd = limit === null ? null : Math.max(0, limit);
  save();
}

export function isBudgetExceeded(): boolean {
  const s = load();
  return s.totalUsd >= getLimitUsd();
}

export function getBudgetStatus() {
  const s = load();
  const limitUsd = getLimitUsd();
  return {
    day: s.day,
    spentUsd: Math.round(s.totalUsd * 10000) / 10000,
    limitUsd,
    defaultLimitUsd: DEFAULT_LIMIT_USD,
    exceeded: s.totalUsd >= limitUsd,
    resetsAt: nextParisMidnight().toISOString(),
    bySource: s.bySource,
  };
}

/** Ajoute un cout au jour courant (exporte pour les tests). */
export function recordSpend(source: string, costUsd: number): void {
  const s = load();
  const st = stat(s, source);
  st.calls++;
  st.costUsd += costUsd;
  s.totalUsd += costUsd;
  save();
}

let lastBlockLog = 0;

/**
 * `fetch(OPENROUTER_URL, init)` mesure + plafonne. `source` nomme le traitement
 * d'origine (categorize, classify, tracking, newsletter, cerveau-vision...).
 */
export async function aiFetch(source: string, init: RequestInit): Promise<Response> {
  const manual = manualCtx.getStore() === true;
  if (!manual && isBudgetExceeded()) {
    const s = load();
    stat(s, source).blocked++;
    save();
    if (Date.now() - lastBlockLog > 60_000) {
      lastBlockLog = Date.now();
      console.warn(
        `[ai] BLOQUE source=${source} : plafond journalier atteint ($${s.totalUsd.toFixed(4)} >= $${getLimitUsd()})`
      );
    }
    return new Response(JSON.stringify({ error: "ai daily budget reached" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  let model = "?";
  let body = init.body;
  if (typeof body === "string") {
    try {
      const obj = JSON.parse(body) as Record<string, unknown>;
      model = String(obj.model || "?");
      obj.usage = { include: true };
      // Raisonnement COUPE par defaut (jetons de reflexion factures sinon),
      // sauf si l'appelant a explicitement pose `reasoning`.
      if (!("reasoning" in obj)) Object.assign(obj, noReasoning(model));
      body = JSON.stringify(obj);
    } catch {
      /* corps non JSON : envoye tel quel */
    }
  }

  const res = await fetch(OPENROUTER_URL, { ...init, body });
  // Lecture du cout sur une COPIE : l'appelant garde la reponse d'origine intacte.
  let cost = 0;
  let tokens = 0;
  try {
    const data = (await res.clone().json()) as {
      usage?: { cost?: number; total_tokens?: number };
    };
    tokens = Number(data.usage?.total_tokens) || 0;
    const c = Number(data.usage?.cost);
    cost = data.usage?.cost !== undefined && Number.isFinite(c) ? c : tokens * FALLBACK_USD_PER_TOKEN;
  } catch {
    /* reponse non JSON (erreur) ou sans clone : rien a compter */
  }
  recordSpend(source, cost);
  const s = load();
  console.log(
    `[ai] source=${source} model=${model} status=${res.status} tokens=${tokens} cost=$${cost.toFixed(5)} jour=$${s.totalUsd.toFixed(4)}/${getLimitUsd()}${manual ? " manuel" : ""}`
  );
  return res;
}

/** Reinitialise l'etat en memoire (tests). */
export function __resetForTests(next: BudgetState | null = null): void {
  state = next;
}
