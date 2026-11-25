// ROUTE PUBLIQUE VOULUE (pas de connexion requise) : Public exprès : version de l'app de bureau, sans donnee utilisateur.
import { NextResponse } from "next/server";
import { getLatestRelease } from "@/lib/desktop-release";

export const dynamic = "force-dynamic";

export async function GET() {
  const latest = await getLatestRelease();
  return NextResponse.json(latest, {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
