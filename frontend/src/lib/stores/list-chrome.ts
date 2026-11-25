"use client";

import { create } from "zustand";

/**
 * Haut des listes du telephone (bandeaux, recherche, filtres) replie au
 * defilement. Un seul etat pour toute l'app : le bandeau des suivis vit dans
 * le layout, la recherche et les filtres dans la page, et ils se replient
 * ensemble.
 *  - `screens` : nombre de blocs <CollapsibleTop> d'ecran montes. A zero, la
 *    mecanique est eteinte (ecran sans repli : le bandeau ne bouge pas).
 *  - `forced` : nombre de raisons en cours de garder le haut affiche
 *    (selection multiple, tiroir ouvert, champ de saisie actif).
 */
interface ListChromeState {
  hidden: boolean;
  screens: number;
  forced: number;
  setHidden: (hidden: boolean) => void;
  /** Declare un ecran repliable ; renvoie la fonction de retrait. */
  registerScreen: () => () => void;
  /** Force l'affichage ; renvoie la fonction qui leve la contrainte. */
  forceVisible: () => () => void;
}

export const useListChromeStore = create<ListChromeState>((set) => ({
  hidden: false,
  screens: 0,
  forced: 0,
  setHidden: (hidden) => set((s) => (s.hidden === hidden ? s : { hidden })),
  registerScreen: () => {
    set((s) => ({ screens: s.screens + 1 }));
    return () =>
      set((s) => {
        const screens = Math.max(0, s.screens - 1);
        return screens === 0 ? { screens, hidden: false } : { screens };
      });
  },
  forceVisible: () => {
    set((s) => ({ forced: s.forced + 1, hidden: false }));
    return () => set((s) => ({ forced: Math.max(0, s.forced - 1) }));
  },
}));
