// ROUTE PUBLIQUE VOULUE (pas de connexion requise) : Catalogue public de modeles et prix (aucune donnee utilisateur).
import { NextResponse } from "next/server";
import { DEFAULT_AI_COMPOSE_MODEL } from "@/lib/ai-models";
import { getModelCatalog } from "../models-catalog";

// Liste des modeles du menu IA de la fenetre d'ecriture, avec le prix du jour,
// le cout estime d'une reponse redigee et le niveau (€ a €€€€).
export async function GET() {
  const catalog = await getModelCatalog();
  return NextResponse.json(
    {
      models: catalog.models.map(({ id, label, input, output, cents, level }) => ({
        id,
        label,
        input,
        output,
        cents,
        level,
      })),
      defaultModel: DEFAULT_AI_COMPOSE_MODEL,
      live: catalog.live,
    },
    { headers: { "Cache-Control": "private, max-age=3600" } }
  );
}
