import { DEFAULT_AI_COMPOSE_MODEL, isAiComposeModel } from "@/lib/ai-models";
import { isWithdrawn } from "./models-catalog";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-0324";
const TIMEOUT_MS = 60_000;

interface CallOptions {
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json_object";
  model?: string;
  timeoutMs?: number;
}

/**
 * Modele demande par le menu IA de la fenetre d'ecriture : seul un id du
 * catalogue (ai-models.ts) encore present chez le fournisseur passe. Un id
 * inconnu ou retire retombe sur Claude Haiku 5.5 ; rien de demande = modele
 * habituel de la route (undefined).
 */
export function resolveModel(requested: unknown): string | undefined {
  if (requested === undefined || requested === null || requested === "") return undefined;
  if (isAiComposeModel(requested) && !isWithdrawn(requested)) return requested;
  if (requested !== DEFAULT_AI_COMPOSE_MODEL) {
    console.warn(`[ai] modele refuse: ${String(requested).slice(0, 80)} -> ${DEFAULT_AI_COMPOSE_MODEL}`);
  }
  return isWithdrawn(DEFAULT_AI_COMPOSE_MODEL) ? undefined : DEFAULT_AI_COMPOSE_MODEL;
}

export async function callOpenRouter(
  systemPrompt: string,
  userPrompt: string,
  opts: CallOptions = {}
): Promise<string> {
  const apiKey =
    (typeof opts.apiKey === "string" && opts.apiKey.trim()) ||
    process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const model =
    (typeof opts.model === "string" && opts.model.trim()) ||
    process.env.OPENROUTER_MODEL ||
    DEFAULT_MODEL;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 1024,
  };
  if (opts.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer":
        process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
      "X-Title": "iMiel",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty LLM response");
  return content.trim();
}

export function cleanAiText(text: string): string {
  return text.replace(/[—–]/g, "-");
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>");
}

function markdownToHtml(text: string): string {
  const lines = text.split("\n");
  const parts: string[] = [];
  let inList: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      parts.push(`<p>${para.join("<br/>")}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (inList) {
      parts.push(`</${inList}>`);
      inList = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushPara();
      closeList();
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)/);
    if (bullet) {
      flushPara();
      if (inList !== "ul") { closeList(); parts.push("<ul>"); inList = "ul"; }
      parts.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }

    const numbered = trimmed.match(/^\d+[.)]\s+(.+)/);
    if (numbered) {
      flushPara();
      if (inList !== "ol") { closeList(); parts.push("<ol>"); inList = "ol"; }
      parts.push(`<li>${inlineMarkdown(numbered[1])}</li>`);
      continue;
    }

    closeList();
    para.push(inlineMarkdown(trimmed));
  }

  flushPara();
  closeList();
  return parts.join("");
}

const ALLOWED_TAG_RE = /^(p|br|strong|em|b|i|ul|ol|li)$/i;

export function formatAiHtml(text: string): string {
  let cleaned = cleanAiText(text).trim();

  // Strip markdown code fences
  cleaned = cleaned.replace(/^```html?\n?/i, "").replace(/\n?```$/, "");

  // Detect if LLM returned HTML
  const hasHtml = /<(p|br|strong|em|b|i|ul|ol|li)[\s>/]/i.test(cleaned);

  if (!hasHtml) {
    return markdownToHtml(cleaned);
  }

  // Sanitize: keep only allowed tags
  return cleaned.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g,
    (match, tag) => (ALLOWED_TAG_RE.test(tag) ? match : "")
  );
}
