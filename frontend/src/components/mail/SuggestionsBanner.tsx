"use client";

import { CalendarClock, ChevronRight } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useSuggestionsStore } from "@/lib/hooks/useCalendarSuggestions";

/**
 * Barre affichee en haut de la liste des conversations quand des echeances
 * detectees dans le suivi attendent un rapprochement (a ajouter a l'agenda ou
 * a ignorer). Remplace l'ouverture automatique du drawer : un tap ouvre le
 * drawer de validation. Le compteur lit le store partage -> il se met a jour
 * en direct quand l'utilisateur traite une proposition.
 */
export function SuggestionsBanner() {
  const t = useT();
  const count = useSuggestionsStore((s) => s.pending.length);
  const setOpen = useSuggestionsStore((s) => s.setOpen);

  if (count === 0) return null;

  const label =
    count === 1
      ? t("suggestions.bannerOne")
      : t("suggestions.bannerMany", { count: String(count) });

  return (
    <button
      type="button"
      data-ref="suggestions-banner"
      onClick={() => setOpen(true)}
      // Pastille arrondie alignee sur la liste (meme regle que le bandeau des
      // suivis : 10px telephone, 1rem ordinateur, choix utilisateur 2026-10-19).
      className="mx-[10px] mt-1 mb-2 flex w-[calc(100%-20px)] items-center gap-2.5 rounded-2xl bg-muted px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-accent/80 md:mx-4 md:w-[calc(100%-2rem)]"
    >
      <CalendarClock className="size-[1.1rem] shrink-0" strokeWidth={1.7} />
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-background px-2 py-0.5 text-xs font-semibold text-foreground">
        {t("suggestions.bannerCta")}
        <ChevronRight className="size-3.5" />
      </span>
    </button>
  );
}
