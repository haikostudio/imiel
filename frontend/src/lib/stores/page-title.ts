"use client";

import { useEffect } from "react";
import { create } from "zustand";

/**
 * Titre de l'ecran courant, affiche au centre de la barre du haut (charte des
 * maquettes : menu, titre, cloche, assistant, Ecrire). Chaque page pose son
 * titre en montant (usePageTitle) ; a defaut, la barre retombe sur le nom de
 * la route. `count` : compteur discret pose a cote du titre sur ordinateur
 * (ex. "32+ conversations" de la liste des mails), retire au demontage.
 */
interface PageTitleState {
  title: string | null;
  count: string | null;
  /** Apparence Miel, ordinateur : la page porte elle-meme le titre et la barre
   *  d'etat dans son bloc de liste (la barre du haut et le layout les omettent). */
  listChrome: boolean;
  /** Telephone : ecran de second niveau -> fleche de retour a la place du
   *  menu dans la barre du haut (entete UNIQUE, plus de seconde bande). */
  back: (() => void) | null;
  setTitle: (title: string | null) => void;
  setCount: (count: string | null) => void;
  setListChrome: (on: boolean) => void;
  setBack: (back: (() => void) | null) => void;
}

export const usePageTitleStore = create<PageTitleState>((set) => ({
  title: null,
  count: null,
  listChrome: false,
  back: null,
  setTitle: (title) => set({ title }),
  setCount: (count) => set({ count }),
  setListChrome: (listChrome) => set({ listChrome }),
  setBack: (back) => set({ back }),
}));

/** Ecran de second niveau : la barre du haut du telephone montre une fleche
 *  de retour qui appelle `back` (retire au demontage). La fonction est lue
 *  par reference : la page la stabilise (useCallback) ou passe un chemin. */
export function usePageBack(back: (() => void) | null) {
  const setBack = usePageTitleStore((s) => s.setBack);
  useEffect(() => {
    setBack(back);
    return () => setBack(null);
  }, [back, setBack]);
}

/** La page affiche son titre et la barre d'etat dans son bloc (Miel, ordinateur). */
export function useListChrome(on: boolean) {
  const setListChrome = usePageTitleStore((s) => s.setListChrome);
  useEffect(() => {
    setListChrome(on);
    return () => setListChrome(false);
  }, [on, setListChrome]);
}

export function usePageTitle(title: string | null | undefined, count?: string | null) {
  const setTitle = usePageTitleStore((s) => s.setTitle);
  const setCount = usePageTitleStore((s) => s.setCount);
  useEffect(() => {
    setTitle(title ?? null);
    return () => setTitle(null);
  }, [title, setTitle]);
  useEffect(() => {
    setCount(count ?? null);
    return () => setCount(null);
  }, [count, setCount]);
}
