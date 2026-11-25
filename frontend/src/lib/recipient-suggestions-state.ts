// Etat partage : une liste de suggestions de destinataires (RecipientInput) est
// ouverte, OU vient de se fermer (fenetre de grace). Sert au Drawer de
// composition mobile (ComposeSheet) pour NE PAS se fermer quand un tap ne fait
// que dismisser les suggestions.
//
// Pourquoi une fenetre de grace et pas une simple verif "ouvert maintenant" :
// le Popover Radix des suggestions se ferme au POINTERDOWN, tandis que le voile
// du tiroir (div onClick) se declenche au CLICK (pointerup). Au moment du click,
// le popover est deja ferme -> une verif instantanee arrive trop tard. On garde
// donc l'etat "actif" quelques centaines de ms apres la fermeture pour couvrir
// le meme geste tap.

let openCount = 0;
let lastClosedAt = 0;
const GRACE_MS = 400;

export function setRecipientSuggestionsOpen(open: boolean): void {
  if (open) {
    openCount++;
  } else if (openCount > 0) {
    openCount--;
    if (openCount === 0) lastClosedAt = Date.now();
  }
}

// True si une liste de suggestions est ouverte, ou s'est fermee dans les
// dernieres GRACE_MS (le tap en cours ne faisait que la dismisser).
export function recipientSuggestionsActive(): boolean {
  if (openCount > 0) return true;
  return Date.now() - lastClosedAt < GRACE_MS;
}
