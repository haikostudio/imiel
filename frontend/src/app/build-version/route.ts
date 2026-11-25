import { NextResponse } from "next/server";

// Endpoint runtime qui renvoie la version du build ACTUELLEMENT servi par le
// serveur. Compare cote client (VersionWatcher) avec la version bakee dans
// l'onglet ouvert : si elles different, un nouveau deploiement a eu lieu ->
// l'onglet propose/effectue un rechargement. Hors /api/* pour eviter la rewrite
// vers PocketBase. Jamais mis en cache (no-store) pour refleter le deploiement
// en direct, y compris dans le webview desktop (cache agressif).
export const dynamic = "force-dynamic";

export function GET() {
  return new NextResponse(
    JSON.stringify({ version: process.env.NEXT_PUBLIC_BUILD_VERSION ?? "" }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    }
  );
}
