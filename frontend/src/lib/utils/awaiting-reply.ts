import type { Message } from "@/lib/pocketbase";

/**
 * Rappel "attend une reponse" d'une conversation.
 *
 * Un fil attend une reponse quand son DERNIER message (tous dossiers, envoyes
 * compris : cf. thread_tails de /api/mail/list) est un mail RECU :
 *   - ni brouillon, ni envoye, ni ecrit depuis une de mes adresses ;
 *   - non repondu sur AUCUNE de ses copies (un mail recu sur deux comptes lies
 *     existe en double et seul l'un porte parfois le flag \Answered) ;
 *   - adresse a moi en "A" (pas seulement en copie) ;
 *   - venant d'une vraie personne : ni no-reply / notifications / newsletter,
 *     ni etiquette automatique (Newsletter, Promotion, Notification...), ni spam ;
 *   - venant d'un CORRESPONDANT : une adresse a laquelle j'ai deja ecrit, ou
 *     une adresse nominative d'une entreprise ou j'ai deja ecrit a quelqu'un
 *     (pas un domaine grand public, pas une adresse generique contact@/service@).
 *     C'est ce qui ecarte les alertes et confirmations (property-alerts@,
 *     contact@banque...) : on ne leur a jamais ecrit ;
 *   - recu il y a moins de AWAITING_MAX_DAYS jours (au-dela, la date normale
 *     revient : un vieux mail sans suite n'est plus un rappel utile).
 */
export const AWAITING_MAX_DAYS = 30;

// Partie locale d'une adresse automatique (debut de l'adresse).
const AUTOMATED_LOCAL_RE =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|ne[-_.]?pas[-_.]?repondre|nepasrepondre|notifications?|notify|alerts?|mailer[-_.]?daemon|postmaster|bounces?|newsletters?|news|digest|marketing|mailer|automated|auto[-_.]?confirm|updates?)([-_.+].*)?$/i;

// Morceaux d'adresse (separes par - _ . +) qui trahissent un envoi automatique :
// "property-alerts@", "info.notifications@", "team-newsletter@"...
const AUTOMATED_TOKENS = new Set([
  "noreply", "donotreply", "nepasrepondre", "alert", "alerts", "notification",
  "notifications", "notify", "newsletter", "newsletters", "mailer", "bounce",
  "bounces", "automated", "digest", "mailing", "notif",
]);

// Adresses generiques (boites partagees d'entreprise) : pas un interlocuteur
// nominatif, sauf si on leur a deja ecrit directement.
const GENERIC_LOCALS = new Set([
  "contact", "service", "services", "info", "infos", "information", "support",
  "hello", "bonjour", "team", "equipe", "admin", "billing", "facturation",
  "factures", "commande", "commandes", "order", "orders", "shop", "store",
  "sales", "ventes", "clients", "client", "serviceclient", "customer",
  "customerservice", "compta", "comptabilite", "office", "accueil", "reception",
  "mail", "email", "webmaster", "hr", "rh", "jobs", "careers", "recrutement",
]);

// Domaines grand public : avoir ecrit a un@gmail.com ne dit rien d'un autre.
const PUBLIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.fr", "hotmail.com",
  "hotmail.fr", "outlook.com", "outlook.fr", "live.com", "live.fr", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "orange.fr", "wanadoo.fr",
  "free.fr", "sfr.fr", "neuf.fr", "laposte.net", "bbox.fr", "bluewin.ch",
  "gmx.com", "gmx.fr", "gmx.de", "gmx.ch", "web.de", "proton.me",
  "protonmail.com", "hey.com", "yandex.com", "mail.com", "libero.it",
]);

// Sous-domaine d'envoi de masse (ex. news.marque.fr, notifications.site.com).
const AUTOMATED_DOMAIN_RE =
  /^(e?mail(ing)?|em|news(letter)?|notifications?|notify|marketing|mkt|bounces?|campaigns?|mailer)\./i;

// Etiquettes posees par la categorisation IA qui designent du courrier
// automatique (noms compares sans accents ni casse).
const AUTOMATED_LABELS = new Set([
  "newsletter",
  "newsletters",
  "promotion",
  "promotions",
  "notification",
  "notifications",
  "soldes",
  "publicite",
  "marketing",
  "reseaux sociaux",
  "social",
  "securite",
  "security",
  "livraison",
  "facture",
  "reservation",
]);

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function isAutomatedAddress(address: string | undefined | null): boolean {
  const addr = (address || "").trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return false;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (AUTOMATED_LOCAL_RE.test(local) || AUTOMATED_DOMAIN_RE.test(domain)) return true;
  return local.split(/[-_.+]/).some((tok) => AUTOMATED_TOKENS.has(tok));
}

