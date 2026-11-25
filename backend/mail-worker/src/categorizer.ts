import { aiFetch } from "./ai-budget";
import { backgroundModel, FALLBACK_BACKGROUND_MODEL } from "./ai-models";
import {
  type Importance,
  type ImportanceExample,
  IMPORTANCE_PROMPT_RULES,
  parseImportance,
} from "./importance";
const TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 1_800;
const MAX_CATEGORIES = 4;
const MAX_NAME_LEN = 30;

export interface CategorizeInput {
  subject: string;
  from: { name?: string; address: string };
  bodyText: string;
  existingLabels: string[];
  /** Signaux de confiance deja calcules a la sync (sender-trust.ts). */
  signals?: { sentToCount: number; receivedInboxCount: number; listUnsubscribe?: boolean };
  /** Dernieres corrections de niveau faites par l'utilisateur (exemples). */
  examples?: ImportanceExample[];
}

export interface CategorizeResult {
  categories: string[];
  importance: Importance | null;
  model: string;
}

export const SYSTEM_PROMPT = `Tu es un classifieur de mails. Pour chaque email tu rends DEUX choses :
1) 1 a ${MAX_CATEGORIES} categories courtes (1 a 2 mots, en francais) decrivant son sujet ;
2) son niveau d'importance pour l'utilisateur.

Categories - regles strictes :
- Reutilise EN PRIORITE une categorie existante si elle correspond (meme avec sens proche). Ne cree une nouvelle categorie que si AUCUNE existante ne convient.
- Categories pertinentes et orthogonales : "Travail", "Finance", "Voyage", "Newsletter", "Notification", "Personnel", "Promotion", "Facture", "Securite", "Reseaux sociaux", "Recrutement", "Sante", "Famille", "Education", "Livraison", "Reservation", "Support", "Developpement", etc.
- Pas de doublons ni de synonymes ("Travail" ET "Boulot" => juste "Travail").
- Format des noms : Title Case, sans accents necessaires mais lisibles, pas de ponctuation, pas d'emoji.
- Si tu hesites, choisis MOINS de categories plutot que plus (mieux vaut 1 categorie correcte que 4 vagues).

${IMPORTANCE_PROMPT_RULES}

Reponds STRICTEMENT en JSON sur une seule ligne, sans texte autour, sans bloc de code :
{"categories": ["Cat1", "Cat2"], "importance": "important|secondary|low"}`;

export function buildUserPrompt(input: CategorizeInput): string {
  const fromStr = input.from.name
    ? `${input.from.name} <${input.from.address}>`
    : input.from.address;
  const body = (input.bodyText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BODY_CHARS);

  const existing =
    input.existingLabels.length > 0
      ? `Categories deja utilisees par cet utilisateur (REUTILISE si une correspond) :\n${input.existingLabels.join(", ")}\n\n`
      : "Aucune categorie deja utilisee.\n\n";

  const sig = input.signals;
  const signals = sig
    ? `Signaux : l'utilisateur a deja ecrit ${sig.sentToCount} fois a cet expediteur ; ${sig.receivedInboxCount} mails deja recus de lui${
        sig.listUnsubscribe ? " ; en-tete de desabonnement present (envoi de masse)" : ""
      }.\n`
    : "";
  const examples =
    input.examples && input.examples.length > 0
      ? `Corrections de niveau faites par l'utilisateur (a respecter pour des mails semblables) :\n${input.examples
          .map((e) => `- ${e.from} | ${e.subject.slice(0, 80)} => ${e.importance}`)
          .join("\n")}\n\n`
      : "";

  return `${existing}${examples}${signals}Expediteur : ${fromStr}\nSujet : ${
    input.subject || "(sans sujet)"
  }\n\nCorps :\n${body}`;
}

function normalizeName(raw: string): string | null {
  let s = String(raw || "").trim();
  if (!s) return null;
  s = s.replace(/[—–]/g, "-");
  s = s.replace(/[^\p{L}\p{N}\s\-&/+]/gu, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.length > MAX_NAME_LEN) s = s.slice(0, MAX_NAME_LEN).trim();
  // Title case (mots de plus d'un caractere)
  s = s
    .split(" ")
    .map((w) => (w.length > 1 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
  return s;
}

export function parseResult(raw: string): { categories: string[]; importance: Importance | null } | null {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const importance = parseImportance(text);
  try {
    const obj = JSON.parse(text) as { categories?: unknown };
    if (Array.isArray(obj.categories)) {
      const names = obj.categories
        .map((c) => (typeof c === "string" ? normalizeName(c) : null))
        .filter((c): c is string => !!c);
      const dedup = Array.from(new Set(names.map((n) => n.toLowerCase()))).map(
        (lower) => names.find((n) => n.toLowerCase() === lower)!
      );
      return { categories: dedup.slice(0, MAX_CATEGORIES), importance };
    }
  } catch {
    // fallback regex below
  }
  const m = text.match(/"categories"\s*:\s*\[([^\]]*)\]/i);
  if (m) {
    const names = (m[1].match(/"([^"]+)"/g) || [])
      .map((q) => q.slice(1, -1))
      .map(normalizeName)
      .filter((c): c is string => !!c);
    return { categories: names.slice(0, MAX_CATEGORIES), importance };
  }
  if (importance) return { categories: [], importance };
  return null;
}

/** Un appel au modele donne. null = echec (HTTP, timeout, JSON invalide). */
async function callModel(
  model: string,
  input: CategorizeInput,
  apiKey: string,
  source: string
): Promise<{ categories: string[]; importance: Importance | null } | null> {
  try {
    const res = await aiFetch(source, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
        "X-Title": "iMiel",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) },
        ],
        temperature: 0,
        max_tokens: 120,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`Categorizer HTTP ${res.status} (${model}): ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      console.warn(`Categorizer: empty LLM response (${model})`);
      return null;
    }
    return parseResult(content);
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      console.warn(`Categorizer timed out (${model})`);
    } else {
      console.warn(`Categorizer error (${model}):`, err);
    }
    return null;
  }
}

/**
 * Categorise un email via LLM ET donne son niveau d'importance, dans le MEME
 * appel (aucun appel en plus pour le tri en trois niveaux). Repli une fois sur
 * l'ancien modele si le modele d'arriere-plan echoue.
 * Retourne null en cas d'erreur, timeout, cle absente ou reponse invalide.
 */
export async function categorizeMessageFull(
  input: CategorizeInput,
  opts: { apiKey?: string; source?: string } = {}
): Promise<CategorizeResult | null> {
  const apiKey = opts.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const source = opts.source || "categorize";
  const model = backgroundModel("OPENROUTER_MODEL_CATEGORIZE");
  const first = await callModel(model, input, apiKey, source);
  if (first) return { ...first, model };
  if (model === FALLBACK_BACKGROUND_MODEL) return null;
  const second = await callModel(FALLBACK_BACKGROUND_MODEL, input, apiKey, source);
  return second ? { ...second, model: FALLBACK_BACKGROUND_MODEL } : null;
}

/** Compatibilite : seules les categories. */
export async function categorizeMessage(
  input: CategorizeInput,
  opts: { apiKey?: string; source?: string } = {}
): Promise<string[] | null> {
  const r = await categorizeMessageFull(input, opts);
  return r ? r.categories : null;
}
