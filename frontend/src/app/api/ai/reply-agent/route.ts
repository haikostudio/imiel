import { NextRequest } from "next/server";
import { callOpenRouter, formatAiHtml, resolveModel } from "../openrouter";
import { fetchCerveauContext, fetchRelatedEmails } from "../context";
import { translateHtml } from "../translate-html";
import { formatWhoIsWho, type WhoIsWho } from "@/lib/contact-memory";
import {
  REPLY_AGENT_EXCHANGES,
  REPLY_AGENT_MIN_OWN,
  authorAddresses,
  normAddr,
  selectExchanges,
  stripQuoted,
  type Exchange,
  type ExchangeCandidate,
  type ReplyAgentEvent,
  type ReplyAgentStep,
} from "@/lib/reply-agent";

// Reponse redigee par l'agent (menu IA de la fenetre d'ecriture).
// Enchaine : collecte des 20 derniers echanges avec l'interlocuteur (deux sens,
// adresses de sa fiche contact comprises ; lecture directe par le worker, la
// requete PocketBase depassait 20 s) + memoire "qui est qui" (fiche de la
// personne construite a la premiere reponse puis mise a jour avec les seuls
// nouveaux mails, fiche MOI, fiches des personnes liees ; elles font foi) +
// mails lies au dossier (RAG) + Cerveau -> profil de style et comprehension
// (1 appel JSON) -> redaction dans
// la langue de la conversation (1 appel) -> traduction francaise de lecture si
// besoin (1 appel). L'avancement part en SSE a chaque etape.
// L'ecran envoie la CONVERSATION etiquetee (MOI / interlocuteur, cf
// formatThread) et le mode : "reply" (l'autre a ecrit en dernier : on repond a
// son dernier message) ou "followup" (c'est MOI qui ai ecrit en dernier : on
// redige une relance). L'IA ecrit TOUJOURS au nom de l'utilisateur.
// Lectures PocketBase avec le JETON de l'utilisateur ; IA avec la cle serveur,
// sur le modele choisi dans le menu (resolveModel : catalogue ferme).

export const maxDuration = 240;
const WRITE_TIMEOUT_MS = 90_000;

const PB_URL = process.env.POCKETBASE_INTERNAL_URL || "http://127.0.0.1:8090";
const PB_TIMEOUT_MS = 20_000;
// Repli quand le worker ne repond pas : on prefere zero echange a 20 s d'attente.
const PB_EXCHANGES_FALLBACK_MS = 8_000;
const WORKER_URL = process.env.WORKER_INTERNAL_URL || process.env.MAIL_WORKER_URL || "http://127.0.0.1:4001";
// Premiere construction d'une fiche : un appel IA sur ~30 mails (~10 s).
const MEMORY_TIMEOUT_MS = 70_000;

interface ReplyAgentBody {
  authToken?: string;
  userId?: string;
  userName?: string;
  subject?: string;
  originalMessage?: string;
  originalDate?: string;
  sender?: { name?: string; address?: string };
  threadContext?: string;
  /** Ids des messages de la conversation (deja dans threadContext). */
  threadIds?: string[];
  /** Adresses des participants de la conversation (hors les miennes). */
  participants?: string[];
  draftContent?: string;
  mode?: "reply" | "followup";
  model?: string;
}

interface StyleProfile {
  language?: string;
  register?: string;
  greeting?: string;
  closing?: string;
  length?: string;
  traits?: string[];
  questions?: string[];
  situation?: string;
}

// Nom de la langue, ecrit dans la langue elle-meme : un code ISO seul ne
// suffit pas, le modele retombe sur le francais de l'utilisateur (essai reel :
// mail anglais detecte "en", reponse redigee en francais).
const LANGUAGE_NAMES: Record<string, string> = {
  fr: "francais",
  en: "English",
  de: "Deutsch",
  it: "italiano",
  es: "espanol",
  pt: "portugues",
  nl: "Nederlands",
  ca: "catala",
};

// Le JSON du modele n'est pas garanti : une liste peut arriver en texte, un
// texte en liste. On ramene chaque champ a sa forme attendue.
function asText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join(" ; ").trim();
  return "";
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asText).filter(Boolean);
  const t = asText(v);
  return t ? [t] : [];
}

