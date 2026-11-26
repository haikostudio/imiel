// Memoire des contacts : la fiche "qui est qui" que l'IA de reponse recoit
// comme information DEJA ETABLIE (role, organisation, lien avec moi, faits,
// personnes du meme dossier), au lieu de tout re-deduire a chaque mail.
//
// - Collecte RAPIDE des echanges avec une personne : l'index plein texte du
//   worker (colonnes expediteur/destinataires, search-index.ts) donne les ids,
//   puis lecture ponctuelle des lignes dans data.db (lecture seule). L'ancienne
//   requete PocketBase (LIKE sur les destinataires JSON de ~42k mails) depassait
//   20 s : l'IA repondait alors sans aucun historique. Repli API borne si la
//   lecture directe est inactive.
// - Fiche creee a la PREMIERE reponse IA vers la personne, puis mise a jour avec
//   les SEULS mails posterieurs a la derniere analyse (aucun nouveau mail =
//   aucun appel IA). Un seul appel JSON sur un modele peu cher.
// - Les corrections de l'utilisateur (champs fixes, faits retires, note libre)
//   priment toujours : mergeMemory ne les ecrase jamais.
// Ecritures par l'API PocketBase (le worker n'ecrit jamais dans data.db).

import { backgroundModel } from "./ai-models";
import { getPbDb, isSqliteDirectAvailable } from "./sqlite-direct";
import { ensureSearchIndexFresh, searchDocs } from "./search-index";
import { ftsPhrase } from "./search-query";
import { aiFetch, serverOpenRouterKey } from "./ai-budget";
import {
  createContactMemory,
  findContactMemories,
  listAccountsForUser,
  listMessagesForAddressesApi,
  updateContactMemory,
  type PBContactMemory,
  type PBEmailAddress,
} from "./pocketbase";
import {
  MEMORY_MAX_MAILS,
  canonAddr,
  isAutomatedAddress,
  mailsAfter,
  mergeMemory,
  normalizeAiMemory,
  relatedParticipants,
  selectPersonMails,
  type ContactMemoryData,
  type MemoryAddr,
  type MemoryMail,
} from "./contact-memory-rules";

const MEMORY_MODEL = backgroundModel("OPENROUTER_MODEL_CONTACT_MEMORY");
const AI_TIMEOUT_MS = 60_000;
const API_FALLBACK_TIMEOUT_MS = 8_000;
// Candidats lus dans l'index avant tri (doublons de comptes relies, automates).
const CANDIDATE_FACTOR = 4;
const SECONDARY_LABEL_NAMES = new Set(["newsletter", "notification", "promotion", "soldes", "reseaux sociaux"]);

function safeJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function htmlToText(html: string): string {
  return (html || "")
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function readable(text: string, html: string): string {
  const t = (text || "").trim();
  if (t.length >= 40) return t;
  return htmlToText(html) || t;
}

/** Adresses de l'utilisateur (comptes), forme canonique. */
export async function myAddresses(userId: string): Promise<Set<string>> {
  return (await myIdentity(userId)).addrs;
}

/** Adresses + nom de l'utilisateur (nom d'affichage d'un compte, sinon "MOI"). */
async function myIdentity(userId: string): Promise<{ addrs: Set<string>; name: string }> {
  const accounts = await listAccountsForUser(userId).catch(() => []);
  const name =
    accounts.map((a) => (a.display_name || "").trim()).find((n) => n.length >= 2 && !n.includes("@")) || "MOI";
  return { addrs: new Set(accounts.map((a) => canonAddr(a.email)).filter(Boolean)), name };
}

function secondaryLabelIds(userId: string): Set<string> {
  const db = getPbDb();
  const out = new Set<string>();
  if (!db) return out;
  try {
    const rows = db
      .prepare(`SELECT id, name, is_secondary FROM labels WHERE user = ?`)
      .all(userId) as { id: string; name: string; is_secondary: number }[];
    for (const r of rows) {
      if (r.is_secondary || SECONDARY_LABEL_NAMES.has((r.name || "").trim().toLowerCase())) out.add(r.id);
    }
  } catch {
    /* table absente : aucun label ecarte */
  }
  return out;
}

interface RawRow {
  id: string;
  message_id: string;
  thread_id: string;
  subject: string;
  date: string;
  from_address: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  is_sent: number;
  is_draft: number;
  labels: string | null;
  text_body: string | null;
  html_body: string | null;
  folder_type: string | null;
  bulk: number;
}

function readRowsByIds(ids: string[]): RawRow[] | null {
  const db = getPbDb();
  if (!db) return null;
  const out: RawRow[] = [];
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const rows = db
        .prepare(
          `SELECT m.id, m.message_id, m.thread_id, m.subject, m.date, m.from_address,
                  m.to_addresses, m.cc_addresses, m.is_sent, m.is_draft, m.labels,
                  substr(m.text_body, 1, 6000) AS text_body,
                  CASE WHEN length(m.text_body) < 40 THEN substr(m.html_body, 1, 30000) ELSE '' END AS html_body,
                  f.type AS folder_type,
                  (instr(m.raw_headers, 'List-Unsubscribe') > 0
                   OR instr(lower(m.raw_headers), 'precedence: bulk') > 0
                   OR instr(lower(m.raw_headers), 'precedence: list') > 0) AS bulk
           FROM messages m LEFT JOIN folders f ON f.id = m.folder
           WHERE m.id IN (${chunk.map(() => "?").join(",")})`
        )
        .all(...chunk) as RawRow[];
      out.push(...rows);
    }
    return out;
  } catch (err) {
    console.warn(`[contact-memory] lecture des mails en echec: ${(err as Error).message}`);
    return null;
  }
}

function toMemoryMail(r: RawRow, secondary: Set<string>): MemoryMail {
  const labels = safeJson<string[]>(r.labels) || [];
  return {
    id: r.id,
    message_id: r.message_id || "",
    thread_id: r.thread_id || "",
    subject: r.subject || "",
    date: r.date || "",
    from: safeJson<PBEmailAddress>(r.from_address),
    to: safeJson<PBEmailAddress[]>(r.to_addresses) || [],
    cc: safeJson<PBEmailAddress[]>(r.cc_addresses) || [],
    is_sent: !!r.is_sent,
    folder_type: r.folder_type || "",
    bulk: !!r.bulk,
    secondary: labels.some((l) => secondary.has(l)),
    text: readable(r.text_body || "", r.html_body || ""),
  };
}

/**
 * Mails de/vers ces adresses (brouillons exclus), du plus recent au plus
 * ancien, adresses verifiees exactement (l'index trouve par mots). null =
 * lecture directe indisponible.
 */
