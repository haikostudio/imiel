// Temporisation AVANT d'ecrire "lu".
//
// Ouvrir une conversation n'ecrit plus "lu" tout de suite : on arme un compte a
// rebours (duree = reglage `auto_mark_read_seconds` du compte, 5 s par defaut).
// Refermer le fil, en ouvrir un autre ou quitter l'ecran ANNULE l'ecriture : le
// message reste non lu. Un seul compte a rebours peut etre arme a la fois (une
// seule conversation est ouverte), d'ou cet etat au niveau MODULE : il est
// atteignable depuis la page mail, la vue conversation et le magasin, sans
// prop-drilling ni cycle d'import.
//
// Le delai 0 conserve le comportement immediat : l'appelant execute alors le
// marquage sans passer par un timer.

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingKey: string | null = null;
let pendingRun: (() => void) | null = null;

/** Annule le marquage differe en attente, s'il y en a un. */
export function cancelPendingMarkRead() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingKey = null;
  pendingRun = null;
}

/** Y a-t-il un marquage differe en attente pour cette cle (thread ou message) ? */
export function hasPendingMarkRead(key?: string) {
  if (!pendingTimer) return false;
  return key ? pendingKey === key : true;
}

/**
 * Arme le marquage "lu" pour dans `seconds` secondes. Remplace tout compte a
 * rebours deja arme (changement de selection). `seconds <= 0` execute tout de
 * suite, comme avant.
 */
export function scheduleMarkRead(key: string, seconds: number, run: () => void) {
  cancelPendingMarkRead();
  if (!Number.isFinite(seconds) || seconds <= 0) {
    run();
    return;
  }
  pendingKey = key;
  pendingRun = run;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    pendingKey = null;
    pendingRun = null;
    run();
  }, seconds * 1000);
}


/**
 * Execute TOUT DE SUITE le marquage differe en attente (clic dans la
 * conversation ouverte : on la lit, inutile d'attendre la fin du delai).
 * Sans marquage en attente, ne fait rien.
 */
export function flushPendingMarkRead() {
  const run = pendingRun;
  if (!pendingTimer || !run) return;
  cancelPendingMarkRead();
  run();
}

/**
 * Gestionnaire de clic (phase de capture) du panneau de lecture : un clic sur le
 * contenu passe la conversation en lu. Les controles (boutons, liens, menus,
 * champs) sont ignores : "Marquer non lu" ne doit pas courir contre un "lu".
 */
export function flushMarkReadOnContentClick(e: { target: EventTarget | null }) {
  const el = e.target as Element | null;
  if (el?.closest?.('button, a, input, textarea, select, [role="button"], [role="menuitem"], [contenteditable="true"]')) {
    return;
  }
  flushPendingMarkRead();
}
