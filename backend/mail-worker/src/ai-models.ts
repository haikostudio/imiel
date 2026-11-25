/**
 * Choix du modele OpenRouter des travaux d'ARRIERE-PLAN du worker (tri spam,
 * categorisation + niveau d'importance, suivi, recap du matin, newsletters,
 * memoire des contacts).
 *
 * Ordre : variable dediee du module (si posee) > OPENROUTER_MODEL_BACKGROUND >
 * DEFAULT_BACKGROUND_MODEL (gagnant de la comparaison sur de vrais mails,
 * scripts/compare-background-models.ts).
 *
 * OPENROUTER_MODEL n'est volontairement PLUS lu ici : il reste le modele du
 * chat / de l'assistant cote Next (frontend/src/app/api/ai/*), qui garde le sien.
 */
export const DEFAULT_BACKGROUND_MODEL = "deepseek/deepseek-v4.1-flash-1017";

/** Modele de repli si le modele d'arriere-plan echoue (HTTP, JSON invalide). */
export const FALLBACK_BACKGROUND_MODEL = "deepseek/deepseek-chat-v3-0324";

export function backgroundModel(dedicatedEnv?: string): string {
  const dedicated = dedicatedEnv ? (process.env[dedicatedEnv] || "").trim() : "";
  if (dedicated) return dedicated;
  const bg = (process.env.OPENROUTER_MODEL_BACKGROUND || "").trim();
  return bg || DEFAULT_BACKGROUND_MODEL;
}

/**
 * Champs a ajouter au corps d'une requete OpenRouter pour COUPER le
 * raisonnement des modeles qui en ont un (Hy4, DeepSeek V4.x, Gemini 2.5) :
 * sans ca, les jetons de reflexion sont factures et la latence explose. Les
 * modeles sans raisonnement ignorent le champ.
 */
export function noReasoning(model: string): Record<string, unknown> {
  if (/deepseek-chat-v3|gpt-4o|claude/i.test(model)) return {};
  return { reasoning: { enabled: false } };
}
