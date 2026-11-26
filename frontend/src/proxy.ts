import { NextResponse, type NextRequest } from "next/server";

// Robots d'entrainement des IA : refus net (403). iMiel est une messagerie
// privee, il n'y a rien a leur montrer. Complete le garde du serveur.
const ROBOTS_IA =
  /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|CCBot|Google-Extended|PerplexityBot|Bytespider|Amazonbot|Applebot-Extended|cohere-ai|Diffbot|FacebookBot|meta-externalagent|Omgilibot|ImagesiftBot|Timpibot|YouBot/i;

// --- Mode LOCAL (app d'ordinateur tout-en-un) --------------------------------
// Le lanceur de l'app (desktop/pile/lanceur.mjs) demarre ce serveur avec
// IMIEL_LOCAL=1 et les adresses de la base et du releveur, choisies A
// L'EXECUTION (ports libres de la machine). Les rewrites de next.config sont
// figes a la fabrication : ici on redirige donc a l'execution.
// Routes servies par Next lui-meme (jamais renvoyees a la base).
const ROUTES_NEXT = /^\/api\/(ai|translate|oauth|test-connection|favicon|desktop)(\/|$)/;
const HOTES_LOCAUX = new Set(["127.0.0.1", "localhost"]);

function localRewrite(request: NextRequest): NextResponse | null {
  if (process.env.IMIEL_LOCAL !== "1") return null;
  // Anti « DNS rebinding » : seule l'adresse locale est servie.
  // (en-tete Host reel : nextUrl.hostname est reconstruit par Next depuis
  // HOSTNAME et vaudrait toujours 127.0.0.1)
  const hote = (request.headers.get("host") || "").replace(/:\d+$/, "").toLowerCase();
  if (!HOTES_LOCAUX.has(hote)) {
    return new NextResponse("Hote refuse.", { status: 403 });
  }
  const { pathname, search } = request.nextUrl;
  const base = process.env.IMIEL_PB_URL;
  const releveur = process.env.IMIEL_WORKER_URL;
  if (base && (pathname.startsWith("/api/") || pathname.startsWith("/_/")) && !ROUTES_NEXT.test(pathname)) {
    return NextResponse.rewrite(new URL(pathname + search, base));
  }
  if (releveur && pathname.startsWith("/worker/")) {
    return NextResponse.rewrite(new URL(pathname.slice("/worker".length) + search, releveur));
  }
  return null;
}

export function proxy(request: NextRequest) {
  const ua = request.headers.get("user-agent") || "";
  if (ROBOTS_IA.test(ua)) {
    return new NextResponse("Acces refuse aux robots d'entrainement.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return localRewrite(request) ?? NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
