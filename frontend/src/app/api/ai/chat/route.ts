import { NextRequest } from "next/server";
import { parseDateWindow, type DateWindow } from "@/lib/utils/query-time-parser";
import {
  TOOL_DEFINITIONS,
  buildAction,
  isWriteTool,
  runReadTool,
  claimsCardWithoutAction,
  toolStepSummary,
  toolLabel,
  type ToolContext,
} from "./tools";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-0324";
// Le modele par defaut (DeepSeek V3) ne lit NI image NI PDF : des qu'un
// message porte une image ou un PDF, le tour bascule sur un modele multimodal
// qui sait aussi appeler les outils.
const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash";
// Bornes serveur des pieces jointes (le client redimensionne deja les images).
const MAX_ATTACHMENTS = 5;
const MAX_DATA_URL_CHARS = 15 * 1024 * 1024; // ~11 Mo binaires en base64
const MAX_TEXT_ATTACHMENT_CHARS = 60_000;
// Timeout sur l'ouverture du flux uniquement (les headers arrivent vite). On
// utilise un AbortController qu'on desarme des que la reponse arrive : sinon
// AbortSignal.timeout coupe AUSSI la lecture du body en plein streaming des
// que la generation depasse la duree (cause confirmee du "operation aborted
// due to timeout" en cours de reponse).
const CONNECT_TIMEOUT_MS = 30_000;
// Timeout du RAG context. En prod (SQLite direct, FTS5 + cache vecteurs)
// la recherche prend <500ms. En dev (worker local pointe sur PB prod via
// HTTP API), la recherche keyword multi-termes peut etre tres lente a froid :
// chaque terme = 1 requete LIKE sur subject/text/html/snippet sur 42k mails,
// 5-7s par terme. En parallele on est borne par le plus lent (~7s) PLUS le
// cold-start auth admin + DNS + TLS. 25s donne de la marge en dev ; en prod
// c'est instantane donc on ne sent pas la difference.
const RAG_TIMEOUT_MS = 25_000;
// Timeout coverage : doit etre tres rapide (SQL direct <20ms). Si on depasse
// 1s c'est qu'on est en fallback PB API et on prefere ne pas bloquer la
// requete : on continue sans la couverture (system prompt sans bornes).
const COVERAGE_TIMEOUT_MS = 1_000;
const WORKER_URL =
  process.env.WORKER_INTERNAL_URL ||
  process.env.MAIL_WORKER_URL ||
  "http://127.0.0.1:4001";

const LANG_NAMES: Record<string, string> = {
  fr: "francais",
  en: "English",
  de: "Deutsch",
  it: "italiano",
};

interface ChatAttachmentIn {
  name?: string;
  type?: string;
  kind?: "image" | "pdf" | "text";
  data?: string; // data URL (image / pdf), seulement sur le message qui l'a joint
  text?: string; // contenu d'un fichier texte
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  attachments?: ChatAttachmentIn[];
}

// Parts de contenu multimodal (format OpenAI / OpenRouter).
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

/**
 * Contenu d'un message utilisateur avec ses pieces jointes. Les binaires
 * (image, PDF) deviennent des parts lues par le modele ; un fichier texte est
 * injecte borne ; un message ancien ne rappelle que les NOMS des fichiers.
 */
function buildUserContent(m: ChatMessage): {
  content: string | ContentPart[];
  binary: boolean;
  images: number;
  lost: string[];
} {
  const atts = Array.isArray(m.attachments) ? m.attachments.slice(0, MAX_ATTACHMENTS) : [];
  if (atts.length === 0) return { content: m.content, binary: false, images: 0, lost: [] };
  const parts: ContentPart[] = [];
  const names: string[] = [];
  // Binaires annonces avec des donnees mais inexploitables (vides, format
  // inconnu, trop lourds) : le tour doit le dire, pas repondre a l'aveugle.
  const lost: string[] = [];
  let images = 0;
  let binary = false;
  for (const a of atts) {
    const name = String(a.name || "fichier").slice(0, 120);
    names.push(name);
    const data = typeof a.data === "string" && a.data.length <= MAX_DATA_URL_CHARS ? a.data : "";
    const announced = typeof a.data === "string";
    if (a.kind === "image" && /^data:image\/[a-z0-9.+-]+;base64,./i.test(data) && data.length > 200) {
      parts.push({ type: "image_url", image_url: { url: data } });
      binary = true;
      images++;
    } else if (a.kind === "pdf" && data.startsWith("data:application/pdf") && data.length > 200) {
      parts.push({ type: "file", file: { filename: name, file_data: data } });
      binary = true;
    } else if (announced && (a.kind === "image" || a.kind === "pdf")) {
      lost.push(name);
    } else if (a.kind === "text" && typeof a.text === "string" && a.text) {
      parts.push({
        type: "text",
        text: `[Contenu du fichier joint "${name}"]\n${a.text.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n[Fin du fichier "${name}"]`,
      });
    }
  }
  const head = `[Pieces jointes : ${names.join(", ")}]`;
  const text = m.content.trim() || "Analyse la ou les pieces jointes.";
  if (parts.length === 0) return { content: `${text}\n${head}`, binary: false, images, lost };
  return { content: [{ type: "text", text: `${text}\n${head}` }, ...parts], binary, images, lost };
}

// Message envoye a OpenRouter pendant la boucle d'outils (format OpenAI).
type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

// Nombre maximal d'aller-retours outils par reponse (recherches enchainees).
// 8 tours : lire la configuration (list_app_data) puis proposer plusieurs
// cartes d'une meme demande (ex: creer une etiquette ET la regle qui l'utilise).
const MAX_TOOL_ROUNDS = 8;

