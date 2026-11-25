// Flux Newsletters : detection, synthese IA traduite, stockage + backfill.
//
// Reutilise la matiere deja presente dans le frontend (api/ai/brief/route.ts) :
// heuristiques de detection, nettoyage HTML->texte et prompt de synthese
// "newsletter". Cote worker on appelle OpenRouter directement (comme
// categorizer.ts) avec le modele dedie OPENROUTER_MODEL_NEWSLETTER.

import { backgroundModel } from "./ai-models";
import {
  PBNewsletterPost,
  findNewsletterPostByMessage,
  createNewsletterPost,
  updateNewsletterPost,
  getUserOpenRouterKey,
  getUserLanguage,
  getUserNotificationsEnabled,
  updateMessage,
  listAccountsForUser,
  listInboxFolderIds,
  listInboxMessagesFromSender,
  listNewsletterSources,
  purgeNewsletterPosts,
  listAlertTopics,
  getMessage,
  listNewsletterPostsWithOriginalTitle,
} from "./pocketbase";
import { sendNewsletterAlertNotification, sendNewsletterNotification } from "./push";
import { logNewsletterActivity } from "./activity";

import { aiFetch } from "./ai-budget";
import {
  canonicalTags,
  invalidateKnownTags,
  listKnownTags,
  parseTagsLine,
  tagsInstruction,
} from "./newsletter-tags";
const TIMEOUT_MS = 30_000;
const BODY_CAP = 18_000;

function newsletterModel(): string {
  return backgroundModel("OPENROUTER_MODEL_NEWSLETTER");
}

// ---------------------------------------------------------------------------
// Detection par SOURCE designee (l'utilisateur choisit explicitement les
// expediteurs a agreger ; plus de detection heuristique). Cache court pour le
// chemin live (sync), lecture fraiche pour le backfill.
// ---------------------------------------------------------------------------

const sourceCache = new Map<
  string,
  { emails: Set<string>; names: Set<string>; expires: number }
>();
const SOURCE_TTL_MS = 60_000;

export function invalidateSourceCache(userId: string): void {
  sourceCache.delete(userId);
}

/** Normalise un nom d'expediteur pour comparaison (minuscules, espaces compresses). */
function normSourceName(name?: string): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

interface SourceMatchers {
  emails: Set<string>;
  names: Set<string>;
}

async function getSourceMatchers(
  userId: string,
  fresh = false
): Promise<SourceMatchers> {
  if (!fresh) {
    const c = sourceCache.get(userId);
    if (c && Date.now() < c.expires) return { emails: c.emails, names: c.names };
  }
  const sources = await listNewsletterSources(userId);
  const emails = new Set(
    sources.map((s) => (s.email || "").trim().toLowerCase()).filter(Boolean)
  );
  // Repli par NOM d'expediteur : une newsletter qui change d'adresse d'envoi
  // (ex. MyClaw ia-newsletter.example.com -> myclaw.ai) garde son nom affiche, donc on
  // continue de l'agreger sans re-suivre. Noms >= 4 caracteres seulement pour
  // limiter les collisions (un "News"/"Info" generique).
  const names = new Set(
    sources.map((s) => normSourceName(s.name)).filter((n) => n.length >= 4)
  );
  sourceCache.set(userId, { emails, names, expires: Date.now() + SOURCE_TTL_MS });
  return { emails, names };
}

/** Retro-compat : ensemble des adresses designees (consomme par le backfill). */
async function getSourceEmails(userId: string, fresh = false): Promise<Set<string>> {
  return (await getSourceMatchers(userId, fresh)).emails;
}

/**
 * Vrai si l'expediteur est une source newsletter designee par l'utilisateur.
 * Match par ADRESSE exacte, ou a defaut par NOM d'expediteur (robuste au
 * changement d'adresse d'envoi d'une meme newsletter).
 */