function normalizeProfile(raw: unknown): StyleProfile {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    language: asText(r.language),
    register: asText(r.register),
    greeting: asText(r.greeting),
    closing: asText(r.closing),
    length: asText(r.length),
    traits: asList(r.traits),
    questions: asList(r.questions),
    situation: asText(r.situation),
  };
}

function sse(ev: ReplyAgentEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(ev)}\n\n`);
}

function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function pbList<T>(
  collection: string,
  token: string,
  params: Record<string, string>,
  timeoutMs = PB_TIMEOUT_MS
): Promise<T[]> {
  const qs = new URLSearchParams({ skipTotal: "1", ...params }).toString();
  const r = await fetch(`${PB_URL}/api/collections/${collection}/records?${qs}`, {
    headers: { Authorization: token },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${collection} HTTP ${r.status}`);
  const d = (await r.json()) as { items?: T[] };
  return d.items || [];
}

async function workerPost<T>(path: string, token: string, payload: unknown, timeoutMs: number): Promise<T> {
  const r = await fetch(`${WORKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return (await r.json()) as T;
}

interface MemoryResponse extends WhoIsWho {
  status?: string;
  newMails?: number;
  ms?: number;
}

const MSG_FIELDS =
  "id,message_id,subject,date,from_address,to_addresses,cc_addresses,is_draft,text_body,html_body:excerpt(1500)";

type RawMsg = ExchangeCandidate & { html_body?: string };

function withText(m: RawMsg): ExchangeCandidate {
  return { ...m, text_body: m.text_body?.trim() ? m.text_body : m.html_body || "" };
}

function stripHtml(html: string): string {
  return (html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatExchanges(list: Exchange[], senderLabel: string): string {
  return list
    .slice()
    .reverse()
    .map((e) => {
      const who = e.direction === "out" ? `MOI -> ${senderLabel}` : `${senderLabel} -> MOI`;
      return `[${e.date.slice(0, 10)}] ${who} | Sujet: ${e.subject || "(sans sujet)"}\n${e.text.slice(0, 1200)}`;
    })
    .join("\n\n---\n\n");
}

// La signature est ajoutee par la fenetre d'ecriture : un petit modele remet
// souvent le prenom seul en dernier paragraphe malgre la consigne. On le retire.
function dropTrailingName(html: string, userName: string): string {
  const names = new Set(
    [userName, userName.split(/\s+/)[0]].map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 2)
  );
  if (names.size === 0) return html;
  const m = html.match(/^([\s\S]*?)(\s*<p>([^<]*)<\/p>\s*)$/i);
  if (!m || !m[1].trim()) return html;
  const last = m[3].replace(/&nbsp;/g, " ").replace(/[\s,.!-]+$/g, "").trim().toLowerCase();
  return names.has(last) ? m[1].trimEnd() : html;
}

export async function POST(request: NextRequest) {
  let body: ReplyAgentBody;
  try {
    body = (await request.json()) as ReplyAgentBody;
  } catch {
    return new Response(JSON.stringify({ error: "invalid body" }), { status: 400 });
  }
  const token = typeof body.authToken === "string" ? body.authToken : "";
  const original = (body.originalMessage || "").trim();
  const sender = body.sender || {};
  if (!token || !original || !sender.address) {
    return new Response(JSON.stringify({ error: "authToken, originalMessage and sender are required" }), {
      status: 400,
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (ev: ReplyAgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(sse(ev));
        } catch {
          closed = true;
        }
      };
      const step = (s: ReplyAgentStep, pct: number) => send({ type: "step", step: s, pct });
      const t0 = Date.now();

      try {
        // --- 1. Collecte des echanges -------------------------------------
        step("collect", 5);
        const followup = body.mode === "followup";
        const model = resolveModel(body.model);
        const userLabel = body.userName || "l'utilisateur";
        const threadContext = (body.threadContext || "").trim().slice(0, 14_000);
        const threadIds = new Set(Array.isArray(body.threadIds) ? body.threadIds : []);
        const originalDay = (body.originalDate || "").slice(0, 10);
        const senderAddr = normAddr(sender.address);
        const senderName = (sender.name || "").trim();
        const senderLabel = senderName || senderAddr;

        const accounts = await pbList<{ email?: string }>("accounts", token, {
          fields: "email",
          perPage: "50",
        }).catch(() => []);
        const myAddrs = accounts.map((a) => normAddr(a.email)).filter(Boolean);

        const contactFilter = [`email = "${esc(senderAddr)}"`];
        if (senderName.length >= 3) contactFilter.push(`name = "${esc(senderName)}"`);
        const contacts = await pbList<{ name?: string; email?: string }>("contacts", token, {
          filter: contactFilter.join(" || "),
          fields: "name,email",
          perPage: "20",
        }).catch(() => []);
        const author = authorAddresses({ name: senderName, address: senderAddr }, contacts, myAddrs);
        step("collect", 12);

        // Mails de/vers chacune des adresses de l'auteur, puis selection pure
        // (deux sens, doublons, brouillons, tri, limite 20).
        const addrClauses = author
          .slice(0, 5)
          .map((a) => {
            const e = esc(a);
            return `from_address.address = "${e}" || to_addresses ~ "${e}" || cc_addresses ~ "${e}"`;
          })
          .join(" || ");
        const ragQuery = (() => {
          const refs = `${body.subject || ""} ${original}`.match(/\b[A-Z]{0,4}\d{6,}[A-Z0-9]*\b/gi);
          const r = refs ? Array.from(new Set(refs.map((x) => x.toUpperCase()))).slice(0, 6).join(" ") : "";
          return r || [senderLabel, body.subject].filter(Boolean).join(" ");
        })();
        // Echanges : lecture directe par le worker (< 1 s) ; repli PocketBase
        // borne si le worker ne repond pas.
        const exchangesPromise = workerPost<{ items?: RawMsg[]; source?: string; ms?: number }>(
          "/contact-memory/exchanges",
          token,
          { addresses: author.slice(0, 5), limit: 60 },
          10_000
        )
          .then((r) => {
            console.log(`[reply-agent] exchanges via worker source=${r.source || "?"} n=${r.items?.length ?? 0} in ${r.ms ?? "?"}ms`);
            return r.items || [];
          })
          .catch((err) => {
            console.warn("[reply-agent] exchanges worker:", (err as Error).message);
            return pbList<RawMsg>(
              "messages",
              token,
              { filter: `is_draft = false && (${addrClauses})`, sort: "-date", perPage: "60", fields: MSG_FIELDS },
              PB_EXCHANGES_FALLBACK_MS
            ).catch((e) => {
              console.warn("[reply-agent] exchanges:", (e as Error).message);
              return [] as RawMsg[];
            });
          });
        // Memoire "qui est qui" : construite a la premiere reponse, puis mise a
        // jour avec les seuls nouveaux mails (aucun appel IA sans nouveau mail).
        const memoryPromise = workerPost<MemoryResponse>(
          "/contact-memory/ensure",
          token,
          {
            addresses: author.slice(0, 5),
            name: senderName,
            participants: Array.isArray(body.participants) ? body.participants.slice(0, 20) : [],
          },
          MEMORY_TIMEOUT_MS
        ).catch((err) => {
          console.warn("[reply-agent] memory:", (err as Error).message);
          return {} as MemoryResponse;
        });
        const [rawExchanges, related, cerveau] = await Promise.all([
          exchangesPromise,
          fetchRelatedEmails(body.userId, ragQuery, body.originalDate),
          fetchCerveauContext(body.userId, `${senderLabel} ${body.subject || ""} ${original.slice(0, 500)}`),
        ]);
        step("memory", 20);
        const memory = await memoryPromise;
        const whoIsWho = formatWhoIsWho(memory, senderLabel);
        const whoBlock = whoIsWho
          ? `\n\nQUI EST QUI (fiches etablies, corrigees par l'utilisateur quand il l'a juge utile). Elles FONT FOI sur toute deduction tiree des mails, en particulier des mails lies au dossier :\n${whoIsWho}\n- N'attribue JAMAIS a une autre personne une action, une responsabilite ou une competence que ces fiches attribuent a MOI (si MOI realise la technique, c'est MOI qui verifie et fait le travail technique, pas un tiers).\n- Si un de mes anciens mails contredit ces fiches, il est errone : ne reprends pas sa formulation.\n- N'ecris jamais que tu as verifie, consulte ou obtenu l'accord de quelqu'un si les mails ne le montrent pas : dis plutot ce que tu vas faire.`
          : "";
        const exchanges = selectExchanges(rawExchanges.map(withText), author, myAddrs, REPLY_AGENT_EXCHANGES);
        const ownToAuthor = exchanges.filter((e) => e.direction === "out");
        step("memory", 28);

        // Trop peu de mes mails a cette personne : mes derniers envois (tous
        // destinataires) servent de reference pour mon style general.
        let generalStyle: Exchange[] = [];
        if (ownToAuthor.length < REPLY_AGENT_MIN_OWN && myAddrs.length > 0) {
          const mineClause = myAddrs
            .slice(0, 5)
            .map((a) => `from_address.address = "${esc(a)}"`)
            .join(" || ");
          const sent = await pbList<RawMsg>("messages", token, {
            filter: `is_draft = false && (${mineClause})`,
            sort: "-date",
            perPage: "15",
            fields: MSG_FIELDS,
          }).catch(() => [] as RawMsg[]);
          const seen = new Set(exchanges.map((e) => e.id));
          generalStyle = sent
            .map(withText)
            .filter((m) => !seen.has(m.id))
            .map((m) => ({
              id: m.id,
              direction: "out" as const,
              subject: m.subject || "",
              date: m.date || "",
              text: stripQuoted(m.text_body || ""),
            }))
            .filter((e) => e.text.length > 20)
            .slice(0, 10);
        }
        console.log(
          `[reply-agent] user=${body.userId || "?"} mode=${followup ? "followup" : "reply"} model=${model || "default"} author=${author.length} addr exchanges=${exchanges.length} own=${ownToAuthor.length} general=${generalStyle.length} thread=${threadContext.length}c related=${related ? "yes" : "no"} memory=${memory.status || "none"}/${memory.newMails ?? 0} who=${whoIsWho.length}c`
        );

        // --- 2-3. Style + comprehension (un appel JSON) --------------------
        step("style", 32);
        const ownSamples = [...ownToAuthor, ...generalStyle];
        const draftPlain = stripHtml(body.draftContent || "");
        const styleSystem = `Tu analyses la maniere d'ecrire de l'utilisateur "${userLabel}" (etiquete MOI dans les mails) et la conversation qu'il mene avec ${senderLabel}.

Renvoie UNIQUEMENT un objet JSON valide avec ces cles :
- "language": code ISO 639-1 de la langue ${followup ? "de la conversation avec cette personne (a defaut, celle de mon dernier message)" : "du DERNIER mail recu de cette personne"} (ex: "fr", "en", "de", "it", "es"). C'est la langue dans laquelle il faudra ecrire.
- "register": "tu" ou "vous" (ou l'equivalent de la langue : first-name / formal...), tel que l'utilisateur l'emploie avec CETTE personne ; a defaut, le plus probable vu la conversation.
- "greeting": la formule d'ouverture habituelle de l'utilisateur avec cette personne (reprise telle quelle de ses mails, sinon "").
- "closing": sa formule de fin habituelle AVANT la signature (ex: "Belle journee", "Best,", "A bientot"), sinon "".
- "length": "tres court", "court", "moyen" ou "long", selon ses habitudes.
- "traits": 3 a 6 traits concrets de son style (tournures recurrentes, ponctuation, emojis ou non, phrases courtes, humour, mots qu'il emploie souvent...).
- "questions": ${followup ? `ce que J'ATTENDS encore de ${senderLabel} (reponse, action, document, delai...) d'apres mon dernier message et la conversation` : `la ou les questions / demandes precises du dernier mail recu de ${senderLabel} auxquelles il faut repondre`}.
- "situation": 1 a 3 phrases sur l'etat reel du sujet (ce qui est fait, attendu, en suspens, et qui doit agir), tire de TOUS les mails fournis.

Base le style UNIQUEMENT sur les mails ecrits par MOI, jamais sur ceux de ${senderLabel}. Ne confonds jamais les deux : "MOI -> ..." est ecrit par l'utilisateur, "${senderLabel} -> MOI" par son correspondant.${whoBlock}`;
        const styleUser = `Mails ecrits par MOI a ${senderLabel} (du plus ancien au plus recent) :
${ownToAuthor.length ? formatExchanges(ownToAuthor, senderLabel) : "(aucun)"}
${generalStyle.length ? `\nMes autres mails recents (style general, autres destinataires) :\n${generalStyle.map((e) => `[${e.date.slice(0, 10)}] Sujet: ${e.subject}\n${e.text.slice(0, 800)}`).join("\n\n---\n\n")}\n` : ""}
Echanges avec ${senderLabel} (du plus ancien au plus recent) :
${exchanges.length ? formatExchanges(exchanges, senderLabel) : "(aucun echange precedent)"}
${threadContext ? `\nConversation en cours (Sujet: ${body.subject || "(sans sujet)"}), du plus ancien au plus recent :\n${threadContext}\n` : ""}
${followup ? `MON DERNIER message a ${senderLabel}${originalDay ? ` (envoye le ${originalDay})` : ""}, toujours sans reponse :` : `DERNIER mail recu de ${senderLabel} (Sujet: ${body.subject || "(sans sujet)"}) :`}
${original.slice(0, 4000)}`;

        let profile: StyleProfile = {};
        try {
          const raw = await callOpenRouter(styleSystem, styleUser.slice(0, 60_000), {
            temperature: 0.2,
            maxTokens: 900,
            responseFormat: "json_object",
            model,
          });
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) profile = normalizeProfile(JSON.parse(m[0]));
        } catch (err) {
          console.warn("[reply-agent] style:", (err as Error).message);
        }
        const language = (profile.language || "fr").toLowerCase().slice(0, 2);
        const languageName = LANGUAGE_NAMES[language] || language;
        step("understand", 50);

        // --- 4. Redaction -------------------------------------------------
        step("write", 58);
        const styleLines = [
          profile.register ? `- Registre avec cette personne : ${profile.register}` : "",
          profile.greeting ? `- Formule d'ouverture habituelle : ${profile.greeting}` : "",
          profile.closing ? `- Formule de fin habituelle : ${profile.closing}` : "",
          profile.length ? `- Longueur habituelle : ${profile.length}` : "",
          ...(profile.traits || []).slice(0, 6).map((t) => `- ${t}`),
        ]
          .filter(Boolean)
          .join("\n");
        const modeRules = followup
          ? `- C'est une RELANCE : ton dernier message a ${senderLabel}${originalDay ? ` (${originalDay})` : ""} est reste sans reponse. Ecris un message COURT (2 a 4 phrases) qui rappelle poliment ce que tu attends${profile.questions?.length ? ` (${profile.questions.slice(0, 4).join(" ; ")})` : ""} et demande ou en est le sujet.
- Ne recopie pas et ne resume pas longuement ton message precedent ; ne remercie pas pour une reponse qui n'est pas venue.`
          : `- Tu reponds au dernier message de ${senderLabel} : reponds a TOUTES ses questions et demandes${profile.questions?.length ? ` : ${profile.questions.slice(0, 6).join(" ; ")}` : ""}.
- NE repete PAS ce que ${senderLabel} a deja dit.`;
        const writeSystem = `Tu es "${userLabel}" (etiquete MOI dans les mails) et tu ecris TOI-MEME, en ton nom, a ${senderLabel}. Tu n'es JAMAIS ${senderLabel} : tu ne parles pas en son nom, tu ne prends pas son role (support, vendeur, service client...), tu ne promets pas de "traiter la demande". Le texte doit sonner EXACTEMENT comme ce que tu ecris d'habitude : memes formules, meme registre, meme longueur, memes tournures. Personne ne doit deviner qu'une IA l'a ecrit.

Ton style (deduit de TES vrais mails, ceux etiquetes MOI) :
${styleLines || "- Naturel, direct, humain."}

Regles :
- LANGUE OBLIGATOIRE : ${languageName} (la langue de la conversation), meme si tes mails precedents et la consigne sont en francais. Transpose ton style (formules, registre, longueur) naturellement en ${languageName}.${language !== "fr" ? ` La salutation et la formule de fin AUSSI sont en ${languageName} : prends l'equivalent naturel de tes formules habituelles (ex: "Bonjour Rory," -> "Hi Rory,", "Bien cordialement," -> "Best regards,"), jamais un mot de francais.` : ""}
${modeRules}
- Tiens compte de la situation reelle${profile.situation ? ` : ${profile.situation}` : ""}. Ne confirme jamais une action qui n'a pas eu lieu.
- N'invente AUCUN fait (date, prix, disponibilite, engagement) absent des mails fournis ou de la consigne. Si une information manque, formule prudemment ou pose la question.
- NE mets PAS de signature ni ton nom a la fin (la signature est ajoutee automatiquement) ; ta formule de fin habituelle, oui.
- N'utilise JAMAIS de tirets longs (— ou –). Uniquement des tirets courts (-) si necessaire.
- Formate en HTML avec UNIQUEMENT : <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>. Pas de Markdown. Chaque paragraphe dans une balise <p>.
- Retourne UNIQUEMENT le HTML du message, sans aucun texte avant ou apres.${whoBlock}${cerveau}`;

        const otherExchanges = exchanges.filter((e) => !threadIds.has(e.id)).slice(0, 12);
        const writeUser = `${otherExchanges.length ? `Nos autres echanges (hors de cette conversation, du plus ancien au plus recent) :\n${formatExchanges(otherExchanges, senderLabel)}\n\n---\n` : ""}${related ? `\nMails de la boite possiblement lies au sujet (certains peuvent etre hors sujet ; NE PAS y repondre) :\n${related}\n\n---\n` : ""}${threadContext ? `\nConversation en cours (Sujet: ${body.subject || "(sans sujet)"}), du plus ancien au plus recent :\n${threadContext}\n\n---\n` : ""}
