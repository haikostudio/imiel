// Suivi (follow-up tracking) au niveau CONVERSATION, pilote par l'utilisateur
// (etoile / clic droit / selection multiple).
//
// Une fiche de suivi = UNE conversation (thread). Sa timeline = un evenement par
// message du fil (auteur, date, descriptif). Ajouter une conversation au suivi
// declenche une extraction LLM sur TOUTE la conversation (type, titre, champs
// dynamiques, suggestion de cloture). Une conversation deja suivie est
// rafraichie automatiquement a l'arrivee de nouveaux messages. Retirer l'etoile
// archive la fiche. La cloture n'est jamais automatique : le LLM ne fait que
// suggerer (`closure_suggested`), l'utilisateur tranche.

import { backgroundModel } from "./ai-models";
import {
  getUserOpenRouterKey,
  getMessage,
  getAccount,
  listAccountsForUser,
  listStarredInboxSince,
  listInboxFolderIds,
  listInboxMessagesForTrackingAsc,
  listMessagesByThread,
  findTrackingItemsByThread,
  findAnyTrackingItemByThread,
  listOpenTrackingCandidates,
  createTrackingItem,
  updateTrackingItem,
  createTrackingEvent,
  upsertTrackingEvent,
  countTrackingEvents,
  deleteTrackingEventsForItem,
  purgeTrackingItems,
  getAttachmentsForMessage,
  getUserPauseFlags,
  invalidateUserPauseFlagsCache,
  getUserNotificationsEnabled,
  getTrackingItem,
  countOpenTrackingItems,
  listAllTrackingItemIds,
  listOpenTrackingItemsForDedup,
  ensureTrackingGroup,
  findCalendarEventByIcsUid,
  listCalendarEventsInRange,
  listTrackingCalendarEventsForItem,
  createCalendarEvent,
  updateCalendarEvent,
  findSuggestionByDedupKey,
  getSuggestion,
  createSuggestion,
  updateSuggestion,
  deletePendingSuggestionsForItem,
  listPendingSuggestionsForUser,
  deleteSuggestion,
  type PBCalendarEvent,
  type PBCalendarSuggestion,
  type PBTrackingItem,
  type PBMessageForThread,
  type PBMessage,
} from "./pocketbase";
import { deleteTrackingEventsEverywhere, patchEventOnGoogle, pushEventQuietly } from "./calendar-google";
import { htmlToPlain, isDesignatedSource } from "./newsletter";
import { isAutomatedSender } from "./cerveau";
import { searchEmbeddings } from "./embeddings";
import { searchKeywordsFTS5 } from "./search-index";
import {
  listRecentMessagesBySenderDomain,
  listMessagesWithCounterpart,
} from "./sqlite-direct";
import { PUBLIC_MAIL_DOMAINS } from "./mail-domains";
import {
  sendTrackingStatusNotification,
  sendCalendarSuggestionNotification,
} from "./push";
import {
  logTrackingNewActivity,
  logTrackingStatusActivity,
  logCalendarSuggestionActivity,
} from "./activity";
import { ianaWallClockToUtcIso } from "./ics";

// Fuseau des heures murales extraites des mails ("RDV a 8h" = 8h chez
// l'utilisateur). Le conteneur tourne en UTC : new Date(y,m,d,h) stockerait
// l'heure murale COMME UTC -> +2h a l'affichage (bug RDV Orange 08h -> 10h).
const TRACKING_TIMEZONE = process.env.TRACKING_TIMEZONE || "Europe/Paris";

/** Heure murale utilisateur -> instant UTC. Fallback fuseau du process si TZ inconnue d'ICU. */
function trackingWallClockToUtc(y: number, mo: number, d: number, h: number, mi: number): Date {
  const iso = ianaWallClockToUtcIso(y, mo, d, h, mi, 0, TRACKING_TIMEZONE);
  return iso ? new Date(iso) : new Date(y, mo - 1, d, h, mi, 0);
}

/** Annee/mois/jour d'un instant, vus dans le fuseau utilisateur. */
function trackingDateParts(ms: number): { y: number; mo: number; d: number } {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: TRACKING_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const [y, mo, d] = dtf.format(new Date(ms)).split("-").map(Number);
    return { y, mo, d };
  } catch {
    const dd = new Date(ms);
    return { y: dd.getFullYear(), mo: dd.getMonth() + 1, d: dd.getDate() };
  }
}

/** Normalise un libelle de statut pour comparer deux etats (insensible casse/espaces). */
function normStatus(s: string): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

import { aiFetch, serverOpenRouterKey } from "./ai-budget";
const TIMEOUT_MS = 25_000;
const PER_MSG_CAP = 1_200;
const TOTAL_CAP = 9_000;
const MAX_MSGS = 25;

function trackingModel(): string {
  // Variable dediee si posee, sinon le modele d'arriere-plan commun (ai-models.ts).
  return backgroundModel("OPENROUTER_MODEL_TRACKING");
}

/** Dedoublonne les messages d'un thread (meme date + meme debut de contenu) :
 * certaines boites stockent le meme mail plusieurs fois (dossiers differents),
 * ce qui creait des etapes en double dans la timeline. */
