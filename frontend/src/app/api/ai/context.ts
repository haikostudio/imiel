// Contexte partage des routes IA (suggestion, reponse redigee par l'agent) :
// rappel Cerveau et mails lies au dossier via le RAG du worker. Best-effort.

const WORKER_URL =
  process.env.WORKER_INTERNAL_URL ||
  process.env.MAIL_WORKER_URL ||
  "http://127.0.0.1:4001";

/**
 * Recall Cerveau (memoire centrale) : best-effort, non bloquant. Renvoie un
 * bloc de contexte a injecter dans le prompt, ou "" si rien / non configure.
 */
export async function fetchCerveauContext(
  userId: string | undefined,
  query: string
): Promise<string> {
  if (!userId || !query.trim()) return "";
  try {
    const res = await fetch(`${WORKER_URL}/cerveau/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, query: query.slice(0, 800), k: 5 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { resultats?: { texte?: string }[] };
    const mems = (data.resultats || [])
      .map((m) => (m?.texte || "").trim())
      .filter(Boolean);
    if (mems.length === 0) return "";
    return `\n\nContexte memorise (Cerveau) - faits utiles a propos de l'utilisateur et de ses echanges (utilise-les si pertinent, sans les citer mot a mot) :\n${mems
      .map((m) => `- ${m.slice(0, 500)}`)
      .join("\n")}`;
  } catch {
    return "";
  }
}

export interface RelatedEmailHit {
  id?: string;
  subject?: string;
  from?: string;
  date?: string;
  body?: string;
  snippet?: string;
}

/**
 * Recupere les emails de la boite lies au dossier via le RAG hybride du worker
 * (semantique + keyword), exactement comme l'assistant chat. Best-effort et non
 * bloquant : renvoie un bloc de contexte trie du plus ANCIEN au plus RECENT, ou
 * "" si rien / echec. But : permettre au modele d'ANALYSER l'etat reel du
 * dossier (commande, expedition, livraison, retour, remboursement...) au lieu de
 * repondre naivement au seul dernier mail (ex: confirmer un retour alors que
 * l'article n'est meme pas encore livre).
 */
export async function fetchRelatedEmails(
  userId: string | undefined,
  query: string,
  originalDate?: string
): Promise<string> {
  if (!userId || !query.trim()) return "";
  try {
    // mode "focused" = pertinence (PAS "wide" qui echantillonne toute la boite
    // de maniere chronologique et rate les mails specifiques du dossier). Query
    // courte et distinctive (refs / expediteur+sujet), JAMAIS le corps entier
    // qui dilue le vecteur vers des mails generiques.
    const res = await fetch(`${WORKER_URL}/embeddings/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        query: query.slice(0, 300),
        limit: 12,
        mode: "focused",
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { results?: RelatedEmailHit[] };
    let hits = (data.results || []).filter((h) => h && (h.body || h.snippet));
    // Filtre temporel : un dossier (commande, retour, rendez-vous...) se joue
    // sur une fenetre courte. On ecarte le bruit vectoriel vieux de plusieurs
    // annees en ne gardant que les mails proches de la date du message auquel on
    // repond. Fallback sur la liste brute si la fenetre vide tout.
    const anchor = originalDate ? new Date(originalDate).getTime() : NaN;
    if (!Number.isNaN(anchor)) {
      const lo = anchor - 365 * 864e5;
      const hi = anchor + 60 * 864e5;
      const within = hits.filter((h) => {
        const t = new Date(h.date || 0).getTime();
        return !Number.isNaN(t) && t >= lo && t <= hi;
      });
      if (within.length >= 1) hits = within;
    }
    if (hits.length === 0) return "";
    const top = hits
      .slice(0, 10)
      .sort(
        (a, b) =>
          new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
      );
    return top
      .map((h, i) => {
        const body = (h.body || h.snippet || "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 700);
        return `[Email ${i + 1}] De: ${h.from || "?"} | Date: ${
          h.date || "?"
        } | Sujet: ${h.subject || "(sans sujet)"}\n${body}`;
      })
      .join("\n\n");
  } catch {
    return "";
  }
}
