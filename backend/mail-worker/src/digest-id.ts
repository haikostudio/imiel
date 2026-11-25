/**
 * Message-ID du resume du lundi : reconnu a la synchronisation (imap.ts) pour
 * ne jamais l'agreger en newsletter, le categoriser ni le notifier deux fois.
 * Module sans dependance (importe par imap.ts ET newsletter-digest.ts).
 */
export const DIGEST_ID_PREFIX = "imiel-digest-";
/** Resumes envoyes avant le renommage (HaikoMail -> iMiel) : toujours reconnus. */
const LEGACY_DIGEST_ID_PREFIX = "haikomail-digest-";

export function digestMessageId(week: string, userId: string): string {
  return `<${DIGEST_ID_PREFIX}${week}-${userId}@imiel.local>`;
}

export function isDigestMessageId(messageId?: string | null): boolean {
  const id = (messageId || "").replace(/^</, "");
  return id.startsWith(DIGEST_ID_PREFIX) || id.startsWith(LEGACY_DIGEST_ID_PREFIX);
}