function dedupMessages(messages: PBMessageForThread[]): PBMessageForThread[] {
  const seen = new Set<string>();
  const out: PBMessageForThread[] = [];
  for (const m of messages) {
    const key = `${m.date}|${(m.snippet || m.text_body || "").replace(/\s+/g, " ").trim().slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/** Retire les URLs et compresse les espaces -> texte court lisible (fallback). */
function stripForFallback(text: string): string {
  return (text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function senderDomainOf(address?: string): string {
  const at = (address || "").lastIndexOf("@");
  return at >= 0 ? address!.slice(at + 1).trim().toLowerCase() : "";
}

/**
 * Le "correspondant" d'une affaire = l'INTERLOCUTEUR (marchand / expediteur),
 * jamais l'utilisateur. S'il existe au moins un message ENTRANT, on prend le
 * `from` du premier entrant. Sinon (fil composé UNIQUEMENT de mails ENVOYES par
 * l'utilisateur : demarche sortante sans reponse encore recue), on prend le
 * DESTINATAIRE du premier mail envoye — sinon le marchand serait l'utilisateur
 * lui-meme (titre/merchant faux).
 */
function counterpartOf(messages: PBMessageForThread[]): {
  name: string;
  address: string;
  domain: string;
} {
  const inbound = messages.find((m) => !m.is_sent);
  if (inbound) {
    const address = inbound.from_address?.address || "";
    return {
      name: inbound.from_address?.name || "",
      address,
      domain: senderDomainOf(address),
    };
  }
  const sent = messages.find((m) => m.is_sent) || messages[0];
  const to = sent?.to_addresses?.[0];
  const address = to?.address || "";
  return { name: to?.name || "", address, domain: senderDomainOf(address) };
}

// Le type est deja affiche dans un badge a part : on retire un eventuel prefixe
// de type en tete de titre ("Commande MH France" -> "MH France").
const TYPE_PREFIX_RE =
  /^(commande|livraison|colis|facture|reservation|rendez-?vous|devis|candidature|support|suivi|administratif|paiement|remboursement|retour)s?\s+/i;

function cleanTitle(rawTitle: string, type: string): string {
  let titleText = (rawTitle || "").trim();
  if (!titleText) return titleText;
  if (type) {
    const esc = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    titleText = titleText.replace(new RegExp(`^${esc}s?\\s+`, "i"), "");
  }
  titleText = titleText.replace(TYPE_PREFIX_RE, "");
  return titleText.trim() || rawTitle.trim();
}

// Ordre de priorite des champs d'identite dans la synthese (registre) : les plus
// distinctifs d'abord (produit + numeros + montant), pour DISTINGUER deux
// commandes du meme marchand.
const SUMMARY_FIELD_ORDER = [
  "produit",
  "reference",
  "numero_commande",
  "commande",
  "numero_suivi",
  "montant",
  "transporteur",
  "mode_paiement",
  "date_livraison",
  "adresse_livraison",
];

/** Synthese d'IDENTITE deterministe d'une affaire (registre) : titre + marchand +
 *  identifiants concrets. Construite depuis les champs deja extraits (fiable, sans
 *  dependre du LLM). Sert de fallback quand le modele ne fournit pas de prose. */
function buildContextSummary(
  title: string,
  merchant: string,
  fields: Record<string, string>
): string {
  const head = [title, merchant && !((title || "").includes(merchant)) ? merchant : ""]
    .filter(Boolean)
    .join(" - ");
  const f = fields && typeof fields === "object" ? fields : {};
  const seen = new Set<string>();
  const kv: string[] = [];
  for (const k of SUMMARY_FIELD_ORDER) {
    if (f[k]) {
      kv.push(`${k.replace(/_/g, " ")}: ${f[k]}`);
      seen.add(k);
    }
  }
  for (const [k, v] of Object.entries(f)) {
    if (kv.length >= 8) break;
    if (!seen.has(k) && v) kv.push(`${k.replace(/_/g, " ")}: ${v}`);
  }
  return [head, kv.join(", ")].filter(Boolean).join(" — ").slice(0, 1500);
}

interface StepSynthesis {
  i: number;
  label: string;
  summary: string;
}

/** Date importante a venir extraite d'une fiche (livraison, rendez-vous,
 * echeance...) destinee a etre poussee dans l'agenda. */
interface FicheDate {
  kind: string;
  label: string;
  date: string; // ISO AAAA-MM-JJ
  time?: string; // HH:MM (optionnel)
  time_end?: string; // HH:MM fin de plage (optionnel, ex creneau "08h-11h")
}

interface FicheExtraction {
  follow_up: boolean;
  match_index: number | null;
  type: string;
  title: string;
  status_label: string;
  context_summary: string;
  fields: Record<string, string>;
  closure_suggested: boolean;
  steps: StepSynthesis[];
  dates: FicheDate[];
}

const SYSTEM_PROMPT = `Tu es un assistant qui maintient des fiches de SUIVI a partir des emails d'une boite mail (commandes, livraisons, reservations, rendez-vous, devis, contrats, candidatures, demarches administratives, support, factures...).

On te donne UNE conversation email (un fil de messages numerotes [0], [1], ...) et la liste des SUIVIS OUVERTS de l'utilisateur. Plusieurs emails de fils differents peuvent concerner la MEME affaire (mail du marchand, mail de paiement PayPal, mail d'expedition, mails du transporteur sur l'acheminement, avenants d'un contrat...). Tu dois rattacher au bon suivi et produire des SYNTHESES CLAIRES et UTILES.

Reponds STRICTEMENT en JSON sur une seule ligne, sans texte autour ni bloc de code :
{"follow_up": false, "match_index": null, "type": "", "title": "", "status_label": "", "context_summary": "", "fields": {}, "closure_suggested": false, "steps": [{"i":0,"label":"","summary":""}], "dates": [{"kind":"livraison","label":"","date":"AAAA-MM-JJ","time":"HH:MM","time_end":"HH:MM"}]}

Regles :
- "follow_up" : true UNIQUEMENT si cette conversation merite un SUIVI dans le temps : commande, livraison/colis, reservation, rendez-vous, devis, contrat, candidature, demarche administrative, ticket de support, dossier en cours, facture a payer/rembourser, garantie/retour, abonnement. false pour : newsletters, promotions/publicite, simples notifications sans action, alertes de securite ponctuelles, conversations personnelles sans suite a suivre, confirmations sans suite. (Si match_index n'est pas null, considere follow_up=true.)
- "match_index" : index (entier) d'un suivi ouvert qui concerne la MEME affaire (meme reference, meme commande, meme numero de suivi, meme marchand+montant), ou null si nouveau. Sois prudent. Le marchand/expediteur peut differer (PayPal, transporteur) si la reference/montant/produit correspondent.
- "type" : UN mot minuscule en francais (ex: "commande", "livraison", "reservation", "rendez-vous", "devis", "contrat", "candidature", "administratif", "support", "facture").
- "title" : un SUJET explicite (le PRODUIT ou l'objet concret de l'affaire) SUIVI de " - " puis du NOM DE L'ENTREPRISE. Format OBLIGATOIRE : "<sujet explicite> - <Entreprise>". NE COMMENCE PAS par le type. Le sujet n'est JAMAIS un mot de statut (autorise, valide, accepte, expedie, paiement, confirmation...) : c'est TOUJOURS le PRODUIT/objet. Si plusieurs mails du fil concernent la meme affaire, prends le produit dans CELUI qui le nomme (souvent le mail d'expedition). Le NUMERO de commande/suivi NE VA PAS dans le titre (il est dans "fields"). Ex: "Buffet 3 portes 150x40 - ManoMano", "Table a manger ovale Wokaka - ManoMano", "Parasol deporte carre - Maisons du Monde", "RDV dentiste 12 mars - Dr Martin", "Assurance auto - AXA". Si AUCUN produit n'est nommable, mets juste le NOM DE L'ENTREPRISE comme titre (ex: "MH France"), jamais un mot de statut.
- "fields" : objet cle->valeur des infos utiles (cles en minuscules_tiret_bas, valeurs courtes), ex: {"reference":"...","produit":"...","montant":"89,90 EUR","date_livraison":"14 mars","transporteur":"Chronopost","numero_suivi":"XY12","adresse_livraison":"12 rue X, 75001 Paris"}. RELEVE SYSTEMATIQUEMENT quand present (infos PRECIEUSES pour l'utilisateur en deplacement) : "numero_suivi" (numero de suivi colis), "code_retrait" / "code_validation" (code a presenter au retrait ou a la livraison), "point_retrait" (nom + ADRESSE COMPLETE du point relais/bureau de poste/consigne, ex: "Relais Tabac de la Gare, 12 rue X, 75001 Paris"), "adresse_depot" (adresse complete du depot/agence ou deposer ou recuperer un colis), "horaires_retrait" (horaires d'ouverture du point), "date_limite_retrait" (date limite pour recuperer le colis). Pour les adresses : TOUJOURS l'adresse POSTALE COMPLETE (rue, code postal, ville) telle qu'ecrite dans le mail, jamais tronquee. Uniquement ce qui est present. Si la conversation contient PLUSIEURS valeurs differentes pour une meme info (ex: deux adresses de livraison), prends TOUJOURS celle du message le PLUS RECENT (l'info a jour), jamais une ancienne.
- "context_summary" : 1 a 2 phrases en francais qui resument l'IDENTITE de l'affaire et servent a la RECONNAITRE parmi d'autres. DOIT contenir les IDENTIFIANTS DISTINCTIFS presents : marchand exact, produit/objet, numero de commande, numero de suivi colis, montant, transporteur, adresse de livraison, date cle. Ecris-le pour DISTINGUER cette affaire d'une AUTRE commande du MEME marchand (ex: "Commande d'une table ovale Wokaka 180cm chez ManoMano (195,12 EUR, PayPal), ref M260691668023, livraison DPD 01475239429211 au 9bis av Charles Flahault Montpellier."). Factuel, pas de ton ludique ici.
- "status_label" : etat actuel court selon le DERNIER message (ex: "Commande confirmee", "Expedie", "En cours de livraison", "Livre", "En attente de reponse").
- "closure_suggested" : true UNIQUEMENT si l'affaire semble terminee (livre, resolu/repondu, rendez-vous passe, annule). Tu SUGGERES, tu ne clotures jamais.
- "dates" : liste des DATES IMPORTANTES A VENIR mentionnees dans la conversation et qui meritent un rappel dans l'agenda : date de livraison prevue, date/heure d'un rendez-vous, date limite/echeance (paiement a effectuer, retour d'un produit, reponse attendue, fin de garantie, expiration), date d'installation/intervention. Chaque entree : {"kind":"livraison|rendez-vous|echeance|limite|retour|intervention|paiement|autre","label":"libelle court et clair (ex: Livraison prevue, RDV dentiste, Date limite de retour)","date":"AAAA-MM-JJ","time":"HH:MM","time_end":"HH:MM"}. "date" est OBLIGATOIRE au format ISO AAAA-MM-JJ : DEDUIS L'ANNEE a partir des dates des messages (indiquees apres chaque " | " dans l'entete de message). Omets "time" si l'heure n'est pas precisee. Si une PLAGE horaire est donnee (ex "creneau entre 8h et 11h"), "time" = debut et "time_end" = fin ; omets "time_end" sinon. Les heures sont en heure LOCALE de l'utilisateur, recopie-les telles quelles. N'INVENTE JAMAIS de date : uniquement celles reellement presentes dans les messages. Liste vide [] si aucune date a retenir.
- "steps" : un objet par message du fil, dans l'ordre, avec son index "i". "label" = titre TRES court et VIVANT de l'etape, commencant par UN emoji pertinent (ex: "Commande confirmee", "C'est paye !", "Colis prepare", "En route !", "Bientot chez vous", "Livre !", "Commande annulee", "Remboursement en cours"). "summary" = 1 a 2 phrases EN FRANCAIS, ton LUDIQUE et CHALEUREUX (comme un bon suivi de colis), qui (a) raconte ce qui se passe avec les infos utiles (montant, date, numero de suivi, transporteur) ET (b) enchaine LOGIQUEMENT avec l'etape PRECEDENTE et annonce la SUITE attendue (progression naturelle : commande -> paiement -> preparation -> expedition -> transport -> livraison ; ou pour un retour : demande -> acceptation -> renvoi -> remboursement). INTERDIT : URLs, liens, charabia, copier-coller brut. Si un message n'apporte rien d'utile, resume-le quand meme brievement et gentiment.
- Langue : francais.`;

function buildUserPrompt(
  messages: PBMessageForThread[],
  candidates: PBTrackingItem[]
): string {
  const slice = messages.slice(-MAX_MSGS);
  const subject = slice[0]?.subject || messages[0]?.subject || "(sans sujet)";
  let total = 0;
  const parts: string[] = [];
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    // Mail ENVOYE : on montre le DESTINATAIRE ("Moi -> Marchand") pour qu'un fil
    // uniquement sortant (demarche sans reponse recue) permette quand meme
    // d'identifier l'interlocuteur/marchand. Mail RECU : le `from` classique.
    const to = m.is_sent ? m.to_addresses?.[0] : undefined;
    const toStr = to?.name
      ? `${to.name} <${to.address}>`
      : to?.address || "";
    const who = m.is_sent
      ? toStr
        ? `Moi -> ${toStr}`
        : "Moi"
      : m.from_address?.name
        ? `${m.from_address.name} <${m.from_address.address}>`
        : m.from_address?.address || "?";
    const bodyRaw = htmlToPlain(m.html_body || m.text_body || m.snippet || "");
    const remaining = Math.max(0, TOTAL_CAP - total);
    if (remaining <= 0) break;
    const body = bodyRaw.slice(0, Math.min(PER_MSG_CAP, remaining));
    total += body.length;
    parts.push(`--- [${i}] ${who} | ${m.date} ---\n${body}`);
  }
  const candidatesStr =
    candidates.length > 0
      ? candidates
          .map((c, i) => {
            const f = c.fields && typeof c.fields === "object" ? c.fields : {};
            const fieldsStr = Object.entries(f)
              .slice(0, 6)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ");
            return `[${i}] ${c.title || "?"} | marchand=${c.merchant || c.sender_domain || "?"} | ${fieldsStr}`;
          })
          .join("\n")
      : "(aucun)";
  return `SUIVIS OUVERTS :\n${candidatesStr}\n\n--- NOUVELLE CONVERSATION ---\nSujet : ${subject}\n\nMessages (${slice.length}, du plus ancien au plus recent) :\n\n${parts.join(
    "\n\n"
  )}`;
}

/** Valide/normalise le tableau `dates` d'une reponse LLM -> FicheDate[]. */
function parseDatesArray(raw: unknown): FicheDate[] {
  const dates: FicheDate[] = [];
  if (!Array.isArray(raw)) return dates;
  for (const d of raw as unknown[]) {
    if (!d || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    const date = typeof o.date === "string" ? o.date.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // ISO obligatoire
    const time =
      typeof o.time === "string" && /^\d{2}:\d{2}$/.test(o.time.trim())
        ? o.time.trim()
        : undefined;
    const timeEnd =
      time && typeof o.time_end === "string" && /^\d{2}:\d{2}$/.test(o.time_end.trim())
        ? o.time_end.trim()
        : undefined;
    dates.push({
      kind: typeof o.kind === "string" ? o.kind.trim().toLowerCase().slice(0, 30) : "autre",
      label: typeof o.label === "string" ? o.label.trim().slice(0, 120) : "",
      date,
      ...(time ? { time } : {}),
      ...(timeEnd ? { time_end: timeEnd } : {}),
    });
    if (dates.length >= 8) break;
  }
  return dates;
}

function parseFiche(raw: string, candidateCount: number): FicheExtraction | null {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  let matchIndex: number | null = null;
  const mi = obj.match_index;
  if (typeof mi === "number" && Number.isInteger(mi) && mi >= 0 && mi < candidateCount) {
    matchIndex = mi;
  }
  const fields: Record<string, string> = {};
  if (obj.fields && typeof obj.fields === "object") {
    for (const [k, v] of Object.entries(obj.fields as Record<string, unknown>)) {
      if (v == null) continue;
      const key = String(k).trim().toLowerCase().replace(/\s+/g, "_").slice(0, 40);
      if (!key) continue;
      fields[key] = String(v).trim().slice(0, 300);
    }
  }
  const steps: StepSynthesis[] = [];
  if (Array.isArray(obj.steps)) {
    for (const s of obj.steps as unknown[]) {
      if (!s || typeof s !== "object") continue;
      const o = s as Record<string, unknown>;
      const i = typeof o.i === "number" ? o.i : Number(o.i);
      if (!Number.isInteger(i)) continue;
      steps.push({
        i,
        label: typeof o.label === "string" ? o.label.trim().slice(0, 200) : "",
        summary: typeof o.summary === "string" ? o.summary.trim().slice(0, 600) : "",
      });
    }
  }
  const dates = parseDatesArray(obj.dates);
  return {
    follow_up:
      obj.follow_up === true || obj.follow_up === "true" || matchIndex !== null,
    match_index: matchIndex,
    type: typeof obj.type === "string" ? obj.type.trim().toLowerCase().slice(0, 40) : "",
    title: typeof obj.title === "string" ? obj.title.trim().slice(0, 200) : "",
    status_label: typeof obj.status_label === "string" ? obj.status_label.trim().slice(0, 200) : "",
    context_summary:
      typeof obj.context_summary === "string" ? obj.context_summary.trim().slice(0, 1500) : "",
    fields,
    closure_suggested: obj.closure_suggested === true || obj.closure_suggested === "true",
    steps,
    dates,
  };
}

async function extractFiche(
  messages: PBMessageForThread[],
  candidates: PBTrackingItem[],
  apiKey: string
): Promise<FicheExtraction | null> {
  try {
    const res = await aiFetch("tracking-extract", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
        "X-Title": "iMiel",
      },
      body: JSON.stringify({
        model: trackingModel(),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(messages, candidates) },
        ],
        temperature: 0,
        max_tokens: 1800,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[tracking] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      console.warn("[tracking] extraction: empty LLM content");
      return null;
    }
    const parsed = parseFiche(content, candidates.length);
    if (!parsed) {
      console.warn(
        `[tracking] extraction: unparseable LLM JSON (len=${content.length})`
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      console.warn("[tracking] extraction timeout");
    } else {
      console.warn("[tracking] extraction error:", err);
    }
    return null;
  }
}

/** Premiere PJ image trouvee dans la conversation (visuel produit). */
async function findImageInThread(messages: PBMessageForThread[]): Promise<string> {
  for (const m of messages) {
    if (!m.has_attachments) continue;
    try {
      const atts = await getAttachmentsForMessage(m.id);
      const img =
        atts.find((a) => (a.content_type || "").toLowerCase().startsWith("image/") && !a.is_inline) ||
        atts.find((a) => (a.content_type || "").toLowerCase().startsWith("image/"));
      if (img) return img.id;
    } catch {
      /* ignore */
    }
  }
  return "";
}

// --- Echeances / livraisons / rendez-vous -> PROPOSITIONS agenda --------------
//
// Les dates importantes a venir extraites d'une fiche (livraison prevue, RDV,
// date limite de retour/paiement...) ne sont JAMAIS ajoutees automatiquement a
// l'agenda. On cree une PROPOSITION (`calendar_suggestions`, statut pending) que
// l'utilisateur valide (ajouter a l'agenda) ou refuse via le drawer dedie.
// Dedup par cle synthetique `tracking:<itemId>:<kind>` : une date qui glisse
// MET A JOUR la proposition (ou deplace l'event si deja accepte) au lieu d'en
// empiler une nouvelle ; un refus reste un refus. Seules les dates FUTURES sont
// proposees. Best effort, jamais bloquant.

const KIND_EMOJI: Record<string, string> = {
  livraison: "📦",
  "rendez-vous": "📅",
  rdv: "📅",
  echeance: "⏰",
  limite: "⏰",
  retour: "↩️",
  intervention: "🔧",
  paiement: "💳",
  autre: "🗓️",
};

function slugifyKind(s: string): string {
  return stripDiacritics(s.toLowerCase()).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "x";
}

function startOfToday(): number {
  const { y, mo, d } = trackingDateParts(Date.now());
  return trackingWallClockToUtc(y, mo, d, 0, 0).getTime();
}

interface PreparedDate {
  key: string;
  uid: string;
  kind: string;
  label: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
}

/** Transforme les dates FUTURES extraites en propositions pretes a poser
 * (cle de dedup, titre, start/end). Filtre les dates passees / invalides. */
function prepareDates(itemId: string, ficheTitle: string, dates: FicheDate[]): PreparedDate[] {
  if (!Array.isArray(dates) || dates.length === 0) return [];
  const today = startOfToday();
  const usedKeys = new Set<string>();
  const out: PreparedDate[] = [];
  for (const d of dates) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.date);
    if (!m) continue;
    const [, y, mo, da] = m;
    let start: Date;
    let allDay: boolean;
    if (d.time && /^(\d{2}):(\d{2})$/.test(d.time)) {
      const [hh, mi] = d.time.split(":").map(Number);
      // Heure murale UTILISATEUR (fuseau TRACKING_TIMEZONE), pas celle du conteneur (UTC).
      start = trackingWallClockToUtc(+y, +mo, +da, hh, mi);
      allDay = false;
    } else {
      // All-day : minuit UTC de la date (convention calendar_events / Google).
      start = new Date(Date.UTC(+y, +mo - 1, +da, 0, 0, 0));
      allDay = true;
    }
    if (isNaN(start.getTime())) continue;
    if (start.getTime() < today) continue; // dates passees : aucun interet
    let end = new Date(start.getTime() + (allDay ? 86400_000 : 3600_000));
    // Plage horaire explicite ("creneau 08h-11h") : fin = borne haute de la plage.
    if (!allDay && d.time_end && /^(\d{2}):(\d{2})$/.test(d.time_end)) {
      const [eh, em] = d.time_end.split(":").map(Number);
      const e = trackingWallClockToUtc(+y, +mo, +da, eh, em);
      if (e.getTime() > start.getTime()) end = e;
    }
    const kind = (d.kind || "autre").toLowerCase();
    let key = slugifyKind(kind);
    if (usedKeys.has(key)) key = `${key}-${slugifyKind(d.label) || "2"}`;
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    const emoji = KIND_EMOJI[kind] || "🗓️";
    const labelText = (d.label || "").trim() || kind.charAt(0).toUpperCase() + kind.slice(1);
    const title = `${emoji} ${labelText}${ficheTitle ? ` · ${ficheTitle}` : ""}`.slice(0, 200);
    out.push({
      key,
      uid: `tracking:${itemId}:${key}`,
      kind,
      label: labelText,
      title,
      start,
      end,
      allDay,
    });
  }
  return out;
}

// Mots NON distinctifs pour rapprocher une echeance d'un event d'agenda : types
// d'echeance (deja portes par l'emoji/kind), termes de RDV generiques et mots
// vides FR/EN. On ne matche que sur des tokens "porteurs" (marchand, produit,
// sujet) pour eviter les faux positifs entre deux events du meme jour.
const AGENDA_MATCH_STOPWORDS = new Set([
  "livraison", "livraisons", "rendez", "vous", "echeance", "echeances", "limite",
  "retour", "retours", "intervention", "paiement", "paiements", "autre", "autres",
  "prevue", "prevu", "prevues", "prevus", "suivi", "commande", "commandes", "colis",
  "renouvellement", "facture", "factures", "abonnement",
  "rendezvous", "reunion", "reunions", "appel", "call", "meeting", "point", "visio", "rappel",
  "pour", "avec", "sur", "les", "des", "une", "dans", "par", "chez", "mon", "ton",
  "son", "votre", "notre", "leur", "this", "that", "with", "from", "your", "the",
]);

/** Tokens distinctifs (>=4 lettres, hors mots vides) d'un libelle. */
function significantTokens(text: string): Set<string> {
  const norm = stripDiacritics((text || "").toLowerCase()).replace(/[^a-z0-9]+/g, " ");
  const out = new Set<string>();
  for (const tok of norm.split(/\s+/)) {
    if (tok.length >= 4 && !AGENDA_MATCH_STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

/** Fenetre [00:00, 23:59:59.999] du jour de `start`, au format datetime de PB.
 * IMPORTANT : PocketBase compare les datetime lexicographiquement au format
 * "YYYY-MM-DD HH:MM:SS.sssZ" (ESPACE). Avec le 'T' d'`toISOString()`, la borne
 * basse exclurait les events stockes a minuit (" " < "T"). On renvoie donc le
 * format espace de PB. */
function pbDayWindow(start: Date): { from: string; to: string } {
  // "Jour" = jour dans le fuseau UTILISATEUR, elargi d'un cran de chaque cote
  // pour couvrir aussi les events all-day stockes a minuit UTC de cette date.
  const { y, mo, d } = trackingDateParts(start.getTime());
  const tzMidnight = trackingWallClockToUtc(y, mo, d, 0, 0).getTime();
  const utcMidnight = Date.UTC(y, mo - 1, d, 0, 0, 0);
  const from = new Date(Math.min(tzMidnight, utcMidnight));
  const to = new Date(Math.max(tzMidnight, utcMidnight) + 86400_000 - 1);
  return {
    from: from.toISOString().replace("T", " "),
    to: to.toISOString().replace("T", " "),
  };
}

/** Portion "kind" d'un ics_uid de suivi `tracking:<itemId>:<kindKey>`. */
function trackingEventKindKey(icsUid: string, itemId: string): string {
  const prefix = `tracking:${itemId}:`;
  return icsUid.startsWith(prefix) ? icsUid.slice(prefix.length) : "";
}

/** Deux cles de suivi designent-elles le MEME type d'echeance ? (livraison vs
 * paiement = non ; "livraison" vs "livraison-livraison-prevue" = oui). */
function sameTrackingKind(baseKind: string, eventKindKey: string): boolean {
  if (!baseKind || !eventKindKey) return false;
  return (
    eventKindKey === baseKind ||
    eventKindKey.startsWith(`${baseKind}-`) ||
    baseKind.startsWith(`${eventKindKey}-`)
  );
}

/** Tolerance (jours) pour considerer que deux echeances du MEME type d'une MEME
 * fiche sont en fait les DEUX BORNES d'une seule echeance (fenetre de livraison
 * "entre le X et le Y"). Assez large pour couvrir une fourchette de livraison,
 * mais bien en deca d'un cycle mensuel pour ne PAS fusionner deux paiements/
 * renouvellements successifs d'un abonnement (~30 j). */
const SAME_KIND_DEDUP_WINDOW_DAYS = 21;

/**
 * Cherche dans l'agenda un event representant DEJA cette echeance. Deux niveaux :
 *  (A) MEME fiche, MEME type d'echeance (`tracking:<itemId>:<kind>`), a moins de
 *      ~3 semaines : la livraison/paiement/RDV de cette fiche est DEJA a l'agenda
 *      -> on ne re-propose PAS une autre date du meme type, typiquement l'AUTRE
 *      borne d'une fenetre de livraison ("entre le 30 juin et le 6 juillet").
 *      On relache ici le jour, mais SEULEMENT pour les events de CETTE fiche du
 *      MEME type. Un type DIFFERENT (livraison vs paiement) reste distinct, et la
 *      fenetre courte evite de fusionner deux echeances mensuelles successives.
 *      EXCEPTION type different : deux events HORODATES de la meme fiche au MEME
 *      instant exact = le MEME rendez-vous renomme par la re-synthese LLM
 *      ("disponibilite" -> "retrait"...) ; la cle de dedup a change mais
 *      l'echeance est deja a l'agenda -> doublon. Les all-day gardent la regle
 *      stricte (livraison vs paiement le meme jour = distincts, voulu).
 *  (B) MEME jour, AUTRE source (Google, ICS, ajout manuel, autre fiche) partageant
 *      un token distinctif (marchand/produit/sujet) -> deja a l'agenda autrement.
 * Evite de proposer ce qui est deja a l'agenda. Best effort (jamais bloquant).
 */
async function findExistingAgendaEvent(
  userId: string,
  itemId: string,
  prepared: { uid: string; kind: string; start: Date; title: string; label: string; allDay?: boolean }
): Promise<PBCalendarEvent | null> {
  const baseKind = slugifyKind(prepared.kind || "");

  // (A) Event "Suivi" de CETTE fiche, du MEME type, a n'importe quel jour proche.
  // Couvre l'autre borne d'une fenetre de livraison une fois la 1ere acceptee.
  try {
    const own = await listTrackingCalendarEventsForItem(userId, itemId);
    const windowMs = SAME_KIND_DEDUP_WINDOW_DAYS * 86400_000;
    for (const ev of own) {
      if (!ev.ics_uid) continue;
      if (ev.ics_uid === prepared.uid) return ev; // exactement cette echeance
      const evStart = new Date(ev.start).getTime();
      if (isNaN(evStart)) continue;
      if (!sameTrackingKind(baseKind, trackingEventKindKey(ev.ics_uid, itemId))) {
        // Type different mais MEME instant exact (events horodates des deux
        // cotes) : meme RDV renomme par la re-synthese -> deja a l'agenda.
        if (!ev.all_day && prepared.allDay === false && evStart === prepared.start.getTime()) {
          return ev;
        }
        continue;
      }
      if (Math.abs(evStart - prepared.start.getTime()) <= windowMs) return ev;
    }
  } catch {
    /* best effort : on continue sur la verif (B) */
  }

  // (B) Event d'une autre source le MEME jour : doublon si token distinctif partage.
  const { from, to } = pbDayWindow(prepared.start);
  let dayEvents: PBCalendarEvent[];
  try {
    dayEvents = await listCalendarEventsInRange(userId, from, to);
  } catch {
    return null; // en cas d'echec on ne bloque pas la proposition
  }
  if (dayEvents.length === 0) return null;
  const ownPrefix = `tracking:${itemId}:`;
  const wanted = significantTokens(`${prepared.label} ${prepared.title}`);
  for (const ev of dayEvents) {
    if (ev.ics_uid && ev.ics_uid === prepared.uid) return ev;
    if (ev.ics_uid && ev.ics_uid.startsWith(ownPrefix)) continue; // deja traite en (A)
    if (wanted.size === 0) continue;
    const hay = significantTokens(`${ev.title} ${ev.description}`);
    for (const tok of wanted) {
      if (hay.has(tok)) return ev;
    }
  }
  return null;
}

/**
 * Cree/maj les PROPOSITIONS d'echeance d'une fiche (statut pending). Ne touche
 * JAMAIS l'agenda directement. Retourne le nombre de NOUVELLES propositions
 * (pour decider d'une notif). Pour une proposition deja `accepted`, met a jour
 * l'event lie si la date a glisse ; un `refused` est respecte (on n'insiste pas).
 * Ne propose PAS une echeance deja presente dans l'agenda (verif `calendar_events`).
 */
async function proposeTrackingDates(
  userId: string,
  itemId: string,
  ficheTitle: string,
  dates: FicheDate[]
): Promise<number> {
  const prepared = prepareDates(itemId, ficheTitle, dates);
  if (prepared.length === 0) return 0;
  let created = 0;

  for (const p of prepared) {
    try {
      const existing = await findSuggestionByDedupKey(userId, p.uid);
      if (!existing) {
        // Deja a l'agenda (Google/ICS/manuel/autre fiche) ? Ne pas re-proposer.
        if (await findExistingAgendaEvent(userId, itemId, p)) continue;
        await createSuggestion({
          user: userId,
          item: itemId,
          dedup_key: p.uid,
          kind: p.kind,
          label: p.label,
          title: p.title,
          fiche_title: ficheTitle,
          start: p.start.toISOString(),
          end: p.end.toISOString(),
          all_day: p.allDay,
          status: "pending",
        });
        created++;
        continue;
      }
      const startChanged = new Date(existing.start).getTime() !== p.start.getTime();
      if (existing.status === "refused") {
        // Respecte le refus, sauf si la date a REELLEMENT change -> on re-propose.
        if (startChanged) {
          await updateSuggestion(existing.id, {
            status: "pending",
            title: p.title,
            label: p.label,
            fiche_title: ficheTitle,
            start: p.start.toISOString(),
            end: p.end.toISOString(),
            all_day: p.allDay,
          });
          created++;
        }
        continue;
      }
      if (existing.status === "accepted") {
        // Deja a l'agenda : on DEPLACE l'event si la date a glisse.
        if (existing.event && (startChanged || existing.all_day !== p.allDay)) {
          try {
            const moved = await updateCalendarEvent(existing.event, {
              title: p.title,
              start: p.start.toISOString(),
              end: p.end.toISOString(),
              all_day: p.allDay,
              ...(startChanged ? { reminders_sent: [] } : {}),
            });
            // L'agenda Suivi est chez Google : la copie Google suit le glissement.
            const etag = await patchEventOnGoogle(moved).catch(() => null);
            if (etag) await updateCalendarEvent(moved.id, { etag });
            await updateSuggestion(existing.id, {
              title: p.title,
              start: p.start.toISOString(),
              end: p.end.toISOString(),
              all_day: p.allDay,
            });
          } catch {
            /* best effort */
          }
        }
        continue;
      }
      // pending : si l'echeance est desormais a l'agenda (ajout externe), la
      // proposition n'a plus lieu d'etre -> on la retire.
      if (await findExistingAgendaEvent(userId, itemId, p)) {
        try {
          await deleteSuggestion(existing.id);
        } catch {
          /* best effort */
        }
        continue;
      }
      // pending : maj des infos si elles ont change (sans recompter comme neuf).
      if (startChanged || existing.title !== p.title || existing.all_day !== p.allDay) {
        await updateSuggestion(existing.id, {
          title: p.title,
          label: p.label,
          fiche_title: ficheTitle,
          start: p.start.toISOString(),
          end: p.end.toISOString(),
          all_day: p.allDay,
        });
      }
    } catch (err) {
      console.warn("[tracking-cal] propose failed:", (err as Error).message);
    }
  }
  return created;
}

/**
 * Retire les propositions EN ATTENTE qui correspondent a un event DEJA present
 * dans l'agenda (ajout externe, doublon Google/ICS/manuel...). Aucun appel LLM
 * (simple comparaison DB). Retourne le nombre de propositions supprimees.
 * Appele au demarrage de l'analyse a la demande pour auto-nettoyer le flux.
 */
export async function prunePendingSuggestionsAlreadyInAgenda(
  userId: string
): Promise<number> {
  let pending: PBCalendarSuggestion[];
  try {
    pending = await listPendingSuggestionsForUser(userId);
  } catch {
    return 0;
  }
  let removed = 0;
  const ficheClosed = new Map<string, boolean>(); // cache statut fiche par item
  for (const s of pending) {
    const start = new Date(s.start);
    if (isNaN(start.getTime())) continue;
    try {
      // Fiche cloturee/archivee : la proposition d'echeance n'a plus lieu d'etre
      // (l'analyse ne traite que les fiches ouvertes -> sinon elle resterait la
      // indefiniment). On la retire.
      let closed = ficheClosed.get(s.item);
      if (closed === undefined) {
        const it = await getTrackingItem(s.item);
        closed = !it || it.archived || !ficheIsOpen(it);
        ficheClosed.set(s.item, closed);
      }
      if (closed) {
        await deleteSuggestion(s.id);
        removed++;
        continue;
      }
      const match = await findExistingAgendaEvent(userId, s.item, {
        uid: s.dedup_key,
        kind: s.kind,
        start,
        title: s.title,
        label: s.label,
        allDay: !!s.all_day,
      });
      if (match) {
        await deleteSuggestion(s.id);
        removed++;
      }
    } catch {
      /* best effort, on continue */
    }
  }
  return removed;
}

/**
 * Accepte une proposition -> cree l'event dans l'agenda (groupe "Suivi", source
 * local, dedup par `ics_uid` = dedup_key). Idempotent : si l'event existe deja
 * (re-clic), on le reutilise. Marque la proposition `accepted`.
 */
export async function acceptSuggestion(suggestionId: string): Promise<PBCalendarSuggestion | null> {
  const s = await getSuggestion(suggestionId);
  if (!s) return null;
  if (s.status === "accepted" && s.event) return s;
  const allDay = !!s.all_day;
  const end =
    s.end || new Date(new Date(s.start).getTime() + (allDay ? 86400_000 : 3600_000)).toISOString();
  let eventId = "";
  try {
    const existing = await findCalendarEventByIcsUid(s.user, s.dedup_key);
    if (existing) {
      eventId = existing.id;
    } else {
      const group = await ensureTrackingGroup(s.user);
      const ev = await createCalendarEvent({
        user: s.user,
        group: group.id,
        title: s.title,
        description: s.fiche_title ? `Suivi · ${s.fiche_title}` : "Suivi",
        location: "",
        start: s.start,
        end,
        all_day: allDay,
        source: "local",
        ics_uid: s.dedup_key,
        status: "confirmed",
      });
      eventId = ev.id;
      await pushEventQuietly(ev);
    }
  } catch (err) {
    console.warn("[tracking-cal] accept create failed:", (err as Error).message);
    throw err;
  }
  return await updateSuggestion(s.id, { status: "accepted", event: eventId });
}

/** Refuse une proposition (n'ajoute rien a l'agenda ; le refus est memorise). */
export async function refuseSuggestion(suggestionId: string): Promise<PBCalendarSuggestion | null> {
  const s = await getSuggestion(suggestionId);
  if (!s) return null;
  return await updateSuggestion(s.id, { status: "refused" });
}

/**
 * Cree ou met a jour la fiche de suivi d'une CONVERSATION (thread), et
 * (re)construit sa timeline a partir de tous les messages du fil. Idempotent :
 * un message ne genere qu'un evenement (UNIQUE(item, message)).
 */
/** Issue d'un suivi : fiche creee ou rafraichie, et nombre de fils anciens
 * rattaches par la collecte (annonce au front apres "Suivre"). */
export interface TrackConversationResult {
  itemId: string;
  created: boolean;
  gathered: number;
}

/**
 * Extraction LLM vide sur une fiche EXISTANTE : persiste quand meme les messages
 * du fil dans la timeline (evenement minimal : auteur + extrait), sans toucher
 * titre / champs / statut. createTrackingEvent (pas upsert) : un evenement deja
 * synthetise n'est jamais ecrase, UNIQUE(item, message) dedoublonne, et un
 * rebuild ulterieur enrichit ces evenements par upsert.
 */
export async function persistThreadWithoutLlm(
  userId: string,
  item: PBTrackingItem,
  threadId: string,
  messages: PBMessageForThread[]
): Promise<number> {
  if (messages.length === 0) return 0;
  const last = messages[messages.length - 1];
  const threadSet = new Set<string>(Array.isArray(item.thread_ids) ? item.thread_ids : []);
  if (item.thread_id) threadSet.add(item.thread_id);
  if (threadId) threadSet.add(threadId);
  let written = 0;
  for (const m of messages.slice(-MAX_MSGS)) {
    const author = m.is_sent ? "" : m.from_address?.name || m.from_address?.address || "?";
    try {
      await createTrackingEvent({
        user: userId,
        item: item.id,
        message: m.id,
        date: m.date,
        kind: "update",
        author,
        label: "",
        detail: stripForFallback(m.text_body || m.snippet || ""),
        changed_fields: {},
      });
      written++;
    } catch {
      // UNIQUE(item, message) -> evenement deja present (idempotence)
    }
  }
  const newer = !item.last_message_date || last.date >= item.last_message_date;
  const n = await countTrackingEvents(item.id).catch(() => 0);
  try {
    await updateTrackingItem(item.id, {
      thread_ids: Array.from(threadSet),
      ...(newer ? { last_message_id: last.id, last_message_date: last.date } : {}),
      ...(n > 0 ? { event_count: n } : {}),
      archived: false,
      // Un envoi de l'utilisateur n'est pas une nouveaute a signaler.
      ...(written > 0 && !last.is_sent ? { is_read: false } : {}),
    });
  } catch (err) {
    console.warn(`[tracking] fallback persist failed ${item.id}:`, (err as Error).message);
  }
  console.warn(
    `[tracking] FALLBACK ${item.id} thread=${threadId} : ${written} evenement(s) sans LLM`
  );
  return written;
}

export async function trackConversation(
  userId: string,
  accountId: string,
  threadId: string,
  seedMessageId: string,
  opts: {
    apiKey?: string;
    attachOnly?: boolean;
    respectFollowUp?: boolean;
    /** Apres creation d'une fiche, va chercher les fils LIES deja presents dans
     * la boite (paiement, expedition, livraison...) -> timeline complete. */
    gather?: boolean;
    /** Reconstruction : ECRASE le titre et les syntheses d'etapes existants avec
     * la nouvelle extraction (sinon on garde l'ancien titre). */
    forceTitle?: boolean;
    /** Chemin LIVE (nouveau mail entrant) : autorise le push "changement de
     * statut". Toujours false en backfill/rebuild/gather pour eviter une rafale
     * de notifications. */
    notify?: boolean;
  } = {}
): Promise<TrackConversationResult | null> {
  const apiKey =
    opts.apiKey || (await getUserOpenRouterKey(userId)) || serverOpenRouterKey() || "";
  if (!apiKey) {
    console.warn(`[tracking] FAIL ${seedMessageId} : pas de cle OpenRouter`);
    return null;
  }

  let messages = threadId ? await listMessagesByThread(threadId) : [];
  if (messages.length === 0) {
    // Fallback : message isole (pas de thread_id exploitable).
    try {
      const m = await getMessage(seedMessageId);
      messages = [
        {
          id: m.id,
          subject: m.subject || "",
          snippet: m.snippet || "",
          text_body: m.text_body || "",
          html_body: m.html_body || "",
          from_address: m.from_address || { address: "" },
          is_sent: !!m.is_sent,
          has_attachments: !!m.has_attachments,
          date: m.date,
          account: m.account,
        },
      ];
    } catch (err) {
      console.warn(`[tracking] message introuvable ${seedMessageId}:`, (err as Error).message);
      return null;
    }
  }

  messages = dedupMessages(messages);

  const inbound = messages.find((m) => !m.is_sent) || messages[0];
  const party = counterpartOf(messages);
  const fromName = party.name;
  const domain = party.domain;
  const last = messages[messages.length - 1];

  // UNE fiche = UNE conversation (thread). Pas de regroupement cross-thread :
  // ca melangeait des sujets sans rapport. Si la conversation a deja une fiche
  // -> refresh, sinon -> nouvelle fiche.
  const existing = await findAnyTrackingItemByThread(userId, threadId);

  // Une extraction vide est souvent TRANSITOIRE (reponse vide / JSON invalide) :
  // UN seul nouvel essai (plafond de depense IA, jamais de boucle).
  let extraction = await extractFiche(messages, [], apiKey);
  if (!extraction) extraction = await extractFiche(messages, [], apiKey);
  if (!extraction) {
    console.warn(`[tracking] EMPTY thread=${threadId || seedMessageId} : extraction LLM vide`);
    // Fiche EXISTANTE : le nouveau message doit quand meme entrer dans la
    // timeline (cas reel : reponse envoyee depuis l'app jamais visible avant un
    // "Reconstruire"). Evenement minimal sans LLM, titre/champs/statut intacts.
    if (existing) {
      await persistThreadWithoutLlm(userId, existing, threadId, messages);
      return { itemId: existing.id, created: false, gathered: 0 };
    }
    return null;
  }

  const imageId = await findImageInThread(messages);
  const cleanedTitle = cleanTitle(extraction.title, extraction.type);

  const target = existing;
  let itemId: string;
  let isMerge = false;
  let createdItem: PBTrackingItem | null = null;
  let finalTitle = "";

  if (target) {
    isMerge = !existing; // rattachement d'un NOUVEAU thread a une fiche existante
    // Statut AVANT mise a jour (l'objet local n'est pas muté par l'update) :
    // sert a detecter un VRAI changement de statut pour le push dedie.
    const oldStatusLabel = target.status_label || "";
    const oldFields =
      target.fields && typeof target.fields === "object" ? target.fields : {};
    const mergedFields = { ...oldFields, ...extraction.fields };
    // Union des threads rattaches a la fiche.
    const threadSet = new Set<string>(
      Array.isArray(target.thread_ids) ? target.thread_ids : []
    );
    if (target.thread_id) threadSet.add(target.thread_id);
    if (threadId) threadSet.add(threadId);
    // last_message = le plus recent entre la fiche et ce thread.
    const newer = !target.last_message_date || last.date >= target.last_message_date;
    try {
      finalTitle = opts.forceTitle
        ? cleanedTitle || target.title
        : target.title || cleanedTitle;
      await updateTrackingItem(target.id, {
        type: target.type || extraction.type || "suivi",
        title: finalTitle,
        status:
          target.status === "done" || target.status === "cancelled" ? "active" : target.status,
        closure_suggested: extraction.closure_suggested,
        status_label: extraction.status_label || target.status_label,
        context_summary:
          extraction.context_summary && extraction.context_summary.length > 15
            ? extraction.context_summary
            : buildContextSummary(finalTitle, target.merchant || fromName || domain, mergedFields),
        fields: mergedFields,
        thread_ids: Array.from(threadSet),
        ...(imageId && !target.image_attachment ? { image_attachment: imageId } : {}),
        merchant: target.merchant || fromName || domain,
        sender_domain: target.sender_domain || domain,
        ...(newer ? { last_message_id: last.id, last_message_date: last.date } : {}),
        archived: false,
        is_read: false,
      });
      // Push "changement de statut" : DISTINCT d'un push e-mail (cloche + libelle
      // "Suivi"). Uniquement en LIVE (opts.notify), quand le DERNIER message est
      // entrant (pas une reponse de l'utilisateur) et que le libelle de statut a
      // REELLEMENT change. Gratuit (aucun appel LLM supplementaire). Non bloquant.
      const newStatusLabel = (extraction.status_label || "").trim();
      if (
        opts.notify === true &&
        !last.is_sent &&
        newStatusLabel.length > 0 &&
        normStatus(newStatusLabel) !== normStatus(oldStatusLabel)
      ) {
        const pushTitle = opts.forceTitle
          ? cleanedTitle || target.title
          : target.title || cleanedTitle;
        void (async () => {
          try {
            // Journal d'activite (independant du push), puis push si active.
            await logTrackingStatusActivity({
              userId,
              itemId: target.id,
              title: pushTitle,
              statusLabel: newStatusLabel,
              date: last.date,
            });
            if (await getUserNotificationsEnabled(userId)) {
              await sendTrackingStatusNotification(userId, target.id, pushTitle, newStatusLabel);
            }
          } catch (err) {
            console.error("[tracking] status push error:", (err as Error).message);
          }
        })();
      }
    } catch (err) {
      console.warn(`[tracking] update item failed ${target.id}:`, (err as Error).message);
      return null;
    }
    itemId = target.id;
  } else if (opts.attachOnly) {
    // Mode rattachement seul : aucun suivi existant ne correspond -> on ne cree pas.
    return null;
  } else if (opts.respectFollowUp && !extraction.follow_up) {
    // Mode auto-detection : on ne cree une fiche que si ca merite un suivi.
    return null;
  } else {
    finalTitle = cleanedTitle || inbound.subject || "(sans sujet)";
    try {
      const item = await createTrackingItem({
        user: userId,
        account: accountId,
        type: extraction.type || "suivi",
        title: finalTitle,
        status: "active",
        closure_suggested: extraction.closure_suggested,
        status_label: extraction.status_label,
        context_summary:
          extraction.context_summary && extraction.context_summary.length > 15
            ? extraction.context_summary
            : buildContextSummary(finalTitle, fromName || domain, extraction.fields),
        fields: extraction.fields,
        ...(imageId ? { image_attachment: imageId } : {}),
        merchant: fromName || domain,
        sender_domain: domain,
        thread_id: threadId || "",
        thread_ids: threadId ? [threadId] : [],
        first_message: messages[0].id,
        last_message_id: last.id,
        last_message_date: last.date,
        event_count: messages.length,
        pinned: false,
        archived: false,
        is_read: false,
      });
      itemId = item.id;
      createdItem = item;
      // Journal d'activite : nouvelle fiche de suivi. Best effort, non bloquant.
      void logTrackingNewActivity({
        userId,
        accountId,
        itemId: item.id,
        title: finalTitle,
        type: extraction.type,
        threadId: threadId || undefined,
        date: last.date,
      }).catch((err) =>
        console.warn("[activity] tracking new log failed:", (err as Error).message)
      );
    } catch (err) {
      console.warn(`[tracking] create item failed thread=${threadId}:`, (err as Error).message);
      return null;
    }
  }

  // Timeline : un evenement par message de CE fil, avec la SYNTHESE produite par
  // le LLM (label + summary). On indexe sur le meme decoupage que le prompt
  // (les MAX_MSGS derniers messages). Idempotent (UNIQUE(item, message)).
  const slice = messages.slice(-MAX_MSGS);
  const stepByIndex = new Map<number, StepSynthesis>();
  for (const s of extraction.steps) stepByIndex.set(s.i, s);
  const isFirstOfFiche = !target; // 1er message d'une fiche neuve -> "created"
  // En reconstruction (forceTitle), on MET A JOUR les syntheses existantes
  // (nouveau ton ludique) au lieu de les laisser telles quelles. Sinon, create
  // idempotent classique.
  const writeEvent = opts.forceTitle ? upsertTrackingEvent : createTrackingEvent;
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const author = m.is_sent ? "" : m.from_address?.name || m.from_address?.address || "?";
    const step = stepByIndex.get(i);
    const summary = (step?.summary || "").trim() || stripForFallback(m.text_body || m.snippet || "");
    try {
      await writeEvent({
        user: userId,
        item: itemId,
        message: m.id,
        date: m.date,
        kind: isFirstOfFiche && i === 0 ? "created" : "update",
        author,
        label: step?.label || "",
        detail: summary,
        changed_fields: {},
      });
    } catch {
      // UNIQUE(item, message) -> evenement deja present (idempotence)
    }
  }

  // Rattachement RETROACTIF des fils LIES (paiement, expedition, livraison,
  // facture...) a la CREATION d'une fiche via l'etoile -> timeline complete.
  // Borne (GATHER_MAX_THREADS) et gratuit pour DECIDER. Respecte la pause user.
  let gathered = 0;
  if (createdItem && opts.gather) {
    let paused = false;
    try {
      paused = (await getUserPauseFlags(userId)).tracking_paused;
    } catch {
      /* ignore */
    }
    if (!paused) {
      try {
        gathered = await gatherRelatedThreads(userId, createdItem, apiKey);
      } catch (err) {
        console.warn("[tracking] gather error:", (err as Error).message);
      }
    }
  }

  // event_count exact apres merge/refresh OU apres rattachement de fils lies.
  if (target || gathered > 0) {
    const n = await countTrackingEvents(itemId);
    if (n > 0) {
      try {
        await updateTrackingItem(itemId, { event_count: n });
      } catch {
        /* best effort */
      }
    }
  }
  // Echeances/livraisons/RDV detectees -> PROPOSITIONS d'agenda (pending). Jamais
  // d'ajout automatique. En LIVE (opts.notify), une notif "a ajouter" si du neuf.
  try {
    const newProposals = await proposeTrackingDates(userId, itemId, finalTitle, extraction.dates);
    if (newProposals > 0 && opts.notify === true) {
      const sample = prepareDates(itemId, finalTitle, extraction.dates)[0]?.title || "";
      // Journal d'activite : echeance(s) detectee(s), en attente d'ajout agenda.
      void logCalendarSuggestionActivity({
        userId,
        itemId,
        count: newProposals,
        sample,
        ficheTitle: finalTitle,
      }).catch((err) =>
        console.warn("[activity] suggestion log failed:", (err as Error).message)
      );
      void (async () => {
        try {
          if (await getUserNotificationsEnabled(userId)) {
            await sendCalendarSuggestionNotification(userId, newProposals, sample);
          }
        } catch (err) {
          console.error("[tracking] suggestion push error:", (err as Error).message);
        }
      })();
    }
  } catch (err) {
    console.warn("[tracking] calendar propose error:", (err as Error).message);
  }

  console.log(
    `[tracking] ${isMerge ? "MERGE" : target ? "REFRESH" : "NEW"} ${itemId} thread=${threadId} (${messages.length} msg${gathered > 0 ? `, +${gathered} lie(s)` : ""}) "${cleanedTitle.slice(0, 50)}"`
  );
  return { itemId, created: !!createdItem, gathered };
}

/** Ajoute la CONVERSATION d'un message au suivi (resout le thread). */
export async function trackConversationFromMessage(
  messageId: string,
  opts: { gather?: boolean } = {}
): Promise<TrackConversationResult | null> {
  let msg;
  let acc;
  try {
    msg = await getMessage(messageId);
    acc = await getAccount(msg.account);
  } catch (err) {
    console.warn(`[tracking] message/compte introuvable ${messageId}:`, (err as Error).message);
    return null;
  }
  return trackConversation(acc.user, msg.account, msg.thread_id || "", msg.id, {
    gather: opts.gather,
  });
}

/** Etoile posee sur un mail -> suivre sa conversation ET rattacher les fils
 * lies deja presents (paiement, expedition, livraison...) pour une timeline
 * complete. */
export async function trackStarredMessage(messageId: string): Promise<void> {
  await trackConversationFromMessage(messageId, { gather: true });
}

/**
 * Etoile retiree -> ARCHIVE la (les) fiche(s) de la conversation. Best effort.
 */
export async function untrackStarredMessage(messageId: string): Promise<void> {
  let msg;
  let acc;
  try {
    msg = await getMessage(messageId);
    acc = await getAccount(msg.account);
  } catch {
    return;
  }
  if (!msg.thread_id) return;
  const items = await findTrackingItemsByThread(acc.user, msg.thread_id);
  for (const it of items) {
    try {
      await updateTrackingItem(it.id, { archived: true });
      // Retire aussi ses echeances/livraisons de l'agenda (groupe "Suivi") et
      // ses propositions encore en attente.
      try {
        const removed = await deleteTrackingEventsEverywhere(acc.user, it.id);
        if (removed > 0) console.log(`[tracking] ${removed} event(s) agenda retire(s) (${it.id})`);
        await deletePendingSuggestionsForItem(it.id);
      } catch {
        /* best effort */
      }
      console.log(`[tracking] ARCHIVE ${it.id} (etoile retiree sur ${messageId})`);
    } catch (err) {
      console.warn(`[tracking] archive failed ${it.id}:`, (err as Error).message);
    }
  }
}

export async function purgeTracking(userId: string): Promise<number> {
  const n = await purgeTrackingItems(userId);
  console.log(`[tracking] purge user=${userId} -> ${n} fiches supprimees`);
  return n;
}

// --- Rattachement d'un thread a une fiche existante (cross-thread) ---

/**
 * Re-synthetise TOUTE la fiche en UN SEUL appel LLM sur l'ENSEMBLE de ses
 * messages (tous les fils rattaches, tries par date). C'est ce qui garantit :
 *  - un TITRE coherent "Produit - Entreprise" (le LLM voit le produit, meme s'il
 *    n'est que dans le mail d'expedition et pas dans celui de paiement) ;
 *  - des CHAMPS coherents (plus de melange entre affaires) ;
 *  - une timeline LUDIQUE et LOGIQUE (le LLM voit toute la progression d'un coup).
 * Non destructif : upsert des evenements (aucune perte si l'appel echoue).
 */
async function resynthesizeWholeFiche(
  userId: string,
  item: PBTrackingItem,
  apiKey: string,
  opts: { clean?: boolean; fallbackThreadId?: string; markUnread?: boolean } = {}
): Promise<void> {
  const threadIds = new Set<string>();
  if (item.thread_id) threadIds.add(item.thread_id);
  for (const t of Array.isArray(item.thread_ids) ? item.thread_ids : []) {
    if (t) threadIds.add(t);
  }
  if (threadIds.size === 0) return;

  let messages: PBMessageForThread[] = [];
  for (const tid of threadIds) {
    try {
      messages.push(...(await listMessagesByThread(tid)));
    } catch {
      /* ignore */
    }
  }
  if (messages.length === 0) return;
  messages = dedupMessages(messages).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );

  const last = messages[messages.length - 1];
  const extraction = await extractFiche(messages, [], apiKey);
  if (!extraction) {
    // Echec d'extraction LLM. Souvent TRANSITOIRE et parfois SILENCIEUX (reponse
    // vide / JSON invalide). Avant, on retournait sans RIEN ecrire : un
    // rattachement live (attachThreadToFollowup) etait alors PERDU (le fil
    // n'etait jamais ajoute a thread_ids, aucun event cree, et rien ne re-tentait
    // -> le mail n'apparaissait JAMAIS dans la fiche). On PERSISTE desormais au
    // minimum l'appartenance des fils + le dernier message ; la narration riche
    // (titre/champs/timeline) sera enrichie au prochain resynth reussi.
    try {
      await updateTrackingItem(item.id, {
        thread_ids: Array.from(threadIds),
        last_message_id: last.id,
        last_message_date: last.date,
        archived: false,
        // Rattachement live -> la fiche a du neuf : repasse en NON LU (la timeline
        // riche viendra au prochain resynth, mais l'utilisateur voit deja le badge).
        ...(opts.markUnread ? { is_read: false } : {}),
      });
    } catch (err) {
      console.warn(
        `[tracking] resynth membership persist failed ${item.id}:`,
        (err as Error).message
      );
      return;
    }
    // Fil tout juste rattache (live) : evenement MINIMAL (sans LLM) pour CHAQUE
    // message de CE fil, afin que le nouveau mail soit VISIBLE dans la timeline
    // meme LLM indispo. Borne a ce fil -> n'ecrase jamais les events deja
    // synthetises des autres fils (upsert par message).
    if (opts.fallbackThreadId) {
      let fbMsgs: PBMessageForThread[] = [];
      try {
        fbMsgs = await listMessagesByThread(opts.fallbackThreadId);
      } catch {
        /* ignore */
      }
      for (const m of fbMsgs) {
        const author = m.is_sent
          ? ""
          : m.from_address?.name || m.from_address?.address || "?";
        try {
          await upsertTrackingEvent({
            user: userId,
            item: item.id,
            message: m.id,
            date: m.date,
            kind: "update",
            author,
            label: "",
            detail: stripForFallback(m.text_body || m.snippet || ""),
            changed_fields: {},
          });
        } catch {
          /* idempotence */
        }
      }
      const n = await countTrackingEvents(item.id).catch(() => 0);
      if (n > 0) {
        try {
          await updateTrackingItem(item.id, { event_count: n });
        } catch {
          /* best effort */
        }
      }
    }
    console.warn(
      `[tracking] resynth LLM null ${item.id} -> membership persisted${
        opts.fallbackThreadId ? " + fallback timeline" : ""
      } (enrichment deferred)`
    );
    return;
  }

  const party = counterpartOf(messages);
  const fromName = party.name;
  const domain = party.domain;
  const cleanedTitle = cleanTitle(extraction.title, extraction.type);
  // Mode "clean" (ré-ancrage) : on REPART des champs ré-extraits, on ne fusionne
  // PAS les anciens (qui contenaient les valeurs d'affaires distinctes mélangées).
  const oldFields =
    opts.clean ? {} : item.fields && typeof item.fields === "object" ? item.fields : {};
  const imageId = await findImageInThread(messages);

  try {
    await updateTrackingItem(item.id, {
      type: extraction.type || item.type || "suivi",
      title: cleanedTitle || item.title,
      status_label: extraction.status_label || item.status_label,
      context_summary:
        extraction.context_summary && extraction.context_summary.length > 15
          ? extraction.context_summary
          : buildContextSummary(
              cleanedTitle || item.title,
              item.merchant || fromName || domain,
              { ...oldFields, ...extraction.fields }
            ),
      closure_suggested: extraction.closure_suggested,
      fields: { ...oldFields, ...extraction.fields },
      thread_ids: Array.from(threadIds),
      ...(imageId && !item.image_attachment ? { image_attachment: imageId } : {}),
      merchant: item.merchant || fromName || domain,
      sender_domain: item.sender_domain || domain,
      last_message_id: last.id,
      last_message_date: last.date,
      archived: false,
      // Rattachement live (mail entrant lie) -> la fiche change : NON LU. Les
      // reconstructions de masse (gather/rebuild) ne passent PAS markUnread, donc
      // pas de "tempete" de fiches non lues sur une passe large.
      ...(opts.markUnread ? { is_read: false } : {}),
    });
  } catch (err) {
    console.warn(`[tracking] resynth update failed ${item.id}:`, (err as Error).message);
    return;
  }

  // Mode "clean" : on purge la timeline AVANT de la reconstruire (sinon les
  // evenements des fils detaches resteraient orphelins). Fait APRES une
  // extraction LLM reussie -> jamais de fiche videe sur echec LLM.
  if (opts.clean) {
    try {
      await deleteTrackingEventsForItem(item.id);
    } catch (err) {
      console.warn(`[tracking] clean wipe events failed ${item.id}:`, (err as Error).message);
    }
  }

  const slice = messages.slice(-MAX_MSGS);
  const stepByIndex = new Map<number, StepSynthesis>();
  for (const s of extraction.steps) stepByIndex.set(s.i, s);
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const author = m.is_sent ? "" : m.from_address?.name || m.from_address?.address || "?";
    const step = stepByIndex.get(i);
    const summary = (step?.summary || "").trim() || stripForFallback(m.text_body || m.snippet || "");
    try {
      await upsertTrackingEvent({
        user: userId,
        item: item.id,
        message: m.id,
        date: m.date,
        kind: i === 0 ? "created" : "update",
        author,
        label: step?.label || "",
        detail: summary,
        changed_fields: {},
      });
    } catch {
      /* idempotence */
    }
  }

  const n = await countTrackingEvents(item.id);
  if (n > 0) {
    try {
      await updateTrackingItem(item.id, { event_count: n });
    } catch {
      /* best effort */
    }
  }

  // Echeances/livraisons/RDV (vue sur TOUS les fils) -> propositions (pending).
  try {
    await proposeTrackingDates(userId, item.id, cleanedTitle || item.title, extraction.dates);
  } catch (err) {
    console.warn("[tracking] calendar propose error:", (err as Error).message);
  }
}

/** Rattache un thread a une fiche EXISTANTE puis re-synthetise toute la fiche
 * (titre + timeline coherents). 1 seul appel LLM. */
async function attachThreadToFollowup(
  userId: string,
  target: PBTrackingItem,
  threadId: string,
  _seedMessageId: string,
  apiKey: string
): Promise<void> {
  const threads = new Set<string>(Array.isArray(target.thread_ids) ? target.thread_ids : []);
  if (target.thread_id) threads.add(target.thread_id);
  if (threadId) threads.add(threadId);
  target.thread_ids = Array.from(threads);
  await resynthesizeWholeFiche(userId, target, apiKey, {
    fallbackThreadId: threadId,
    markUnread: true,
  });
  console.log(`[tracking] ATTACH ${target.id} <- thread=${threadId} (resynth)`);
}

/**
 * Rattachement MANUEL : l'utilisateur choisit explicitement une fiche EXISTANTE
 * et y ajoute un (ou plusieurs) mail(s) selectionne(s). On collecte les threads
 * des messages (dedup, garde-fou d'appartenance au meme utilisateur que la
 * fiche), on les ajoute a `thread_ids` puis on re-synthetise TOUTE la fiche en
 * UN SEUL appel LLM (titre + timeline coherents), quel que soit le nombre de
 * mails passes. Distinct de "Suivre" (qui cree une fiche) : ici la cible existe.
 */
export async function attachMessagesToTrackingItem(
  messageIds: string[],
  itemId: string
): Promise<void> {
  const item = await getTrackingItem(itemId);
  if (!item) throw new Error("fiche introuvable");

  const newThreads = new Set<string>();
  let seed = "";
  for (const mid of messageIds) {
    try {
      const msg = await getMessage(mid);
      const acc = await getAccount(msg.account);
      if (acc.user !== item.user) continue; // fiche d'un autre utilisateur : on ignore
      if (msg.thread_id) {
        newThreads.add(msg.thread_id);
        if (!seed) seed = msg.id;
      }
    } catch {
      /* message introuvable : on ignore et on continue */
    }
  }
  if (newThreads.size === 0) throw new Error("aucun thread valide a rattacher");

  const apiKey =
    (await getUserOpenRouterKey(item.user)) || serverOpenRouterKey() || "";
  if (!apiKey) throw new Error("pas de cle OpenRouter");

  const threads = new Set<string>(Array.isArray(item.thread_ids) ? item.thread_ids : []);
  if (item.thread_id) threads.add(item.thread_id);
  for (const t of newThreads) threads.add(t);
  item.thread_ids = Array.from(threads);

  await resynthesizeWholeFiche(item.user, item, apiKey, {
    fallbackThreadId: Array.from(newThreads)[0],
    markUnread: true,
  });
  console.log(
    `[tracking] ATTACH-MANUAL ${item.id} <- ${newThreads.size} thread(s) (resynth)`
  );
}

// Seuil de similarite vectorielle pour rattacher un mail a un suivi existant.
const ATTACH_THRESHOLD = 0.6;

/** Cherche, via le vecteur LOCAL (gratuit) du mail, un suivi ouvert dont un
 * message est tres proche semantiquement. Retourne la fiche ou null. Aucun
 * appel OpenRouter. */
async function findMatchingFollowup(
  userId: string,
  messageId: string,
  excludeThreadId?: string
): Promise<PBTrackingItem | null> {
  let msg;
  try {
    msg = await getMessage(messageId);
  } catch {
    return null;
  }
  const query = `${msg.subject || ""} ${msg.snippet || htmlToPlain(msg.text_body || "").slice(0, 400)}`.trim();
  if (!query) return null;
  let hits: { message: string; score: number }[] = [];
  try {
    hits = await searchEmbeddings({ userId, query, limit: 8 });
  } catch {
    return null;
  }
  for (const h of hits) {
    if (h.score < ATTACH_THRESHOLD) break;
    if (h.message === messageId) continue;
    let hm;
    try {
      hm = await getMessage(h.message);
    } catch {
      continue;
    }
    if (!hm.thread_id || hm.thread_id === excludeThreadId) continue;
    const fu = await findTrackingItemsByThread(userId, hm.thread_id);
    if (fu.length > 0) return fu[0];
  }
  return null;
}

// --- Rattachement RETROACTIF des fils lies a une fiche (gather) ---
//
// Quand on suit une affaire (commande, retour, dossier...), ses etapes sont
// presque toujours dans des fils SEPARES (confirmation marchand, paiement
// PayPal/Stripe, expedition, suivi transporteur, livraison, facture...). Pour
// une timeline complete, on va chercher ces fils DEJA PRESENTS dans la boite.
// La DECISION de rattacher est GRATUITE et PRECISE : on relie uniquement les
// fils qui partagent un VRAI numero d'affaire (commande/suivi/facture/
// transaction) deja extrait par l'IA -> recherche FTS5 du numero. PAS de
// rapprochement semantique flou (les embeddings 0.55 ramenaient du bruit :
// newsletters, inventaires, autres commandes). Gemini n'est appele QUE pour
// SYNTHETISER chaque fil retenu (plafonne).

// Cles de champs qui portent en general un identifiant precis et PARTAGE entre
// les mails d'une meme affaire.
const ID_FIELD_RE =
  /(reference|ref|commande|order|numero|num|tracking|suivi|colis|facture|invoice|dossier|reservation|booking|contrat|transaction|paiement|payment)/i;

/** Tokens "identifiants" (numeros de commande/suivi/facture...) extraits des
 * champs et du titre d'une fiche. On exige des tokens TRES specifiques (au moins
 * un chiffre, longueur >= 7, ni montant ni date) : seul un VRAI numero partage
 * (commande, colis, transaction) doit servir a relier deux fils, sinon on melange
 * des affaires sans rapport. */
function extractIdentifierTokens(item: PBTrackingItem): string[] {
  const out = new Set<string>();
  const consider = (raw: string) => {
    if (!raw) return;
    const matches = raw.match(/[A-Za-z0-9][A-Za-z0-9\-_/#.]{5,}/g) || [];
    for (const tok of matches) {
      const t = tok.replace(/[.#/_-]+$/, "").trim();
      if (t.length < 7 || t.length > 40) continue; // un numero d'affaire est long
      if (!/\d/.test(t)) continue; // doit contenir un chiffre
      if (/^\d{1,4}([.,]\d{1,2})?$/.test(t)) continue; // montant pur -> ambigu
      if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(t)) continue; // date pure -> ambigu
      out.add(t);
      if (out.size >= 6) break;
    }
  };
  const fields = item.fields && typeof item.fields === "object" ? item.fields : {};
  for (const [k, v] of Object.entries(fields)) {
    if (ID_FIELD_RE.test(k)) consider(String(v));
  }
  consider(item.title || ""); // le titre contient souvent la reference ("Amazon #123-456")
  return Array.from(out).slice(0, 6);
}

// Fenetre de RECENCE du rattachement. Une affaire (commande, livraison, retour,
// remboursement, RDV...) se joue sur quelques semaines/mois, JAMAIS sur plusieurs
// annees. On REFUSE donc de rattacher un fil dont les messages sont trop loin,
// dans le temps, des messages deja dans la fiche : un email du MEME marchand
// vieux de 6 ans = une AUTRE affaire (autre commande, autre adresse), pas le meme
// suivi. C'est ce qui empeche d'aspirer automatiquement des donnees perimees.
// La fenetre est RELATIVE aux dates de la fiche (pas "recent dans l'absolu") :
// suivre une vieille affaire reste possible, on refuse juste de melanger deux
// affaires temporellement disjointes. Configurable via env.
const GATHER_WINDOW_DAYS = Number(process.env.TRACKING_GATHER_WINDOW_DAYS) || 180;
const GATHER_WINDOW_MS = GATHER_WINDOW_DAYS * 86400_000;

type DateSpan = { min: number; max: number };

/** Etendue [min, max] (ms epoch) des dates des messages des fils donnes.
 * Sert d'ancre a la fenetre de recence. null si aucune date exploitable. */
async function computeThreadsDateSpan(threadIds: Iterable<string>): Promise<DateSpan | null> {
  let min = Infinity;
  let max = -Infinity;
  for (const tid of threadIds) {
    if (!tid) continue;
    let ms: PBMessageForThread[] = [];
    try {
      ms = await listMessagesByThread(tid);
    } catch {
      continue;
    }
    for (const m of ms) {
      const t = Date.parse(m.date);
      if (Number.isNaN(t)) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  return min === Infinity ? null : { min, max };
}

/** Le mail (par sa date) est-il dans la fenetre de recence de la fiche ?
 * Pas d'ancre (span null) ou date illisible -> on ne bloque pas (prudent). */
function dateWithinSpanWindow(dateStr: string | undefined, span: DateSpan | null): boolean {
  if (!span) return true;
  const t = Date.parse(dateStr || "");
  if (Number.isNaN(t)) return true;
  return t >= span.min - GATHER_WINDOW_MS && t <= span.max + GATHER_WINDOW_MS;
}

// Plafond de fils rattaches PAR fiche par NUMERO (signal sur, gratuit).
const GATHER_MAX_THREADS = 6;
// Plafond de fils candidats PAR SUJET a faire confirmer par l'IA (borne le cout).
const SUBJECT_MAX_CANDIDATES = 10;
// Sous-plafonds par SOURCE (cumulatifs) : les tokens FTS ne prennent pas plus de
// SUBJECT_TOKEN_CAP slots, laissant de la place a la semantique (b) puis au
// signal "meme domaine expediteur" (c). Empeche qu'une source noie les autres.
const SUBJECT_TOKEN_CAP = 6;
const SUBJECT_EMB_CAP = 8;
// Seuil cosinus pour qu'un mail soit CANDIDAT au sujet (permissif : l'IA tranche).
const SUBJECT_EMB_THRESHOLD = 0.4;
// Fenetre SERREE (autour des dates de la fiche) pour la source "meme domaine
// expediteur" : les mails FRERES operationnels (RDV, activation, expedition,
// retour) se groupent autour de la commande. Serree pour NE PAS aspirer les
// factures mensuelles recurrentes du meme marchand (l'IA les rejetterait, mais
// autant ne pas payer la confirmation). En jours.
const DOMAIN_SIBLING_WINDOW_DAYS = 45;
const DOMAIN_SIBLING_WINDOW_MS = DOMAIN_SIBLING_WINDOW_DAYS * 86400_000;
// Source "meme correspondant" (adresse NOMINATIVE exacte) : echanges PRECEDENTS
// avec la meme personne, dans un fil separe. Fenetre ARRIERE large (celle de la
// recence, 180 j par defaut) mais serree apres la fiche ; sous-plafond propre
// (chaque candidat coute une confirmation IA).
const COUNTERPART_MAX_CANDIDATES = 4;

/** Adresse exploitable comme "meme personne" : ni automate (no-reply,
 * notifications...), ni vide. */
function isNominativeAddress(address: string): boolean {
  const a = (address || "").trim().toLowerCase();
  if (!a.includes("@")) return false;
  if (isAutomatedSender(a)) return false;
  return !/^(no-?reply|do-?not-?reply|ne-?pas-?repondre|nepasrepondre|notifications?|newsletters?|news|mailer-daemon|bounces?|alerts?)[@.+_-]/.test(a);
}
// Format datetime PocketBase (espace, pas ISO 'T') pour comparer en SQLite.
function toPbDateStr(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ");
}

const SUBJECT_STOPWORDS = new Set([
  "avec", "pour", "dans", "votre", "vous", "nous", "notre", "commande", "facture",
  "paiement", "mensuel", "annuel", "france", "gmbh", "sarl", "sas", "euro", "euros",
  "eur", "chf", "marchand", "numero", "reference", "suivi", "colis", "livraison",
  "transaction", "details", "merci", "bonjour", "client", "service", "online",
]);

/** Cles de `fields` (dynamiques, produites par le LLM) qui portent un libelle
 * PRODUIT/OBJET distinctif -> a inclure dans la recherche "par sujet". Sans ca,
 * un token fort comme "Livebox" (souvent range dans `offre`) n'etait JAMAIS
 * utilise et le rattachement retombait sur des mots generiques ("fibre",
 * marchand) noyes dans le bruit. */
const SUBJECT_FIELD_KEYS = [
  "produit", "product", "article", "modele", "model", "designation",
  "libelle", "objet", "offre", "formule", "abonnement", "prestation",
];

/** Concatene les valeurs texte des champs produit/objet d'une fiche. */
function subjectFieldsText(item: PBTrackingItem): string {
  const f = item.fields && typeof item.fields === "object" ? item.fields : {};
  const parts: string[] = [];
  for (const k of SUBJECT_FIELD_KEYS) {
    const v = (f as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) parts.push(v.trim());
  }
  return parts.join(" ");
}

/** Mots-cles DISTINCTIFS du PRODUIT/objet d'une fiche (pour la recherche FTS5
 * "par sujet"). On vire les mots vides et les nombres. */
function extractSubjectTokens(item: PBTrackingItem): string[] {
  const src = `${subjectFieldsText(item)} ${item.title || ""}`;
  const words = (src.toLowerCase().match(/[a-zà-ÿ][a-zà-ÿ0-9-]{3,}/gi) || [])
    .map((w) => w.toLowerCase())
    .filter((w) => !SUBJECT_STOPWORDS.has(w) && !/^\d+$/.test(w));
  // Les plus distinctifs (longs) d'abord, dedup.
  const uniq = Array.from(new Set(words)).sort((a, b) => b.length - a.length);
  return uniq.slice(0, 3);
}

function buildSubjectQuery(item: PBTrackingItem): string {
  return `${item.title || ""} ${subjectFieldsText(item)} ${item.merchant || ""}`.trim();
}

function ficheIsOpen(item: PBTrackingItem): boolean {
  return item.status === "active" || item.status === "waiting";
}

/** Mails CANDIDATS "par sujet" (produit/marchand/semantique) a faire confirmer
 * par l'IA. 100% GRATUIT (FTS5 + embeddings locaux). Retourne threadId ->
 * messageId representatif. Exclut les fils deja rattaches. */
async function discoverSubjectCandidates(
  item: PBTrackingItem,
  exclude: Set<string>,
  span: DateSpan | null
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const accountId = item.account || undefined;
  const userId = item.user;

  // a) Mot-cle produit (FTS5), en ROUND-ROBIN entre tokens : chaque token
  //    contribue A TOUR DE ROLE. Sans ca, un token GENERIQUE tres frequent
  //    (ex. "demenagement", present dans des dizaines de pubs) monopolise tout
  //    le budget de candidats et un token DISTINCTIF (ex. "livebox", qui pointe
  //    le VRAI mail frere) n'est jamais interroge. Sous-cap pour reserver de la
  //    place aux sources (b)/(c).
  {
    const tokens = extractSubjectTokens(item);
    const perToken: PBMessage[][] = [];
    for (const tok of tokens) {
      let hits: PBMessage[] | null = null;
      try {
        hits = searchKeywordsFTS5({
          userId,
          accountId,
          terms: [tok],
          limit: 15,
          lightweight: true,
          orderBy: "date",
        });
      } catch {
        hits = null;
      }
      perToken.push(hits || []);
    }
    for (let i = 0; out.size < SUBJECT_TOKEN_CAP; i++) {
      let progressed = false;
      for (const hits of perToken) {
        if (i >= hits.length) continue;
        progressed = true;
        const h = hits[i];
        if (!h.thread_id || exclude.has(h.thread_id) || out.has(h.thread_id)) continue;
        out.set(h.thread_id, h.id);
        if (out.size >= SUBJECT_TOKEN_CAP) break;
      }
      if (!progressed) break;
    }
  }

  // b) Proximite semantique (embeddings locaux) = le vrai "par sujet".
  if (out.size < SUBJECT_EMB_CAP) {
    const query = buildSubjectQuery(item);
    if (query) {
      let vh: { message: string; score: number }[] = [];
      try {
        vh = await searchEmbeddings({ userId, accountId, query, limit: 20 });
      } catch {
        vh = [];
      }
      for (const h of vh) {
        if (h.score < SUBJECT_EMB_THRESHOLD) break; // tries par score desc
        if (out.size >= SUBJECT_EMB_CAP) break;
        let hm;
        try {
          hm = await getMessage(h.message);
        } catch {
          continue;
        }
        if (!hm.thread_id || exclude.has(hm.thread_id) || out.has(hm.thread_id)) continue;
        out.set(hm.thread_id, h.message);
      }
    }
  }

  // d) MEME correspondant (adresse nominative exacte, en expediteur OU en
  //    destinataire) : les echanges PRECEDENTS avec la meme personne, souvent
  //    dans un fil a part (premiere prise de contact, devis, relance). Fenetre
  //    arriere large (GATHER_WINDOW) : c'est ce qui manquait pour "les mails
  //    d'avant". L'IA confirme ensuite chaque candidat (llmConfirmBelongs).
  if (out.size < SUBJECT_MAX_CANDIDATES && item.thread_id && span) {
    let anchorMsgs: PBMessageForThread[] = [];
    try {
      anchorMsgs = await listMessagesByThread(item.thread_id);
    } catch {
      anchorMsgs = [];
    }
    const party = anchorMsgs.length ? counterpartOf(anchorMsgs) : null;
    if (party && isNominativeAddress(party.address)) {
      let ch: PBMessage[] | null = null;
      try {
        ch = listMessagesWithCounterpart({
          userId,
          accountId,
          address: party.address,
          since: toPbDateStr(span.min - GATHER_WINDOW_MS),
          until: toPbDateStr(span.max + DOMAIN_SIBLING_WINDOW_MS),
          limit: 30,
        });
      } catch {
        ch = null;
      }
      let added = 0;
      for (const h of ch || []) {
        if (out.size >= SUBJECT_MAX_CANDIDATES || added >= COUNTERPART_MAX_CANDIDATES) break;
        if (!h.thread_id || exclude.has(h.thread_id) || out.has(h.thread_id)) continue;
        out.set(h.thread_id, h.id);
        added++;
      }
    }
  }

  // c) MEME domaine expediteur, dans une fenetre SERREE autour de la fiche.
  //    Jamais pour un fournisseur grand public (gmail.com...) : le domaine n'y
  //    designe personne, la source (d) couvre deja la meme personne.
  //    Rattrape les mails FRERES du meme marchand (RDV, activation, expedition,
  //    retour) dans un fil SEPARE qui ne repete NI numero NI token produit
  //    distinctif -> invisibles pour (a)/(b). L'IA (llmConfirmBelongs) tranche
  //    ensuite, donc les factures/pubs recurrentes du domaine sont rejetees.
  //    Necessite une ancre temporelle (span) pour ne pas balayer tout l'historique.
  if (
    out.size < SUBJECT_MAX_CANDIDATES &&
    item.sender_domain &&
    !PUBLIC_MAIL_DOMAINS.has(item.sender_domain.toLowerCase()) &&
    span
  ) {
    const since = toPbDateStr(span.min - DOMAIN_SIBLING_WINDOW_MS);
    const until = toPbDateStr(span.max + DOMAIN_SIBLING_WINDOW_MS);
    let dh: PBMessage[] | null = null;
    try {
      dh = listRecentMessagesBySenderDomain({
        userId,
        accountId,
        domain: item.sender_domain,
        since,
        until,
        limit: 20,
      });
    } catch {
      dh = null;
    }
    for (const h of dh || []) {
      if (out.size >= SUBJECT_MAX_CANDIDATES) break;
      if (!h.thread_id || exclude.has(h.thread_id) || out.has(h.thread_id)) continue;
      out.set(h.thread_id, h.id);
    }
  }
  return out;
}

/** L'IA tranche : ce mail concerne-t-il EXACTEMENT cette affaire suivie ? STRICT
 * (false en cas de doute) -> recall du sujet SANS melanger des affaires
 * differentes. 1 petit appel LLM. */
async function llmConfirmBelongs(
  item: PBTrackingItem,
  msg: PBMessageForThread,
  apiKey: string,
  opts: { lockerNotice?: boolean } = {}
): Promise<boolean> {
  const f = item.fields && typeof item.fields === "object" ? item.fields : {};
  const fieldsStr = Object.entries(f)
    .slice(0, 8)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  const who = msg.from_address?.name || msg.from_address?.address || "?";
  const body = htmlToPlain(msg.html_body || msg.text_body || msg.snippet || "").slice(0, 1000);
  const system =
    'Tu verifies si un EMAIL concerne EXACTEMENT une affaire deja suivie (meme commande / dossier / produit / reservation). Reponds STRICTEMENT en JSON sur une ligne : {"belongs": true} ou {"belongs": false}. Sois STRICT : si tu n\'es pas SUR que c\'est la MEME affaire, reponds false. Un email du MEME marchand mais pour une AUTRE commande = false. Une pub/newsletter = false. En revanche, un email de SUIVI OPERATIONNEL de CETTE meme affaire (confirmation, RDV/installation, activation, expedition/livraison, retour, facture de CETTE commande) = true des lors qu\'un detail concorde avec le suivi (numero, reference, produit/offre, date d\'installation/livraison/echeance, adresse) — meme s\'il ne repete pas le numero de commande. INTERDIT (false) : rattacher sur un simple mot de sujet generique (Suivi, Facture, Commande, Reunion, Compte-rendu, Re:, TR:) ou une ressemblance THEMATIQUE (deux sujets "business/pro", deux emails en francais...). De la correspondance entre des personnes ou adresses DIFFERENTES de celles du suivi, sans identifiant CONCRET propre a CETTE affaire (numero de commande/contrat/facture, produit exact, marchand exact), = false. Il faut un ancrage CONCRET, pas une simple proximite de sujet. Dans le doute : false.';
  const lockerHint = opts.lockerNotice
    ? "\nCAS PARTICULIER : cet email est un AVIS DE MISE A DISPOSITION EN CONSIGNE/LOCKER/CASIER envoye par un prestataire AU NOM du marchand. Ces avis portent souvent un numero LOGISTIQUE (preparation/retrait) DIFFERENT du numero de commande du suivi : ce numero different NE SUFFIT PAS a conclure false. Reponds true si le marchand est le meme, que le suivi est une commande a retirer (retrait/click & collect/point de retrait) et que la ville ou le lieu de retrait concorde, sans contradiction concrete (autre produit nomme, autre ville)."
    : "";
  const user = `SUIVI :\n- type : ${item.type}\n- titre : ${item.title}\n- marchand : ${item.merchant}\n- infos : ${fieldsStr}${
    item.context_summary ? `\n- identite : ${item.context_summary.slice(0, 400)}` : ""
  }\n\nEMAIL :\n- de : ${who}\n- sujet : ${msg.subject}\n- extrait : ${body}\n\nCet email concerne-t-il CE suivi precis ?`;
  try {
    const res = await aiFetch("tracking-confirm", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
        "X-Title": "iMiel",
      },
      body: JSON.stringify({
        model: trackingModel(),
        messages: [
          { role: "system", content: system + lockerHint },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 20,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.log(`[tracking] confirm HTTP ${res.status} fiche=${item.id} -> refus`);
      return false;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content || "";
    try {
      const obj = JSON.parse(content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
      return obj.belongs === true || obj.belongs === "true";
    } catch {
      return /"belongs"\s*:\s*true/i.test(content);
    }
  } catch (err) {
    console.log(`[tracking] confirm erreur fiche=${item.id} -> refus: ${(err as Error).message}`);
    return false;
  }
}

// Plafond de fiches presentees au LLM dans l'adjudication generale (UN SEUL appel
// par mail, quel que soit le nombre de fiches). Au-dela, on garde les plus
// recentes (tri -last_message_date) et on log la troncature.
const PICK_MAX_FICHES = 40;

/**
 * FILET GENERAL (dernier recours du chemin live) : un mail entrant qu'aucun
 * signal GRATUIT n'a rattache est soumis a UNE adjudication LLM sur la liste des
 * fiches OUVERTES. Le modele choisit le numero de la fiche a laquelle le mail
 * appartient, ou 0 (aucune). C'est "le LLM lit chaque mail entrant face aux
 * fiches ouvertes" (choix utilisateur 2026-07-07), fait en UN SEUL appel par mail
 * (jamais un appel par fiche). Retourne la fiche choisie (ouverte) ou null.
 */
async function llmPickFollowup(
  userId: string,
  msg: PBMessage,
  apiKey: string,
  excludeThreadId?: string
): Promise<PBTrackingItem | null> {
  let fiches: PBTrackingItem[];
  try {
    fiches = await listOpenTrackingCandidates(userId, { cap: PICK_MAX_FICHES });
  } catch {
    return null;
  }
  // La conversation courante est deja geree par le chemin "thread suivi".
  fiches = fiches.filter((f) => !(excludeThreadId && f.thread_id === excludeThreadId));
  if (fiches.length === 0) return null; // rien a rattacher -> zero appel LLM
  if (fiches.length > PICK_MAX_FICHES) {
    console.warn(
      `[tracking] pick: ${fiches.length} fiches ouvertes, plafonnees a ${PICK_MAX_FICHES} (plus recentes)`
    );
    fiches = fiches.slice(0, PICK_MAX_FICHES);
  }

  // Catalogue RICHE : chaque affaire est presentee avec son IDENTITE (synthese +
  // identifiants concrets : produit, numeros de commande/suivi, montant,
  // transporteur, adresse). C'est ce qui permet de DISTINGUER deux commandes du
  // MEME marchand (sinon on matche sur le seul nom du magasin et on melange tout).
  const catalog = fiches
    .map((f, i) => {
      const ff = f.fields && typeof f.fields === "object" ? f.fields : {};
      const infos = Object.entries(ff)
        .slice(0, 8)
        .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
        .join(", ");
      const lines = [
        `#${i + 1} ${f.title || "(sans titre)"}${f.merchant ? ` [${f.merchant}]` : ""}${
          f.type ? ` (${f.type})` : ""
        }`,
      ];
      if (f.context_summary) lines.push(`   identite: ${f.context_summary.slice(0, 400)}`);
      if (infos) lines.push(`   infos: ${infos}`);
      return lines.join("\n");
    })
    .join("\n");

  const who = msg.from_address?.name || msg.from_address?.address || "?";
  const dom = senderDomainOf(msg.from_address?.address);
  const body = htmlToPlain(msg.html_body || msg.text_body || msg.snippet || "").slice(0, 1500);
  const system =
    'Tu rattaches un EMAIL a la BONNE affaire deja suivie, ou a AUCUNE. On te donne une liste NUMEROTEE de suivis OUVERTS (chacun avec son IDENTITE : marchand, produit, numeros de commande/suivi, montant, transporteur, adresse) puis un email. Reponds STRICTEMENT en JSON sur une ligne : {"match": N} (numero du suivi) ou {"match": 0} si aucun.\n' +
    'REGLE CENTRALE : rattache UNIQUEMENT si l\'email partage un IDENTIFIANT CONCRET avec l\'identite du suivi : meme numero de commande/suivi/facture, OU meme produit precis, OU meme reference, OU meme adresse de livraison. Le seul nom du marchand NE SUFFIT PAS.\n' +
    'DEUX COMMANDES DU MEME MARCHAND = DEUX AFFAIRES DIFFERENTES : si l\'email porte un numero de suivi / une reference / un produit / un transporteur DIFFERENT de ceux du suivi, reponds 0 (meme si c\'est le meme magasin).\n' +
    'TRANSPORTEUR : une notif transporteur (Colissimo, DPD, Chronopost, Mondial Relay...) appartient a une commande SEULEMENT si son numero de colis correspond au numero de suivi de l\'affaire, OU si l\'adresse/le produit correspond. Citer le nom du marchand ("expedie par ManoMano") NE SUFFIT PAS : plusieurs commandes du meme marchand ont des colis DIFFERENTS.\n' +
    'INTERDIT AUSSI : pub/newsletter/prospection = 0 ; correspondance pro entre personnes DIFFERENTES partageant juste un mot de sujet (Suivi, Facture, Reunion, Re:, TR:) = 0.\n' +
    'Dans le doute, reponds 0 : mieux vaut ne rien rattacher qu\'un mauvais rattachement. Un seul numero au maximum.';
  const user = `SUIVIS OUVERTS :\n${catalog}\n\nEMAIL A RATTACHER :\n- de : ${who}${
    dom ? ` <${dom}>` : ""
  }\n- sujet : ${msg.subject || "(sans sujet)"}\n- extrait : ${body}\n\nA quel suivi (numero) cet email appartient-il, ou 0 ?`;
  try {
    const res = await aiFetch("tracking-pick", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
        "X-Title": "iMiel",
      },
      body: JSON.stringify({
        model: trackingModel(),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 20,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content || "";
    let idx = 0;
    try {
      const obj = JSON.parse(content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
      idx = Number(obj.match) || 0;
    } catch {
      const m = content.match(/"match"\s*:\s*(\d+)/);
      idx = m ? Number(m[1]) : 0;
    }
    if (idx < 1 || idx > fiches.length) return null;
    return fiches[idx - 1];
  } catch {
    return null;
  }
}

/** Messages representatifs d'un fil candidat (pour la confirmation). */
async function messagesOfThread(
  threadId: string,
  seedId: string
): Promise<PBMessageForThread | null> {
  try {
    const ms = await listMessagesByThread(threadId);
    if (ms.length > 0) return ms[ms.length - 1]; // le plus recent porte l'etat actuel
  } catch {
    /* ignore */
  }
  try {
    const m = await getMessage(seedId);
    return {
      id: m.id,
      subject: m.subject || "",
      snippet: m.snippet || "",
      text_body: m.text_body || "",
      html_body: m.html_body || "",
      from_address: m.from_address || { address: "" },
      is_sent: !!m.is_sent,
      has_attachments: !!m.has_attachments,
      date: m.date,
      account: m.account,
    };
  } catch {
    return null;
  }
}

/**
 * Rattache a une fiche OUVERTE les fils LIES, en DEUX temps :
 *  1) NUMERO partage (FTS5) -> rattachement direct (signal sur, gratuit) ;
 *  2) SUJET (produit/marchand/semantique, gratuit) -> chaque candidat est
 *     CONFIRME par l'IA ("concerne-t-il ce suivi ?") avant rattachement.
 * Puis re-synthese de TOUTE la fiche (titre + timeline coherents). En `dryRun`,
 * ne fait AUCUN appel LLM et retourne le NB de candidats sujet (= nb de
 * confirmations IA qu'une vraie passe couterait). Retourne sinon le nb rattache.
 */
async function gatherRelatedThreads(
  userId: string,
  item: PBTrackingItem,
  apiKey: string,
  opts: { dryRun?: boolean; clean?: boolean } = {}
): Promise<number> {
  // Mode "clean" (ré-ancrage) : on REPART du SEUL fil d'origine (celui sur lequel
  // l'utilisateur a cliqué "Suivre", stocké dans `thread_id`). On jette tous les
  // fils rattachés précédemment + les champs/marchand accumulés -> la découverte
  // ci-dessous re-dérive l'ensemble depuis zéro et les mauvais rattachements
  // (autres commandes, autre transporteur) tombent. Sans ancre fiable, on
  // n'efface rien (comportement additif classique) pour ne pas vider la fiche.
  if (opts.clean && item.thread_id) {
    item.thread_ids = [item.thread_id];
    // Re-extraction depuis le SEUL fil d'origine -> champs/marchand/numéros
    // PROPRES (les anciens mélangeaient plusieurs affaires). Ces signaux frais
    // servent ensuite à re-découvrir UNIQUEMENT les vrais fils liés (numéro
    // partagé, transporteur citant CE marchand), sans traîner les anciens.
    let anchorMsgs: PBMessageForThread[] = [];
    try {
      anchorMsgs = dedupMessages(await listMessagesByThread(item.thread_id)).sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : 0
      );
    } catch {
      /* ignore */
    }
    const fresh = anchorMsgs.length ? await extractFiche(anchorMsgs, [], apiKey) : null;
    if (fresh) {
      const party = counterpartOf(anchorMsgs);
      item.fields = fresh.fields || {};
      item.title = cleanTitle(fresh.title, fresh.type) || item.title;
      item.type = fresh.type || item.type;
      item.merchant = party.name || party.domain || "";
      item.sender_domain = party.domain;
    } else {
      // Extraction impossible -> on ne devine pas : champs vidés, ré-ancrage seul.
      item.fields = {};
      item.merchant = "";
      item.sender_domain = "";
    }
  }
  const exclude = new Set<string>();
  if (item.thread_id) exclude.add(item.thread_id);
  for (const tid of Array.isArray(item.thread_ids) ? item.thread_ids : []) {
    if (tid) exclude.add(tid);
  }

  // Ancre temporelle de la fiche : on ne rattachera AUCUN fil hors de la fenetre
  // de recence relative a ces dates (empeche d'aspirer une affaire vieille de
  // plusieurs annees du meme marchand).
  const span = await computeThreadsDateSpan(exclude);

  // 1) NUMERO partage (FTS5) -> direct (mais dans la fenetre de recence).
  const found = new Set<string>();
  const accountId = item.account || undefined;
  for (const tok of extractIdentifierTokens(item)) {
    if (found.size >= GATHER_MAX_THREADS) break;
    let hits: PBMessage[] | null = null;
    try {
      hits = searchKeywordsFTS5({
        userId,
        accountId,
        terms: [tok],
        limit: 20,
        lightweight: true,
        orderBy: "date",
      });
    } catch {
      hits = null;
    }
    if (!hits) continue;
    for (const h of hits) {
      const tid = h.thread_id;
      if (!tid || exclude.has(tid) || found.has(tid)) continue;
      if (!dateWithinSpanWindow(h.date, span)) continue;
      found.add(tid);
      if (found.size >= GATHER_MAX_THREADS) break;
    }
  }

  // 1bis) Notifications TRANSPORTEUR citant le marchand de la fiche (Colissimo
  //       "confie par X"...) : fil separe, sujet generique, AUCUN numero commun
  //       -> on les retrouve par le NOM du marchand (FTS5) puis on VERIFIE que
  //       c'est bien une notif transporteur citant ce marchand. Rattachement
  //       direct (signal sur, 0 appel IA), comme le numero partage. Inutile en
  //       dryRun : ca ne genere aucune confirmation IA a estimer.
  if (!opts.dryRun && ficheLooksShipment(item)) {
    const seenCandidates = new Set<string>();
    // Garde-fou numero de colis : si la fiche connait deja un numero de suivi, une
    // notif transporteur qui ne le contient PAS est un colis DIFFERENT (autre
    // commande du meme marchand) -> on ne la rattache pas (cf bug Colissimo/DPD).
    const ficheTrackNums = ficheTrackingNumbers(item);
    for (const m of ficheMerchantForms(item)) {
      if (found.size >= GATHER_MAX_THREADS) break;
      const termSets: string[][] = [[m.alnum]];
      const words = m.words.split(" ").filter((t) => t.length >= 4).slice(0, 2);
      if (words.length >= 2) termSets.push(words);
      for (const terms of termSets) {
        if (found.size >= GATHER_MAX_THREADS) break;
        let hits: PBMessage[] | null = null;
        try {
          hits = searchKeywordsFTS5({
            userId,
            accountId,
            terms,
            limit: 20,
            lightweight: true,
            orderBy: "date",
          });
        } catch {
          hits = null;
        }
        if (!hits) continue;
        for (const h of hits) {
          const tid = h.thread_id;
          if (!tid || exclude.has(tid) || found.has(tid)) continue;
          if (seenCandidates.has(h.id)) continue;
          seenCandidates.add(h.id);
          if (seenCandidates.size > 30) break; // borne le nb de getMessage
          let full: PBMessage;
          try {
            full = await getMessage(h.id);
          } catch {
            continue;
          }
          if (!dateWithinSpanWindow(full.date, span)) continue;
          if (!isCarrierSender(full)) continue;
          const fhay = carrierHay(full);
          const fhayAlnum = normAlnum(fhay);
          if (!hayMentionsMerchant(normWords(fhay), fhayAlnum, m)) continue;
          // Colis DIFFERENT de celui deja connu de la fiche -> autre commande.
          if (ficheTrackNums.length > 0 && !ficheTrackNums.some((t) => fhayAlnum.includes(t)))
            continue;
          found.add(tid);
          if (found.size >= GATHER_MAX_THREADS) break;
        }
      }
    }
  }

  // 2) SUJET (gratuit a decouvrir) -> confirmation IA par candidat. Uniquement
  //    sur les suivis OUVERTS (on ne suit plus une affaire close).
  const excludeForSubject = new Set<string>(exclude);
  for (const t of found) excludeForSubject.add(t);
  let candidates = new Map<string, string>();
  if (ficheIsOpen(item)) {
    candidates = await discoverSubjectCandidates(item, excludeForSubject, span);
  }

  if (opts.dryRun) {
    // Estimation : nb de confirmations IA que couterait une vraie passe.
    return candidates.size;
  }

  let confirmed = 0;
  for (const [tid, seedId] of candidates) {
    const msg = await messagesOfThread(tid, seedId);
    if (!msg) continue;
    // Hors fenetre de recence -> autre affaire : ni LLM, ni rattachement.
    if (!dateWithinSpanWindow(msg.date, span)) continue;
    if (await llmConfirmBelongs(item, msg, apiKey)) {
      found.add(tid);
      confirmed++;
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  // Re-synthese de TOUTE la fiche (1 appel) -> titre + timeline coherents.
  const all = new Set<string>(exclude);
  for (const tid of found) all.add(tid);
  item.thread_ids = Array.from(all);
  await resynthesizeWholeFiche(userId, item, apiKey, { clean: opts.clean });

  if (found.size > 0) {
    console.log(
      `[tracking] GATHER ${item.id} <- ${found.size} fil(s) (${confirmed} confirme(s) par sujet)`
    );
  }
  return found.size;
}

/**
 * Estimation GRATUITE (aucun appel IA) du cout d'une passe d'analyse PAR SUJET :
 * nombre de fiches ouvertes + nombre de confirmations IA a effectuer.
 */
export async function estimateSubjectAnalysis(
  userId: string
): Promise<{ fiches: number; confirmCalls: number }> {
  const ids = await listAllTrackingItemIds(userId);
  let confirmCalls = 0;
  let openFiches = 0;
  for (const id of ids) {
    const item = await getTrackingItem(id);
    if (!item || item.archived || !ficheIsOpen(item)) continue;
    openFiches++;
    try {
      confirmCalls += await gatherRelatedThreads(userId, item, "", { dryRun: true });
    } catch {
      /* best effort */
    }
  }
  return { fiches: openFiches, confirmCalls };
}

/**
 * Deduplique les fiches OUVERTES d'un user : deux fiches qui partagent un fil
 * sont la MEME affaire (apres rattachement croise, les doublons ont le meme jeu
 * de fils). On regroupe par fils partages (union-find) et on garde la plus
 * riche (plus d'evenements), on archive les autres. Retourne le nb archive.
 */
export async function dedupFichesForUser(userId: string): Promise<number> {
  const fiches = await listOpenTrackingItemsForDedup(userId);
  if (fiches.length <= 1) return 0;

  // INCLUSION STRICTE : une fiche est un doublon UNIQUEMENT si TOUS ses fils sont
  // contenus dans une autre fiche. (Deux vrais doublons ont, apres rattachement
  // croise, le MEME jeu de fils.) On NE fusionne PAS sur un simple fil commun :
  // un mail d'expedition peut citer plusieurs commandes et se retrouver rattache
  // a deux affaires DIFFERENTES -> les fusionner serait faux.
  const withSets = fiches
    .map((f) => ({
      f,
      set: new Set<string>([f.thread_id, ...f.thread_ids].filter(Boolean)),
    }))
    .filter((x) => x.set.size > 0);

  // Candidats "gardes" d'abord : plus grand jeu de fils, puis plus d'evenements,
  // puis id stable -> deterministe.
  withSets.sort((a, b) => {
    if (b.set.size !== a.set.size) return b.set.size - a.set.size;
    if (b.f.event_count !== a.f.event_count) return b.f.event_count - a.f.event_count;
    return a.f.id < b.f.id ? -1 : 1;
  });

  const kept: { id: string; set: Set<string> }[] = [];
  let archived = 0;
  for (const { f, set } of withSets) {
    const host = kept.find((k) => [...set].every((t) => k.set.has(t)));
    if (host) {
      try {
        await updateTrackingItem(f.id, { archived: true });
        archived++;
        console.log(`[tracking] DEDUP archive ${f.id} (contenu dans ${host.id})`);
      } catch {
        /* best effort */
      }
    } else {
      kept.push({ id: f.id, set });
    }
  }
  return archived;
}

/**
 * Reconstruit UNE fiche : (1) decouvre ses fils LIES manquants (numeros partages,
 * gratuit) et (2) re-synthetise TOUTE la fiche en 1 appel LLM -> titre coherent
 * "Produit - Entreprise" + timeline ludique et logique sur l'ensemble. NON
 * DESTRUCTIF (upsert, aucune perte si l'appel echoue). Retourne le nb de fils
 * lies trouves.
 */
export async function rebuildFiche(
  userId: string,
  itemId: string,
  clean = false
): Promise<number> {
  const apiKey =
    (await getUserOpenRouterKey(userId)) || serverOpenRouterKey() || "";
  if (!apiKey) return 0;
  const item = await getTrackingItem(itemId);
  if (!item || item.user !== userId || item.archived) return 0;
  return gatherRelatedThreads(userId, item, apiKey, { clean });
}

/** Reconstruit une fiche en resolvant le user depuis la fiche (route worker). */
export async function rebuildFicheById(itemId: string, clean = false): Promise<number> {
  const item = await getTrackingItem(itemId);
  if (!item) return 0;
  return rebuildFiche(item.user, itemId, clean);
}

/** Cherche un suivi OUVERT dont un NUMERO d'affaire (commande/suivi/facture)
 * apparait LITTERALEMENT dans ce mail -> rattachement PRECIS (zero bruit, aucun
 * appel OpenRouter pour decider). C'est ce qui fait qu'une "mise a jour" (mail
 * d'expedition, de livraison, du transporteur...) tombe dans le BON suivi des
 * sa reception. Retourne la fiche ou null. */
async function findFollowupBySharedNumber(
  userId: string,
  msg: PBMessage,
  excludeThreadId?: string
): Promise<PBTrackingItem | null> {
  const hay = `${msg.subject || ""} ${htmlToPlain(
    msg.text_body || msg.html_body || msg.snippet || ""
  )}`.toLowerCase();
  if (!hay.trim()) return null;
  let fiches: PBTrackingItem[];
  try {
    fiches = await listOpenTrackingCandidates(userId, { cap: 60 });
  } catch {
    return null;
  }
  for (const f of fiches) {
    if (f.thread_id && f.thread_id === excludeThreadId) continue;
    for (const tok of extractIdentifierTokens(f)) {
      if (hay.includes(tok.toLowerCase())) return f;
    }
  }
  return null;
}

// --- Pont TRANSPORTEUR -> MARCHAND -------------------------------------------
//
// Les notifications des transporteurs (Colissimo/La Poste, Chronopost, Mondial
// Relay, DHL, UPS...) arrivent dans un fil SEPARE, ne reprennent PAS le numero
// de commande du marchand (elles n'ont que LEUR propre numero de colis) et ont
// un sujet generique ("Votre colis arrive"). Elles ne matchaient donc NI par
// fil, NI par numero partage, NI par semantique -> elles tombaient a cote du
// suivi. MAIS elles citent quasi toujours le NOM du marchand expediteur ("Votre
// Colissimo confie par NANOPROTECTION"). On s'en sert comme PONT vers la fiche
// OUVERTE du meme marchand. Une fois rattachee, la re-synthese capte le numero
// de colis du transporteur -> les MAJ suivantes matchent par numero (gratuit).

// Les prestataires de CONSIGNES / CASIERS (Quadient, Parcel Pending, InPost...)
// envoient l'avis "colis arrive en locker" AU NOM du marchand (nom affiche
// "Decathlon", adresse no-reply@quadient.com) : ils comptent comme transporteurs.
const CARRIER_HINT_RE =
  /(quadient|parcelpending|parcel-pending|inpost|bloqit|packcity|colissimo|laposte|chronopost|mondialrelay|mondial-relay|relaiscolis|relais-colis|colisprive|colis-prive|fedex|bpost|dbschenker|geodis|shippingbo|\bdhl\b|\bups\b|\bdpd\b|\bgls\b|\btnt\b)/i;

// Marqueurs de corps (sur texte SANS accents) propres a une notif transporteur.
const CARRIER_BODY_RE =
  /(votre colis|numero de suivi|suivre mon colis|confie par|sera livre|en cours de livraison|point de retrait|votre livraison|pris en charge|colis arrive|colis a bien ete livre|locker|consigne|casier)/;

// Avis de mise a disposition en CONSIGNE / CASIER (texte SANS accents).
const LOCKER_BODY_RE = /\b(lockers?|consignes?|casiers?)\b/;

function isLockerNotice(msg: PBMessage): boolean {
  return LOCKER_BODY_RE.test(normWords(carrierHay(msg)));
}

// Champs qui trahissent une fiche d'EXPEDITION physique (vs abonnement, facture,
// demarche administrative...). Seules ces fiches sont eligibles au pont.
const SHIPMENT_FIELD_RE =
  /(suivi|tracking|transporteur|colis|produit|product|livraison|expedition)/i;

// Processeurs de paiement : jamais l'expediteur cite par un transporteur ->
// inutilisables comme nom de marchand pour le pont.
const PAYMENT_BRAND_RE = /^(paypal|stripe|klarna|scalapay|alma|sumup|gocardless|revolut|lydia)/;

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function normWords(s: string): string {
  return stripDiacritics(s.toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim();
}
function normAlnum(s: string): string {
  return stripDiacritics(s.toLowerCase()).replace(/[^a-z0-9]+/g, "");
}
function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function carrierHay(msg: PBMessage): string {
  return `${msg.subject || ""} ${msg.snippet || ""} ${htmlToPlain(
    (msg.html_body || msg.text_body || "").slice(0, 6000)
  )}`;
}

function isCarrierNotification(msg: PBMessage): boolean {
  const who = `${msg.from_address?.address || ""} ${msg.from_address?.name || ""}`;
  if (CARRIER_HINT_RE.test(who)) return true;
  return CARRIER_BODY_RE.test(normWords(carrierHay(msg)));
}

/** STRICT : l'EXPEDITEUR est lui-meme un transporteur (Colissimo, GLS, DPD...).
 *  Sert au PONT par nom de marchand (rattachement SANS numero partage) : seul un
 *  vrai transporteur peut etre rattache a une fiche sur la base du nom du
 *  marchand. Une place de marche ou un vendeur qui "parle" d'un colis (corps avec
 *  "en cours de livraison") mais porte SON PROPRE numero de commande designe une
 *  AUTRE affaire du meme marchand -> on ne ponte PAS dessus (cf croisement Aosom
 *  direct vs Aosom via Maisons du Monde). Le match par numero reste, lui, ouvert
 *  a tous les expediteurs. */
function isCarrierSender(msg: PBMessage): boolean {
  const who = `${msg.from_address?.address || ""} ${msg.from_address?.name || ""}`;
  return CARRIER_HINT_RE.test(who);
}

function ficheLooksShipment(item: PBTrackingItem): boolean {
  const f = item.fields && typeof item.fields === "object" ? item.fields : {};
  for (const k of Object.keys(f)) if (SHIPMENT_FIELD_RE.test(k)) return true;
  return /(commande|colis|livraison|expedition|achat|order|parcel|shipment|retour|panier)/.test(
    normWords(`${item.type || ""} ${item.title || ""}`)
  );
}

interface MerchantForm {
  words: string;
  alnum: string;
}

/** Formes normalisees du NOM du marchand d'une fiche (merchant, marchand/vendeur
 *  des fields, partie marchand du titre, marque du domaine expediteur). On ecarte
 *  les noms trop courts/generiques, les processeurs de paiement et les noms de
 *  transporteurs (sinon une fiche "Colissimo" matcherait tout). */
function ficheMerchantForms(item: PBTrackingItem): MerchantForm[] {
  const raws = new Set<string>();
  if (item.merchant) raws.add(item.merchant);
  const f = item.fields && typeof item.fields === "object" ? item.fields : {};
  if (typeof f.marchand === "string") raws.add(f.marchand);
  if (typeof f.vendeur === "string") raws.add(f.vendeur);
  if (item.title && item.title.includes(" - ")) {
    const tail = item.title.split(" - ").pop() || "";
    if (tail) raws.add(tail);
  }
  if (item.sender_domain) {
    const parts = item.sender_domain.split(".");
    raws.add(parts.length > 1 ? parts.slice(0, -1).join(" ") : item.sender_domain);
  }
  const out: MerchantForm[] = [];
  const seen = new Set<string>();
  for (const r of raws) {
    const alnum = normAlnum(r);
    if (alnum.length < 5) continue; // trop court / generique
    if (PAYMENT_BRAND_RE.test(alnum)) continue;
    if (CARRIER_HINT_RE.test(alnum)) continue;
    if (seen.has(alnum)) continue;
    seen.add(alnum);
    out.push({ words: normWords(r), alnum });
  }
  return out;
}

/** Le mail cite-t-il ce marchand ? Gere "Nano-Protection" cite "NANOPROTECTION"
 *  (forme sans separateur) ET les noms multi-mots avec bornes de mots. */
function hayMentionsMerchant(hayWords: string, hayAlnum: string, m: MerchantForm): boolean {
  if (m.alnum.length >= 6 && hayAlnum.includes(m.alnum)) return true;
  const toks = m.words.split(" ").filter((t) => t.length >= 3);
  if (toks.length === 0 || toks.join("").length < 5) return false;
  const re = new RegExp(`\\b${toks.map(escapeReg).join("\\s+")}\\b`);
  return re.test(hayWords);
}

function toThreadMsg(m: PBMessage): PBMessageForThread {
  return {
    id: m.id,
    subject: m.subject || "",
    snippet: m.snippet || "",
    text_body: m.text_body || "",
    html_body: m.html_body || "",
    from_address: m.from_address || { address: "" },
    is_sent: !!m.is_sent,
    has_attachments: !!m.has_attachments,
    date: m.date,
    account: m.account,
  };
}

/** Notification transporteur -> fiches OUVERTES d'expedition dont le NOM du
 *  marchand est cite dans le mail. Triees par recence. Aucun appel IA. */
// Champs qui portent le NUMERO DE COLIS / SUIVI (specifiques transporteur, vs un
// numero de commande que le transporteur ne connait pas).
const TRACKING_FIELD_RE = /(numero_suivi|num_suivi|suivi|tracking|colis|track)/i;

/** Numeros de suivi/colis (normalises alnum) deja connus d'une fiche. Sert au
 *  garde-fou du pont transporteur. */
function ficheTrackingNumbers(item: PBTrackingItem): string[] {
  const out = new Set<string>();
  const f = item.fields && typeof item.fields === "object" ? item.fields : {};
  for (const [k, v] of Object.entries(f)) {
    if (!TRACKING_FIELD_RE.test(k)) continue;
    for (const tok of String(v).match(/[A-Za-z0-9][A-Za-z0-9-]{6,}/g) || []) {
      const t = normAlnum(tok);
      if (t.length >= 8 && /\d/.test(t)) out.add(t);
    }
  }
  return Array.from(out);
}

async function findFollowupsByMerchantMention(
  userId: string,
  msg: PBMessage,
  excludeThreadId?: string
): Promise<PBTrackingItem[]> {
  if (!isCarrierSender(msg)) return [];
  // Le nom affiche compte : un prestataire de consignes ecrit "au nom" du marchand.
  const hay = `${msg.from_address?.name || ""} ${carrierHay(msg)}`;
  const hayWords = normWords(hay);
  const hayAlnum = normAlnum(hay);
  if (!hayAlnum) return [];
  let fiches: PBTrackingItem[];
  try {
    fiches = await listOpenTrackingCandidates(userId, { cap: 60 });
  } catch {
    return [];
  }
  const matches: PBTrackingItem[] = [];
  for (const f of fiches) {
    if (f.thread_id && f.thread_id === excludeThreadId) continue;
    if (!ficheLooksShipment(f)) continue;
    // GARDE-FOU NUMERO DE COLIS : si la fiche a DEJA un (des) numero(s) de suivi et
    // qu'AUCUN n'apparait dans la notif, c'est un colis DIFFERENT -> une AUTRE
    // commande du meme marchand. On ne ponte PAS (c'est le bug "Colissimo 6A069
    // colle sur la fiche DPD 01475"). Fiche sans numero de suivi encore : on
    // autorise (la notif le fournira), la confirmation IA tranchera ensuite.
    const trackNums = ficheTrackingNumbers(f);
    if (trackNums.length > 0 && !trackNums.some((t) => hayAlnum.includes(t))) continue;
    for (const m of ficheMerchantForms(f)) {
      if (hayMentionsMerchant(hayWords, hayAlnum, m)) {
        matches.push(f);
        break;
      }
    }
  }
  return matches;
}

/**
 * A la sync (et a la reprise recente), pour un mail entrant : 1) conversation
 * deja suivie -> refresh (gratuit). 2) NUMERO d'affaire partage avec un suivi
 * ouvert -> rattachement direct (gratuit). 2bis) notif TRANSPORTEUR citant le
 * marchand d'une fiche ouverte (gratuit). 3) FILET GENERAL : le LLM lit le mail
 * face a TOUTES les fiches ouvertes et tranche en UN appel (recall maximal, choix
 * utilisateur 2026-07-07). Retourne true si le mail a ete rattache a une fiche
 * (NOUVEAU lien), false sinon (utile au compteur de la reprise recente).
 */
export async function autoProcessMail(
  userId: string,
  accountId: string,
  threadId: string | undefined,
  messageId: string,
  _fromAddress?: string,
  opts: { notify?: boolean } = {}
): Promise<boolean> {
  // 1) Conversation deja suivie -> refresh (gratuit). Pas un NOUVEAU rattachement.
  if (threadId) {
    const tracked = await findTrackingItemsByThread(userId, threadId);
    if (tracked.length > 0) {
      // notify uniquement sur le chemin LIVE (nouveau mail entrant) : permet le
      // push "changement de statut" et l'exclut des backfills/rebuilds.
      await trackConversation(userId, accountId, threadId, messageId, { notify: opts.notify });
      return false;
    }
  }

  const apiKey =
    (await getUserOpenRouterKey(userId)) || serverOpenRouterKey() || "";

  let msg: PBMessage;
  try {
    msg = await getMessage(messageId);
  } catch {
    return false;
  }

  // 2) Numero d'affaire partage avec un suivi ouvert -> rattachement precis.
  const byNumber = await findFollowupBySharedNumber(userId, msg, threadId);
  if (byNumber) {
    if (!apiKey) return false;
    await attachThreadToFollowup(userId, byNumber, threadId || "", messageId, apiKey);
    return true;
  }

  // 2bis) Notification TRANSPORTEUR -> fiche OUVERTE du marchand cite, DEJA filtree
  //       par le garde-fou numero de colis (findFollowupsByMerchantMention). On ne
  //       rattache JAMAIS en direct sur le seul nom du marchand : la confirmation
  //       STRICTE tranche a chaque fois (plusieurs commandes d'un meme magasin).
  const carrierMatches = await findFollowupsByMerchantMention(userId, msg, threadId);
  const tag = `[tracking] live ${messageId} "${(msg.subject || "").slice(0, 50)}"`;
  if (carrierMatches.length > 0) {
    if (!apiKey) return false;
    let target: PBTrackingItem | null = null;
    const tmCarrier = toThreadMsg(msg);
    const lockerNotice = isLockerNotice(msg);
    for (const cand of carrierMatches) {
      // Fiche trop eloignee dans le temps = autre affaire du meme marchand.
      const span = await computeThreadsDateSpan(ficheThreadSet(cand));
      if (!dateWithinSpanWindow(msg.date, span)) {
        console.log(`${tag} pont transporteur: fiche ${cand.id} hors fenetre de temps`);
        continue;
      }
      if (await llmConfirmBelongs(cand, tmCarrier, apiKey, { lockerNotice })) {
        target = cand;
        break;
      }
      console.log(`${tag} pont transporteur: confirmation refusee pour fiche ${cand.id}`);
    }
    if (target) {
      await attachThreadToFollowup(userId, target, threadId || "", messageId, apiKey);
      return true;
    }
  } else if (isCarrierNotification(msg)) {
    console.log(
      `${tag} avis de livraison sans fiche au marchand reconnu (expediteur transporteur=${isCarrierSender(msg)})`
    );
  }

  if (!apiKey) return false;

  // 3) FILET GENERAL — le LLM lit CE mail face a TOUTES les fiches ouvertes et
  //    tranche en UN SEUL appel (subsume les anciens signaux "meme domaine
  //    expediteur" et "sujet semantique" : le modele voit deja marchand, domaine,
  //    sujet et extrait). Choix utilisateur (2026-07-07) : analyser chaque mail
  //    entrant pour un recall MAXIMAL ; cout borne a 1 appel/mail (zero si aucune
  //    fiche ouverte).
  const picked = await llmPickFollowup(userId, msg, apiKey, threadId);
  if (!picked || !ficheIsOpen(picked)) {
    console.log(`${tag} aucun numero commun, aucune fiche choisie par l'IA`);
    return false;
  }
  // Garde de recence (filet) : ne pas coller un mail temporellement tres loin des
  // fils de la fiche (commande du meme marchand vieille de plusieurs annees = AUTRE
  // affaire).
  const pickedSpan = await computeThreadsDateSpan(ficheThreadSet(picked));
  if (!dateWithinSpanWindow(msg.date, pickedSpan)) {
    console.log(`${tag} fiche ${picked.id} choisie par l'IA mais hors fenetre de temps`);
    return false;
  }
  // DOUBLE CONTROLE : le "pick" (choisir 1 fiche parmi N) PROPOSE ; la
  // confirmation STRICTE, independante et par fiche, DISPOSE. Sans elle, le pick
  // sur-matche la correspondance thematique (des mails "Suivi"/"prix"/"reunion"
  // colles a tort sur un contrat). On exige donc un 2e avis STRICT avant d'attacher.
  if (!(await llmConfirmBelongs(picked, toThreadMsg(msg), apiKey))) {
    console.log(`${tag} fiche ${picked.id} choisie par l'IA, confirmation refusee`);
    return false;
  }
  await attachThreadToFollowup(userId, picked, threadId || "", messageId, apiKey);
  return true;
}

