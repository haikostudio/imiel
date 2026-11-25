import { NextRequest, NextResponse } from "next/server";
import { callOpenRouter } from "@/app/api/ai/openrouter";

const TRANSLATE_MODEL =
  process.env.OPENROUTER_TRANSLATE_MODEL || "google/gemini-2.5-flash-lite";

const LANG_NAMES: Record<string, string> = {
  en: "English", fr: "French", de: "German", it: "Italian",
  es: "Spanish", pt: "Portuguese", nl: "Dutch", pl: "Polish",
  ru: "Russian", ja: "Japanese", zh: "Chinese", ko: "Korean",
  ar: "Arabic", tr: "Turkish", uk: "Ukrainian", ro: "Romanian",
  cs: "Czech", sv: "Swedish", da: "Danish", hu: "Hungarian",
};

function langLabel(code: string | undefined | null): string | null {
  if (!code || code === "auto") return null;
  return LANG_NAMES[code] || code;
}

// Estime grossierement la marge de tokens necessaire pour traduire `items`.
function estimateMaxTokens(items: string[]): number {
  const chars = items.reduce((sum, s) => sum + s.length, 0);
  // ~4 chars/token + overhead JSON, on triple pour les langues verbeuses (de, fr)
  const tokens = Math.ceil((chars / 4) * 3) + 200;
  return Math.min(Math.max(tokens, 512), 8192);
}

async function translateBatchJson(
  items: string[],
  target: string,
  source: string | null,
  apiKey: string | undefined,
): Promise<string[]> {
  const targetName = LANG_NAMES[target] || target;
  const sourceName = langLabel(source);

  const systemPrompt = [
    `You are a professional translator. You will receive a JSON object with a "texts" field containing an array of short strings.`,
    `Translate each string${sourceName ? ` from ${sourceName}` : ""} to ${targetName}.`,
    `Rules:`,
    `- Return ONLY a JSON object of shape {"translations": [...]} with the EXACT same number of elements, in the same order.`,
    `- Do NOT merge, split, reorder or omit any element.`,
    `- Keep URLs, email addresses, code identifiers and numbers unchanged.`,
    `- Preserve leading/trailing whitespace and line breaks within each string.`,
    `- If a string has no translatable content (URL only, number only, punctuation), return it unchanged.`,
  ].join("\n");

  const userPrompt = JSON.stringify({ texts: items });

  const raw = await callOpenRouter(systemPrompt, userPrompt, {
    temperature: 0.2,
    maxTokens: estimateMaxTokens(items),
    responseFormat: "json_object",
    model: TRANSLATE_MODEL,
    apiKey,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Certains modeles ajoutent du texte autour : on tente d'extraire le bloc JSON.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Translator returned non-JSON output");
    parsed = JSON.parse(match[0]);
  }

  const obj = parsed as { translations?: unknown };
  if (!obj || !Array.isArray(obj.translations)) {
    throw new Error("Translator response missing 'translations' array");
  }
  const out = obj.translations.map((v) => (typeof v === "string" ? v : ""));
  if (out.length !== items.length) {
    throw new Error(
      `Translator returned ${out.length} items, expected ${items.length}`,
    );
  }
  return out;
}

async function translatePlainText(
  q: string,
  target: string,
  source: string | null,
  format: "text" | "html" | undefined,
  apiKey: string | undefined,
): Promise<string> {
  const targetName = LANG_NAMES[target] || target;
  const sourceName = langLabel(source);
  const isHtml = format === "html";

  const systemPrompt = `You are a professional translator. Translate the following text${sourceName ? ` from ${sourceName}` : ""} to ${targetName}.${isHtml ? " Preserve ALL HTML tags, attributes, and structure exactly as they are. Only translate the visible text content between tags." : ""} Return ONLY the translated text, no explanation, no prefix.`;

  return callOpenRouter(systemPrompt, q, {
    temperature: 0.2,
    maxTokens: Math.min(Math.max(Math.ceil((q.length / 4) * 3) + 200, 512), 8192),
    model: TRANSLATE_MODEL,
    apiKey,
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { q, items, source, target, format, apiKey } = body as {
      q?: string;
      items?: unknown;
      source?: string;
      target?: string;
      format?: "text" | "html";
      apiKey?: string;
    };

    if (!target) {
      return NextResponse.json({ error: "Missing target" }, { status: 400 });
    }

    if (Array.isArray(items)) {
      const inputs = (items as unknown[]).map((s) =>
        typeof s === "string" ? s : "",
      );
      if (inputs.length === 0) {
        return NextResponse.json({ translations: [] });
      }
      const translations = await translateBatchJson(inputs, target, source ?? null, apiKey);
      return NextResponse.json({ translations });
    }

    if (!q || typeof q !== "string") {
      return NextResponse.json(
        { error: "Missing q or items" },
        { status: 400 },
      );
    }

    const translatedText = await translatePlainText(
      q,
      target,
      source ?? null,
      format,
      apiKey,
    );
    return NextResponse.json({ translatedText });
  } catch (err) {
    console.error("[translate/translate]", err);
    return NextResponse.json(
      { error: (err as Error).message || "Translation failed" },
      { status: 500 },
    );
  }
}
