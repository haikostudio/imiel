/**
 * Niveau d'importance d'un mail (tri en trois niveaux) : important / secondary
 * / low. Stocke dans `messages.importance` (+ `importance_source`), migration 075.
 *
 * Ordre de decision (decideImportance) :
 *   1. regle expediteur de l'utilisateur (importance_rules : adresse > domaine)
 *   2. l'utilisateur a deja ecrit a l'expediteur => jamais "low"
 *   3. verdict de l'IA (rendu dans le MEME appel que la categorisation)
 *   4. repli heuristique SANS IA (skipLlmClassify, budget, erreur)
 *
 * NB : `contacts` est rempli automatiquement depuis TOUS les mails recus : la
 * presence dans le carnet n'est PAS un signal de confiance (constate sur les
 * vrais mails : 100 % des expediteurs commerciaux y figurent). Seul
 * `sentToCount` (l'utilisateur a deja ecrit) compte.
 */
export type Importance = "important" | "secondary" | "low";
export type ImportanceSource = "ai" | "rule" | "user" | "heuristic";

export const IMPORTANCE_VALUES: Importance[] = ["important", "secondary", "low"];

export interface ImportanceExample {
  from: string;
  subject: string;
  importance: Importance;
}

export interface ImportanceRule {
  match_type: "email" | "domain";
  match_value: string;
  importance: Importance;
}

export const IMPORTANCE_PROMPT_RULES = `Niveau d'importance - choisis EXACTEMENT un des trois :
- "important" : un humain qui ecrit personnellement et attend une reponse (client, prospect, partenaire, collegue, proche) ; un rendez-vous ou une reservation (confirmation, rappel, modification, annulation) ; une facture a payer ou une echeance ; le recapitulatif quotidien que l'utilisateur s'envoie a lui-meme.
- "secondary" : notification professionnelle AUTOMATIQUE utile mais sans humain qui attend : App Store Connect, TestFlight, Google Play Console, Mozilla Add-ons, GitHub, deploiements, supervision de serveurs, alertes de securite ou nouvel appareil, codes de connexion, recus de paiement, confirmations de commande, renouvellements, changements de compte ou de facturation, mentions sur une plateforme.
- "low" : commercial et bruit : promotions, soldes, Black Friday, cashback, newsletters, digests hebdomadaires, webinaires et evenements marketing, reseaux sociaux (recaps, suggestions, statistiques), offres et projets des plateformes freelance, mises a jour de CGU, annonces de produits, demandes d'avis, prospection non sollicitee.
Regles : si l'utilisateur a deja ecrit a cet expediteur, jamais "low". Un mail automatique n'est "important" que s'il s'agit d'un rendez-vous, d'une reservation ou d'une facture. Les corrections de l'utilisateur priment.`;

export function isImportance(v: unknown): v is Importance {
  return v === "important" || v === "secondary" || v === "low";
}

/** Lit "importance" dans une reponse JSON (tolerant : synonymes, casse). */
export function parseImportance(text: string): Importance | null {
  let raw: unknown = null;
  try {
    raw = (JSON.parse(text) as { importance?: unknown }).importance;
  } catch {
    const m = text.match(/"importance"\s*:\s*"([^"]+)"/i);
    raw = m ? m[1] : null;
  }
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (isImportance(v)) return v;
  if (/^(high|haute?|importante?|urgent)/.test(v)) return "important";
  if (/^(medium|moyen|secondaire|normal)/.test(v)) return "secondary";
  if (/^(faible|bas|peu|useless|inutile|noise)/.test(v)) return "low";
  return null;
}