// --- Suivis RESSEMBLANTS avant creation (action "Suivre") ---
//
// Avant de creer une fiche, on cherche GRATUITEMENT (aucun appel OpenRouter) les
// fiches OUVERTES qui semblent concerner la meme affaire, pour que
// l'UTILISATEUR choisisse : ajouter ce mail a une fiche existante, ou creer un
// nouveau suivi. Jamais de rattachement automatique ici (UNE fiche = UNE
// conversation tant que l'utilisateur n'en decide pas autrement).

export type TrackingCandidateReason = "number" | "carrier" | "counterpart" | "domain" | "similar";

export interface TrackingCandidate {
  item: PBTrackingItem;
  reason: TrackingCandidateReason;
}

const CANDIDATES_MAX = 3;

export async function findTrackingCandidates(messageId: string): Promise<TrackingCandidate[]> {
  let msg: PBMessage;
  let userId: string;
  try {
    msg = await getMessage(messageId);
    userId = (await getAccount(msg.account)).user;
  } catch {
    return [];
  }
  const threadId = msg.thread_id || "";
  // Conversation deja suivie : "Suivre" ne fait que rafraichir sa fiche.
  if (threadId && (await findTrackingItemsByThread(userId, threadId)).length > 0) return [];

  const out: TrackingCandidate[] = [];
  const seen = new Set<string>();
  const push = (item: PBTrackingItem | null | undefined, reason: TrackingCandidateReason) => {
    if (!item || seen.has(item.id) || out.length >= CANDIDATES_MAX) return;
    if (!ficheIsOpen(item) || item.archived) return;
    if (threadId && ficheThreadSet(item).has(threadId)) return;
    seen.add(item.id);
    out.push({ item, reason });
  };

  // 1) Numero d'affaire (commande, colis, facture...) cite dans ce mail.
  push(await findFollowupBySharedNumber(userId, msg, threadId), "number");
  // 2) Avis de transporteur citant le marchand d'une fiche d'expedition.
  for (const f of await findFollowupsByMerchantMention(userId, msg, threadId)) push(f, "carrier");

  // 3) Meme correspondant (adresse nominative) ou meme domaine d'entreprise,
  //    sur une fiche active RECENTE (fenetre de recence autour de ce mail).
  if (out.length < CANDIDATES_MAX) {
    let party = { address: "", domain: "" };
    try {
      const threadMsgs = threadId ? await listMessagesByThread(threadId) : [];
      party = counterpartOf(threadMsgs.length ? threadMsgs : [toThreadMsg(msg)]);
    } catch {
      /* ignore */
    }
    const domain = party.domain;
    if (domain && !PUBLIC_MAIL_DOMAINS.has(domain)) {
      let fiches: PBTrackingItem[] = [];
      try {
        fiches = await listOpenTrackingCandidates(userId, { senderDomain: domain, cap: 20 });
      } catch {
        fiches = [];
      }
      const msgTime = Date.parse(msg.date);
      for (const f of fiches) {
        if (out.length >= CANDIDATES_MAX) break;
        if ((f.sender_domain || "").toLowerCase() !== domain) continue;
        const last = Date.parse(f.last_message_date || f.updated || "");
        if (!Number.isNaN(msgTime) && !Number.isNaN(last) && Math.abs(msgTime - last) > GATHER_WINDOW_MS) continue;
        push(f, isNominativeAddress(party.address) ? "counterpart" : "domain");
      }
    }
  }

  // 4) Contenu tres proche (vecteurs locaux, seuil strict ATTACH_THRESHOLD).
  if (out.length < CANDIDATES_MAX) {
    push(await findMatchingFollowup(userId, messageId, threadId), "similar");
  }
  return out;
}

