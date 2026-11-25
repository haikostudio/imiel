/**
 * Comparaison des modeles d'arriere-plan sur de VRAIS mails (lecture seule).
 *
 * Meme prompt que la production (categorizer.ts : categories + niveau
 * d'importance en un appel), raisonnement coupe, temperature 0, JSON force.
 * Mesure par modele : accord avec un tri de reference, JSON valide, latence,
 * cout reel (usage.cost d'OpenRouter) et jetons de reflexion factures.
 *
 * Les mails ne sont JAMAIS versionnes : ils sont lus depuis des fichiers locaux
 * passes en arguments (extraits en lecture seule de la base du serveur).
 *
 *   OPENROUTER_API_KEY=... npx tsx scripts/compare-background-models.ts \
 *     /tmp/mails.json /tmp/trust.json /tmp/reference.json [modele1,modele2,...]
 *
 * mails.json     : [{id, subject, from:{name,address}, body, listUnsub}]
 * trust.json     : {adresse: {sentToCount, receivedInboxCount}}
 * reference.json : ["important"|"secondary"|"low", ...] (meme ordre que mails)
 */
import fs from "fs";
import { SYSTEM_PROMPT, buildUserPrompt, parseResult } from "../src/categorizer";
import { noReasoning } from "../src/ai-models";
import type { Importance } from "../src/importance";

const [mailsPath, trustPath, refPath, modelsArg] = process.argv.slice(2);
if (!mailsPath || !trustPath || !refPath) {
  console.error("usage: compare-background-models.ts mails.json trust.json reference.json [modeles]");
  process.exit(1);
}
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY manquante");
  process.exit(1);
}

interface Mail {
  id: string;
  subject: string;
  from: { name?: string; address: string };
  body: string;
  listUnsub?: boolean;
}
const mails = JSON.parse(fs.readFileSync(mailsPath, "utf8")) as Mail[];
const trust = JSON.parse(fs.readFileSync(trustPath, "utf8")) as Record<
  string,
  { sentToCount: number; receivedInboxCount: number }
>;
const reference = JSON.parse(fs.readFileSync(refPath, "utf8")) as Importance[];
const models = (modelsArg ||
  "tencent/hy4-flash,deepseek/deepseek-v4.1-flash-1017,deepseek/deepseek-chat-v3-0324")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

interface Row {
  i: number;
  ok: boolean;
  importance: Importance | null;
  categories: string[];
  ms: number;
  cost: number;
  reasoningTokens: number;
  error?: string;
}

async function one(model: string, mail: Mail, i: number): Promise<Row> {
  const t = trust[(mail.from?.address || "").toLowerCase()] || { sentToCount: 0, receivedInboxCount: 0 };
  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "iMiel" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: buildUserPrompt({
              subject: mail.subject,
              from: mail.from,
              bodyText: mail.body,
              existingLabels: ["Travail", "Finance", "Newsletter", "Notification", "Promotion", "Facture", "Securite", "Developpement", "Reservation", "Sante"],
              signals: { sentToCount: t.sentToCount, receivedInboxCount: t.receivedInboxCount, listUnsubscribe: mail.listUnsub },
            }),
          },
        ],
        temperature: 0,
        max_tokens: 120,
        response_format: { type: "json_object" },
        usage: { include: true },
        ...noReasoning(model),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const ms = Date.now() - t0;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { cost?: number; completion_tokens_details?: { reasoning_tokens?: number } };
      error?: { message?: string };
    };
    if (!res.ok) return { i, ok: false, importance: null, categories: [], ms, cost: 0, reasoningTokens: 0, error: `HTTP ${res.status} ${data?.error?.message || ""}` };
    const content = data.choices?.[0]?.message?.content || "";
    const parsed = parseResult(content);
    return {
      i,
      ok: !!parsed?.importance,
      importance: parsed?.importance ?? null,
      categories: parsed?.categories ?? [],
      ms,
      cost: Number(data.usage?.cost || 0),
      reasoningTokens: Number(data.usage?.completion_tokens_details?.reasoning_tokens || 0),
      error: parsed?.importance ? undefined : `reponse illisible: ${content.slice(0, 80)}`,
    };
  } catch (e) {
    return { i, ok: false, importance: null, categories: [], ms: Date.now() - t0, cost: 0, reasoningTokens: 0, error: String((e as Error).message || e) };
  }
}

async function runModel(model: string): Promise<Row[]> {
  const out: Row[] = [];
  const CONC = 6;
  let next = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (next < mails.length) {
        const i = next++;
        out.push(await one(model, mails[i], i));
      }
    })
  );
  return out.sort((a, b) => a.i - b.i);
}

function pct(n: number, d: number) {
  return d ? `${((100 * n) / d).toFixed(0)} %` : "-";
}

(async () => {
  const summary: Record<string, unknown>[] = [];
  const all: Record<string, Row[]> = {};
  for (const model of models) {
    const rows = await runModel(model);
    all[model] = rows;
    const valid = rows.filter((r) => r.ok);
    const agree = rows.filter((r) => r.importance === reference[r.i]);
    const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
    const cost = rows.reduce((s, r) => s + r.cost, 0);
    const lowOnImportant = rows.filter((r) => reference[r.i] === "important" && r.importance === "low").length;
    summary.push({
      model,
      accord: pct(agree.length, rows.length),
      json_valide: pct(valid.length, rows.length),
      importants_classes_peu_utiles: lowOnImportant,
      latence_mediane_ms: lat[Math.floor(lat.length / 2)],
      latence_p90_ms: lat[Math.floor(lat.length * 0.9)],
      plus_de_10s: rows.filter((r) => r.ms > 10_000).length,
      cout_100_mails_usd: Number(cost.toFixed(5)),
      jetons_reflexion: rows.reduce((s, r) => s + r.reasoningTokens, 0),
      erreurs: rows.filter((r) => r.error).length,
    });
  }
  console.table(summary);
  // Desaccords, un par un (pour relecture humaine)
  for (const model of models) {
    console.log(`\n--- Desaccords ${model} ---`);
    for (const r of all[model]) {
      if (r.importance !== reference[r.i]) {
        const m = mails[r.i];
        console.log(
          `#${r.i} ref=${reference[r.i]} got=${r.importance ?? "?"} | ${m.from?.address} | ${(m.subject || "").slice(0, 60)}${r.error ? ` [${r.error}]` : ""}`
        );
      }
    }
  }
  fs.writeFileSync("/tmp/compare-background-models.result.json", JSON.stringify({ summary, all }, null, 1));
})();
