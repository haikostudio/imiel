/**
 * Series de messages d'une conversation, facon messagerie.
 *
 * Des messages qui se suivent A L'ECRAN, envoyes depuis la meme adresse le meme
 * jour, forment une serie : seul le premier affiche (le plus haut) porte
 * l'avatar et le nom, les suivants ne gardent que l'heure et les coches.
 *
 * La regle suit exactement ce qui est AFFICHE, dans l'ordre d'affichage :
 * - une coupure ("break" : brouillon intercale, indicateur de messages replies)
 *   termine la serie ;
 * - un changement de jour (pastille de date) ou d'adresse aussi ;
 * - un message REPLIE (seul son en-tete est visible) n'est jamais une suite :
 *   il garde avatar et nom, sinon on ne saurait plus de qui il vient. Il peut
 *   en revanche ouvrir une serie (son en-tete montre l'auteur).
 */

export type SeriesEntry =
  | { kind: "message"; id: string; sender: string; date: string; open: boolean }
  | { kind: "break" };

/** Cle de jour d'une date (meme decoupage que les pastilles de date du fil). */
export function seriesDayKey(date: string): string {
  const d = new Date(date);
  return isNaN(d.getTime()) ? "" : d.toDateString();
}

/** Identifiants des messages qui CONTINUENT une serie (ni avatar ni nom). */
export function computeSeriesContinuations(entries: SeriesEntry[]): Set<string> {
  const continuations = new Set<string>();
  let prev: { sender: string; day: string } | null = null;
  for (const entry of entries) {
    if (entry.kind === "break") {
      prev = null;
      continue;
    }
    const sender = entry.sender.trim().toLowerCase();
    const day = seriesDayKey(entry.date);
    if (entry.open && prev && sender && day && prev.sender === sender && prev.day === day) {
      continuations.add(entry.id);
    }
    prev = { sender, day };
  }
  return continuations;
}
