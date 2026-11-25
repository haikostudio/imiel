import { NextResponse, type NextRequest } from "next/server";

// Robots d'entrainement des IA : refus net (403). iMiel est une messagerie
// privee, il n'y a rien a leur montrer. Complete le garde du serveur.
const ROBOTS_IA =
  /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|CCBot|Google-Extended|PerplexityBot|Bytespider|Amazonbot|Applebot-Extended|cohere-ai|Diffbot|FacebookBot|meta-externalagent|Omgilibot|ImagesiftBot|Timpibot|YouBot/i;

export function proxy(request: NextRequest) {
  const ua = request.headers.get("user-agent") || "";
  if (ROBOTS_IA.test(ua)) {
    return new NextResponse("Acces refuse aux robots d'entrainement.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
