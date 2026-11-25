import { callOpenRouter } from "./openrouter";

// Traduction d'un fragment HTML de mail en conservant sa structure. Partagee
// par le bouton "Traduire" de l'editeur (/api/ai/translate) et par la version
// francaise de lecture de la reponse redigee par l'agent (/api/ai/reply-agent).
// Meme modele que la correction : celui choisi dans le menu IA de la fenetre
// d'ecriture (option model, validee par resolveModel cote route).
export const TRANSLATE_TARGETS: Record<string, string> = {
  en: "English",
  de: "German (Deutsch)",
  es: "Spanish (espanol)",
  fr: "French (francais)",
};

export async function translateHtml(
  html: string,
  target: string,
  opts: { apiKey?: string; model?: string } = {}
): Promise<string> {
  const lang = TRANSLATE_TARGETS[target];
  if (!lang) throw new Error("unsupported target");

  const systemPrompt = `You are a professional translator. You receive a JSON object {"html"} containing an HTML fragment taken from an email being written. Translate its text into ${lang}.

Rules:
- Translate faithfully: same meaning, same tone and register (keep informal as informal, formal as formal). Add nothing, remove nothing, never comment or explain.
- Keep EXACTLY the HTML structure: same tags, same attributes (href, src, class, data-*), same <p>, <br>, lists, <strong>/<em>, links. Only the human-readable text changes.
- Do not translate URLs, email addresses, code, reference numbers or proper names.
- If the fragment is already in ${lang}, return it unchanged.
- The fragment may start or end in the middle of a sentence: translate it as is, without completing it.

Return ONLY a valid JSON object {"html": "..."} with the translated HTML, without markdown backticks.`;

  const result = await callOpenRouter(systemPrompt, `{"html": ${JSON.stringify(html)}}`, {
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: 0.1,
    maxTokens: 4000,
    responseFormat: "json_object",
  });
  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Invalid AI response format");
  const parsed = JSON.parse(jsonMatch[0]);
  if (typeof parsed.html !== "string" || !parsed.html.trim()) {
    throw new Error("Empty translation");
  }
  return parsed.html;
}
