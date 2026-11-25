export interface AuthResult {
  method: "spf" | "dkim" | "dmarc";
  result: "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";
  detail?: string;
}

export interface HeaderDetails {
  replyTo?: string;
  mailer?: string;
  messageId?: string;
  auth: AuthResult[];
}

function parseAuthResults(headerValue: string): AuthResult[] {
  const results: AuthResult[] = [];

  const spfMatch = headerValue.match(/spf\s*=\s*(\w+)/i);
  if (spfMatch) {
    const detail = headerValue.match(/spf\s*=\s*\w+\s*([^;]*)/i);
    results.push({
      method: "spf",
      result: normalizeResult(spfMatch[1]),
      detail: detail?.[1]?.trim() || undefined,
    });
  }

  const dkimMatch = headerValue.match(/dkim\s*=\s*(\w+)/i);
  if (dkimMatch) {
    const detail = headerValue.match(/dkim\s*=\s*\w+\s*([^;]*)/i);
    results.push({
      method: "dkim",
      result: normalizeResult(dkimMatch[1]),
      detail: detail?.[1]?.trim() || undefined,
    });
  }

  const dmarcMatch = headerValue.match(/dmarc\s*=\s*(\w+)/i);
  if (dmarcMatch) {
    const detail = headerValue.match(/dmarc\s*=\s*\w+\s*([^;]*)/i);
    results.push({
      method: "dmarc",
      result: normalizeResult(dmarcMatch[1]),
      detail: detail?.[1]?.trim() || undefined,
    });
  }

  return results;
}

function normalizeResult(raw: string): AuthResult["result"] {
  const lower = raw.toLowerCase();
  if (lower === "pass") return "pass";
  if (lower === "fail") return "fail";
  if (lower === "softfail") return "softfail";
  if (lower === "neutral") return "neutral";
  if (lower === "temperror") return "temperror";
  if (lower === "permerror") return "permerror";
  return "none";
}

function getHeaderValue(rawHeaders: string, name: string): string | undefined {
  const regex = new RegExp(`^${name}:\\s*(.+?)(?=\\r?\\n\\S|$)`, "ims");
  const match = rawHeaders.match(regex);
  if (!match) return undefined;
  // Unfold continuation lines (lines starting with whitespace)
  return match[1].replace(/\r?\n[ \t]+/g, " ").trim() || undefined;
}

export function parseHeaderDetails(rawHeaders: string): HeaderDetails {
  const replyTo = getHeaderValue(rawHeaders, "Reply-To");
  const mailer = getHeaderValue(rawHeaders, "X-Mailer") || getHeaderValue(rawHeaders, "User-Agent");
  const messageId = getHeaderValue(rawHeaders, "Message-ID") || getHeaderValue(rawHeaders, "Message-Id");

  const authHeader = getHeaderValue(rawHeaders, "Authentication-Results");
  const auth = authHeader ? parseAuthResults(authHeader) : [];

  return { replyTo, mailer, messageId, auth };
}
