// ROUTE PUBLIQUE VOULUE (pas de connexion requise) : Public exprès : retour de Google ; l'etat (state) est verifie par le worker.
import { NextRequest, NextResponse } from "next/server";

const MAIL_WORKER_URL = process.env.MAIL_WORKER_URL || "http://localhost:4001";

// Version pour tous (app d'ordinateur) : Google rend la main au NAVIGATEUR du
// systeme sur 127.0.0.1 (client « ordinateur ») ; on y affiche une page simple
// au lieu de rouvrir iMiel dans ce navigateur, ou il n'a pas de session.
function pageAgenda(ok: boolean, detail = ""): NextResponse {
  const titre = ok ? "Agenda Google relie" : "L'agenda n'a pas pu etre relie";
  const texte = ok ? "Vous pouvez fermer cette page et revenir dans iMiel." : detail || "Reessayez depuis iMiel, Reglages > Agenda.";
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
  const html = `<!doctype html><meta charset="utf-8"><title>iMiel</title><body style="font:16px system-ui;display:grid;place-items:center;min-height:90vh;margin:0"><main style="max-width:28rem;text-align:center"><h1 style="font-size:20px">${esc(titre)}</h1><p>${esc(texte)}</p></main></body>`;
  return new NextResponse(html, { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");
  const pourTous = process.env.IMIEL_EDITION === "tous";

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
    if (pourTous) return pageAgenda(false, "Autorisation annulee.");
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

    if (pourTous) return pageAgenda(!!data.success, data.error);
    if (data.success) {
      return NextResponse.redirect(
        new URL("/?oauth_redirect=settings&oauth_success=true", appUrl)
      );
    }

    return NextResponse.redirect(
      new URL(`/?oauth_redirect=settings&oauth_error=${encodeURIComponent(data.error || "failed")}`, appUrl)
    );
  } catch {
    if (pourTous) return pageAgenda(false);
    return NextResponse.redirect(
      new URL("/?oauth_redirect=settings&oauth_error=server_error", appUrl)
    );
  }
}
