import { buildThread, type Thread } from "@/lib/hooks/useThreads";

/**
 * Groupes d'expediteurs.
 *
 * Stockage : `users.grouped_senders` (string[]). Chaque entree est UN groupe,
 * dont les adresses sont separees par "|" (ex. "info@a.com|news@a.com"). Une
 * entree sans "|" est un groupe a une seule adresse : les reglages anterieurs
 * restent valides tels quels. L'id du thread virtuel est `sg:` + la PREMIERE
 * adresse du groupe, pour que les URL `t=sg:...` existantes restent valides.
 */
export const SENDER_GROUP_SEPARATOR = "|";

/** Decoupe les entrees stockees en groupes d'adresses (minuscules, sans doublon). */
export function parseSenderGroups(entries: string[]): string[][] {
  const groups: string[][] = [];
  for (const entry of entries) {
    const seen = new Set<string>();
    const group: string[] = [];
    for (const raw of String(entry || "").split(SENDER_GROUP_SEPARATOR)) {
      const addr = raw.trim().toLowerCase();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      group.push(addr);
    }
    if (group.length) groups.push(group);
  }
  return groups;
}

/** L'adresse fait-elle partie d'un groupe ? */
export function isSenderGrouped(entries: string[], address: string): boolean {
  const addr = (address || "").toLowerCase();
  return parseSenderGroups(entries).some((g) => g.includes(addr));
}

/**
 * Reunit des adresses en UN groupe. Tout groupe existant qui contient deja
 * l'une d'elles est absorbe (ses adresses gardent leur ordre, et la premiere
 * adresse du premier groupe touche reste en tete -> id `sg:` stable).
 */