// Garde-fou "promesse dans le vide" : un tour qui se termine SANS appel
// d'outil sur une annonce ("un instant", "je vais chercher"...) n'a rien fait.
// Le modele ignore la consigne ecrite ; on le relance donc une fois cote serveur.
const PROMISE_RE =
  /(un (petit )?instant|une (petite )?seconde|je (vais|m'en vais|lance|verifie|recherche|cherche|finalise|consulte|m'occupe|reviens)|laisse[- ]moi|patiente[zr]?|attende[zr]?|je te (tiens|redis)|one moment|let me (check|look|search|find)|i('| wi)ll (check|look|search|find|get back)|einen moment|ich (suche|schaue|prufe)|un momento|ora cerco)/;
function endsWithPromise(text: string): boolean {
  const tail = text
    .slice(-300)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u2019/g, "'")
    .toLowerCase();
  return tail.trim() !== "" && PROMISE_RE.test(tail);
}

interface RagHit {
  id: string;
  thread_id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  body: string;
  score: number;
}

interface IndexingStatus {
  total: number;
  embedded: number;
  backfillRunning?: boolean;
  backfillDone?: number;
  backfillTotal?: number;
}

interface CoverageStats {
  earliestDate: string | null;
  latestDate: string | null;
  totalMessages: number;
  indexedMessages: number;
}

// Fiche de suivi compacte renvoyee par le worker (GET /tracking/context).
// Source STRUCTUREE et fiable pour les questions achats/commandes/livraisons :
// le RAG email seul peut rater les bons mails (ex: "bureau" matche des mails
// de coworking vieux de 10 ans au lieu de la commande de table recente).
interface TrackingFiche {
  id: string;
  title: string;
  type: string;
  status: string;
  status_label: string;
  merchant: string;
  closure_suggested: boolean;
  fields: Record<string, unknown>;
  thread_id: string;
  last_message_date: string;
  events: Array<{ date: string; label: string; detail: string }>;
}

const TRACKING_TIMEOUT_MS = 5_000;

function sse(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

/**
 * Recupere les bornes temporelles + total mails de l'utilisateur depuis le
 * worker. Cache cote worker (5min TTL). Echec silencieux : on continue sans
 * la couverture plutot que de bloquer la requete chat.
 */
async function fetchCoverage(userId: string): Promise<CoverageStats | null> {
  try {
    const res = await fetch(
      `${WORKER_URL}/embeddings/coverage?userId=${encodeURIComponent(userId)}`,
      { signal: AbortSignal.timeout(COVERAGE_TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    return (await res.json()) as CoverageStats;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const {
    messages,
    language,
    today,
    userId,
    apiKey: bodyKey,
    authToken,
    timezone,
  } = (await request.json()) as {
    // Jeton PocketBase de l'utilisateur : les outils de lecture interrogent
    // PB avec, donc sous ses regles d'acces.
    authToken?: string;
    timezone?: string;
    messages: ChatMessage[];
    language?: string;
    today?: string;
    userId?: string;
    // accountId existe encore cote client mais on l'ignore volontairement :
    // l'assistant cherche TOUJOURS sur tous les comptes de l'utilisateur,
    // sinon on rate les mails du "mauvais" compte sans le dire.
    accountId?: string;
    apiKey?: string;
  };

  const apiKey =
    (typeof bodyKey === "string" && bodyKey.trim()) ||
    process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "OPENROUTER_API_KEY is not configured" },
      { status: 500 }
    );
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages is required" }, { status: 400 });
  }

  const lang = LANG_NAMES[language || "fr"] || LANG_NAMES.fr;
  const date = today || new Date().toISOString().slice(0, 10);

  // Construction de la requete RAG : on concatene les 3 derniers messages
  // utilisateur (dernier en premier pour le poids), pas seulement le dernier.
  // Sinon une follow-up vague ("fais-moi une analyse", "resume ca", "et lui ?")
  // perd le sujet de la question precedente : le RAG cherche sur 3 mots
  // generiques et ne ramene rien de pertinent, le LLM repond a cote.
  // En concatenant, les termes specifiques ("Jean", "projet X", refs, dates)
  // restent dans la query et le RAG retrouve les bons mails.
  const userMsgs = messages.filter((m) => m.role === "user");
  const lastUserContent = (userMsgs[userMsgs.length - 1]?.content || "").trim();
  const query = userMsgs
    .slice(-3)
    .map((m) => m.content.trim())
    .filter(Boolean)
    .reverse()
    .join(" ")
    .slice(0, 800);

  // Normalisation sans accents pour matcher l'intent quelle que soit la
  // graphie de l'utilisateur ("resume" et "resume" passent tous deux).
  // Strip aussi les apostrophes typographiques (-> apostrophe ASCII) pour
  // matcher d'une seule facon dans les regex.
  const stripAccents = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[‘’]/g, "'");
  const lastUserContentNorm = stripAccents(lastUserContent).toLowerCase();

  // Detection meta : la question porte sur la conversation chat elle-meme
  // ("resume notre echange", "qu'est-ce que tu m'as dit", "analyse notre
  // discussion"). Dans ce cas le LLM doit s'appuyer SURTOUT sur l'historique
  // de chat, pas sur le RAG (qui ramenerait des mails sans rapport).
  const META_RE =
    /\b(notre|cette|la)\s+(discussion|conversation|echange|chat)\b|\b(tu m'?as dit|on (?:vient de|s'est) dit|qu'est-ce que (?:tu|on) (?:a|as|avons) dit|recap(?:itule)? (?:notre|la))\b/i;
  const isMetaQuestion = META_RE.test(lastUserContentNorm);

  // Detection "wide" : la question est une synthese / vue d'ensemble qui
  // demande l'arc complet d'un sujet, OU une question d'ORIGINE (premier mail,
  // depuis quand, depuis combien de temps). Patterns enrichis pour couvrir
  // "il y a N mois", "en {mois}", "saison derniere" — sinon ces questions
  // tombent en focused et ratent l'historique long.
  const WIDE_INTENT_PATTERNS = [
    // FR : synthese / analyse
    "resum\\w*",
    "synthes\\w*",
    "synthetis\\w*",
    "recap\\w*",
    "recapitul\\w*",
    "historiqu\\w*",
    "chronologi\\w*",
    "integralit\\w*",
    "panorama",
    "panoramique",
    "timeline",
    // FR : vue d'ensemble
    "vue d['']ensemble",
    "ensemble (?:du|des|de) ",
    "tout (?:le|la|les|sur|au sujet|a propos|ce|l[''])",
    "sur (?:le|la|les|l['']) (?:projet|dossier|sujet|affaire|programme|themat\\w*)",
    // FR : origine / temporel
    "depuis (?:quand|combien|le debut|toujours|des mois|plusieurs mois)",
    "depuis (?:\\d+ )?(?:mois|semaine|jour|an|annee)",
    // Accepte n'importe quel mot court entre "quand" et le verbe (a/ont/on/
    // est/sont/ca/cela/ils/elles), couvre toutes les conjugaisons FR
    "quand\\s+(?:\\S+\\s+){0,3}(?:commenc\\w*|debut\\w*|demarr\\w*|entam\\w*|ouvert|aborde\\w*|ne\\s+commenc\\w*)",
    "quand (?:remonte|datent?|a-t-on)",
    "ont (?:commenc\\w*|debut\\w*|demarr\\w*)",
    "(?:a |on |ont |sont )(?:commenc\\w*|debut\\w*|demarr\\w*)",
    "premier(?:e|s|es)? (?:mail|email|message|echange|contact|envoi|reponse|ech\\w*)",
    "plus ancien(?:s|ne|nes)?",
    "origine du",
    "debut(?:s)? (?:du|de la|des) (?:projet|dossier|sujet|echange|programme|relation|collaboration|discussion)",
    "depuis combien de temps",
    "il y a combien de temps",
    "il y a \\d+ (?:mois|ans|annees|semaines)",
    "en (?:janv|fevr|mars|avr|mai|juin|juil|aout|sept|oct|nov|dec)",
    "(?:l[''])?(?:ete|automne|hiver|printemps)( dernier| passe| \\d{4})?",
    "l['']?(?:annee|mois) (?:derniere?|passee?)",
    // EN
    "overview",
    "first (?:mail|email|message|exchange|contact)",
    "oldest (?:mail|email|message)",
    "since when",
    "when did .{0,30}? (?:start|begin)",
    "how long (?:has|have|did)",
    "complete history",
    "whole (?:project|thread|conversation)",
    "all about",
    "everything (?:about|on)",
    "(?:\\d+ )?(?:months?|years?|weeks?|days?) ago",
    // DE
    "zusammenfass\\w*",
    "ubersicht",
    "gesamt(?:bild|ansicht)",
    "alles uber",
    "seit wann",
    "wann hat .{0,30}? (?:angefangen|begonnen)",
    "vor (?:\\d+ )?(?:monaten?|jahren?|wochen?)",
    // IT
    "riassum\\w*",
    "panoramica",
    "tutto (?:il|sul|su)",
    "quando (?:e |ha )?(?:iniziato|cominciato)",
    "prima (?:mail|email|messaggio)",
    "(?:\\d+ )?(?:mesi|anni|settimane) fa",
  ];
  const WIDE_INTENT_RE = new RegExp(
    "\\b(" + WIDE_INTENT_PATTERNS.join("|") + ")",
    "i"
  );
  const isWideQuery = WIDE_INTENT_RE.test(lastUserContentNorm);

  // Parse une eventuelle fenetre temporelle ("avril 2025", "il y a 8 mois",
  // "l'ete dernier", "depuis janvier", "en 2024"...). Si presente, le worker
  // bypass le cap 75k vecteurs et cible la fenetre via FTS5 SQL : on retrouve
  // les mails anciens meme sur des boites volumineuses.
  const dateWindow: DateWindow | null = parseDateWindow(lastUserContent);

  // Si une fenetre est detectee on force wide mode (echantillonnage chrono
  // dans la fenetre, comportement attendu pour une question temporelle).
  const ragMode: "focused" | "wide" =
    (isWideQuery || dateWindow) && !isMetaQuestion ? "wide" : "focused";

  // Couverture reelle de la boite : recupere en parallele du RAG. Le timeout
  // est court (1s) car la query SQL directe est instantanee ; en cas d'echec
  // on continue sans la couverture (system prompt sans bornes).
  let coverage: CoverageStats | null = null;
  let hits: RagHit[] = [];
  let indexing: IndexingStatus | null = null;
  let ragSearchUsedWindow: DateWindow | null = null;
  // Flag CRITIQUE : si le worker est down ou que le RAG plante, on DOIT
  // le faire savoir au LLM (sinon il invente "je n'ai rien trouve") ET
  // au user via le bandeau UI.
  let ragError: string | null = null;
  let cerveauMems: string[] = [];
  let trackingFiches: TrackingFiche[] = [];

  // Wide mode : on demande plus de candidats (25) pour vraiment couvrir
  // l'arc historique. Focused garde 15 (rapide, suffisant pour les
  // questions ciblees).
  const ragLimit = ragMode === "wide" ? 25 : 15;
  if (query && userId) {
    const ragT0 = Date.now();
    console.log(
      `[chat] RAG query mode=${ragMode} limit=${ragLimit} user=${userId}${
        dateWindow ? ` window=${dateWindow.from}..${dateWindow.to}(${dateWindow.label})` : ""
      } q="${query.slice(0, 120)}${query.length > 120 ? "..." : ""}"`
    );
    const [ragResult, coverageResult, cerveauResult, trackingResult] = await Promise.allSettled([
      fetch(`${WORKER_URL}/embeddings/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          query,
          limit: ragLimit,
          mode: ragMode,
          dateWindow: dateWindow || undefined,
        }),
        signal: AbortSignal.timeout(RAG_TIMEOUT_MS),
      }).then((r) => {
        if (!r.ok) throw new Error(`RAG HTTP ${r.status}`);
        return r.json() as Promise<{
          results?: RagHit[];
          indexing?: IndexingStatus;
          dateWindow?: DateWindow;
        }>;
      }),
      fetchCoverage(userId),
      // Recall Cerveau (memoire centrale) : non bloquant, complement au RAG.
      fetch(`${WORKER_URL}/cerveau/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, query, k: 5 }),
        signal: AbortSignal.timeout(RAG_TIMEOUT_MS),
      })
        .then((r) => (r.ok ? r.json() : { resultats: [] }))
        .then((d) => (d as { resultats?: { texte?: string }[] }).resultats || []),
      // Fiches de suivi (Suivi d'affaires) : donnees structurees fiables sur
      // les achats/commandes/livraisons/factures. Non bloquant, best effort.
      fetch(
        `${WORKER_URL}/tracking/context?userId=${encodeURIComponent(userId)}`,
        { signal: AbortSignal.timeout(TRACKING_TIMEOUT_MS) }
      )
        .then((r) => (r.ok ? r.json() : { fiches: [] }))
        .then((d) => (d as { fiches?: TrackingFiche[] }).fiches || []),
    ]);

    if (ragResult.status === "fulfilled") {
      hits = ragResult.value.results || [];
      indexing = ragResult.value.indexing || null;
      ragSearchUsedWindow = ragResult.value.dateWindow || null;
      console.log(
        `[chat] RAG got ${hits.length} hits in ${Date.now() - ragT0}ms (indexed ${
          indexing?.embedded ?? "?"
        }/${indexing?.total ?? "?"})`
      );
    } else {
      // Worker down ou erreur fatale du RAG : on enregistre l'erreur pour
      // l'injecter dans le system prompt ET la remonter a l'UI (sinon le
      // LLM dirait "je n'ai rien trouve" en hallucinant qu'il a cherche).
      const msg = (ragResult.reason as Error)?.message || "unknown";
      ragError = msg;
      console.error("[chat] RAG context error:", msg);
    }

    if (coverageResult.status === "fulfilled" && coverageResult.value) {
      coverage = coverageResult.value;
    }

    if (cerveauResult.status === "fulfilled" && Array.isArray(cerveauResult.value)) {
      cerveauMems = cerveauResult.value
        .map((m) => (m?.texte || "").trim())
        .filter(Boolean);
    }

    if (trackingResult.status === "fulfilled" && Array.isArray(trackingResult.value)) {
      trackingFiches = trackingResult.value;
    }
  }

  const ctxBlocks =
    hits.length > 0
      ? hits
          .map(
            (h, i) =>
              `[#${i + 1} | id=${h.id} | thread=${h.thread_id} | score=${h.score}]\nDe: ${
                h.from
              }\nDate: ${h.date}\nSujet: ${h.subject}\n${h.body}`
          )
          .join("\n\n---\n\n")
      : ragError
        ? `(ERREUR TECHNIQUE : le service de recherche dans les emails a echoue : "${ragError}". Aucun email n'a ete consulte.)`
        : "(aucun email pertinent trouve dans la memoire pour cette requete)";

  // Note erreur RAG : si le worker etait down/timeout, on l'indique
  // EXPLICITEMENT au LLM pour qu'il NE PRETENDE PAS avoir cherche.
  const ragErrorNote = ragError
    ? `\n\nALERTE CRITIQUE : Le service de recherche dans les emails a ECHOUE (erreur technique : "${ragError}"). Tu N'AS PAS pu consulter les emails de l'utilisateur. Tu DOIS :
- Dire HONNETEMENT a l'utilisateur "Je n'ai pas pu acceder a tes emails pour le moment (service de recherche indisponible). Reessaye dans un instant ou verifie que le worker tourne."
- NE JAMAIS dire "je n'ai trouve aucun email" ou "rien trouve" : tu n'as PAS cherche, le service est tombe.
- NE PAS inventer de reponse, NE PAS proposer de reformulations.`
    : "";

  // Note d'indexation : si la boite n'est pas entierement indexee, on le
  // signale explicitement pour que le LLM nuance ses reponses negatives.
  let indexingNote = "";
  if (indexing && indexing.total > 0) {
    const pct = Math.round((indexing.embedded / indexing.total) * 100);
    if (pct < 95) {
      const running = indexing.backfillRunning
        ? ` (indexation en cours : ${indexing.backfillDone}/${indexing.backfillTotal})`
        : "";
      indexingNote = `\n\nETAT MEMOIRE : ${indexing.embedded}/${indexing.total} mails indexes (${pct}%)${running}. Si tu ne trouves rien, mentionne que la memoire est encore partielle.`;
    }
  }

  // Bornes reelles de la boite : sert au LLM pour ne JAMAIS inventer une
  // borne temporelle ("rien avant mi-avril") quand la boite remonte plus loin.
  // Si on a la couverture, on l'injecte explicitement.
  let coverageBoundsNote = "";
  if (coverage && coverage.earliestDate && coverage.latestDate) {
    const earliest = coverage.earliestDate.slice(0, 10);
    const latest = coverage.latestDate.slice(0, 10);
    coverageBoundsNote = `\n\nCOUVERTURE REELLE DE LA BOITE :
- Plus ancien mail : ${earliest}
- Plus recent mail : ${latest}
- Total mails dans la boite : ${coverage.totalMessages}
- Mails indexes (recherchables) : ${coverage.indexedMessages}`;
  }

  // Fenetre de recherche effectivement utilisee (si une periode etait
  // detectee dans la question) : le LLM doit le savoir pour formuler
  // honnetement "dans la periode demandee, j'ai trouve...".
  let searchWindowNote = "";
  if (ragSearchUsedWindow) {
    searchWindowNote = `\n\nFENETRE DE RECHERCHE : la question contient une reference temporelle. La recherche a ete ciblee sur ${ragSearchUsedWindow.from} -> ${ragSearchUsedWindow.to} (${ragSearchUsedWindow.label || ""}). Reponds explicitement par rapport a cette periode.`;
  }

  // Note de couverture echantillon (pour eviter "je n'ai trouve que 3 emails")
  let coverageNote = "";
  if (hits.length > 0) {
    if (ragMode === "wide") {
      const oldest = hits.reduce(
        (acc, h) => (h.date < acc ? h.date : acc),
        hits[0].date
      );
      const newest = hits.reduce(
        (acc, h) => (h.date > acc ? h.date : acc),
        hits[0].date
      );
      coverageNote = `\n\nECHANTILLON : Le CONTEXTE contient ${hits.length} emails echantillonnes chronologiquement (du ${oldest.slice(0, 10)} au ${newest.slice(0, 10)}). D'autres emails existent entre ces points. NE DIS JAMAIS "je n'ai trouve que X emails" : construis une synthese qui couvre la periode.`;
    } else {
      coverageNote = `\n\nECHANTILLON : Le CONTEXTE contient ${hits.length} emails selectionnes (les plus pertinents). D'autres peuvent exister sur le sujet. Formule "voici les emails les plus pertinents" plutot que "je n'ai trouve que X emails".`;
    }
  }

  // Suivi d'affaires : bloc structure des fiches de l'utilisateur. C'est la
  // source la plus FIABLE pour les questions achats/commandes/livraisons :
  // titre, marchand, statut, numero de suivi, dates... la ou la recherche
  // email peut ramener des mails hors sujet (mots ambigus).
  let suiviNote = "";
  if (trackingFiches.length > 0) {
    const lines = trackingFiches.map((f) => {
      const isClosed = f.status === "done" || f.status === "cancelled";
      const flds = Object.entries(f.fields || {})
        .filter(([, v]) => v !== null && v !== "" && typeof v !== "object")
        .slice(0, 8)
        .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
        .join(", ");
      const evs = (f.events || [])
        .map((e) => `${(e.date || "").slice(0, 10)} ${e.label}`.trim())
        .join(" | ");
      return `- [${isClosed ? "Cloture" : "Ouvert"}] (${f.type || "affaire"}) ${
        f.title
      }${f.merchant ? ` — marchand: ${f.merchant}` : ""}${
        f.last_message_date
          ? ` — dernier message: ${f.last_message_date.slice(0, 10)}`
          : ""
      }${flds ? `\n  Infos: ${flds}` : ""}${evs ? `\n  Timeline: ${evs}` : ""}`;
    });
    suiviNote = `\n\nSUIVI D'AFFAIRES (fiches de suivi de l'utilisateur — donnees STRUCTUREES et VERIFIEES sur ses achats, commandes, livraisons, factures, rendez-vous et dossiers) :\n${lines.join(
      "\n"
    )}\n\nPour toute question sur un achat, une commande, une livraison, un colis, une facture ou un dossier : appuie-toi D'ABORD sur ce SUIVI D'AFFAIRES (c'est la verite), puis complete avec le CONTEXTE emails s'il apporte des details concordants. Si une fiche correspond meme PARTIELLEMENT au produit ou sujet demande (ex: l'utilisateur dit "table de bureau" et une fiche mentionne un pied de table, un plateau ou une table), presente-la comme correspondance probable ("je vois cette commande, est-ce bien celle-la ?") plutot que de repondre "rien trouve".`;
  }

  // Memoire centrale (Cerveau) : contexte complementaire au RAG email.
  const cerveauNote =
    cerveauMems.length > 0
      ? `\n\nMEMOIRE CENTRALE (Cerveau) - faits/contexte pertinents memorises :\n${cerveauMems
          .map((m) => `- ${m.slice(0, 600)}`)
          .join("\n")}`
      : "";

  const metaNote = isMetaQuestion
    ? `\n\nIMPORTANT : la question porte sur VOTRE conversation chat. Reponds en t'appuyant sur l'HISTORIQUE ci-dessous, n'invente pas de propos. Le CONTEXTE emails ne sert qu'en complement.`
    : "";

  const systemPrompt = `Tu es l'assistant IA d'iMiel, un client email. Tu aides l'utilisateur a retrouver et comprendre ses emails, a resumer ses conversations, a analyser ses echanges, et tu AGIS pour lui (brouillons, agenda, contacts, suivis) apres sa validation.

Date du jour : ${date}.

Regles fondamentales :
- Reponds toujours en ${lang}, de maniere naturelle, claire et concise.
- Le CONTEXTE ci-dessous resulte d'une recherche HYBRIDE (semantique + mots-cles) sur TOUS les comptes email de l'utilisateur. C'est un ECHANTILLON pertinent, PAS la totalite.
- PIECES JOINTES : un message utilisateur peut porter des images, des PDF ou des fichiers texte joints (marques [Pieces jointes : ...]). Regarde-les et reponds a partir de leur contenu reel ; ne pretends jamais voir un fichier dont seul le nom est rappele (message ancien) : dis qu'il faut le joindre a nouveau.
- L'HISTORIQUE de conversation (messages user/assistant) est ta MEMOIRE. Tu DOIS le prendre en compte a chaque reponse.

REGLES TEMPORELLES STRICTES (TRES IMPORTANT) :
- N'INVENTE JAMAIS de borne temporelle. Tu ne dis JAMAIS "je n'ai rien avant {date}" — c'est une hallucination interdite.
- Si tu cherches sur une periode et ne trouves rien, dis "je n'ai trouve aucun mail correspondant a {sujet} entre {from} et {to}" — et propose d'elargir.
- Refere-toi a la COUVERTURE REELLE ci-dessous si elle est fournie : c'est la verite sur ce que contient la boite. Tu peux dire "ta boite remonte jusqu'a {earliest}" mais JAMAIS "tu n'as rien avant {date}" sans verifier que c'est dans la couverture.

Gestion des follow-ups :
- Quand l'utilisateur pose une question vague ("fais-moi une analyse", "et alors ?", "creuse"), elle se refere au SUJET deja aborde. Combine HISTORIQUE + CONTEXTE, ne traite jamais la derniere question isolement.
- Si la requete est meta (porte sur votre echange chat), reponds depuis l'historique.

Sois PROACTIF :
- Exploite tout ce que tu vois (HISTORIQUE + CONTEXTE) pour construire une synthese utile. Identifie interlocuteurs, sujets, dates cles, evolution, decisions.
- Cite l'expediteur, le sujet et la date des messages.
- N'invente JAMAIS d'emails, expediteurs, dates ou details absents du CONTEXTE.
- FILTRE DE PERTINENCE (CRITIQUE) : la recherche est approximative, le CONTEXTE peut contenir des emails HORS SUJET (homonymes : "bureau" peut matcher des mails de coworking au lieu d'un meuble). N'utilise QUE les emails qui repondent VRAIMENT a la question. Si aucun email du CONTEXTE n'est pertinent, dis-le honnetement — ne construis JAMAIS une reponse en tordant des emails sans rapport.
- Si le CONTEXTE ne contient rien : regarde l'HISTORIQUE en premier. Si vraiment rien : dis-le une fois, propose 2-3 reformulations concretes. Ne redemande PAS de precisions a chaque tour.

OUTILS ET ACTIONS :
- Tu disposes d'outils. Les outils search_* (emails, agenda, contacts, newsletters, suivi) LISENT les donnees sans rien modifier : utilise-les librement pour fonder tes reponses (ex: question sur l'agenda -> search_calendar, sur une newsletter -> search_newsletters).
- Tu as acces a TOUTE l'application iMiel : list_app_data lit les comptes, signatures, etiquettes, dossiers, regles de tri, expediteurs bloques, newsletters suivies, alertes et reglages (plusieurs rubriques en un appel).
- Les outils propose_* (brouillon, evenements, contacts, suivi, comptes, signature, etiquettes, dossiers, regles, blocages, newsletters, alertes, gestes sur les mails, reglages) NE FONT RIEN eux-memes : ils affichent une CARTE que l'utilisateur accepte, modifie ou refuse. Ne pretends JAMAIS qu'une action est faite : dis qu'une proposition attend sa validation, en une phrase courte, sans recopier le detail de la carte.
- Brouillon : retrouve d'abord les ADRESSES des destinataires (search_contacts, sinon search_emails). N'invente jamais une adresse ; si elle reste introuvable, demande-la. Redige un vrai texte (formule d'appel, corps, formule de politesse) dans la langue du destinataire. Un brouillon n'est JAMAIS envoye.
- Agenda : les heures sont en heure LOCALE de l'utilisateur (fuseau ${timezone || "Europe/Paris"}), format YYYY-MM-DDTHH:mm. Pour modifier ou supprimer, cherche TOUJOURS les evenements avec search_calendar pour obtenir leurs id. Plusieurs evenements = UN seul appel avec la liste.
- CONFIGURATION DE L'APP : toute demande de configurer, creer, modifier ou supprimer quelque chose DANS iMiel (ajouter un compte, ecrire une signature, creer une etiquette ou une regle, bloquer un expediteur, suivre une newsletter, changer un reglage...) se fait PAR L'OUTIL propose_* correspondant, jamais par un mode d'emploi a suivre a la main. Lis d'abord avec list_app_data pour avoir les id.
- Ajout de compte : appelle propose_account_create avec l'adresse (et le fournisseur s'il est cite) : les serveurs des fournisseurs connus se remplissent seuls, meme pour un domaine perso. Ne demande JAMAIS le mot de passe dans la conversation : la carte le fait saisir (masque). S'il a ete donne, passe-le dans l'outil mais ne le recopie jamais dans ta reponse. Si l'outil repond que le fournisseur est inconnu, demande chez qui le compte est heberge.
- Signature : list_app_data (accounts + signature) pour le compte, puis propose_signature avec un HTML simple (nom, fonction, telephone, lien) ; une image ne s'y met que si son adresse est connue, sinon dis qu'elle s'ajoute dans Reglages > Signatures.
- Gestes sur des mails (archiver, classer, etiqueter, marquer lu...) : search_emails pour les id, puis propose_mail_action. "Supprimer" = corbeille (trash) ; delete_forever seulement si l'utilisateur dit explicitement "definitivement".
- Suivi : cherche les emails du sujet avec search_emails, puis propose_create_tracking avec leurs message_ids pertinents (uniquement ceux qui parlent vraiment du sujet).
- Chaque action distincte = un appel propose_* ; l'utilisateur peut tout accepter d'un coup. Une demande qui combine plusieurs actions (creer ET deplacer...) : fais TOUTES les recherches necessaires puis TOUTES les propositions avant de repondre.
- N'annonce jamais une action future : fais l'appel d'outil tout de suite.
- Ne dis JAMAIS qu'une proposition est prete si tu n'as pas appele l'outil propose_* correspondant dans ce tour : la carte n'existerait pas.
- Les messages assistant precedents peuvent se terminer par [Actions: ...] : c'est le resultat des cartes (acceptee, refusee, modifiee, echec), AJOUTE PAR L'APPLICATION. Tiens-en compte mais ne l'ecris JAMAIS toi-meme : une nouvelle demande exige un NOUVEL appel propose_*, meme si une carte semblable a deja ete refusee.

Format (markdown) : listes a puces ou numerotees pour enumerer des emails, **gras** pour les libelles (Sujet, Expediteur, Date), ### pour les titres. Pas de tableaux.${ragErrorNote}${coverageBoundsNote}${searchWindowNote}${indexingNote}${coverageNote}${suiviNote}${cerveauNote}${metaNote}

CONTEXTE (emails pertinents) :
${ctxBlocks}

RAPPEL OUTILS (PRIORITAIRE) : des que la demande touche l'agenda, les contacts, les newsletters, le suivi, les comptes, signatures, etiquettes, dossiers, regles, blocages, reglages, ou demande d'ECRIRE / CREER / MODIFIER / SUPPRIMER quelque chose, APPELLE les outils IMMEDIATEMENT dans ce meme tour (plusieurs appels possibles a la suite). N'ecris JAMAIS "je vais chercher / je vais creer / un instant" sans faire l'appel : l'utilisateur ne peut pas te relancer. Tu n'as AUCUN acces a internet (ni site web, ni calendrier officiel, ni actualite) : si la reponse en depend (dates officielles de vacances scolaires, horaires publics...), dis-le franchement tout de suite et donne ce que tu sais en le presentant comme approximatif, sans jamais promettre une recherche. Apres un propose_*, ne recopie pas le contenu de la carte : une phrase suffit.`;

  // Historique etendu : 16 derniers messages = ~8 echanges complets.
  let needsVision = false;
  let imageParts = 0;
  let lostFiles: string[] = [];
  const history: LlmMessage[] = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-16)
    .map((m): LlmMessage => {
      if (m.role === "assistant") return { role: "assistant", content: m.content };
      const built = buildUserContent(m);
      if (built.binary) needsVision = true;
      imageParts += built.images;
      if (built.lost.length) lostFiles = built.lost;
      return { role: "user", content: built.content };
    });
  // Garde-fou : un fichier joint dont le contenu n'a pas pu etre transmis ne
  // doit jamais donner une reponse qui fait comme s'il n'existait pas.
  if (lostFiles.length > 0) {
    console.warn(`[chat] piece jointe inexploitable user=${userId || "?"} fichiers=${lostFiles.join(",")}`);
    return Response.json(
      {
        error: `Le contenu de ${lostFiles.join(", ")} n'a pas pu etre transmis a l'assistant. Joignez le fichier a nouveau (format JPEG, PNG ou PDF).`,
      },
      { status: 422 }
    );
  }
  const model = needsVision
    ? process.env.OPENROUTER_MODEL_VISION || DEFAULT_VISION_MODEL
    : process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  console.log(`[chat] model=${model} vision=${needsVision} images=${imageParts}`);
  // Le dernier message porte une image : le modele la lit AVANT de chercher
  // dans les mails, et n'en redemande jamais le contenu.
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const lastHasImage = !!lastUser && Array.isArray(lastUser.content) && lastUser.content.some((p) => p.type !== "text");
  const convo: LlmMessage[] = [
    {
      role: "system",
      content: lastHasImage
        ? `${systemPrompt}\n\nFICHIER JOINT AU DERNIER MESSAGE : une image ou un document est joint et tu le VOIS. Lis-le en premier et appuie ta reponse (et tes propositions) sur son contenu. Ne demande JAMAIS a l'utilisateur de te redonner ce qu'il contient ; le CONTEXTE email n'est qu'un complement.`
        : systemPrompt,
    },
    ...history,
  ];

  const toolCtx: ToolContext | null =
    userId && typeof authToken === "string" && authToken
      ? {
          userId,
          authToken,
          timezone: timezone || "Europe/Paris",
          // Ce que l'utilisateur a REELLEMENT ecrit : un mot de passe propose
          // par le modele n'est garde que s'il y figure (jamais invente).
          userText: history
            .filter((m) => m.role === "user")
            .map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => ("text" in p ? String(p.text) : "")).join(" ") : ""))
            .join("\n"),
        }
      : null;
  // Une reponse = un groupe d'actions ("Tout accepter" valide tout le groupe).
  const groupId = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  // Ouvre un tour OpenRouter en streaming. AbortController manuel : on abort
  // UNIQUEMENT si les headers n'arrivent pas dans le delai ; la lecture du
  // body streame n'est plus bornee ensuite.
  async function openRound(withTools: boolean): Promise<Response> {
    const connectController = new AbortController();
    const connectTimer = setTimeout(() => connectController.abort(), CONNECT_TIMEOUT_MS);
    try {
      return await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
          "X-Title": "iMiel",
        },
        body: JSON.stringify({
          model,
          messages: convo,
          // 0.4 : un peu plus expressif que 0.3 (conversationnel) mais reste
          // factuel. Au-dela on hallucine sur les details emails.
          temperature: 0.4,
          max_tokens: ragMode === "wide" ? 2000 : 1200,
          stream: true,
          ...(withTools && toolCtx ? { tools: TOOL_DEFINITIONS, tool_choice: "auto" } : {}),
        }),
        signal: connectController.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }
  }

  let firstUpstream: Response;
  try {
    firstUpstream = await openRound(true);
  } catch (err) {
    return Response.json({ error: (err as Error).message || "AI chat failed" }, { status: 502 });
  }
  if (!firstUpstream.ok || !firstUpstream.body) {
    const body = await firstUpstream.text().catch(() => "");
    console.error("OpenRouter HTTP", firstUpstream.status, body.slice(0, 300));
    return Response.json({ error: `OpenRouter HTTP ${firstUpstream.status}` }, { status: 502 });
  }

  // Meta event emis avant les tokens : permet a l'UI d'afficher un bandeau
  // "j'ai cherche sur la periode X, trouve Y mails" avant la reponse, ou
  // une alerte rouge si le RAG a echoue (worker down, timeout).
  const metaEvent = {
    type: "meta" as const,
    hits: hits.length,
    mode: ragMode,
    window: ragSearchUsedWindow,
    coverage: coverage
      ? {
          earliest: coverage.earliestDate,
          latest: coverage.latestDate,
          total: coverage.totalMessages,
          indexed: coverage.indexedMessages,
        }
      : null,
    sources: hits.slice(0, 8).map((h) => ({
      id: h.id,
      thread_id: h.thread_id,
      subject: h.subject,
      from: h.from,
      date: h.date,
    })),
    error: ragError,
  };

  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sse(metaEvent));
      try {
        let upstream: Response = firstUpstream;
        // Texte deja emis par un tour precedent : on separe le suivant d'un
        // saut de paragraphe (sinon "Un instant.Voici..." colle).
        let emittedText = false;
        let nudged = false;
        // Cartes reellement emises dans cette reponse (garde-fou carte imaginaire).
        let actionsEmitted = 0;
        let allText = "";
        // Boucle d'outils : chaque tour streame son texte ; s'il demande des
        // outils, on les execute (lecture) ou on les transforme en carte
        // (ecriture), on rend le resultat au modele et on relance.
        for (let round = 0; ; round++) {
          const reader = upstream.body!.getReader();
          activeReader = reader;
          const decoder = new TextDecoder();
          let buf = "";
          let text = "";
          const calls: { id: string; name: string; args: string }[] = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === "[DONE]") continue;
              try {
                const json = JSON.parse(payload);
                const d = json?.choices?.[0]?.delta;
                const delta: string | undefined = d?.content;
                if (delta) {
                  const sep = !text && emittedText ? "\n\n" : "";
                  text += delta;
                  controller.enqueue(sse({ type: "token", delta: sep + delta }));
                }
                const tcs = d?.tool_calls as
                  | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
                  | undefined;
                if (Array.isArray(tcs)) {
                  for (const tc of tcs) {
                    const i = typeof tc.index === "number" ? tc.index : calls.length;
                    calls[i] = calls[i] || { id: "", name: "", args: "" };
                    if (tc.id) calls[i].id = tc.id;
                    if (tc.function?.name) calls[i].name += tc.function.name;
                    if (tc.function?.arguments) calls[i].args += tc.function.arguments;
                  }
                }
              } catch {
                // chunk partiel ou commentaire keep-alive : ignore
              }
            }
          }
          if (text) emittedText = true;
          allText += text;
          const validCalls = calls.filter((c) => c && c.name);
          const fakeCard = validCalls.length === 0 && actionsEmitted === 0 && claimsCardWithoutAction(allText);
          if (validCalls.length === 0 && toolCtx && (endsWithPromise(text) || fakeCard)) {
            if (!nudged && round + 1 < MAX_TOOL_ROUNDS) {
              // Relance UNIQUE : rappel ferme d'agir ou de repondre franchement.
              nudged = true;
              const id = `step_${round}_retry`;
              controller.enqueue(sse({ type: "step", step: { id, name: "retry", state: "running" } }));
              convo.push({ role: "assistant", content: text });
              convo.push({
                role: "user",
                content:
                  fakeCard
                    ? "[Systeme] Tu as ecrit qu'une carte / proposition attend la validation, mais tu n'as appele AUCUN outil propose_* : aucune carte n'existe a l'ecran. Appelle MAINTENANT l'outil propose_* correspondant (apres list_app_data si tu as besoin d'un id). N'ecris jamais '[Actions: ...]' toi-meme."
                    : "[Systeme] Tu viens d'annoncer une action sans la faire, et l'utilisateur ne peut pas te relancer. Appelle MAINTENANT l'outil necessaire, ou donne ta reponse definitive. Si c'est impossible (pas d'acces internet, donnee absente), dis-le franchement. N'ecris plus jamais 'un instant' ni 'je vais chercher'.",
              });
              console.log(`[chat] ${fakeCard ? "carte imaginaire" : "promesse sans action"}, relance round=${round}`);
              const retry = await openRound(true);
              controller.enqueue(sse({ type: "step", step: { id, name: "retry", state: "done" } }));
              if (!retry.ok || !retry.body) {
                const body = await retry.text().catch(() => "");
                throw new Error(`OpenRouter HTTP ${retry.status} ${body.slice(0, 120)}`);
              }
              upstream = retry;
              continue;
            }
            // Relance deja faite : message honnete (traduit cote ecran).
            controller.enqueue(sse({ type: "unfinished" }));
          }
          if (validCalls.length === 0 || !toolCtx) break;

          validCalls.forEach((c, i) => {
            if (!c.id) c.id = `call_${round}_${i}`;
          });
          convo.push({
            role: "assistant",
            content: text || null,
            tool_calls: validCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.args || "{}" },
            })),
          });
          for (const c of validCalls) {
            let args: Record<string, unknown> = {};
            try {
              args = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {};
            } catch {
              convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ error: "arguments JSON invalides" }) });
              continue;
            }
            let result: unknown;
            // Deroule visible : une etape "en cours" puis "terminee" (ou en
            // echec) avec ce qui a ete cherche et le nombre de resultats.
            const stepId = `step_${round}_${c.id}`;
            const stepName = isWriteTool(c.name) ? "propose" : c.name;
            controller.enqueue(sse({ type: "step", step: { id: stepId, name: stepName, label: toolLabel(c.name), state: "running" } }));
            try {
              if (isWriteTool(c.name)) {
                const action = await buildAction(c.name, args, toolCtx, groupId);
                controller.enqueue(sse({ type: "action", action }));
                actionsEmitted++;
                result = {
                  status: "proposed",
                  message: "Carte affichee a l'utilisateur : RIEN n'est fait tant qu'il n'a pas clique sur Accepter.",
                };
                controller.enqueue(sse({ type: "step", step: { id: stepId, name: stepName, state: "done" } }));
              } else {
                result = await runReadTool(c.name, args, toolCtx);
                const failed = !!(result && typeof result === "object" && "error" in result);
                const { detail, count } = toolStepSummary(c.name, args, result);
                controller.enqueue(sse({ type: "step", step: { id: stepId, name: stepName, state: failed ? "error" : "done", detail, count } }));
              }
            } catch (err) {
              result = { error: (err as Error).message || "echec de l'outil" };
              controller.enqueue(sse({ type: "step", step: { id: stepId, name: stepName, state: "error" } }));
            }
            console.log(`[chat] tool ${c.name} round=${round}`);
            convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result).slice(0, 12_000) });
          }

          // Dernier tour autorise : on retire les outils pour forcer une reponse texte.
          const next = await openRound(round + 1 < MAX_TOOL_ROUNDS);
          if (!next.ok || !next.body) {
            const body = await next.text().catch(() => "");
            throw new Error(`OpenRouter HTTP ${next.status} ${body.slice(0, 120)}`);
          }
          upstream = next;
        }
        controller.enqueue(sse({ type: "done" }));
      } catch (err) {
        controller.enqueue(
          sse({ type: "error", message: (err as Error).message || "stream" })
        );
      } finally {
        controller.close();
      }
    },
    cancel() {
      activeReader?.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
