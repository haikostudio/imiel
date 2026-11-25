import { NextResponse } from "next/server";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-0324";
const TIMEOUT_MS = 5_000;

export async function GET() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const keyPrefix = apiKey ? apiKey.slice(0, 8) + "..." : "NOT_SET";

  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      return NextResponse.json(
        {
          status: "error",
          message: `OpenRouter returned ${res.status}`,
          keyPrefix,
          hasServerKey: !!apiKey,
          model,
        },
        { status: 503 }
      );
    }

    return NextResponse.json({
      status: "ok",
      keyPrefix,
      hasServerKey: !!apiKey,
      model,
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        message: `Cannot reach OpenRouter: ${(err as Error).message}`,
        keyPrefix,
        hasServerKey: !!apiKey,
        model,
      },
      { status: 503 }
    );
  }
}