${followup ? `Mon dernier message a ${senderLabel}${originalDay ? ` (${originalDay})` : ""}, sans reponse depuis (a relancer, pas a recopier) :` : `Dernier mail recu de ${senderLabel} (Sujet: ${body.subject || "(sans sujet)"}) :`}
${original.slice(0, 4000)}
${draftPlain ? `\n---\nCONSIGNE de ma part (ce que je veux dire ; developpe-la ${followup ? "en une relance" : "en une reponse complete"} dans mon style, sans rien contredire ni oublier) :\n${draftPlain.slice(0, 2000)}` : ""}

---
${followup ? `Write a short follow-up FROM me TO ${senderLabel}` : `Write my reply TO ${senderLabel}`}, in ${languageName} only.`;

        const draft = await callOpenRouter(writeSystem, writeUser.slice(0, 70_000), {
          temperature: 0.6,
          maxTokens: 1500,
          model,
          timeoutMs: WRITE_TIMEOUT_MS,
        });
        const html = dropTrailingName(formatAiHtml(draft), body.userName || "");
        if (!html.replace(/<[^>]*>/g, "").trim()) throw new Error("Empty reply");
        step("write", 85);

        // --- 5. Traduction francaise de lecture ---------------------------
        let translationFr: string | undefined;
        if (language !== "fr") {
          step("translate", 88);
          translationFr = await translateHtml(html, "fr", { model }).catch((err) => {
            console.warn("[reply-agent] translate:", (err as Error).message);
            return undefined;
          });
        }
        console.log(`[reply-agent] done lang=${language} model=${model || "default"} in ${Date.now() - t0}ms`);
        send({ type: "done", html, language, translationFr, exchanges: exchanges.length });
      } catch (err) {
        console.error("[reply-agent] error:", err);
        send({ type: "error", message: (err as Error).message || "reply agent failed" });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // deja ferme (client parti)
        }
      }
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