const AUTOMATED_LOCAL_RE =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|ne[-_.]?pas[-_.]?repondre|notifications?|notify|alerts?|mailer(-daemon)?|bounce|system|automated|postmaster|wordpress|testflight[-_]no[-_]reply|developer|security|account|accounts|billing|payments?|support|service|info|team|hello|bonjour|contact)([-_.+].*)?$/i;
const PRO_AUTOMATED_DOMAIN_RE =
  /(^|\.)(apple\.com|mozilla\.org|github\.com|gitlab\.com|google\.com|microsoft\.com|infomaniak\.com|vercel\.com|netlify\.com|stripe\.com|paypal\.[a-z.]+|cloudflare\.com|hetzner\.com|sentry\.io|resend\.com)$/i;
const NEWSLETTER_HINT_RE =
  /(newsletter|digest|marketing|news@|promo|offres?|deals?|campaign|mailchimp|beehiiv|substack|sendinblue|brevo|hubspot|klaviyo)/i;
const RDV_INVOICE_SUBJECT_RE =
  /\b(rendez[- ]vous|rdv|reservation|réservation|facture|invoice|echeance|échéance|appointment)\b/i;

export interface HeuristicInput {
  fromAddress?: string;
  subject?: string;
  sentToCount: number;
  listUnsubscribe?: boolean;
  /** Mail envoye par une des adresses de l'utilisateur (recap du matin...). */
  fromSelf?: boolean;
}

/** Repli SANS IA : jamais d'appel reseau, toujours une reponse. */
export function heuristicImportance(input: HeuristicInput): Importance {
  const addr = (input.fromAddress || "").trim().toLowerCase();
  const local = addr.split("@")[0] || "";
  const domain = addr.split("@")[1] || "";
  const subject = input.subject || "";
  if (input.fromSelf) return "important";
  if (input.sentToCount >= 1) return "important";
  if (RDV_INVOICE_SUBJECT_RE.test(subject)) return "important";
  if (input.listUnsubscribe || NEWSLETTER_HINT_RE.test(addr)) return "low";
  if (PRO_AUTOMATED_DOMAIN_RE.test(domain)) return "secondary";
  if (AUTOMATED_LOCAL_RE.test(local)) return "secondary";
  // Adresse personnelle inconnue : on ne la tait pas.
  return "secondary";
}

/** Regle expediteur : adresse exacte prioritaire sur le domaine. */
export function matchImportanceRule(
  rules: ImportanceRule[],
  fromAddress?: string
): ImportanceRule | null {
  const addr = (fromAddress || "").trim().toLowerCase();
  if (!addr) return null;
  const domain = addr.split("@")[1] || "";
  const exact = rules.find((r) => r.match_type === "email" && r.match_value === addr);
  if (exact) return exact;
  if (!domain) return null;
  return (
    rules.find(
      (r) =>
        r.match_type === "domain" &&
        (domain === r.match_value || domain.endsWith("." + r.match_value))
    ) || null
  );
}

export interface DecideInput {
  rules: ImportanceRule[];
  fromAddress?: string;
  subject?: string;
  sentToCount: number;
  listUnsubscribe?: boolean;
  fromSelf?: boolean;
  ai: Importance | null;
}

export function decideImportance(input: DecideInput): {
  importance: Importance;
  source: ImportanceSource;
} {
  const rule = matchImportanceRule(input.rules, input.fromAddress);
  if (rule) return { importance: rule.importance, source: "rule" };
  if (input.ai) {
    if (input.ai === "low" && (input.sentToCount >= 1 || input.fromSelf)) {
      return { importance: "secondary", source: "ai" };
    }
    return { importance: input.ai, source: "ai" };
  }
  return { importance: heuristicImportance(input), source: "heuristic" };
}

/** Le niveau autorise-t-il une notification, selon le reglage de l'utilisateur ? */
export type NotifyImportance = "important" | "important_secondary" | "all";

export function importanceAllowsNotification(
  importance: Importance | null | undefined,
  setting: NotifyImportance | string | null | undefined
): boolean {
  const s: NotifyImportance =
    setting === "important" || setting === "all" ? setting : "important_secondary";
  if (s === "all") return true;
  if (!importance) return true; // niveau inconnu : ne jamais taire par erreur
  if (s === "important") return importance === "important";
  return importance !== "low";
}
