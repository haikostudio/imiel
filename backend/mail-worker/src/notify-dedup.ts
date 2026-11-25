/**
 * Anti double notification d'un MEME mail recu sur plusieurs comptes d'un
 * meme utilisateur (destinataires multiples, transfert, releve POP3 d'une
 * boite par une autre : Gmail relevait contact@studio.example.com avec 10-60 min de
 * retard -> deuxieme push pour un mail deja notifie).
 *
 * Regle "la plus ancienne notifie" : une copie ne notifie pas si une copie de
 * meme Message-ID existe sur un AUTRE compte du meme utilisateur et qu'elle a
 * ete enregistree AVANT elle (created, puis id a egalite). Deux copies
 * quasi simultanees -> exactement une notifie, jamais zero.
 *
 * Module PUR (sans base) : la lecture des copies vit dans pocketbase.ts.
 */

export interface MessageCopy {
  id: string;
  account: string;
  created: string;
}

/**
 * Variantes exactes d'un Message-ID a chercher (le stockage garde l'en-tete
 * brut, chevrons compris) : avec / sans chevrons, casse d'origine et
 * minuscules. Comparaison par egalite -> l'index idx_msg_mid reste utilise.
 * Vide -> [] (un mail sans Message-ID n'est jamais considere comme copie).
 */
export function messageIdVariants(messageId: string | undefined | null): string[] {
  const core = (messageId || "").trim().replace(/^<|>$/g, "").trim();
  if (!core) return [];
  const out = new Set<string>();
  for (const c of [core, core.toLowerCase()]) {
    out.add(`<${c}>`);
    out.add(c);
  }
  return [...out];
}

function before(a: MessageCopy, b: MessageCopy): boolean {
  if (a.created !== b.created) return a.created < b.created;
  return a.id < b.id;
}

/**
 * Vrai si `selfId` est une copie TARDIVE : une copie anterieure existe sur un
 * autre compte. `copies` = toutes les copies du Message-ID chez l'utilisateur
 * (self compris). Self introuvable -> false (dans le doute on notifie).
 */
export function isLaterCopyOnOtherAccount(
  selfId: string,
  copies: MessageCopy[]
): boolean {
  const self = copies.find((c) => c.id === selfId);
  if (!self) return false;
  return copies.some(
    (c) => c.id !== self.id && c.account !== self.account && before(c, self)
  );
}
