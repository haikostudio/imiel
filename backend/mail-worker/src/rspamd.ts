const RSPAMD_URL = process.env.RSPAMD_URL || "http://127.0.0.1:11334";
// Score Rspamd a partir duquel un mail est considere spam meme sans LLM
// (filet de securite quand le classifieur LLM est indisponible/desactive).
const RSPAMD_HARD_SPAM_SCORE = Number(
  process.env.RSPAMD_HARD_SPAM_SCORE || "15"
);
const RSPAMD_CHECK_TIMEOUT_MS = 10_000;
const RSPAMD_PING_TIMEOUT_MS = 2_000;
const HEALTH_CHECK_INTERVAL_MS = 60_000;

let cachedAvailable: boolean | null = null;
let lastHealthCheck = 0;

// --- Types ---

interface RspamdSymbol {
  name: string;
  score: number;
  metric_score?: number;
  description?: string;
  options?: string[];
}

interface RspamdCheckResponse {
  is_skipped: boolean;
  score: number;
  required_score: number;
  action: string;
  symbols: Record<string, RspamdSymbol>;
  message_id?: string;
  time_real?: number;
}

export interface SpamCheckResult {
  isSpam: boolean;
  score: number;
  action: string;
  symbols: string[];
  threshold: number;
}

// --- Public API ---

/**
 * Check if an email is spam via Rspamd /checkv2.
 * Returns null if Rspamd is unavailable (graceful degradation).
 */
export async function checkSpam(
  rawEmail: Buffer
): Promise<SpamCheckResult | null> {
  try {
    const available = await isRspamdAvailable();
    if (!available) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      RSPAMD_CHECK_TIMEOUT_MS
    );

    const response = await fetch(`${RSPAMD_URL}/checkv2`, {
      method: "POST",
      headers: { "Content-Type": "message/rfc822" },
      body: rawEmail,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`Rspamd check failed: HTTP ${response.status}`);
      return null;
    }

    const result = (await response.json()) as RspamdCheckResponse;

    // Rspamd seul ne route en spam que sur cas extreme : "reject" ou score
    // tres eleve. Le routage fin est decide par le classifieur LLM.
    const isSpam =
      result.action === "reject" ||
      result.score >= RSPAMD_HARD_SPAM_SCORE;

    return {
      isSpam,
      score: result.score,
      action: result.action,
      symbols: Object.keys(result.symbols || {}),
      threshold: result.required_score,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn("Rspamd check timed out");
    } else {
      console.warn("Rspamd check error:", err);
    }
    return null;
  }
}

/**
 * Check if Rspamd is reachable. Result is cached for 60s.
 */
export async function isRspamdAvailable(): Promise<boolean> {
  const now = Date.now();
  if (cachedAvailable !== null && now - lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) {
    return cachedAvailable;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      RSPAMD_PING_TIMEOUT_MS
    );

    const response = await fetch(`${RSPAMD_URL}/ping`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    cachedAvailable = response.ok;
  } catch {
    cachedAvailable = false;
  }

  lastHealthCheck = now;
  return cachedAvailable;
}

/**
 * Teach Rspamd that this email is spam (Bayes learning).
 */
export async function learnSpam(rawEmail: Buffer): Promise<boolean> {
  return learn(rawEmail, "learnspam");
}

/**
 * Teach Rspamd that this email is ham (Bayes learning).
 */
export async function learnHam(rawEmail: Buffer): Promise<boolean> {
  return learn(rawEmail, "learnham");
}

/**
 * Get Rspamd health info for the /health endpoint.
 */
export async function getRspamdHealth(): Promise<{
  available: boolean;
  version?: string;
}> {
  const available = await isRspamdAvailable();
  if (!available) return { available: false };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      RSPAMD_PING_TIMEOUT_MS
    );

    const response = await fetch(`${RSPAMD_URL}/stat`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as { version?: string };
      return { available: true, version: data.version };
    }
  } catch {
    // ignore
  }

  return { available: true };
}

// --- Internal ---

async function learn(
  rawEmail: Buffer,
  endpoint: "learnspam" | "learnham"
): Promise<boolean> {
  try {
    const available = await isRspamdAvailable();
    if (!available) return false;

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      RSPAMD_CHECK_TIMEOUT_MS
    );

    const response = await fetch(`${RSPAMD_URL}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "message/rfc822" },
      body: rawEmail,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`Rspamd ${endpoint} failed: HTTP ${response.status}`);
      return false;
    }

    const result = (await response.json()) as { success?: boolean };
    return result.success !== false;
  } catch (err) {
    console.warn(`Rspamd ${endpoint} error:`, err);
    return false;
  }
}
