import { NextRequest, NextResponse } from "next/server";
import { resolveModel } from "../openrouter";
import { TRANSLATE_TARGETS, translateHtml } from "../translate-html";

// Traduction d'un passage du compose (bouton "Traduire" de l'editeur, et
// "Actualiser" du cadre "Voir en francais" de la reponse redigee par l'agent).
export async function POST(request: NextRequest) {
  try {
    const { html, target, apiKey, model } = await request.json();

    if (typeof html !== "string" || !html.trim()) {
      return NextResponse.json({ error: "html is required" }, { status: 400 });
    }
    if (!TRANSLATE_TARGETS[target]) {
      return NextResponse.json({ error: "unsupported target" }, { status: 400 });
    }
    return NextResponse.json({ html: await translateHtml(html, target, { apiKey, model: resolveModel(model) }) });
  } catch (err) {
    console.error("AI translate error:", err);
    return NextResponse.json(
      { error: (err as Error).message || "AI translation failed" },
      { status: 500 }
    );
  }
}