function splitAddress(address: string): [string, string] {
  const at = address.lastIndexOf("@");
  return at <= 0 ? [address, ""] : [address.slice(0, at), address.slice(at + 1)];
}

// Domaines des correspondants, calcules une fois par jeu d'adresses.
const domainCache = new WeakMap<Set<string>, Set<string>>();
function domainsOf(addresses: Set<string>): Set<string> {
  let domains = domainCache.get(addresses);
  if (!domains) {
    domains = new Set<string>();
    for (const a of addresses) {
      const d = splitAddress(a)[1];
      if (d) domains.add(d);
    }
    domainCache.set(addresses, domains);
  }
  return domains;
}

/**
 * L'expediteur est-il un correspondant ? Adresse a laquelle j'ai deja ecrit,
 * ou adresse NOMINATIVE d'une entreprise ou j'ai deja ecrit a quelqu'un.
 */
export function isKnownCorrespondent(
  address: string,
  correspondents: Set<string>,
  myEmails: Set<string>
): boolean {
  const addr = address.toLowerCase().trim();
  if (correspondents.has(addr)) return true;
  const [local, domain] = splitAddress(addr);
  if (!domain || PUBLIC_DOMAINS.has(domain)) return false;
  for (const mine of myEmails) {
    if (splitAddress(mine)[1] === domain) return false;
  }
  if (GENERIC_LOCALS.has(local.replace(/[-_.+].*$/, ""))) return false;
  return domainsOf(correspondents).has(domain);
}

export function isAutomatedLabelName(name: string | undefined | null): boolean {
  if (!name) return false;
  return AUTOMATED_LABELS.has(stripAccents(name).toLowerCase().trim());
}

export interface AwaitingReplyContext {
  /** Adresses de mes comptes, en minuscules */
  myEmails: Set<string>;
  /**
   * Adresses auxquelles j'ai deja ecrit (useCorrespondents). null = pas encore
   * chargees -> aucun rappel (mieux vaut aucun rappel qu'un faux).
   */
  correspondents: Set<string> | null;
  /** Une autre copie du meme message (autre compte) est-elle repondue ? */
  answered?: boolean;
  /** Nom d'une etiquette depuis son id (etiquettes automatiques) */
  labelName?: (labelId: string) => string | undefined;
  /** Le message est dans le dossier spam */
  isSpam?: boolean;
  /** Horloge (ms) — injectable pour les tests */
  now?: number;
}

/**
 * Renvoie la date (ISO/PB) depuis laquelle le fil attend une reponse, ou null.
 * `message` = dernier message reel de la conversation.
 */
export function getAwaitingReplySince(
  message: Message | undefined | null,
  ctx: AwaitingReplyContext
): string | null {
  if (!message) return null;
  if (message.is_draft || message.is_sent) return null;
  if (message.is_answered || ctx.answered) return null;
  if (ctx.isSpam) return null;

  const from = (message.from_address?.address || "").toLowerCase().trim();
  if (!from || ctx.myEmails.has(from)) return null;
  if (isAutomatedAddress(from)) return null;
  if (!ctx.correspondents || !isKnownCorrespondent(from, ctx.correspondents, ctx.myEmails)) {
    return null;
  }

  const toMe = (message.to_addresses ?? []).some((r) =>
    ctx.myEmails.has((r.address || "").toLowerCase().trim())
  );
  if (!toMe) return null;

  if (ctx.labelName) {
    for (const id of message.labels ?? []) {
      if (isAutomatedLabelName(ctx.labelName(id))) return null;
    }
  }

  const ts = new Date(message.date).getTime();
  if (Number.isNaN(ts)) return null;
  const now = ctx.now ?? Date.now();
  if (now - ts > AWAITING_MAX_DAYS * 86_400_000) return null;
  return message.date;
}

const UNITS: Record<string, { min: string; h: string; d: string; w: string }> = {
  fr: { min: "min", h: "h", d: "j", w: "sem" },
  en: { min: "min", h: "h", d: "d", w: "w" },
  de: { min: "Min", h: "Std", d: "T", w: "Wo" },
  it: { min: "min", h: "h", d: "g", w: "sett" },
};

/** Duree courte depuis `since` : "5 min", "3 h", "2 j", "2 sem". */
export function formatWaitingDuration(
  since: string,
  language: string,
  now: number = Date.now()
): string {
  const u = UNITS[language] ?? UNITS.fr;
  const ms = Math.max(0, now - new Date(since).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} ${u.min}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${u.h}`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} ${u.d}`;
  return `${Math.floor(days / 7)} ${u.w}`;
}
