import { NextResponse } from "next/server";
import {
  resolveAssetDownloadUrl,
  type DesktopPlatform,
} from "@/lib/desktop-release";

export const dynamic = "force-dynamic";

const VALID: DesktopPlatform[] = ["windows", "mac", "linux"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") as DesktopPlatform | null;
  const kind = url.searchParams.get("kind");

  if (!platform || !VALID.includes(platform)) {
    return NextResponse.json({ error: "invalid-platform" }, { status: 400 });
  }

  const target = await resolveAssetDownloadUrl(platform, kind);
  if (!target) {
    return NextResponse.json({ error: "not-available" }, { status: 404 });
  }
  // Redirige le navigateur vers l'URL signee temporaire de GitHub (le token
  // serveur n'est jamais expose au client).
  return NextResponse.redirect(target, 302);
}