export async function isDesignatedSource(
  userId: string,
  fromAddress?: string,
  fromName?: string
): Promise<boolean> {
  const { emails, names } = await getSourceMatchers(userId);
  const addr = (fromAddress || "").trim().toLowerCase();
  if (addr && emails.has(addr)) return true;
  const name = normSourceName(fromName);
  if (name.length >= 4 && names.has(name)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// HTML -> texte propre (port de api/ai/brief/route.ts)
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  hellip: "...", mdash: "-", ndash: "-", laquo: "<<", raquo: ">>",
  copy: "(c)", reg: "(R)", trade: "(TM)", euro: "EUR", pound: "GBP",
  middot: "*", bull: "*", deg: "deg", zwnj: "", zwj: "", shy: "",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-z]+);/gi, (m, name) => HTML_ENTITIES[name.toLowerCase()] ?? m);
}

export function htmlToPlain(raw: string): string {
  if (!raw) return "";
  if (!/<[a-z!/]/i.test(raw)) return raw.replace(/\s+/g, " ").trim();
  let t = raw;
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<\s*br\s*\/?>/gi, "\n");
  t = t.replace(/<\/\s*(p|div|li|tr|h[1-6]|blockquote|pre|table|article|section|header|footer)\s*>/gi, "\n");
  t = t.replace(/<[^>]+>/g, " ");
  t = decodeEntities(t);
  t = t.replace(/https?:\/\/\S{120,}/gi, "[lien]");
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n[ \t]+/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

// ---------------------------------------------------------------------------
// Synthese IA (prompt newsletter porte de api/ai/brief/route.ts)
// ---------------------------------------------------------------------------

const LANG_NAMES: Record<string, string> = {
  fr: "francais",
  en: "English",
  de: "Deutsch",
  it: "italiano",
};

function systemPrompt(lang: string): string {
  return `Tu es l'assistant IA d'iMiel. Tu rediges un RESUME DETAILLE en ${lang} d'une newsletter ou email automatise, de maniere a ce que l'utilisateur n'ait PAS BESOIN d'ouvrir l'email pour capter l'essentiel.

- PREMIERE LIGNE, avant le HTML, exactement au format "TITRE: ..." : le sujet de la newsletter traduit en ${lang}, court (12 mots au plus), fidele au sujet d'origine. Si le sujet d'origine commence par un emoji, garde-le en tete. Si le sujet est deja en ${lang}, reprends-le tel quel. Pas de guillemets.
- Ecris en ${lang}.
- N'invente rien. N'ajoute aucune information absente du contenu.
- N'utilise JAMAIS de tirets longs (— ou –). Tirets courts (-) uniquement.
- Formate en HTML avec UNIQUEMENT ces balises : <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>. Pas de Markdown.
- Apres la ligne TITRE (et la ligne TAGS si elle est demandee plus bas), retourne UNIQUEMENT le HTML, sans aucun autre texte avant ou apres (le titre n'est PAS repete dans le HTML).
- Sois exhaustif sur le CONTENU EDITORIAL (articles, sujets, produits, annonces). Tu peux ecrire jusqu'a environ 500 mots si la newsletter est riche.
- Ignore les elements parasites : pied de page, liens de desabonnement, mentions legales, boutons sociaux.
- Structure obligatoire :
  1. <p><strong>Resume :</strong> environ QUATRE LIGNES (2 a 3 phrases, 45 a 70 mots) qui disent DE QUOI parle la newsletter : les sujets concrets, les faits, les chiffres. Il sert de description dans la liste. Entre DIRECTEMENT dans le sujet : INTERDIT de commencer par "Cette edition", "Cette newsletter", "Ce numero", "Dans cette edition" ou toute formule qui parle de la newsletter elle-meme ("met en lumiere", "explore", "presente", "revient sur"...).</p>
  2. <p><strong>A retenir :</strong></p> une <ul> courte de 2 a 5 puces avec les infos vraiment utiles a memoriser (chiffres, dates, decisions). Omets si rien de marquant.
  3. <p><strong>Au sommaire :</strong></p> suivi d'une <ul>. Une <li> par sujet/article/section : commence par le titre en <strong>, puis 1 a 3 phrases qui resument son contenu reel.
  4. <p><strong>Source :</strong> nom de l'emetteur et theme general en une ligne.</p>`;
}

