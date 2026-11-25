// Modeles proposes dans le menu IA de la fenetre d'ecriture (ligne "Modele").
// Regles PURES partagees par l'ecran et les routes /api/ai : catalogue ferme
// (le serveur refuse tout autre id), prix de repli, cout estime d'une reponse
// redigee et niveau de cout affiche (€ a €€€€).
// Le chat IA, les etiquettes automatiques, les newsletters et le suivi gardent
// leur modele (OPENROUTER_MODEL...) : ce choix ne concerne QUE la redaction.

export interface AiModel {
  id: string;
  /** Libelle court affiche dans le menu. */
  label: string;
  /** Prix en dollars par million de jetons (entree / sortie). */
  input: number;
  output: number;
}

export const DEFAULT_AI_COMPOSE_MODEL = "anthropic/claude-haiku-5.5";

// Prix de repli releves sur OpenRouter le 2026-10-17 ; la route /api/ai/models
// les remplace par les prix du jour quand le fournisseur repond.
export const AI_MODELS: AiModel[] = [
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", input: 0.15, output: 0.6 },
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", input: 0.1, output: 0.5 },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", input: 0.1, output: 0.5 },
  { id: "mistralai/mistral-large-4-0", label: "Mistral Large 4", input: 0.68, output: 2.09 },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", input: 0.825, output: 4.125 },
  { id: "moonshotai/kimi-k3", label: "Kimi K3", input: 0.304, output: 11.936 },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", input: 2, output: 10 },
  { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", input: 2, output: 10 },
  { id: "google/gemini-4-argon", label: "Gemini 4 Argon", input: 2, output: 10 },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", input: 4, output: 20 },
];

/** Volume type d'une reponse redigee (conversation + echanges + redaction). */
export const REPLY_TOKENS_IN = 25_000;
export const REPLY_TOKENS_OUT = 2_000;

export type CostLevel = 1 | 2 | 3 | 4;

export function findAiModel(id: string | null | undefined): AiModel | undefined {
  return AI_MODELS.find((m) => m.id === id);
}

export function isAiComposeModel(id: unknown): id is string {
  return typeof id === "string" && !!findAiModel(id);
}

/** Cout estime d'une reponse redigee, en centimes (dollar ~ euro). */
export function estimateReplyCents(p: { input: number; output: number }): number {
  return ((REPLY_TOKENS_IN * p.input + REPLY_TOKENS_OUT * p.output) / 1_000_000) * 100;
}

/** € < 1 c, €€ < 5 c, €€€ < 10 c, €€€€ au-dela. */
export function costLevel(cents: number): CostLevel {
  if (cents < 1) return 1;
  if (cents < 5) return 2;
  if (cents < 10) return 3;
  return 4;
}

export function costLevelLabel(level: CostLevel): string {
  return "€".repeat(level);
}

/** "≈ 0,4 c" sous le centime, "≈ 7 c" au-dela. */
export function formatCents(cents: number, locale = "fr"): string {
  const digits = cents < 1 ? 1 : 0;
  const n = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
    Math.max(cents, digits ? 0.1 : 1)
  );
  return `≈ ${n} c`;
}

export interface AiModelPrice extends AiModel {
  cents: number;
  level: CostLevel;
}

export function withCost(m: AiModel): AiModelPrice {
  const cents = estimateReplyCents(m);
  return { ...m, cents, level: costLevel(cents) };
}

/** Catalogue avec cout, du moins cher au plus cher (ordre stable a cout egal). */
export function pricedCatalog(models: AiModel[] = AI_MODELS): AiModelPrice[] {
  return models
    .map(withCost)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.cents - b.m.cents || a.i - b.i)
    .map(({ m }) => m);
}

export const AI_COMPOSE_MODEL_STORAGE_KEY = "imiel:ai-compose-model";
