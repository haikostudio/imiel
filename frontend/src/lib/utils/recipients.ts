export type RecipientAddr = { name?: string; address: string };

/** Destinataires uniques (To + Cc + Cci), ordre de premiere apparition. */
export function uniqueRecipients(
  lists: Array<RecipientAddr[] | undefined | null>
): RecipientAddr[] {
  const seen = new Set<string>();
  const out: RecipientAddr[] = [];
  for (const list of lists) {
    for (const a of list ?? []) {
      const key = (a.address || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

export function recipientLabel(addr: RecipientAddr | undefined | null): string {
  if (!addr) return "";
  return (addr.name || addr.address || "").trim();
}

/** Nom affiche pour une adresse d'ouverture, a partir des destinataires du mail. */
export function labelForRecipientEmail(
  recipients: RecipientAddr[],
  email: string | undefined | null
): string {
  const key = (email || "").trim().toLowerCase();
  if (!key) return "";
  const match = recipients.find(
    (a) => (a.address || "").trim().toLowerCase() === key
  );
  return recipientLabel(match) || email!.trim();
}