function ficheThreadSet(item: PBTrackingItem): Set<string> {
  const set = new Set<string>(Array.isArray(item.thread_ids) ? item.thread_ids : []);
  if (item.thread_id) set.add(item.thread_id);
  return set;
}

// --- Analyse a la demande des suivis ETOILES recents (borne) ---

interface StarredAnalyzeState {
  running: boolean;
  total: number;
  done: number;
  attached: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const STARRED_CAP = 60;
const starredAnalyzeStates = new Map<string, StarredAnalyzeState>();

export function getStarredAnalyzeStatus(userId: string): StarredAnalyzeState {
  return (
    starredAnalyzeStates.get(userId) || {
      running: false,
      total: 0,
      done: 0,
      attached: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
    }
  );
}

function isoSinceDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().replace("T", " ").slice(0, 19) + ".000Z";
}

/**
 * Construit les fiches des conversations ETOILEES recentes (fenetre `days`,
 * borne a STARRED_CAP) puis rattache leurs mails lies recents (paiement,
 * expedition, transporteur...) via le filtre vectoriel -> timelines d'evolution.
 * NE touche QUE les conversations etoilees + leurs mails lies. Pas de detection.
 */
export function startStarredAnalyze(userId: string, days = 14): StarredAnalyzeState {
  const current = starredAnalyzeStates.get(userId);
  if (current && current.running) return current;

  const state: StarredAnalyzeState = {
    running: true,
    total: 0,
    done: 0,
    attached: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  starredAnalyzeStates.set(userId, state);

  void (async () => {
    try {
      const apiKey =
        (await getUserOpenRouterKey(userId)) || serverOpenRouterKey() || "";
      if (!apiKey) {
        state.error = "OpenRouter API key manquante";
        return;
      }
      const sinceIso = isoSinceDays(days);
      const accounts = await listAccountsForUser(userId);

      // Phase 1 : fiches des conversations etoilees recentes (dedup thread).
      const starredThreads = new Set<string>();
      const seen = new Set<string>();
      const targets: { threadId: string; accountId: string; seedId: string; date: string }[] = [];
      for (const acc of accounts) {
        const inboxIds = await listInboxFolderIds(acc.id);
        for (const fid of inboxIds) {
          let page = 1;
          while (true) {
            if (!state.running) return;
            const res = await listStarredInboxSince(fid, sinceIso, page, 100);
            if (res.items.length === 0) break;
            for (const m of res.items) {
              const key = m.thread_id ? `t:${m.thread_id}` : `m:${m.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              if (m.thread_id) starredThreads.add(m.thread_id);
              targets.push({ threadId: m.thread_id || "", accountId: m.account, seedId: m.id, date: m.date });
            }
            if (page >= res.totalPages) break;
            page++;
          }
        }
      }
      // Ordre chronologique (la commande avant le paiement/l'expedition) pour des
      // timelines coherentes et un bon rapprochement.
      targets.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const capped = targets.slice(0, STARRED_CAP);
      state.total = capped.length;

      for (const tgt of capped) {
        if (!state.running) return;
        try {
          // Deja suivie -> refresh. Sinon, rapprochement VECTORIEL d'une fiche
          // existante (meme commande etoilee plus tot) -> on rattache au lieu de
          // creer un doublon. Sinon -> nouvelle fiche.
          const existing = tgt.threadId
            ? await findAnyTrackingItemByThread(userId, tgt.threadId)
            : null;
          if (existing) {
            await trackConversation(userId, tgt.accountId, tgt.threadId, tgt.seedId, { apiKey });
          } else {
            const match = await findMatchingFollowup(userId, tgt.seedId, tgt.threadId);
            if (match) {
              await attachThreadToFollowup(userId, match, tgt.threadId, tgt.seedId, apiKey);
              state.attached++;
            } else {
              await trackConversation(userId, tgt.accountId, tgt.threadId, tgt.seedId, { apiKey });
            }
          }
        } catch (err) {
          console.warn("[tracking-starred] build failed:", err);
        }
        state.done++;
        await new Promise((r) => setTimeout(r, 300));
      }

      // Phase 2 : rattacher les mails recents LIES (hors threads etoiles) aux
      // fiches, via vecteurs (Gemini seulement sur un vrai match).
      for (const acc of accounts) {
        const inboxIds = await listInboxFolderIds(acc.id);
        for (const fid of inboxIds) {
          let page = 1;
          while (true) {
            if (!state.running) return;
            const res = await listInboxMessagesForTrackingAsc(fid, sinceIso, page, 100);
            if (res.items.length === 0) break;
            for (const m of res.items) {
              if (!state.running) return;
              if (m.thread_id && starredThreads.has(m.thread_id)) continue; // deja traite
              try {
                await autoProcessMail(userId, m.account, m.thread_id, m.id, m.from_address?.address);
              } catch {
                /* best effort */
              }
              await new Promise((r) => setTimeout(r, 120));
            }
            if (page >= res.totalPages) break;
            page++;
          }
        }
      }
    } catch (err) {
      state.error = (err as Error).message || String(err);
      console.error("[tracking-starred] fatal:", err);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  return state;
}

// --- Reconstruction de MASSE des fiches existantes (a la demande, bornee) ---
//
// Pour chaque fiche ouverte de l'utilisateur, va chercher ses fils lies
// manquants (gather) afin de completer les timelines. Le cout est annonce a
// l'utilisateur AVANT lancement (nombre de fiches), cf /tracking/rebuild-estimate.

interface RebuildAllState {
  running: boolean;
  total: number;
  done: number;
  attached: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const rebuildAllStates = new Map<string, RebuildAllState>();

export function getRebuildAllStatus(userId: string): RebuildAllState {
  return (
    rebuildAllStates.get(userId) || {
      running: false,
      total: 0,
      done: 0,
      attached: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
    }
  );
}

/** Nombre de fiches qui seraient reconstruites (pour annoncer le cout). */
export async function estimateRebuildAll(userId: string): Promise<number> {
  return countOpenTrackingItems(userId);
}

/**
 * Reconstruit TOUTES les fiches ouvertes de l'utilisateur (gather sur chacune).
 * Idempotent (UNIQUE(item, message)) : relancer ne cree pas de doublons. Borne
 * par le nombre de fiches x GATHER_MAX_THREADS. Rate-limite.
 */
export function startRebuildAll(userId: string, clean = false): RebuildAllState {
  const current = rebuildAllStates.get(userId);
  if (current && current.running) return current;

  const state: RebuildAllState = {
    running: true,
    total: 0,
    done: 0,
    attached: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  rebuildAllStates.set(userId, state);

  void (async () => {
    try {
      const apiKey =
        (await getUserOpenRouterKey(userId)) || serverOpenRouterKey() || "";
      if (!apiKey) {
        state.error = "OpenRouter API key manquante";
        return;
      }
      // Collecte des ids AVANT modification (la reconstruction change le tri).
      const ids = await listAllTrackingItemIds(userId);
      state.total = ids.length;
      for (const id of ids) {
        if (!state.running) return;
        try {
          const att = await rebuildFiche(userId, id, clean);
          state.attached += att;
        } catch (err) {
          console.warn("[tracking-rebuild] item failed:", (err as Error).message);
        }
        state.done++;
        await new Promise((r) => setTimeout(r, 250));
      }
      // Passe finale : fusionne les fiches en doublon (meme affaire = fils
      // partages) en gardant la plus riche.
      try {
        const merged = await dedupFichesForUser(userId);
        if (merged > 0) console.log(`[tracking-rebuild] dedup -> ${merged} doublon(s) archive(s)`);
      } catch (err) {
        console.warn("[tracking-rebuild] dedup failed:", (err as Error).message);
      }
    } catch (err) {
      state.error = (err as Error).message || String(err);
      console.error("[tracking-rebuild] fatal:", err);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  return state;
}

// --- Reprise LLM des mails RECENTS (fenetre jours) sur les fiches ouvertes -----
//
// Choix utilisateur (2026-07-07) : au lieu d'attendre les nouveaux mails, on
// repasse les mails inbox des N derniers jours dans le MEME pipeline live
// (autoProcessMail) pour rattraper ceux deja recus mais loupes. Chaque mail non
// deja rattache par un signal gratuit est soumis a UNE adjudication LLM sur les
// fiches ouvertes (llmPickFollowup). Borne par le volume inbox de la fenetre,
// rate-limite, cout annonce AVANT lancement (estimateReprocessRecent). notify OFF
// (batch) pour ne pas declencher de rafale de push.

interface ReprocessRecentState {
  running: boolean;
  total: number;
  done: number;
  attached: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const REPROCESS_DEFAULT_DAYS = 30;
const reprocessRecentStates = new Map<string, ReprocessRecentState>();

export function getReprocessRecentStatus(userId: string): ReprocessRecentState {
  return (
    reprocessRecentStates.get(userId) || {
      running: false,
      total: 0,
      done: 0,
      attached: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
    }
  );
}

/** Nombre de mails inbox dans la fenetre (annonce du cout AVANT lancement). */
export async function estimateReprocessRecent(
  userId: string,
  days = REPROCESS_DEFAULT_DAYS
): Promise<number> {
  const sinceIso = isoSinceDays(days);
  let total = 0;
  try {
    const accounts = await listAccountsForUser(userId);
    for (const acc of accounts) {
      const inboxIds = await listInboxFolderIds(acc.id);
      for (const fid of inboxIds) {
        const res = await listInboxMessagesForTrackingAsc(fid, sinceIso, 1, 1);
        total += res.totalItems || 0;
      }
    }
  } catch {
    /* worker/PB indispo : estimation best effort */
  }
  return total;
}

/**
 * Repasse les mails inbox des `days` derniers jours dans autoProcessMail (meme
 * pipeline que le live, notify OFF). Rattache les mails deja recus mais loupes
 * aux fiches ouvertes. Idempotent (attachThreadToFollowup ne cree pas de doublon ;
 * un mail deja dans une fiche = simple refresh, non compte). Rate-limite.
 */
export function startReprocessRecent(
  userId: string,
  days = REPROCESS_DEFAULT_DAYS
): ReprocessRecentState {
  const current = reprocessRecentStates.get(userId);
  if (current && current.running) return current;

  const state: ReprocessRecentState = {
    running: true,
    total: 0,
    done: 0,
    attached: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  reprocessRecentStates.set(userId, state);

  void (async () => {
    try {
      const apiKey =
        (await getUserOpenRouterKey(userId)) || serverOpenRouterKey() || "";
      if (!apiKey) {
        state.error = "OpenRouter API key manquante";
        return;
      }
      const sinceIso = isoSinceDays(days);
      const accounts = await listAccountsForUser(userId);
      // Denominateur stable (annonce identique a l'estimate) avant de traiter.
      state.total = await estimateReprocessRecent(userId, days);

      for (const acc of accounts) {
        const inboxIds = await listInboxFolderIds(acc.id);
        for (const fid of inboxIds) {
          let page = 1;
          while (true) {
            if (!state.running) return;
            const res = await listInboxMessagesForTrackingAsc(fid, sinceIso, page, 100);
            if (res.items.length === 0) break;
            for (const m of res.items) {
              if (!state.running) return;
              try {
                const linked = await autoProcessMail(
                  userId,
                  m.account,
                  m.thread_id,
                  m.id,
                  m.from_address?.address
                );
                if (linked) state.attached++;
              } catch {
                /* best effort par mail */
              }
              state.done++;
              await new Promise((r) => setTimeout(r, 150));
            }
            if (page >= res.totalPages) break;
            page++;
          }
        }
      }
    } catch (err) {
      state.error = (err as Error).message || String(err);
      console.error("[tracking-reprocess] fatal:", err);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  return state;
}

// --- Analyse a la demande des ECHEANCES des fiches ouvertes (propositions) ----
//
// Pour chaque fiche OUVERTE, un appel LLM FOCALISE (dates uniquement, prompt
// minimal -> peu de tokens) relit ses messages et en sort les dates a venir
// (livraison, RDV, echeance...). On cree des PROPOSITIONS (pending) ; aucun ajout
// auto a l'agenda. Une seule notif recapitulative a la fin (pas de rafale). Le
// drawer du front laisse l'utilisateur ajouter/refuser chaque date.

const DATES_SYSTEM_PROMPT = `Tu extrais les DATES IMPORTANTES A VENIR d'une conversation email de suivi (commande/livraison, rendez-vous, echeance, contrat...). Reponds STRICTEMENT en JSON sur une seule ligne, sans texte autour ni bloc de code :
{"dates":[{"kind":"livraison|rendez-vous|echeance|limite|retour|intervention|paiement|autre","label":"libelle court et clair","date":"AAAA-MM-JJ","time":"HH:MM","time_end":"HH:MM"}]}
Regles : "date" OBLIGATOIRE au format ISO AAAA-MM-JJ -> DEDUIS L'ANNEE a partir des dates des messages (indiquees apres chaque " | "). Omets "time" si l'heure n'est pas precisee. Si une PLAGE horaire est donnee (ex "creneau entre 8h et 11h"), "time" = debut et "time_end" = fin ; omets "time_end" sinon. Heures en heure LOCALE de l'utilisateur, recopiees telles quelles. N'INVENTE JAMAIS de date : uniquement celles reellement presentes (livraison prevue, rendez-vous, date limite de paiement/retour/reponse, fin de garantie, installation/intervention). Ignore les dates passees sans interet. Tableau vide [] si aucune. Langue : francais.`;

/** Construit le bloc de messages (cap tokens) pour l'extraction de dates. */
function buildMessagesText(messages: PBMessageForThread[]): string {
  const slice = messages.slice(-MAX_MSGS);
  let total = 0;
  const parts: string[] = [];
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const who = m.is_sent
      ? "Moi"
      : m.from_address?.name || m.from_address?.address || "?";
    const bodyRaw = htmlToPlain(m.html_body || m.text_body || m.snippet || "");
    const remaining = Math.max(0, TOTAL_CAP - total);
    if (remaining <= 0) break;
    const body = bodyRaw.slice(0, Math.min(PER_MSG_CAP, remaining));
    total += body.length;
    parts.push(`--- [${i}] ${who} | ${m.date} ---\n${body}`);
  }
  return parts.join("\n\n");
}

/** Extraction FOCALISEE des dates a venir d'un jeu de messages (1 petit appel). */
async function extractDatesOnly(
  messages: PBMessageForThread[],
  apiKey: string
): Promise<FicheDate[]> {
  const text = buildMessagesText(messages);
  if (!text.trim()) return [];
  try {
    const res = await aiFetch("tracking-dates", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
        "X-Title": "iMiel",
      },
      body: JSON.stringify({
        model: trackingModel(),
        messages: [
          { role: "system", content: DATES_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        temperature: 0,
        max_tokens: 500,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return [];
    const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return [];
    }
    return parseDatesArray(obj.dates);
  } catch {
    return [];
  }
}

/** Messages (dedup, tries) de TOUS les fils d'une fiche. */
async function messagesOfFiche(item: PBTrackingItem): Promise<PBMessageForThread[]> {
  const threadIds = new Set<string>();
  if (item.thread_id) threadIds.add(item.thread_id);
  for (const t of Array.isArray(item.thread_ids) ? item.thread_ids : []) {
    if (t) threadIds.add(t);
  }
  let messages: PBMessageForThread[] = [];
  for (const tid of threadIds) {
    try {
      messages.push(...(await listMessagesByThread(tid)));
    } catch {
      /* ignore */
    }
  }
  messages = dedupMessages(messages).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  return messages;
}

interface AnalyzeDatesState {
  running: boolean;
  total: number;
  done: number;
  detected: number; // nb de NOUVELLES propositions creees
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const analyzeDatesStates = new Map<string, AnalyzeDatesState>();

export function getAnalyzeDatesStatus(userId: string): AnalyzeDatesState {
  return (
    analyzeDatesStates.get(userId) || {
      running: false,
      total: 0,
      done: 0,
      detected: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
    }
  );
}

/**
 * Lance l'analyse des echeances sur TOUTES les fiches OUVERTES de l'utilisateur.
 * 1 petit appel LLM focalise par fiche. Cree des propositions (pending), envoie
 * UNE notif recapitulative a la fin. Idempotent (dedup par cle). Rate-limite.
 */
export function startAnalyzeDates(userId: string): AnalyzeDatesState {
  const current = analyzeDatesStates.get(userId);
  if (current && current.running) return current;

  const state: AnalyzeDatesState = {
    running: true,
    total: 0,
    done: 0,
    detected: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  analyzeDatesStates.set(userId, state);

  void (async () => {
    let firstSampleTitle = "";
    try {
      const apiKey =
        (await getUserOpenRouterKey(userId)) || serverOpenRouterKey() || "";
      if (!apiKey) {
        state.error = "OpenRouter API key manquante";
        return;
      }
      // Auto-nettoyage : retire d'abord les propositions deja a l'agenda.
      await prunePendingSuggestionsAlreadyInAgenda(userId);
      const ids = await listAllTrackingItemIds(userId);
      const openItems: PBTrackingItem[] = [];
      for (const id of ids) {
        const item = await getTrackingItem(id);
        if (!item || item.archived || !ficheIsOpen(item)) continue;
        openItems.push(item);
      }
      state.total = openItems.length;

      for (const item of openItems) {
        if (!state.running) return;
        try {
          const messages = await messagesOfFiche(item);
          if (messages.length > 0) {
            const dates = await extractDatesOnly(messages, apiKey);
            if (dates.length > 0) {
              const title = item.title || "";
              const created = await proposeTrackingDates(userId, item.id, title, dates);
              if (created > 0) {
                state.detected += created;
                if (!firstSampleTitle) {
                  firstSampleTitle = prepareDates(item.id, title, dates)[0]?.title || "";
                }
              }
            }
          }
        } catch (err) {
          console.warn("[tracking-dates] item failed:", (err as Error).message);
        }
        state.done++;
        await new Promise((r) => setTimeout(r, 200));
      }

      // UNE notif recapitulative s'il y a du neuf.
      if (state.detected > 0) {
        try {
          if (await getUserNotificationsEnabled(userId)) {
            await sendCalendarSuggestionNotification(userId, state.detected, firstSampleTitle);
          }
        } catch (err) {
          console.warn("[tracking-dates] notif failed:", (err as Error).message);
        }
      }
      console.log(
        `[tracking-dates] user=${userId} fiches=${state.total} -> ${state.detected} proposition(s)`
      );
    } catch (err) {
      state.error = (err as Error).message || String(err);
      console.error("[tracking-dates] fatal:", err);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  return state;
}

/** Estimation GRATUITE : nb de fiches ouvertes (= nb d'appels LLM de l'analyse). */
export async function estimateAnalyzeDates(userId: string): Promise<number> {
  return countOpenTrackingItems(userId);
}
