"use client";

// Monte iMiel Cloud dans l'app : ecran de compte tant que l'appareil n'est pas
// relie, moteur de synchro une fois relie, bandeau quand l'abonnement est
// arrete (ordinateur : continuer gratuitement ; web : reprendre ; iPhone :
// information seulement, sans lien d'achat).
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { useCloud } from "@/lib/cloud/client";
import { cloudDisponible, estOrdinateurCloud } from "@/lib/cloud/config";
import { demarrerCloud } from "@/lib/cloud/sync";
import { ouvrirPaiement, paiementPermis, passerEnGratuit } from "@/lib/cloud/abonnement";
import { CloudGate } from "./CloudGate";

export function CloudHost() {
  const t = useT();
  const [dispo, setDispo] = useState(false);
  const relie = useCloud((s) => s.relie);
  const abonnement = useCloud((s) => s.abonnement);
  // L'ecran de compte reste ouvert apres l'inscription (etape « Ajoutez votre
  // premiere boite ») jusqu'a ce qu'il se ferme lui-meme. Etat garde hors du
  // composant : l'app peut se redessiner pendant ce temps.
  const ecran = useCloud((s) => s.ecran);
  const setCloud = useCloud((s) => s.set);

  useEffect(() => setDispo(cloudDisponible()), []);
  useEffect(() => {
    if (!dispo || !relie) return;
    return demarrerCloud();
  }, [dispo, relie]);

  if (!dispo) return null;
  if (!relie || ecran) return <CloudGate onRelie={() => setCloud({ ecran: false })} />;
  if (abonnement?.etat !== "arrete") return null;
  return (
    <div data-ref="cloud-stopped-banner" className="bg-accent text-accent-foreground flex flex-wrap items-center justify-center gap-3 px-4 py-2 text-sm">
      <span>{t("cloud.banner.stopped")}</span>
      {estOrdinateurCloud() && (
        <button type="button" className="font-medium underline" onClick={() => void passerEnGratuit()} data-ref="cloud-banner-free">
          {t("cloud.sub.continueFree")}
        </button>
      )}
      {paiementPermis() && (
        <button type="button" className="font-medium underline" onClick={() => void ouvrirPaiement()} data-ref="cloud-banner-resume">
          {t("cloud.sub.resume")}
        </button>
      )}
    </div>
  );
}
