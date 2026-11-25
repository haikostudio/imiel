// ROUTE PUBLIQUE VOULUE (pas de connexion requise) : Public exprès : proxy de favicon par domaine (lecture seule, domaine reduit).
import { type NextRequest } from "next/server";
import { createHash } from "node:crypto";

// Proxy de favicon de marque, par domaine. Pourquoi un proxy serveur et pas un
// <img> direct vers un service de favicon :
//  - les sous-domaines d'envoi (info.manomano.fr, noreply.aosom.fr,
//    email.apple.com...) n'ont PAS d'icone -> on reduit au domaine de MARQUE.
//  - gstatic faviconV2 renvoie un GLOBE generique quand il n'a pas le favicon,
//    souvent avec un corps PNG VALIDE (status 404 ou 200) -> en <img> le
//    navigateur l'affiche quand meme (onerror ne se declenche pas), d'ou des
//    "globes" partout au lieu de notre repli initiales. Cote serveur on LIT le
//    vrai status + on rejette le placeholder par empreinte, puis on renvoie un
//    404 a corps VIDE sur echec -> la balise <img> declenche onerror -> Radix
//    AvatarFallback affiche l'initiale coloree.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 4500;

// Empreintes des placeholders connus a refuser (globe gstatic faviconV2).
const PLACEHOLDER_MD5 = new Set(["b8a0bf372c762e966cc99ede8682bc71"]);

// ccTLD a SLD sur deux niveaux (.co.uk, .com.au, .gouv.fr...) : garder 3 labels.
const TWO_LABEL_SLD = new Set([
  "co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "gob", "gouv",
]);

// Reduit un host au domaine de marque (eTLD+1). Les favicons vivent sur le
// domaine racine, pas sur le sous-domaine d'envoi.
function registrableDomain(raw: string): string {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const last = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (last.length === 2 && TWO_LABEL_SLD.has(sld)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

function faviconV2(domain: string): string {
  const url = encodeURIComponent(`https://${domain}`);
  return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${url}&size=64`;
}

// 404 a corps vide -> <img> onerror -> repli initiales cote client. Cache court
// pour ne pas re-interroger le service a chaque rendu d'une marque sans icone.
function miss(): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "public, max-age=86400" },
  });
}

export async function GET(req: NextRequest) {
  const domain = registrableDomain(req.nextUrl.searchParams.get("domain") || "");
  if (!domain.includes(".")) return miss();

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(faviconV2(domain), { signal: ctrl.signal, redirect: "follow" });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !ct.startsWith("image/")) return miss();
    const buf = Buffer.from(await r.arrayBuffer());
    // Corps minuscule (pixel transparent) ou placeholder globe -> initiales.
    if (buf.byteLength < 70) return miss();
    if (PLACEHOLDER_MD5.has(createHash("md5").update(buf).digest("hex"))) return miss();
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": ct,
        "Cache-Control": "public, max-age=604800, immutable",
      },
    });
  } catch {
    return miss();
  } finally {
    clearTimeout(to);
  }
}
