import type { Message } from "@/lib/pocketbase";

/**
 * Fusion differentielle d'une page 1 fraiche dans une liste deja affichee.
 *
 * POURQUOI : un "refresh" de liste (retour au premier plan, envoi d'un mail,
 * undo, changement de reglage...) ne doit JAMAIS repasser la liste par l'etat
 * vide (skeletons gris) puis la redessiner : c'est un clignotement penible et
 * la position de scroll est perdue. On refetch la page 1 en tache de fond et
 * on n'applique que les differences : maj en place, ajout des nouveaux,
 * retrait de ce qui a disparu cote serveur.
 */

/** Champs de ligne effectivement rendus par la liste. */
function sameListRow(a: Message, b: Message): boolean {
  return (
    a.folder === b.folder &&
    a.date === b.date &&
    a.subject === b.subject &&
    a.snippet === b.snippet &&
    a.is_read === b.is_read &&
    a.is_starred === b.is_starred &&
    a.is_answered === b.is_answered &&
    a.is_draft === b.is_draft &&
    a.is_sent === b.is_sent &&
    a.has_attachments === b.has_attachments &&
    a.priority === b.priority &&
    a.thread_id === b.thread_id &&
    (a.labels ?? []).join(",") === (b.labels ?? []).join(",")
  );
}

export interface MergeMailListOptions {
  /** true si la page fraiche couvre TOUT le resultat serveur (moins d'une page pleine). */
  complete: boolean;
  /** Tri applique a la liste (meme comparateur que le fetch). */
  comparator: (a: Message, b: Message) => number;
  /** Ids a ne jamais retirer (inserts locaux pas encore visibles cote serveur). */
  protectedIds?: Set<string>;
  /** Ids deja presents ailleurs dans la fenetre (autres pages) : pas de doublon. */
  skipIds?: Set<string>;
}

export interface MergeMailListResult {
  /** Liste fusionnee. Identite conservee (=== prev) si rien n'a change. */
  items: Message[];
  /** Ids reellement ajoutes par cette fusion (pour l'animation slide-in). */
  addedIds: string[];
  /** Ids retires (disparus cote serveur). */
  removedIds: string[];
}

export function mergeMailListPage(
  prev: Message[],
  fresh: Message[],
  opts: MergeMailListOptions
): MergeMailListResult {
  const freshById = new Map(fresh.map((m) => [m.id, m]));
  // Borne basse couverte par la page fraiche : en dessous, on ne sait rien
  // (les pages suivantes ne sont pas rechargees) -> on garde tel quel.
  const cutoff =
    opts.complete || fresh.length === 0
      ? null
      : new Date(fresh[fresh.length - 1].date).getTime();

  const kept: Message[] = [];
  const removedIds: string[] = [];
  let changed = false;

  for (const item of prev) {
    const updated = freshById.get(item.id);
    if (updated) {
      if (sameListRow(item, updated)) {
        kept.push(item);
      } else {
        kept.push({ ...item, ...updated });
        changed = true;
      }
      continue;
    }
    if (opts.protectedIds?.has(item.id)) {
      kept.push(item);
      continue;
    }
    // Comparaison STRICTE : plusieurs mails peuvent partager la meme date a la
    // seconde pres (envois en masse). Un mail a la date exacte de la derniere
    // ligne fraiche peut donc etre legitimement sur la page suivante : on le
    // garde plutot que de le retirer a tort.
    const withinFreshRange = cutoff === null || new Date(item.date).getTime() > cutoff;
    if (withinFreshRange) {
      removedIds.push(item.id);
      changed = true;
      continue;
    }
    kept.push(item);
  }

  const knownIds = new Set(prev.map((m) => m.id));
  const added: Message[] = [];
  for (const msg of fresh) {
    if (knownIds.has(msg.id)) continue;
    if (opts.skipIds?.has(msg.id)) continue;
    added.push(msg);
    changed = true;
  }

  if (!changed) {
    return { items: prev, addedIds: [], removedIds: [] };
  }

  const merged = [...added, ...kept];
  merged.sort(opts.comparator);
  return { items: merged, addedIds: added.map((m) => m.id), removedIds };
}
