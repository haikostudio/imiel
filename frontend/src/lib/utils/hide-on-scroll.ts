/**
 * Regle pure du repli "haut de liste masque au defilement" (telephone).
 *
 * Hysteresis par POINT DE REFERENCE, pas par ecart a l'image precedente :
 *  - haut affiche -> la reference suit le point le plus HAUT atteint ; on
 *    replie quand on descend de plus de `threshold` sous elle ;
 *  - haut replie -> la reference suit le point le plus BAS atteint ; on
 *    reaffiche quand on remonte de plus de `threshold` au-dessus d'elle.
 * Les petits pas d'un defilement lent s'additionnent donc, et le moindre vrai
 * retour vers le haut ramene le bloc.
 *
 * Hors geste (defilement pose par le code : page suivante, nouveau mail en
 * tete, compensation de fenetre glissante) et pendant le gel qui suit une
 * bascule (le repli DANS la mise en page agrandit la zone qui defile et fait
 * reculer la position toute seule en bas de liste), on recale seulement la
 * reference, sans basculer.
 */
export interface HideOnScrollState {
  hidden: boolean;
  /** Point de reference (px) depuis lequel l'ecart est mesure. */
  ref: number;
  /** Instant (ms) avant lequel aucune bascule n'est permise. */
  frozenUntil: number;
}

export interface HideOnScrollOptions {
  /** Un geste de l'utilisateur est-il en cours (doigt, molette, elan) ? */
  gesture: boolean;
  /** Sous cette position, le bloc est toujours affiche. */
  topZone?: number;
  /** Ecart (px) a la reference qui declenche une bascule. */
  threshold?: number;
  /** Gel (ms) apres une bascule : un peu plus que la transition. */
  freezeMs?: number;
}

export const HIDE_ON_SCROLL_TOP_ZONE = 60;
export const HIDE_ON_SCROLL_THRESHOLD = 10;
export const HIDE_ON_SCROLL_FREEZE_MS = 260;

export const initialHideOnScrollState: HideOnScrollState = { hidden: false, ref: 0, frozenUntil: 0 };

/** Borne la position entre 0 et le bas reel : le rebond elastique iOS ne compte pas. */
export function clampScrollPosition(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  return Math.max(0, Math.min(scrollTop, Math.max(0, scrollHeight - clientHeight)));
}

export function stepHideOnScroll(
  state: HideOnScrollState,
  pos: number,
  now: number,
  opts: HideOnScrollOptions,
): HideOnScrollState {
  const topZone = opts.topZone ?? HIDE_ON_SCROLL_TOP_ZONE;
  const threshold = opts.threshold ?? HIDE_ON_SCROLL_THRESHOLD;
  const freezeMs = opts.freezeMs ?? HIDE_ON_SCROLL_FREEZE_MS;

  if (pos <= topZone) {
    if (state.hidden) return { hidden: false, ref: pos, frozenUntil: now + freezeMs };
    return state.ref === pos ? state : { ...state, ref: pos };
  }
  if (!opts.gesture || now < state.frozenUntil) {
    return state.ref === pos ? state : { ...state, ref: pos };
  }
  if (state.hidden) {
    if (pos > state.ref) return { ...state, ref: pos };
    if (state.ref - pos > threshold) return { hidden: false, ref: pos, frozenUntil: now + freezeMs };
    return state;
  }
  if (pos < state.ref) return { ...state, ref: pos };
  if (pos - state.ref > threshold) return { hidden: true, ref: pos, frozenUntil: now + freezeMs };
  return state;
}