function findMailsDirect(userId: string, addresses: string[], limit: number): MemoryMail[] | null {
  if (!isSqliteDirectAvailable()) return null;
  const addrs = addresses.map(canonAddr).filter((a) => a.includes("@")).slice(0, 6);
  if (addrs.length === 0) return [];
  const match = addrs.map((a) => `{sender recipients} : ${ftsPhrase(a, false)}`).join(" OR ");
  const keys = searchDocs({ userId, match, isDraft: false, orderBy: "date", limit: limit * CANDIDATE_FACTOR });
  if (!keys) return null;
  const rows = readRowsByIds(keys.map((k) => k.id));
  if (!rows) return null;
  const secondary = secondaryLabelIds(userId);
  const wanted = new Set(addrs);
  return rows
    .filter((r) => !r.is_draft)
    .map((r) => toMemoryMail(r, secondary))
    .filter((m) => [m.from, ...m.to, ...m.cc].some((a) => wanted.has(canonAddr(a?.address))))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Collecte : lecture directe, sinon API PocketBase bornee (vide en cas de depassement). */
export async function findMailsWithAddresses(
  userId: string,
  addresses: string[],
  limit: number
): Promise<{ mails: MemoryMail[]; source: "direct" | "api" | "none" }> {
  // Rattrape les mails arrives depuis la derniere passe de l'index (<= 5 s).
  if (isSqliteDirectAvailable()) await ensureSearchIndexFresh().catch(() => undefined);
  const direct = findMailsDirect(userId, addresses, limit);
  if (direct) return { mails: direct, source: "direct" };
  try {
    const items = await listMessagesForAddressesApi(
      userId,
      addresses.map(canonAddr),
      limit * 2,
      API_FALLBACK_TIMEOUT_MS
    );
    const mails = items.map<MemoryMail>((m) => ({
      id: m.id,
      message_id: m.message_id || "",
      thread_id: m.thread_id || "",
      subject: m.subject || "",
      date: m.date || "",
      from: m.from_address,
      to: m.to_addresses || [],
      cc: m.cc_addresses || [],
      is_sent: !!m.is_sent,
      folder_type: "",
      bulk: false,
      secondary: false,
      text: readable(m.text_body || "", m.html_body || ""),
    }));
    return { mails, source: "api" };
  } catch (err) {
    console.warn(`[contact-memory] repli API en echec: ${(err as Error).message}`);
    return { mails: [], source: "none" };
  }
}

/**
 * Echanges bruts avec une personne, au format attendu par l'agent de reponse
 * (ExchangeCandidate du frontend) : la selection fine (deux sens, 20 derniers)
 * reste faite cote route.
 */
export async function listExchangeCandidates(userId: string, addresses: string[], limit = 60) {
  const t0 = Date.now();
  const { mails, source } = await findMailsWithAddresses(userId, addresses, limit);
  const mine = await myAddresses(userId);
  const items = mails
    .filter((m) => m.is_sent || mine.has(canonAddr(m.from?.address)) || (!m.bulk && !m.secondary))
    .slice(0, limit)
    .map((m) => ({
      id: m.id,
      message_id: m.message_id,
      subject: m.subject,
      date: m.date,
      from_address: m.from,
      to_addresses: m.to,
      cc_addresses: m.cc,
      is_draft: false,
      text_body: m.text,
    }));
  return { items, source, ms: Date.now() - t0 };
}

// --- Construction / mise a jour de la fiche ---------------------------------

function toData(rec: PBContactMemory | null, addresses: string[], name: string): ContactMemoryData {
  return {
    name: rec?.name || name,
    addresses: Array.from(new Set([...(rec?.addresses || []), ...addresses].map(canonAddr).filter(Boolean))),
    role: rec?.role || "",
    organization: rec?.organization || "",
    relation: rec?.relation || "",
    facts: rec?.facts || [],
    related: rec?.related || [],
    user_notes: rec?.user_notes || "",
    locked: rec?.locked || [],
    dismissed: rec?.dismissed || [],
  };
}

function label(a: MemoryAddr | null | undefined, mine: Set<string>): string {
  const c = canonAddr(a?.address);
  if (mine.has(c)) return "MOI";
  const n = (a?.name || "").trim();
  return n && !n.includes("@") ? `${n} <${c}>` : c || "?";
}

function formatMailsForMemory(mails: MemoryMail[], mine: Set<string>, maxChars: number): string {
  const blocks: string[] = [];
  let used = 0;
  for (const m of mails.slice().sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const from = m.is_sent ? "MOI" : label(m.from, mine);
    const to = m.to.map((a) => label(a, mine)).join(", ");
    const cc = m.cc.length ? ` | Cc: ${m.cc.map((a) => label(a, mine)).join(", ")}` : "";
    const text = stripQuotedText(m.text).slice(0, 900);
    const block = `[${m.date.slice(0, 10)}] De: ${from} | A: ${to}${cc} | Sujet: ${m.subject || "(sans sujet)"}\n${text}`;
    if (used + block.length > maxChars && blocks.length > 0) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join("\n\n---\n\n");
}

/** Retire l'historique cite (lignes ">" et "Le ... a ecrit :"). */
export function stripQuotedText(text: string): string {
  const kept: string[] = [];
  for (const line of (text || "").replace(/\r/g, "").split("\n")) {
    const l = line.trim();
    if (/^>/.test(l)) continue;
    if (
      /^(le|on|am|il)\s.+(a ecrit|a écrit|wrote|schrieb|ha scritto)\s*:?\s*$/i.test(l) ||
      /^-{2,}\s*(original message|message d'origine|urspr[uü]ngliche nachricht)/i.test(l) ||
      /^(de|from|von)\s*:\s.+@/i.test(l)
    ) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function describeExisting(d: ContactMemoryData): string {
  const lines = [
    d.role ? `- Role : ${d.role}${d.locked.includes("role") ? " (CORRIGE PAR L'UTILISATEUR, fait foi)" : ""}` : "",
    d.organization
      ? `- Organisation : ${d.organization}${d.locked.includes("organization") ? " (CORRIGE PAR L'UTILISATEUR, fait foi)" : ""}`
      : "",
    d.relation
      ? `- Lien avec MOI : ${d.relation}${d.locked.includes("relation") ? " (CORRIGE PAR L'UTILISATEUR, fait foi)" : ""}`
      : "",
    ...d.facts.map((f) => `- Fait : ${f}`),
    ...d.related.map((p) => `- Personne liee : ${p.name || p.address}${p.address ? ` <${p.address}>` : ""} - ${p.role}`),
    d.user_notes ? `- NOTE DE L'UTILISATEUR (fait foi sur tout le reste) : ${d.user_notes}` : "",
    d.dismissed.length ? `- Faits FAUX selon l'utilisateur (ne jamais les remettre) : ${d.dismissed.join(" ; ")}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

const systemPrompt = (meName: string) => `Tu tiens la fiche "qui est qui" d'un correspondant de l'utilisateur (etiquete MOI dans les mails). Cette fiche sert ensuite a une IA qui redige les reponses de MOI : elle doit savoir QUI est cette personne, ce qu'elle FAIT, et ce que MOI fais pour elle.

Renvoie UNIQUEMENT un objet JSON valide :
- "name": nom complet de la personne (tel qu'elle signe), sinon "".
- "role": sa fonction / son role dans les echanges (ex: "Coordinateur de la plateforme Atelier60", "Client, donne les demandes de corrections"), court.
- "organization": son organisation / entreprise, sinon "".
- "relation": le lien entre elle et MOI, en precisant QUI FAIT QUOI (ex: "Client de MOI ; MOI suis le developpeur et l'administrateur technique de la plateforme"), 1 phrase.
- "facts": 3 a 10 faits DURABLES et utiles pour lui repondre (projets en cours, responsabilites de chacun, decisions prises, habitudes, preferences). Pas d'anecdote datee sans portee, pas de contenu de newsletter.
- "related": les personnes du meme dossier (co-destinataires, personnes citees) : [{"name","address","role"}] ; "role" dit ce que cette personne fait dans le dossier PAR RAPPORT a MOI (ex: "client, transmet les demandes de corrections a MOI et valide les livraisons"), meme regle de deduction.
- "me_role": en une phrase, ce que fait l'utilisateur dans ces echanges (metier / role), deduit des mails.

Regles :
- N'affirme que ce que les mails montrent. Dans le doute, n'ecris rien plutot qu'une supposition.
- Ne confonds JAMAIS les auteurs : "De: MOI" est ecrit par l'utilisateur.
- Deduis le role de chacun de ce qu'il ECRIT LUI-MEME, pas de ce qu'un autre dit de lui en passant. Qui demande une correction, une fonctionnalite ou une intervention, envoie un contrat ou une offre, teste et valide ("teste, tu peux deployer") est cote CLIENT / donneur d'ordre (chef de projet, mandant...) : ce n'est PAS lui qui realise le travail. Celui a qui ces demandes sont adressees et qui livre (le plus souvent MOI) est le prestataire qui realise.
- Les mails de MOI peuvent contenir des formulations approximatives : en cas de contradiction, ce que les AUTRES demandent a MOI et ce que MOI livre fait foi.
- Une valeur "CORRIGE PAR L'UTILISATEUR" ou une "NOTE DE L'UTILISATEUR" fait foi : ne la contredis jamais, aligne le reste dessus.
- Pour une MISE A JOUR, renvoie la fiche COMPLETE revue (garde les faits encore vrais, ajoute les nouveaux, retire ceux que les nouveaux mails rendent faux).
- La fiche est lue par l'utilisateur : dans TOUS les champs, designe-le par son nom "${meName}" a la 3e personne (ex: "Client de ${meName} ; ${meName} est le developpeur..."), jamais "MOI" ni "je".
- Redige en francais.`;

async function callMemoryAi(system: string, user: string): Promise<unknown | null> {
  const apiKey = serverOpenRouterKey();
  if (!apiKey) return null;
  try {
    const res = await aiFetch("contact-memory", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://pb.example.com",
        "X-Title": "iMiel",
      },
      body: JSON.stringify({
        model: MEMORY_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.1,
        max_tokens: 1400,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[contact-memory] IA HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content || "";
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (err) {
    console.warn(`[contact-memory] IA en echec: ${(err as Error).message}`);
    return null;
  }
}

export interface EnsureMemoryInput {
  userId: string;
  addresses: string[];
  name?: string;
  /** Adresses des participants du fil en cours : leurs fiches existantes sont rendues (sans construction). */
  participants?: string[];
}

export interface EnsureMemoryResult {
  me: PBContactMemory | null;
  person: PBContactMemory | null;
  others: PBContactMemory[];
  /** built = premiere analyse ; updated = nouveaux mails integres ; unchanged = rien de neuf (aucun appel IA). */
  status: "built" | "updated" | "unchanged" | "empty" | "error";
  newMails: number;
  ms: number;
}

/** Cles uniques par adresse : une course entre deux reponses ne cree pas deux fiches. */
async function saveMemory(
  userId: string,
  existing: PBContactMemory | null,
  data: Partial<PBContactMemory>,
  key: string
): Promise<PBContactMemory | null> {
  try {
    if (existing) return await updateContactMemory(existing.id, data);
    return await createContactMemory({ ...data, user: userId, key });
  } catch (err) {
    // Conflit d'unicite (fiche creee entre-temps) : on relit et on met a jour.
    const again = (await findContactMemories(userId, [key]).catch(() => []))[0];
    if (again) return updateContactMemory(again.id, data).catch(() => again);
    console.warn(`[contact-memory] enregistrement en echec: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Fiche de la personne a jour (construite a la premiere demande, puis
 * completee avec les seuls nouveaux mails), plus la fiche "Moi" et les fiches
 * existantes des personnes liees / du fil.
 */
export async function ensureContactMemory(input: EnsureMemoryInput): Promise<EnsureMemoryResult> {
  const t0 = Date.now();
  const { userId } = input;
  const { addrs: mine, name: meName } = await myIdentity(userId);
  const person = Array.from(
    new Set(input.addresses.map(canonAddr).filter((a) => a.includes("@") && !mine.has(a)))
  );
  const done = (r: Omit<EnsureMemoryResult, "ms">): EnsureMemoryResult => ({ ...r, ms: Date.now() - t0 });
  if (person.length === 0) return done({ me: null, person: null, others: [], status: "empty", newMails: 0 });

  const known = await findContactMemories(userId, ["me", ...person]).catch(() => [] as PBContactMemory[]);
  let me = known.find((k) => k.key === "me") || null;
  let rec = known.find((k) => k.key !== "me") || null;
  const personSet = new Set([...person, ...(rec?.addresses || []).map(canonAddr)]);

  const { mails } = await findMailsWithAddresses(userId, Array.from(personSet), MEMORY_MAX_MAILS * 2);
  const personMails = selectPersonMails(mails, personSet, mine, MEMORY_MAX_MAILS * 2);
  const fresh = rec?.built_at ? mailsAfter(personMails, rec.last_message_date || "") : personMails;
  let status: EnsureMemoryResult["status"] = "unchanged";

  if (fresh.length > 0) {
    const batch = fresh.slice(0, MEMORY_MAX_MAILS);
    const existing = toData(rec, person, (input.name || "").trim());
    const isBuild = !rec?.built_at;

    // Personnes du meme dossier : leurs derniers vrais echanges completent la
    // premiere construction (qui demande quoi, qui fait quoi).
    let relatedBlock = "";
    if (isBuild) {
      const others = relatedParticipants(personMails, personSet, mine, 3);
      const parts: string[] = [];
      for (const o of others) {
        const found = await findMailsWithAddresses(userId, [o.address], 12);
        const own = new Set([o.address]);
        const sel = selectPersonMails(found.mails, own, mine, 5).filter((m) => !batch.some((b) => b.id === m.id));
        if (sel.length) {
          parts.push(`### Mails ou figure ${o.name || o.address} <${o.address}>\n${formatMailsForMemory(sel, mine, 3500)}`);
        }
      }
      if (parts.length) relatedBlock = `\n\nEchanges avec des personnes du meme dossier (pour situer les roles de chacun) :\n${parts.join("\n\n")}`;
    }

    const meText = [me?.role ? `Role de MOI : ${me.role}` : "", me?.user_notes ? `MOI selon l'utilisateur (fait foi) : ${me.user_notes}` : ""]
      .filter(Boolean)
      .join("\n");
    const userPrompt = `MOI = l'utilisateur, ${meName}.
Personne : ${existing.name || person[0]} (${Array.from(personSet).join(", ")})
${meText ? `\n${meText}\n` : ""}
${isBuild ? "PREMIERE construction de la fiche." : "MISE A JOUR de la fiche existante avec les nouveaux mails."}
${existing.role || existing.facts.length || existing.user_notes ? `\nFiche actuelle :\n${describeExisting(existing)}\n` : ""}
${isBuild ? "Echanges avec la personne" : "NOUVEAUX mails depuis la derniere analyse"} (du plus ancien au plus recent) :
${formatMailsForMemory(batch, mine, 28_000)}${relatedBlock}`;

    if (process.env.CONTACT_MEMORY_DEBUG) console.log(`[contact-memory] prompt:\n${userPrompt}`);
    const raw = await callMemoryAi(systemPrompt(meName), userPrompt.slice(0, 48_000));
    if (raw) {
      const ai = normalizeAiMemory(raw);
      const merged = mergeMemory(existing, ai);
      const newest = fresh.reduce((acc, m) => (m.date > acc ? m.date : acc), rec?.last_message_date || "");
      const saved = await saveMemory(
        userId,
        rec,
        {
          name: merged.name.slice(0, 200),
          addresses: merged.addresses,
          role: merged.role,
          organization: merged.organization,
          relation: merged.relation,
          facts: merged.facts,
          related: merged.related,
          last_message_date: newest,
          analyzed_count: (rec?.analyzed_count || 0) + batch.length,
          model: MEMORY_MODEL,
          built_at: new Date().toISOString().replace("T", " "),
        },
        person[0]
      );
      if (saved) {
        rec = saved;
        status = isBuild ? "built" : "updated";
      } else status = "error";
      // Fiche "Moi" encore vide : on y pose le role deduit, que l'utilisateur corrigera.
      if (ai.me_role && !me?.role && !(me?.locked || []).includes("role")) {
        me = (await saveMemory(userId, me, { role: ai.me_role, name: me?.name || "Moi" }, "me")) || me;
      }
    } else status = "error";
  } else if (!rec) {
    status = "empty";
  }

  // Fiches deja connues des personnes liees et des participants du fil.
  const otherKeys = new Set<string>();
  for (const p of rec?.related || []) if (p.address) otherKeys.add(p.address);
  for (const a of input.participants || []) {
    const c = canonAddr(a);
    if (c.includes("@") && !mine.has(c) && !personSet.has(c) && !isAutomatedAddress(c)) otherKeys.add(c);
  }
  const others = otherKeys.size
    ? (await findContactMemories(userId, Array.from(otherKeys)).catch(() => [] as PBContactMemory[])).filter(
        (o) => o.key !== "me" && o.id !== rec?.id && (o.role || o.relation || o.user_notes || (o.facts || []).length)
      )
    : [];

  return done({ me, person: rec, others: others.slice(0, 8), status, newMails: fresh.length });
}
