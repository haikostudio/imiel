import { NextRequest, NextResponse } from "next/server";
import { callOpenRouter, formatAiHtml, resolveModel } from "../openrouter";

const LANG_NAMES: Record<string, string> = {
  fr: "francais",
  en: "English",
  de: "Deutsch",
  it: "italiano",
};

// Modeles par type de note. Defaults choisis pour optimiser cout / qualite :
// - newsletter : Gemini Flash Lite (sortie structuree longue bon marche)
// - autres : modele global par defaut (DeepSeek)
const MODEL_BY_KIND = {
  newsletter:
    process.env.OPENROUTER_MODEL_NEWSLETTER || "google/gemini-2.5-flash-lite",
  conversation: process.env.OPENROUTER_MODEL_CONVERSATION || undefined,
  single: process.env.OPENROUTER_MODEL_SINGLE || undefined,
} as const;

// ---------------------------------------------------------------------------
// HTML -> texte propre : retire style/script/head, convertit les sauts de
// ligne structurels, decode les entites courantes, vire les URLs/datauri
// excessivement longues (tracking) et collapse les blancs.
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

function htmlToPlain(raw: string): string {
  if (!raw) return "";
  // Detection HTML simple : pas de balises -> deja texte
  if (!/<[a-z!/]/i.test(raw)) return raw.replace(/\s+/g, " ").trim();

  let t = raw;
  // Blocs entiers a jeter
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Sauts de ligne structurels
  t = t.replace(/<\s*br\s*\/?>/gi, "\n");
  t = t.replace(/<\/\s*(p|div|li|tr|h[1-6]|blockquote|pre|table|article|section|header|footer)\s*>/gi, "\n");
  // Restantes
  t = t.replace(/<[^>]+>/g, " ");
  // Entites
  t = decodeEntities(t);
  // URLs tres longues (tracking) -> placeholder
  t = t.replace(/https?:\/\/\S{120,}/gi, "[lien]");
  // Whitespace
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n[ \t]+/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

interface BriefMessage {
  from: string;
  fromAddress?: string;
  date: string;
  mine: boolean;
  body: string;
}

type BriefKind = "conversation" | "single" | "newsletter";

const NEWSLETTER_ADDR_RE = /(^|[<\s])(noreply|no-reply|donotreply|do-not-reply|newsletter|newsletters|notification|notifications|marketing|mailing|news|info|hello|updates?|team|community|digest|bulletin|press)@/i;
const NEWSLETTER_BODY_RE = /unsubscribe|se desabonner|se désabonner|désinscrire|abmelden|annulla iscrizione|view in browser|view in your browser|voir dans le navigateur|view as webpage|cet ?e?-?mail vous a été envoyé|you are receiving this email|vous recevez cet email/i;

function isNewsletterLike(m: BriefMessage): boolean {
  if (m.mine) return false;
  const addr = (m.fromAddress || m.from || "").toLowerCase();
  if (NEWSLETTER_ADDR_RE.test(addr)) return true;
  if (NEWSLETTER_BODY_RE.test(m.body || "")) return true;
  return false;
}

function detectKind(msgs: BriefMessage[]): BriefKind {
  if (msgs.length === 0) return "single";
  if (msgs.length === 1) {
    return isNewsletterLike(msgs[0]) ? "newsletter" : "single";
  }
  const hasMine = msgs.some((m) => m.mine);
  const senders = new Set(
    msgs
      .filter((m) => !m.mine)
      .map((m) => (m.fromAddress || m.from || "").toLowerCase())
      .filter(Boolean)
  );
  if (hasMine || senders.size > 1) return "conversation";
  // Plusieurs messages d'un seul expediteur automatise = newsletter recurrente
  return isNewsletterLike(msgs[0]) ? "newsletter" : "conversation";
}

const COMMON_RULES = (lang: string) =>
  `- Ecris en ${lang}.
- N'invente rien. N'ajoute aucune information absente des messages.
- N'utilise JAMAIS de tirets longs (— ou –). Tirets courts (-) uniquement.
- Formate en HTML avec UNIQUEMENT ces balises : <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>. Pas de Markdown.
- Retourne UNIQUEMENT le HTML, sans aucun texte avant ou apres.`;

function systemForKind(kind: BriefKind, lang: string, hasPrev: boolean): string {
  if (kind === "conversation") {
    return `Tu es l'assistant IA d'iMiel. Tu rediges des NOTES PERSONNELLES de SUIVI pour l'utilisateur sur une DISCUSSION email (plusieurs messages echanges).

${COMMON_RULES(lang)}
- Adopte le point de vue de l'utilisateur (les messages marques "MOI" sont les siens).
- Sois factuel, concis, telegraphique. Pas de blabla.
- Structure obligatoire :
  1. <p><strong>Resume global :</strong> un paragraphe court (2-4 phrases) qui synthetise le sujet, l'etat actuel et la prochaine action attendue.</p>
  2. <p><strong>Chronologie :</strong></p> suivi d'une <ul> ordonnee du plus ancien au plus recent. Chaque <li> commence par la date au format court (JJ/MM HH:MM), puis l'expediteur (MOI ou nom), puis en 1-2 phrases la substance du message (decisions, demandes, infos).
  3. <p><strong>En attente :</strong></p> liste a puces de ce qui doit etre fait et par qui. Omets cette section si rien n'est en attente.
${hasPrev
        ? "- On te fournit des notes EXISTANTES et UNIQUEMENT les nouveaux messages. METS A JOUR : conserve le resume global (ajuste si necessaire), ajoute les nouvelles entrees a la chronologie, mets a jour la section En attente."
        : "- Analyse l'integralite de la discussion ci-dessous."}`;
  }

  if (kind === "newsletter") {
    return `Tu es l'assistant IA d'iMiel. Tu rediges un RESUME DETAILLE en ${lang} d'une newsletter ou email automatise, de maniere a ce que l'utilisateur n'ait PAS BESOIN d'ouvrir l'email pour capter l'essentiel.

${COMMON_RULES(lang)}
- Sois exhaustif sur le CONTENU EDITORIAL (articles, sujets, produits, annonces). Tu peux ecrire jusqu'a environ 500 mots si la newsletter est riche.
- Ignore les elements parasites : pied de page, liens de desabonnement, mentions legales, boutons sociaux.
- Structure obligatoire :
  1. <p><strong>Resume :</strong> un paragraphe synthetique qui presente l'angle / le message principal de cette edition.</p>
  2. <p><strong>A retenir :</strong></p> une <ul> courte de 2 a 5 puces avec les infos vraiment utiles a memoriser (chiffres, dates, decisions). Omets si rien de marquant.
  3. <p><strong>Au sommaire :</strong></p> suivi d'une <ul>. Une <li> par sujet/article/section : commence par le titre en <strong>, puis 1 a 3 phrases qui resument son contenu reel.
  4. <p><strong>Source :</strong> nom de l'emetteur et theme general en une ligne.</p>`;
  }

  // single
  return `Tu es l'assistant IA d'iMiel. Tu rediges une NOTE DE LECTURE en ${lang} pour un email unique recu par l'utilisateur.

${COMMON_RULES(lang)}
- Reste concis : un memo qui permet de comprendre l'email sans l'ouvrir.
- Structure obligatoire :
  1. <p><strong>Expediteur :</strong> nom et, en quelques mots, le sujet reel du mail.</p>
  2. <p><strong>Resume :</strong> un paragraphe (2-5 phrases) qui restitue fidelement le contenu et l'intention du message.</p>
  3. <p><strong>Action attendue :</strong> ce que l'utilisateur doit faire (repondre, decider, valider, payer, etc.), avec deadline si mentionnee. Ecris "Aucune action requise" si c'est une simple information.</p>
  4. <p><strong>Points cles :</strong></p> une <ul> courte (2-5 puces) avec les infos importantes (chiffres, dates, noms, liens vers documents). Omets si le mail est trivial.`;
}

export async function POST(request: NextRequest) {
  try {
    const { subject, messages, previousBrief, language, apiKey, model } =
      (await request.json()) as {
        subject?: string;
        messages?: BriefMessage[];
        previousBrief?: string;
        language?: string;
        apiKey?: string;
        /** Choix du menu IA de la fenetre d'ecriture : prime sur MODEL_BY_KIND. */
        model?: string;
      };

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: "messages is required" },
        { status: 400 }
      );
    }

    const lang = LANG_NAMES[language || "fr"] || LANG_NAMES.fr;
    const hasPrev = typeof previousBrief === "string" && previousBrief.trim() !== "";
    const kind = detectKind(messages);
    // L'incremental n'a de sens que pour les discussions.
    const useIncremental = hasPrev && kind === "conversation";

    const systemPrompt = systemForKind(kind, lang, useIncremental);

    // Cap par message : on peut etre plus genereux pour newsletter car le
    // body propre est bien plus court que le HTML brut.
    const bodyCap = kind === "newsletter" ? 18000 : 5000;

    const transcript = messages
      .map((m) => {
        const who = m.mine ? "MOI" : m.from || "inconnu";
        const body = htmlToPlain(m.body || "").slice(0, bodyCap);
        return `[${m.date}] ${who} :\n${body}`;
      })
      .join("\n\n---\n\n");

    const prevSection = useIncremental
      ? `Notes existantes a mettre a jour :\n${htmlToPlain(previousBrief!).slice(0, 4000)}\n\n---\n\n${
          messages.length > 1 ? "Nouveaux messages" : "Nouveau message"
        } :\n`
      : kind === "newsletter"
        ? "Contenu de la newsletter :\n"
        : kind === "single"
          ? "Email :\n"
          : "Discussion (du plus ancien au plus recent) :\n";

    const userPrompt = `Sujet : ${subject || "(sans sujet)"}\n\n${prevSection}${transcript}`;

    const text = await callOpenRouter(systemPrompt, userPrompt, {
      apiKey,
      temperature: 0.3,
      maxTokens: kind === "newsletter" ? 2500 : 1200,
      model: resolveModel(model) || MODEL_BY_KIND[kind],
    });

    return NextResponse.json({ brief: formatAiHtml(text), kind });
  } catch (err) {
    console.error("AI brief error:", err);
    return NextResponse.json(
      { error: (err as Error).message || "AI brief failed" },
      { status: 500 }
    );
  }
}
