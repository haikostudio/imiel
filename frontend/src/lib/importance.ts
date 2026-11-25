/** Tri en trois niveaux : couleurs et libelles partages (pastilles, trait, menus). */
export type Importance = "important" | "secondary" | "low";

export const IMPORTANCE_LEVELS: Importance[] = ["important", "secondary", "low"];

/** Couleurs validees (maquettes #dc3e / #da90) : lisibles en clair et en sombre. */
export const IMPORTANCE_COLORS: Record<Importance, string> = {
  important: "#e5484d",
  secondary: "#3b82f6",
  low: "#eab308",
};

export function isImportance(v: unknown): v is Importance {
  return v === "important" || v === "secondary" || v === "low";
}

/** Niveau d'une conversation : celui du mail RECU le plus recent qui en a un. */
export function threadImportance(
  messages: { importance?: string; is_sent?: boolean; date?: string }[]
): Importance | null {
  let best: { lvl: Importance; date: string } | null = null;
  for (const m of messages) {
    if (m.is_sent || !isImportance(m.importance)) continue;
    const d = m.date || "";
    if (!best || d > best.date) best = { lvl: m.importance, date: d };
  }
  return best ? best.lvl : null;
}
