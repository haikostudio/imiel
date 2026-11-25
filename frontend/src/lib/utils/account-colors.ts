/**
 * Palette de couleurs pour les comptes email.
 * Chaque compte doit avoir une couleur unique parmi cette palette.
 */
export const ACCOUNT_COLORS = [
  { value: "#3b82f6", label: "Bleu" },
  { value: "#ef4444", label: "Rouge" },
  { value: "#22c55e", label: "Vert" },
  { value: "#f59e0b", label: "Ambre" },
  { value: "#8b5cf6", label: "Violet" },
  { value: "#ec4899", label: "Rose" },
  { value: "#06b6d4", label: "Cyan" },
  { value: "#f97316", label: "Orange" },
  { value: "#14b8a6", label: "Teal" },
  { value: "#6366f1", label: "Indigo" },
] as const;

export type AccountColor = (typeof ACCOUNT_COLORS)[number]["value"];

/**
 * Retourne la premiere couleur disponible (non utilisee par un autre compte).
 */
export function getNextAvailableColor(usedColors: string[]): string {
  const used = new Set(usedColors);
  for (const c of ACCOUNT_COLORS) {
    if (!used.has(c.value)) return c.value;
  }
  return ACCOUNT_COLORS[0].value;
}
