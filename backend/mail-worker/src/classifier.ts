import { aiFetch } from "./ai-budget";
import { backgroundModel } from "./ai-models";
const TIMEOUT_MS = 8_000;
const MAX_BODY_CHARS = 2_000;

export interface ClassifyContext {
  /** Mails envoyes par l'utilisateur a cet expediteur. */
  sentToCount?: number;
  /** Mails recus de cet expediteur deja en boite non-spam. */
  receivedInboxCount?: number;
  /** Le domaine est-il deja connu en boite normale ? */
  knownDomain?: boolean;
  /** L'expediteur figure-t-il dans contacts ? (>= seuil) */
  inContacts?: boolean;
}

export interface ClassifyInput {
  subject: string;
  from: { name?: string; address: string };
  bodyText: string;
  rspamdScore?: number;
  context?: ClassifyContext;
}

export interface ClassifyResult {
  spam: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `Tu es un filtre anti-spam permissif pour une boite mail personnelle.

Ton role : decider si un email est du SPAM evident ou doit aller en boite de reception (inbox).

Regle d'or : EN CAS DE DOUTE, ce n'est PAS du spam (biais inbox fort).

Signaux de confiance (s'ils sont fournis dans le prompt) :
- "Deja ecrit a cet expediteur" >= 1 => JAMAIS spam (l'utilisateur correspond avec lui).
- "Deja recu en boite normale" >= 5 => quasi jamais spam (relation continue).
- "Domaine deja connu en boite normale" => presomption d'inbox.

Marque spam:true UNIQUEMENT si l'email est clairement :
- du courrier non sollicite de masse / publicite agressive non desiree
- du phishing (usurpation, vol d'identifiants)
- une arnaque (faux gains, fraude, sextorsion, fausse facture)
- porteur de malware

Va TOUJOURS en inbox (spam:false) :
- emails personnels ou professionnels
- transactionnels (recus, confirmations, securite de compte, codes)
- newsletters et notifications de services auxquels l'utilisateur peut etre abonne
- tout email ambigu ou dont tu n'es pas certain

Reponds STRICTEMENT en JSON sur une seule ligne, sans texte autour, sans bloc de code :
{"spam": false, "reason": "courte raison"}`;

function buildUserPrompt(input: ClassifyInput): string {
  const fromStr = input.from.name
    ? `${input.from.name} <${input.from.address}>`
    : input.from.address;
  const body = (input.bodyText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BODY_CHARS);

  const hints: string[] = [];
  if (typeof input.rspamdScore === "number") {
    hints.push(
      `Score Rspamd (plus haut = plus suspect) : ${input.rspamdScore}`
    );
  }
  const ctx = input.context;
  if (ctx) {
    if (typeof ctx.sentToCount === "number") {
      hints.push(`Deja ecrit a cet expediteur : ${ctx.sentToCount} fois`);
    }
    if (typeof ctx.receivedInboxCount === "number") {
      hints.push(
        `Deja recu en boite normale de cet expediteur : ${ctx.receivedInboxCount} mails`
      );
    }
    if (ctx.knownDomain) {
      hints.push("Domaine deja connu en boite normale");
    }
    if (ctx.inContacts) {
      hints.push("Expediteur present dans les contacts de l'utilisateur");
    }
  }
  const hintBlock = hints.length > 0 ? "\nContexte :\n- " + hints.join("\n- ") : "";

  return `Expediteur : ${fromStr}\nSujet : ${
    input.subject || "(sans sujet)"
  }${hintBlock}\n\nCorps :\n${body}`;
}

function parseResult(raw: string): ClassifyResult | null {
  let text = raw.trim();
  // Retirer un eventuel bloc de code markdown
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    const obj = JSON.parse(text) as { spam?: unknown; reason?: unknown };
    if (typeof obj.spam === "boolean") {
      return {
        spam: obj.spam,
        reason: typeof obj.reason === "string" ? obj.reason : "",
      };
    }
  } catch {
    // fallback regex ci-dessous
  }

  const m = text.match(/"spam"\s*:\s*(true|false)/i);
  if (m) {
    const reasonMatch = text.match(/"reason"\s*:\s*"([^"]*)"/i);
    return {
      spam: m[1].toLowerCase() === "true",
      reason: reasonMatch ? reasonMatch[1] : "",
    };
  }

  return null;
}

/**
 * Classe un email via LLM (OpenRouter / DeepSeek). Permissif, biais inbox.
 * Retourne null en cas d'erreur, timeout, cle absente ou reponse invalide :
 * l'appelant doit alors retomber sur le fallback Rspamd.
 */
export async function classifyMessage(
  input: ClassifyInput
): Promise<ClassifyResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const model = backgroundModel("OPENROUTER_MODEL_CLASSIFY");

  try {
    const res = await aiFetch("classify", {
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
        max_tokens: 150,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`Classifier HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      console.warn("Classifier: empty LLM response");
      return null;
    }

    return parseResult(content);
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      console.warn("Classifier timed out");
    } else {
      console.warn("Classifier error:", err);
    }
    return null;
  }
}
