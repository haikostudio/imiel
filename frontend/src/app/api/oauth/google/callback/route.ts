// ROUTE PUBLIQUE VOULUE (pas de connexion requise) : Public exprès : retour de Google ; l'etat (state) est verifie par le worker.
import { NextRequest, NextResponse } from "next/server";

const MAIL_WORKER_URL = process.env.MAIL_WORKER_URL || "http://localhost:4001";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  // Redirige l'utilisateur vers l'origine reelle d'ou il vient (dev-VPS ou
  // prod), pas un localhost code en dur. On respecte les headers de proxy
  // (Traefik) ; repli sur l'origine de la requete puis sur l'env.
  const fwdProto = request.headers.get("x-forwarded-proto");
  const fwdHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const appUrl =
    (fwdHost ? `${fwdProto || "https"}://${fwdHost}` : "") ||
    request.nextUrl.origin ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000";

  if (error || !code || !state) {
    return NextResponse.redirect(
      new URL("/?oauth_redirect=settings&oauth_error=cancelled", appUrl)
    );
  }

  try {
    const res = await fetch(`${MAIL_WORKER_URL}/oauth/google/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
    });

    const data = await res.json();

    if (data.success) {
      return NextResponse.redirect(
        new URL("/?oauth_redirect=settings&oauth_success=true", appUrl)
      );
    }

    return NextResponse.redirect(
      new URL(`/?oauth_redirect=settings&oauth_error=${encodeURIComponent(data.error || "failed")}`, appUrl)
    );
  } catch {
    return NextResponse.redirect(
      new URL("/?oauth_redirect=settings&oauth_error=server_error", appUrl)
    );
  }
}