export function mergeSendersIntoGroup(entries: string[], addresses: string[]): string[] {
  const wanted = addresses.map((a) => (a || "").trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return entries;
  const groups = parseSenderGroups(entries);
  const merged: string[] = [];
  const kept: string[][] = [];
  let insertAt = -1;
  for (const g of groups) {
    if (g.some((a) => wanted.includes(a))) {
      if (insertAt < 0) insertAt = kept.length;
      for (const a of g) if (!merged.includes(a)) merged.push(a);
    } else {
      kept.push(g);
    }
  }
  for (const a of wanted) if (!merged.includes(a)) merged.push(a);
  if (insertAt < 0) insertAt = kept.length;
  kept.splice(insertAt, 0, merged);
  return kept.map((g) => g.join(SENDER_GROUP_SEPARATOR));
}

/** Defait le groupe entier qui contient l'adresse (toutes ses adresses d'un coup). */
export function removeSenderGroup(entries: string[], address: string): string[] {
  const addr = (address || "").toLowerCase();
  return parseSenderGroups(entries)
    .filter((g) => !g.includes(addr))
    .map((g) => g.join(SENDER_GROUP_SEPARATOR));
}

/**
 * Adresse "de l'expediteur" d'une conversation, pour le bouton Regrouper : un
 * groupe virtuel donne son adresse de tete ; sinon le message le plus recent
 * qui n'est pas un envoi de l'utilisateur, a defaut le dernier message.
 */
export function threadSenderAddress(thread: Thread): string {
  if (thread.id.startsWith("sg:")) return thread.id.slice(3).toLowerCase();
  const msgs = [...thread.messages].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  const received = msgs.find((m) => !m.is_sent && m.from_address?.address);
  return (
    received?.from_address?.address ||
    thread.lastMessage.from_address?.address ||
    ""
  ).toLowerCase();
}

/**
 * Applique le groupement par expediteur sur les threads.
 * Pour chaque groupe qui a au moins un thread, fusionne tous ses threads en un
 * seul Thread virtuel avec id "sg:{premiere adresse du groupe}".
 * Les threads non concernes restent inchanges.
 * Tri : non lus d'abord (sauf opts.unreadFirst=false), puis date du lastMessage desc.
 */
export function applySenderGrouping(
  threads: Thread[],
  groupedSenders: string[],
  opts?: { unreadFirst?: boolean }
): Thread[] {
  const unreadFirst = opts?.unreadFirst ?? true;
  if (groupedSenders.length === 0) return threads;

  // adresse -> cle du groupe (sa premiere adresse)
  const groupKeyOf = new Map<string, string>();
  for (const group of parseSenderGroups(groupedSenders)) {
    for (const addr of group) {
      if (!groupKeyOf.has(addr)) groupKeyOf.set(addr, group[0]);
    }
  }
  if (groupKeyOf.size === 0) return threads;

  // Grouper les threads par groupe d'expediteurs
  const senderThreads = new Map<string, Thread[]>();
  const standalone: Thread[] = [];

  for (const thread of threads) {
    // Verifier tous les messages du thread, pas seulement le dernier.
    // Ainsi un thread ou l'expediteur groupe a envoye un message mais
    // quelqu'un d'autre a repondu (lastMessage different) sera quand meme groupe.
    const matchedKey = thread.messages
      .map((m) => groupKeyOf.get((m.from_address?.address || "").toLowerCase()))
      .find((k): k is string => !!k);

    if (matchedKey) {
      const existing = senderThreads.get(matchedKey);
      if (existing) {
        existing.push(thread);
      } else {
        senderThreads.set(matchedKey, [thread]);
      }
    } else {
      standalone.push(thread);
    }
  }

  // Fusionner chaque groupe en un Thread virtuel
  const virtualThreads: Thread[] = [];
  for (const [key, groupThreads] of senderThreads) {
    if (groupThreads.length === 0) continue;

    // Collecter tous les messages de tous les threads du groupe
    const allMessages = groupThreads.flatMap((t) => t.messages);

    // Utiliser buildThread pour construire le thread virtuel
    const virtualThread = buildThread(allMessages, `sg:${key}`);

    // buildThread recalcule fullMessageCount a partir des seuls messages
    // charges dans la fenetre. Pour le groupe, sommer les counts reels
    // (cross-folder) de chaque thread constitutif.
    virtualThread.fullMessageCount = groupThreads.reduce(
      (sum, t) => sum + t.fullMessageCount,
      0
    );

    // Dernier message REEL du groupe (reponse envoyee comprise, cf.
    // applyThreadTails) : buildThread ne voit que les messages de la vue.
    for (const t of groupThreads) {
      if (
        new Date(t.displayMessage.date).getTime() >
        new Date(virtualThread.displayMessage.date).getTime()
      ) {
        virtualThread.displayMessage = t.displayMessage;
        virtualThread.displayAnswered = t.displayAnswered;
      }
    }

    // Nom de l'expediteur du mail le plus recent comme sujet
    const senderName =
      virtualThread.lastMessage.from_address?.name ||
      virtualThread.lastMessage.from_address?.address ||
      key;
    virtualThread.subject = senderName;

    virtualThreads.push(virtualThread);
  }

  const result = [...standalone, ...virtualThreads];
  result.sort((a, b) => {
    if (unreadFirst) {
      const au = a.unreadCount > 0 ? 0 : 1;
      const bu = b.unreadCount > 0 ? 0 : 1;
      if (au !== bu) return au - bu;
    }
    return (
      new Date(b.displayMessage.date).getTime() -
      new Date(a.displayMessage.date).getTime()
    );
  });

  return result;
}

export interface GroupAvatarPerson {
  name: string;
  address: string;
}

/**
 * Les (au plus deux) interlocuteurs principaux d'un groupe, pour l'avatar de
 * la ligne regroupee. Compte les messages par auteur en EXCLUANT l'utilisateur
 * (ses adresses `myEmails` et ses envois `is_sent`) ; tri par nombre de
 * messages decroissant puis par message le plus recent. Aucun auteur hors
 * l'utilisateur -> repli sur l'adresse de tete du groupe.
 */
export function senderGroupAvatars(
  thread: Thread,
  myEmails: Set<string>,
  max = 2
): GroupAvatarPerson[] {
  const byAddr = new Map<string, { name: string; address: string; count: number; last: number }>();
  for (const m of thread.messages) {
    const address = (m.from_address?.address || "").trim().toLowerCase();
    if (!address || m.is_sent || myEmails.has(address)) continue;
    const time = new Date(m.date).getTime() || 0;
    const entry = byAddr.get(address);
    if (!entry) {
      byAddr.set(address, { name: m.from_address?.name || "", address, count: 1, last: time });
      continue;
    }
    entry.count += 1;
    if (time >= entry.last) {
      entry.last = time;
      if (m.from_address?.name) entry.name = m.from_address.name;
    } else if (!entry.name && m.from_address?.name) {
      entry.name = m.from_address.name;
    }
  }
  // Une meme personne ecrit parfois depuis deux adresses (pro / perso) : un
  // nom affiche deja retenu ne donne pas un second rond.
  const people: GroupAvatarPerson[] = [];
  const seenNames = new Set<string>();
  for (const p of [...byAddr.values()].sort((a, b) => b.count - a.count || b.last - a.last)) {
    const nameKey = (p.name || p.address).trim().toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    people.push({ name: p.name || p.address, address: p.address });
    if (people.length >= max) break;
  }
  if (people.length > 0) return people;
  const address = threadSenderAddress(thread);
  return [{ name: thread.subject || address, address }];
}
