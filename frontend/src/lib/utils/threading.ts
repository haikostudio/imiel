import type { Message } from "@/lib/pocketbase";

/**
 * Calcule un identifiant de thread à partir des en-têtes d'un message.
 *
 * Logique :
 * 1. Si thread_id est déjà défini, l'utiliser
 * 2. Si references[] est présent, utiliser le premier (message original)
 * 3. Si in_reply_to est présent, l'utiliser
 * 4. Sinon, utiliser message_id (nouveau thread)
 */
export function calculateThreadId(message: Message): string {
  if (message.thread_id) {
    return message.thread_id;
  }

  if (message.references && message.references.length > 0) {
    return message.references[0];
  }

  if (message.in_reply_to) {
    return message.in_reply_to;
  }

  return message.message_id || message.id;
}

/**
 * Regroupe les messages par thread_id, puis fusionne les groupes
 * ayant le meme sujet normalise et des participants communs.
 * Retourne un objet { [threadId]: Message[] }.
 */
export function groupMessagesByThread(
  msgs: Message[]
): Record<string, Message[]> {
  // Passe 1 : grouper par thread_id (headers References/In-Reply-To)
  const threads: Record<string, Message[]> = {};

  for (const msg of msgs) {
    const threadId = calculateThreadId(msg);

    if (!threads[threadId]) {
      threads[threadId] = [];
    }

    threads[threadId].push(msg);
  }

  // Passe 2 : fusionner les groupes par sujet normalise + participants communs
  // Cela regroupe les emails envoyes separement (sans In-Reply-To/References)
  // On indexe chaque groupe par TOUS les sujets normalises de ses messages
  const subjectMap = new Map<string, Set<string>>(); // normalizedSubject -> Set<threadId>
  for (const threadId of Object.keys(threads)) {
    const subjects = new Set<string>();
    for (const msg of threads[threadId]) {
      const ns = normalizeSubject(msg.subject || "").toLowerCase();
      if (ns) subjects.add(ns);
    }
    for (const ns of subjects) {
      if (!subjectMap.has(ns)) {
        subjectMap.set(ns, new Set());
      }
      subjectMap.get(ns)!.add(threadId);
    }
  }

  const alreadyMerged = new Set<string>();
  for (const [, threadIdSet] of subjectMap) {
    const threadIds = [...threadIdSet].filter((id) => !alreadyMerged.has(id) && threads[id]);
    if (threadIds.length <= 1) continue;

    // Pour chaque paire, verifier les participants communs puis fusionner
    const targetId = threadIds[0];

    for (let i = 1; i < threadIds.length; i++) {
      const candidateId = threadIds[i];
      if (alreadyMerged.has(candidateId) || !threads[candidateId]) continue;

      if (hasCommonParticipants(threads[targetId], threads[candidateId])) {
        threads[targetId] = [...threads[targetId], ...threads[candidateId]];
        delete threads[candidateId];
        alreadyMerged.add(candidateId);
      }
    }
  }

  // Trier chaque thread par date (ASC)
  for (const threadId of Object.keys(threads)) {
    threads[threadId].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
  }

  return threads;
}

/** Collecte toutes les adresses email d'un message (from, to, cc) */
function collectAddresses(msg: Message): string[] {
  const addrs: string[] = [];
  if (msg.from_address?.address) addrs.push(msg.from_address.address.toLowerCase());
  for (const r of msg.to_addresses ?? []) {
    if (r.address) addrs.push(r.address.toLowerCase());
  }
  for (const r of msg.cc_addresses ?? []) {
    if (r.address) addrs.push(r.address.toLowerCase());
  }
  return addrs;
}

/** Verifie si deux groupes de messages partagent au moins un participant */
function hasCommonParticipants(a: Message[], b: Message[]): boolean {
  const participantsA = new Set<string>();
  for (const msg of a) {
    for (const addr of collectAddresses(msg)) {
      participantsA.add(addr);
    }
  }
  for (const msg of b) {
    for (const addr of collectAddresses(msg)) {
      if (participantsA.has(addr)) return true;
    }
  }
  return false;
}

/**
 * Génère un sujet de thread normalisé (sans préfixes Re:/Fwd:/Tr:/Rép:).
 * Retire tous les prefixes imbriques (Re: Re: Re: Sujet → Sujet).
 */
export function normalizeSubject(subject: string): string {
  let s = subject;
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/^(Re|Fwd|Fw|Tr|Rép)\s*:\s*/i, "").trim();
  }
  return s;
}

/**
 * Détermine si deux messages appartiennent au même thread,
 * en se basant sur les headers et le sujet normalisé.
 */
export function isSameThread(a: Message, b: Message): boolean {
  const threadA = calculateThreadId(a);
  const threadB = calculateThreadId(b);

  if (threadA === threadB) return true;

  // Fallback : même sujet normalisé + participants communs
  if (normalizeSubject(a.subject) !== normalizeSubject(b.subject)) {
    return false;
  }

  const participantsA = new Set([
    a.from_address?.address,
    ...(a.to_addresses ?? []).map((t) => t.address),
    ...(a.cc_addresses ?? []).map((t) => t.address),
  ].filter(Boolean));
  const participantsB = new Set([
    b.from_address?.address,
    ...(b.to_addresses ?? []).map((t) => t.address),
    ...(b.cc_addresses ?? []).map((t) => t.address),
  ].filter(Boolean));

  for (const p of participantsA) {
    if (participantsB.has(p)) return true;
  }

  return false;
}