/** Nettoie une sortie LLM : retire d'eventuels blocs de code markdown. */
function cleanHtml(text: string): string {
  return text
    .trim()
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export interface AlertTopic {
  id: string;
  name: string;
  description?: string;
}

/** Consigne additionnelle : sujets d'alerte a reperer dans le meme appel. */
function alertsInstruction(topics: AlertTopic[]): string {
  const list = topics
    .map((t, i) => `${i + 1}. ${t.name}${t.description ? ` (${t.description})` : ""}`)
    .join("\n");
  return `

SUJETS D'ALERTE de l'utilisateur :
${list}
Apres le HTML, ajoute UNE derniere ligne exactement au format "ALERTES: 1,3" avec les numeros des sujets REELLEMENT abordes par la newsletter (juge sur le sens, pas seulement le mot exact ; une simple mention au passage ne compte pas), ou "ALERTES: aucune".`;
}

/**
 * Retire une formule d'ouverture meta ("Cette edition met en lumiere ...")
 * du paragraphe Resume, filet de securite si le modele desobeit.
 */
export function stripMetaOpening(html: string): string {
  return html.replace(
    /(<p\b[^>]*>\s*<strong>\s*R[eé]sum[eé]\s*:?\s*<\/strong>\s*:?\s*)([^<]*)/i,
    (_m, head: string, text: string) => {
      const re =
        /^(?:dans\s+)?(?:cette|ce)\s+(?:[ée]dition|newsletter|lettre|num[ée]ro|envoi|message|infolettre)\b[^.,:;]*?\b(?:met(?:tent)?\s+en\s+(?:lumi[èe]re|avant|valeur)|explore|pr[ée]sente|revient\s+sur|se\s+penche\s+sur|aborde|propose|d[ée]taille|annonce|fait\s+le\s+point\s+sur|partage|traite(?:\s+de)?|souligne|[ée]voque|examine|d[ée]crit|met\s+l'accent\s+sur|s'int[ée]resse\s+[àa]|informe(?:\s+sur)?|rappelle)\s+(?:(?:d'abord|notamment|principalement|surtout)\s+)?/i;
      const m = re.exec(text);
      if (!m) return head + text;
      const rest = text.slice(m[0].length).replace(/^(?:que|qu')\s*/i, "");
      if (!rest.trim()) return head + text;
      return head + rest.charAt(0).toUpperCase() + rest.slice(1);
    }
  );
}

const TITLE_MAX = 160;

/** Nettoie un titre rendu par le LLM ; "" si inutilisable. */
export function cleanNewsletterTitle(raw: string): string {
  let t = (raw || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/^["'\u00ab\u201c]+\s*/, "").replace(/\s*["'\u00bb\u201d]+$/, "").trim();
  if (!t || /^\(?sans sujet\)?$/i.test(t)) return "";
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX - 1).trimEnd() + "\u2026";
  return t;
}

/**
 * Extrait et retire la ligne "TITRE: ..." placee en tete par le LLM (tolere
 * <p>, <h2>, gras markdown, "Titre :"). Sans ligne de titre : title "".
 */
export function parseTitleLine(text: string): { html: string; title: string } {
  const re =
    /^\s*(?:<(?:p|h[1-6])\b[^>]*>)?\s*(?:\*\*|<strong>)?\s*TITRE\s*:\s*(?:\*\*|<\/strong>)?\s*([^\n<]*?)\s*(?:\*\*)?\s*(?:<\/strong>)?\s*(?:<\/(?:p|h[1-6])>)?\s*(?:\n|$|(?=<))/i;
  const m = re.exec(text);
  if (!m) return { html: text, title: "" };
  return { html: text.slice(m[0].length).trim(), title: cleanNewsletterTitle(m[1]) };
}

/** Extrait et retire la ligne "ALERTES: ..." ; renvoie les sujets trouves. */
export function parseAlertsLine(
  text: string,
  topics: AlertTopic[]
): { html: string; matched: AlertTopic[] } {
  const re = /(?:^|\n)\s*(?:<p>)?\s*ALERTES?\s*:\s*([^\n<]*)(?:<\/p>)?\s*$/i;
  const m = re.exec(text);
  if (!m) return { html: text, matched: [] };
  const html = text.slice(0, m.index).trim();
  const seen = new Set<string>();
  const matched: AlertTopic[] = [];
  for (const n of m[1].match(/\d+/g) || []) {
    const t = topics[Number(n) - 1];
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      matched.push(t);
    }
  }
  return { html, matched };
}

export async function generateNewsletterSynthesis(
  input: {
    subject: string;
    fromName: string;
    body: string;
    language: string;
    topics?: AlertTopic[];
    /** Etiquettes deja employees ; absent = pas de ligne TAGS demandee. */
    knownTags?: string[];
  },
  apiKey: string
): Promise<{ summary: string; title: string; matched: AlertTopic[]; tags: string[] | null } | null> {
  const topics = input.topics || [];
  const withTags = Array.isArray(input.knownTags);
  const lang = LANG_NAMES[input.language] || LANG_NAMES.fr;
  const body = (input.body || "").slice(0, BODY_CAP);
  const userPrompt = `Source : ${input.fromName}\nSujet : ${
    input.subject || "(sans sujet)"
  }\n\nContenu de la newsletter :\n${body}`;

  try {
    const res = await aiFetch("newsletter", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
        "X-Title": "iMiel",
      },
      body: JSON.stringify({
        model: newsletterModel(),
        messages: [
          {
            role: "system",
            content:
              systemPrompt(lang) +
              (withTags ? tagsInstruction(input.knownTags || []) : "") +
              (topics.length ? alertsInstruction(topics) : ""),
          },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 2500,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`[newsletter] HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    const titled = parseTitleLine(cleanHtml(content));
    // La ligne TAGS est retiree MEME sans etiquettes demandees : elle ne doit
    // jamais fuir dans la synthese affichee.
    const tagged = parseTagsLine(titled.html);
    const { html, matched } = parseAlertsLine(tagged.html, topics);
    return {
      summary: stripMetaOpening(cleanHtml(html)),
      title: titled.title,
      matched,
      tags: withTags ? canonicalTags(tagged.tags, input.knownTags || []) : null,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      console.warn("[newsletter] synthese timeout");
    } else {
      console.warn("[newsletter] synthese error:", err);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Process d'une newsletter : cree le post (pending) puis le remplit.
// ---------------------------------------------------------------------------

export async function processNewsletter(args: {
  messageId: string;
  userId: string;
  accountId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  bodyText: string;
  htmlBody: string;
  threadId?: string;
  messageDate: string;
  /** Notifier l'utilisateur d'une nouvelle entree (live uniquement, pas backfill). */
  notify?: boolean;
}): Promise<void> {
  try {
    const existing = await findNewsletterPostByMessage(args.messageId);
    if (existing) return;

    const userKey = await getUserOpenRouterKey(args.userId);
    const apiKey = userKey || process.env.OPENROUTER_API_KEY || "";
    if (!apiKey) {
      console.warn(`[newsletter] FAIL ${args.messageId} : pas de cle OpenRouter`);
      return;
    }

    const language = await getUserLanguage(args.userId);
    const sourceName = args.fromName || args.fromAddress;

    // Cree le post en "pending" : il apparait tout de suite dans le flux.
    let post: PBNewsletterPost;
    try {
      post = await createNewsletterPost({
        user: args.userId,
        message: args.messageId,
        account: args.accountId,
        source_name: sourceName,
        source_address: args.fromAddress,
        original_subject: args.subject,
        title: args.subject || "(sans sujet)",
        summary: "",
        language,
        message_date: args.messageDate,
        thread_id: args.threadId || "",
        status: "pending",
        is_read: false,
      });
    } catch (err) {
      // Course possible sur l'index UNIQUE(message) -> deja traite ailleurs.
      console.warn(`[newsletter] create skip ${args.messageId}:`, (err as Error).message);
      return;
    }

    // Un mail agrege vit dans le flux : on le marque lu dans la boite (couvre
    // le backfill ; le chemin live l'a deja cree lu). Best effort.
    try {
      await updateMessage(args.messageId, { is_read: true });
    } catch (err) {
      console.warn(`[newsletter] mark-read failed ${args.messageId}:`, (err as Error).message);
    }

    // Sujets d'alerte : verifies uniquement pour les NOUVELLES newsletters
    // (chemin live), dans le meme appel LLM que la synthese.
    let topics: AlertTopic[] = [];
    if (args.notify) {
      try {
        topics = await listAlertTopics(args.userId);
      } catch (err) {
        console.warn(`[newsletter] alert topics KO ${args.userId}:`, (err as Error).message);
      }
    }

    // Etiquettes de sujet : meme appel que la synthese (aucun cout en plus),
    // alignees sur l'ecriture des etiquettes deja employees.
    const knownTags = await listKnownTags(args.userId).catch(() => [] as string[]);

    const body = htmlToPlain(args.htmlBody || args.bodyText || "");
    const result = await generateNewsletterSynthesis(
      { subject: args.subject, fromName: sourceName, body, language, topics, knownTags },
      apiKey
    );
    const summary = result?.summary || "";
    const matched = result?.matched || [];

    if (summary.trim()) {
      // Titre traduit (meme appel que la synthese) ; sans titre rendu, le sujet
      // d'origine reste. original_subject n'est jamais touche.
      const title = result?.title || "";
      await updateNewsletterPost(post.id, {
        ...(title ? { title } : {}),
        summary,
        status: "done",
        matched_alerts: matched.map((t) => ({ id: t.id, name: t.name })),
        tags: result?.tags || [],
        tags_done: true,
      });
      if (result?.tags?.length) invalidateKnownTags(args.userId);
      if (matched.length) {
        console.log(
          `[newsletter] ALERT ${args.messageId} -> ${matched.map((t) => t.name).join(", ")}`
        );
      }
      console.log(
        `[newsletter] OK ${args.messageId} "${(args.subject || "").slice(0, 60)}"`
      );
      // Journal d'activite : nouvelle newsletter agregee (live uniquement, comme
      // le push : le backfill 30j ne doit pas remplir le feed retroactivement).
      if (args.notify) {
        void logNewsletterActivity({
          userId: args.userId,
          accountId: args.accountId,
          sourceName,
          subject: title || args.subject,
          messageId: args.messageId,
          threadId: args.threadId,
          date: args.messageDate,
        }).catch((err) =>
          console.warn(`[activity] newsletter log failed ${args.messageId}:`, (err as Error).message)
        );
      }
      // Notification "nouvelle newsletter agregee" (live uniquement).
      if (args.notify) {
        try {
          if (await getUserNotificationsEnabled(args.userId)) {
            // Un sujet d'alerte trouve REMPLACE la notif ordinaire : un seul push.
            if (matched.length) {
              await sendNewsletterAlertNotification(
                args.userId,
                matched.map((t) => t.name),
                sourceName,
                title || args.subject,
                post.id
              );
            } else {
              await sendNewsletterNotification(args.userId, sourceName, title || args.subject);
            }
          }
        } catch (err) {
          console.warn(`[newsletter] notify failed ${args.messageId}:`, (err as Error).message);
        }
      }
    } else {
      await updateNewsletterPost(post.id, { status: "error" });
      console.warn(`[newsletter] EMPTY ${args.messageId}`);
    }
  } catch (err) {
    console.warn(`[newsletter] ERROR ${args.messageId}:`, err);
  }
}

/**
 * Recalcule la synthese d'un post existant (nouvelle consigne). L'ancienne
 * synthese reste en place si le recalcul echoue. Ne touche pas aux alertes.
 */
export async function regenerateNewsletterSummary(post: PBNewsletterPost): Promise<boolean> {
  const userKey = await getUserOpenRouterKey(post.user);
  const apiKey = userKey || process.env.OPENROUTER_API_KEY || "";
  if (!apiKey) return false;
  const msg = await getMessage(post.message).catch(() => null);
  if (!msg) return false;
  const body = htmlToPlain(msg.html_body || msg.text_body || "");
  if (!body.trim()) return false;
  const result = await generateNewsletterSynthesis(
    {
      subject: post.original_subject,
      fromName: post.source_name || post.source_address,
      body,
      language: post.language || "fr",
    },
    apiKey
  );
  if (!result?.summary.trim()) return false;
  await updateNewsletterPost(post.id, {
    ...(result.title ? { title: result.title } : {}),
    summary: result.summary,
    status: "done",
  });
  return true;
}

// ---------------------------------------------------------------------------
// Rattrapage des titres traduits (syntheses anterieures au titre traduit).
// Appel LEGER : sujet + debut de la synthese deja traduite, par lots, sans
// relire le mail. Ne touche que `title` (ni summary, ni alertes). Idempotent :
// seuls les posts dont le titre vaut encore le sujet d'origine sont repris.
// ---------------------------------------------------------------------------

const TITLE_BATCH = 15;

function plainExcerpt(html: string, max = 300): string {
  return htmlToPlain(html || "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Traduit une serie de sujets ; rend un titre par entree ("" si absent). */
export async function translateNewsletterTitles(
  items: { subject: string; summary: string }[],
  language: string,
  apiKey: string
): Promise<string[] | null> {
  if (items.length === 0) return [];
  const lang = LANG_NAMES[language] || LANG_NAMES.fr;
  const list = items
    .map((it, i) => `${i + 1}. Sujet : ${it.subject || "(sans sujet)"}\n   Contenu : ${plainExcerpt(it.summary)}`)
    .join("\n");
  try {
    const res = await aiFetch("newsletter", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
        "X-Title": "iMiel",
      },
      body: JSON.stringify({
        model: newsletterModel(),
        messages: [
          {
            role: "system",
            content: `Pour chaque newsletter numerotee, ecris son sujet traduit en ${lang} : court (12 mots au plus), fidele au sujet d'origine, aide du contenu si le sujet est vague. Garde un emoji de tete s'il y en a un. Sujet deja en ${lang} : reprends-le tel quel. Reponds UNIQUEMENT par une ligne par newsletter, au format "1: titre", sans guillemets.`,
          },
          { role: "user", content: list },
        ],
        temperature: 0.2,
        max_tokens: 60 * items.length + 100,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[newsletter-titles] HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content || "";
    const out = items.map(() => "");
    for (const line of content.split("\n")) {
      const m = /^\s*(\d+)\s*[:.)-]\s*(.+)$/.exec(line);
      if (!m) continue;
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < out.length && !out[idx]) out[idx] = cleanNewsletterTitle(m[2]);
    }
    return out;
  } catch (err) {
    console.warn("[newsletter-titles] error:", (err as Error).message);
    return null;
  }
}

/**
 * Rattrapage ponctuel : titres traduits des syntheses des `days` derniers
 * jours. `dryRun` compte sans appeler le LLM ni ecrire.
 */
export async function backfillNewsletterTitles(opts: {
  days: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}): Promise<{ candidates: number; updated: number; calls: number }> {
  const log = opts.log || (() => {});
  const posts: PBNewsletterPost[] = [];
  for (let page = 1; ; page++) {
    const res = await listNewsletterPostsWithOriginalTitle(isoSince(opts.days), page);
    posts.push(...res.items);
    if (page >= res.totalPages || res.items.length === 0) break;
  }
  const byUser = new Map<string, PBNewsletterPost[]>();
  for (const p of posts) {
    if (!(p.summary || "").trim()) continue;
    const arr = byUser.get(p.user) || [];
    arr.push(p);
    byUser.set(p.user, arr);
  }
  const candidates = Array.from(byUser.values()).reduce((n, a) => n + a.length, 0);
  let updated = 0;
  let calls = 0;
  if (opts.dryRun) {
    const batches = Array.from(byUser.values()).reduce((n, a) => n + Math.ceil(a.length / TITLE_BATCH), 0);
    log(`[dry-run] ${candidates} titres a traduire, ${batches} appel(s) LLM`);
    return { candidates, updated: 0, calls: batches };
  }
  for (const [userId, list] of byUser) {
    const apiKey = (await getUserOpenRouterKey(userId)) || process.env.OPENROUTER_API_KEY || "";
    if (!apiKey) {
      log(`SKIP user=${userId} : pas de cle OpenRouter`);
      continue;
    }
    for (let i = 0; i < list.length; i += TITLE_BATCH) {
      const batch = list.slice(i, i + TITLE_BATCH);
      const language = batch[0].language || (await getUserLanguage(userId));
      calls++;
      const titles = await translateNewsletterTitles(
        batch.map((p) => ({ subject: p.original_subject, summary: p.summary })),
        language,
        apiKey
      );
      if (!titles) {
        log(`KO  lot de ${batch.length} (user=${userId})`);
        continue;
      }
      for (let j = 0; j < batch.length; j++) {
        const title = titles[j];
        const post = batch[j];
        if (!title || title === post.title) continue;
        await updateNewsletterPost(post.id, { title });
        updated++;
        log(`OK  ${post.id} ${(post.original_subject || "").slice(0, 50)} -> ${title}`);
      }
    }
  }
  return { candidates, updated, calls };
}

// ---------------------------------------------------------------------------
// Backfill : (re)agrege les mails des SOURCES designees sur la fenetre N jours.
// ---------------------------------------------------------------------------

const BACKFILL_WINDOW_DAYS = 90;
const PER_PAGE = 30;
const DELAY_BETWEEN_ITEMS_MS = 250;

interface NLBackfillState {
  running: boolean;
  done: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const states = new Map<string, NLBackfillState>();

export function getNewsletterBackfillStatus(userId: string): NLBackfillState {
  return (
    states.get(userId) || {
      running: false,
      done: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
    }
  );
}

function isoSince(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

/**
 * (Re)agrege les mails des sources designees. Si `sourceEmail` est fourni, ne
 * traite que cette source (declenche quand l'utilisateur vient de l'ajouter),
 * sinon toutes les sources de l'utilisateur.
 */
export function startNewsletterBackfill(
  userId: string,
  sourceEmail?: string
): NLBackfillState {
  const current = states.get(userId);
  if (current && current.running) return current;

  const state: NLBackfillState = {
    running: true,
    done: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  states.set(userId, state);

  void (async () => {
    try {
      const apiKey =
        (await getUserOpenRouterKey(userId)) || process.env.OPENROUTER_API_KEY || "";
      if (!apiKey) {
        state.error = "OpenRouter API key manquante";
        return;
      }

      // Lecture fraiche des sources (reflete un ajout tout juste fait).
      invalidateSourceCache(userId);
      const allEmails = await getSourceEmails(userId, true);
      const targetEmails = sourceEmail
        ? [sourceEmail.trim().toLowerCase()].filter((e) => allEmails.has(e))
        : Array.from(allEmails);
      if (targetEmails.length === 0) return;

      const accounts = await listAccountsForUser(userId);
      const sinceIso = isoSince(BACKFILL_WINDOW_DAYS);

      for (const acc of accounts) {
        const inboxIds = await listInboxFolderIds(acc.id);
        for (const fid of inboxIds) {
          for (const email of targetEmails) {
            let page = 1;
            while (true) {
              if (!state.running) return;
              let res;
              try {
                res = await listInboxMessagesFromSender(fid, email, sinceIso, page, PER_PAGE);
              } catch (err) {
                console.error("[newsletter-backfill] page failed:", err);
                state.error = (err as Error).message || "page fetch failed";
                break;
              }
              if (res.items.length === 0) break;

              for (const item of res.items) {
                if (!state.running) return;
                const existing = await findNewsletterPostByMessage(item.id);
                if (existing) continue;

                await processNewsletter({
                  messageId: item.id,
                  userId,
                  accountId: item.account,
                  subject: item.subject || "",
                  fromName: item.from_address?.name || "",
                  fromAddress: item.from_address?.address || email,
                  bodyText: item.text_body || item.snippet || "",
                  htmlBody: item.html_body || "",
                  threadId: item.thread_id,
                  messageDate: item.date,
                });
                state.done++;
                await new Promise((r) => setTimeout(r, DELAY_BETWEEN_ITEMS_MS));
              }

              if (page >= res.totalPages) break;
              page++;
            }
          }
        }
      }
    } catch (err) {
      state.error = (err as Error).message || String(err);
      console.error("[newsletter-backfill] fatal:", err);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  return state;
}

/** Vide le flux d'un utilisateur (supprime tous ses newsletter_posts). */
export async function purgeNewsletterFeed(userId: string): Promise<number> {
  const n = await purgeNewsletterPosts(userId);
  console.log(`[newsletter] purge user=${userId} -> ${n} posts supprimes`);
  return n;
}
