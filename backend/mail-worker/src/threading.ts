import crypto from "crypto";

/**
 * Calculate a deterministic thread_id from email headers.
 *
 * Strategy:
 * 1. If In-Reply-To or References headers exist, use the first
 *    Message-ID from References (the root of the thread).
 * 2. If no references, use the message's own Message-ID as thread root.
 * 3. Hash the root Message-ID to produce a consistent thread_id.
 */
export function calculateThreadId(headers: {
  messageId: string;
  inReplyTo: string;
  references: string;
}): string {
  const { messageId, inReplyTo, references } = headers;

  // Extract all Message-IDs from References header
  const refIds = extractMessageIds(references);

  // The thread root is the first reference (oldest ancestor)
  let rootId: string;

  if (refIds.length > 0) {
    rootId = refIds[0];
  } else if (inReplyTo) {
    // Fall back to In-Reply-To
    const replyIds = extractMessageIds(inReplyTo);
    rootId = replyIds[0] || messageId;
  } else {
    // This is a new thread root
    rootId = messageId;
  }

  if (!rootId) {
    // No Message-ID at all, generate a random thread ID
    return crypto.randomUUID();
  }

  return hashMessageId(rootId);
}

/**
 * Extract Message-IDs from a header value.
 * Message-IDs are enclosed in angle brackets: <id@domain>
 */
function extractMessageIds(headerValue: string): string[] {
  if (!headerValue) return [];

  const matches = headerValue.match(/<[^>]+>/g);
  if (!matches) return [];

  return matches.map((m) => m.trim());
}

/**
 * Hash a Message-ID to produce a consistent, shorter thread_id.
 * Uses SHA-256 truncated to 16 hex chars for a reasonable balance
 * of uniqueness and brevity.
 */
function hashMessageId(messageId: string): string {
  const normalized = messageId.toLowerCase().trim();
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");
  return hash.substring(0, 32);
}
