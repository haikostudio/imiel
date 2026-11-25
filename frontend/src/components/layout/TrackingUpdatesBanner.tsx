"use client";

import { PackageSearch } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useHashRouter } from "@/lib/hash-router";
import {
  useTrackingUpdates,
  useTrackingUpdatesStore,
} from "@/lib/hooks/useTrackingUpdates";

/**
 * Bandeau "X suivi(s) mis a jour" affiche SOUS la barre de recherche sur toutes
 * les pages SAUF la page Suivi (ou le neuf est deja visible dans la liste).
 * Permet de reperer une nouveaute de suivi depuis n'importe quelle vue :
 *  - tap sur le bandeau -> ouvre la page Suivi ;
 *  - "Tout marquer comme lu" -> efface le compteur (memes fiches que la page Suivi).
 * Le compteur vit dans un store partage (useTrackingUpdatesStore) alimente par
 * useTrackingUpdates (refresh + realtime + poll).
 */
export function TrackingUpdatesBanner() {
  const t = useT();
  const { route, navigate } = useHashRouter();
  // Alimente le store (refresh + realtime + poll). Doit tourner meme quand le
  // bandeau est masque (compteur 0 / page Suivi) pour detecter l'arrivee de neuf.
  useTrackingUpdates();
  const count = useTrackingUpdatesStore((s) => s.ids.length);
  const markAllRead = useTrackingUpdatesStore((s) => s.markAllRead);

  // Masque sur la page Suivi (info deja presente) et quand il n'y a rien de neuf.
  if (route === "suivi" || count === 0) return null;

  return (
    <div
      role="button"
      tabIndex={0}
      data-ref="tracking-updates-banner"
      onClick={() => navigate("/suivi")}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate("/suivi");
        }
      }}
      // Pastille arrondie dont les bords tombent sur ceux de la liste : meme
      // marge exterieure que les lignes et la recherche (10px telephone, 1rem
      // ordinateur) -> pas de double marge (choix utilisateur 2026-10-19).
      className="mx-[10px] mt-1 mb-2 flex shrink-0 cursor-pointer items-center gap-2.5 rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-accent/80 md:mx-4 md:mt-3"
    >
      <PackageSearch className="size-[1.1rem] shrink-0" strokeWidth={1.7} />
      <span className="min-w-0 flex-1 truncate font-medium">
        {t("tracking.updatedBanner", { count: String(count) })}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void markAllRead();
        }}
        className="shrink-0 rounded-full px-2 py-0.5 text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
      >
        {t("tracking.markAllRead")}
      </button>
    </div>
  );
}
