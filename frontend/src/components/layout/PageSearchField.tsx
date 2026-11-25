"use client";

import { SearchField } from "@/components/ui/kit";
import { useIsMiel } from "@/lib/hooks/useSettings";
import { useMailStore } from "@/lib/stores/mail-store";
import { cn } from "@/lib/utils";

/**
 * Recherche en tete d'une page de contenu (vue d'ensemble, agenda,
 * newsletters) : Miel sur ordinateur SEULEMENT (la barre d'etat qui portait la
 * pilule de recherche n'existe plus en Miel). Le texte d'aide nomme la page
 * (« Rechercher dans l'agenda ») mais la palette ouverte cherche dans TOUS les
 * mails (decision utilisateur, carte « Pages au meme gabarit »). Ailleurs
 * (Minimaliste, telephone : masque en CSS, sans saut au premier rendu) :
 * rien, la page reste celle d'origine.
 */
export function PageSearchField({ placeholder, className }: { placeholder: string; className?: string }) {
  const isMiel = useIsMiel();
  const openSearch = useMailStore((s) => s.openSearch);
  if (!isMiel) return null;
  return (
    <SearchField
      onActivate={openSearch}
      placeholder={placeholder}
      className={cn("hidden flex-none md:flex", className)}
      data-ref="page-search"
    />
  );
}
