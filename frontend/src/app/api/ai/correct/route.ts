import { NextRequest, NextResponse } from "next/server";
import { callOpenRouter, resolveModel } from "../openrouter";

const LANG_NAMES: Record<string, string> = {
  fr: "francais",
  en: "English",
  de: "Deutsch",
  it: "italiano",
};

export async function POST(request: NextRequest) {
  try {
    const { subject, body, language, apiKey, model } = await request.json();

    if (!body && !subject) {
      return NextResponse.json(
        { error: "subject or body is required" },
        { status: 400 }
      );
    }

    const lang = LANG_NAMES[language] || LANG_NAMES.fr;

    const systemPrompt = `Tu es un relecteur qui corrige un email SANS le reecrire. La langue est ${lang}. Tu recois un objet JSON {"subject","body"} ou "body" est du HTML. Tu renvoies le MEME message, corrige et tout juste poli, en gardant tout le reste identique.

Ce que tu DOIS faire :
- Corriger les fautes d'orthographe, de grammaire, d'accord, de conjugaison et de ponctuation.
- Corriger UNIQUEMENT les tournures reellement maladroites ou incorrectes, avec le changement MINIMAL (remplace quelques mots, ne recris pas la phrase).

Ce que tu NE DOIS JAMAIS faire :
- NE reformule PAS, ne change ni le style, ni le ton, ni le niveau de langue, ni le choix des mots quand ce n'est pas necessaire.
- N'ajoute AUCUNE information et n'en supprime AUCUNE. Garde la meme longueur et le meme sens.
- Ne change PAS le registre : si le message est familier (tutoiement, "Salut", "++", smileys, abreviations), garde-le familier. Ne "professionnalise" rien.
- Conserve EXACTEMENT la structure HTML : memes balises, memes paragraphes <p>, memes sauts de ligne <br>, memes listes (<ul>/<ol>/<li>) ou memes lignes commencant par un tiret, memes formules d'ouverture et de cloture (y compris "++", "A+", signatures courtes).
- Ne fusionne pas des lignes ou des puces entre elles, n'en cree pas de nouvelles.
- Pour "subject" : corrige seulement une vraie faute d'orthographe s'il y en a une. N'INVENTE JAMAIS un sujet, ne le reformule pas, ne le remplis pas s'il est vide. Si aucune faute, renvoie-le a l'identique.
- Si le texte est deja correct, renvoie-le exactement tel quel.

Renvoie UNIQUEMENT un objet JSON valide {"subject": "...", "body": "..."} avec le HTML corrige dans "body", sans explication ni backticks markdown.`;

    const userPrompt = `{"subject": ${JSON.stringify(subject || "")}, "body": ${JSON.stringify(body || "")}}`;

    const result = await callOpenRouter(systemPrompt, userPrompt, {
      apiKey,
      model: resolveModel(model),
      temperature: 0.1,
      maxTokens: 4000,
      responseFormat: "json_object",
    });

    // Extraire le JSON de la reponse (au cas ou le modele ajoute du texte autour)
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(
        { error: "Invalid AI response format" },
        { status: 500 }
      );
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return NextResponse.json({
      subject: parsed.subject || subject || "",
      body: parsed.body || body || "",
    });
  } catch (err) {
    console.error("AI correct error:", err);
    return NextResponse.json(
      { error: (err as Error).message || "AI correction failed" },
      { status: 500 }
    );
  }
}
