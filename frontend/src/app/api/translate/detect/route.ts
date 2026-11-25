import { NextRequest, NextResponse } from "next/server";
import { callOpenRouter } from "@/app/api/ai/openrouter";

const DETECT_MODEL =
  process.env.OPENROUTER_TRANSLATE_MODEL || "google/gemini-2.5-flash-lite";

export async function POST(request: NextRequest) {
  try {
    const { q, apiKey } = await request.json();
    if (!q) return NextResponse.json([{ confidence: 1, language: "en" }]);

    const result = await callOpenRouter(
      "Detect the language of the following text. Return ONLY the ISO 639-1 two-letter language code (e.g. en, fr, de, it, es). Nothing else, no quotes, no explanation.",
      q.substring(0, 500),
      { model: DETECT_MODEL, maxTokens: 8, temperature: 0, apiKey },
    );

    const langCode = result.toLowerCase().replace(/[^a-z]/g, "").substring(0, 2);
    return NextResponse.json([
      { confidence: 0.95, language: langCode || "en" },
    ]);
  } catch (err) {
    console.error("[translate/detect]", err);
    return NextResponse.json([{ confidence: 0, language: "auto" }]);
  }
}
