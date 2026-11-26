/**
 * Etiquettes de sujet des newsletters (GPT, Gemini, Securite, Generation
 * d'images...) et leurs statistiques.
 *
 * - Les NOUVELLES newsletters sont etiquetees dans le MEME appel IA que la
 *   synthese (ligne "TAGS: ..." juste apres "TITRE: ...", parsee puis retiree,
 *   cf. newsletter.ts) : aucun cout en plus.
 * - Les etiquettes deja employees par l'utilisateur sont donnees au modele, et
 *   toute etiquette egale a une existante a la casse / aux accents / aux espaces
 *   pres prend son ecriture (jamais "GPT" et "gpt" cote a cote). "GPT" et
 *   "GPT-5" restent DISTINCTES : seul l'utilisateur les fusionne (renommage).
 * - Rattrapage : les syntheses des 90 derniers jours sans etiquettes sont
 *   etiquetees en tache de fond, par lots, sous le budget IA (ai-budget.ts).
 *   `tags_done` marque une synthese traitee : jamais deux passages.
 */

import { backgroundModel } from "./ai-models";
import { aiFetch, parisDay, serverOpenRouterKey } from "./ai-budget";
import {
  getUserOpenRouterKey,
  listAllNewsletterPosts,
  listNewsletterPostsPage,
  updateNewsletterPost,
  type PBNewsletterPost,
} from "./pocketbase";
import { htmlToPlain } from "./newsletter";

export const TAGS_PER_POST = 5;
const TAG_MAX_LEN = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Regles pures (testees dans newsletter-tags.test.ts)
// ---------------------------------------------------------------------------

/** Cle de comparaison : minuscules, sans accents, espaces resserres. */
export function foldTag(tag: string): string {
  return (tag || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Nettoie une etiquette brute ; "" si inutilisable. */
export function cleanTag(raw: string): string {
  let t = (raw || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/^[\s#"'\u00ab\u201c.\-]+/, "")
    .replace(/[\s"'\u00bb\u201d.]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || /^(aucune?|none|n\/a|-)$/i.test(t)) return "";
  if (t.length > TAG_MAX_LEN) t = t.slice(0, TAG_MAX_LEN).trim();
  // Un theme ecrit tout en minuscules prend une majuscule ; un nom de produit
  // ("iOS", "GPT", "xAI") garde son ecriture.
  if (t === t.toLowerCase()) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

/**
 * Etiquettes finales d'une newsletter : nettoyees, alignees sur l'ecriture
 * des etiquettes deja connues (meme cle `foldTag`), sans doublon, 5 au plus.
 */
export function canonicalTags(raw: string[], known: string[] = []): string[] {
  const byFold = new Map<string, string>();
  for (const k of known) {
    const f = foldTag(k);
    if (f && !byFold.has(f)) byFold.set(f, k);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const c = cleanTag(r);
    if (!c) continue;
    const f = foldTag(c);
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(byFold.get(f) || c);
    if (out.length >= TAGS_PER_POST) break;
  }
  return out;
}

/** Decoupe "a, b ; c" en etiquettes brutes. */
export function splitTagList(line: string): string[] {
  return (line || "").split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Extrait et retire la ligne "TAGS: ..." (tolere <p>, gras, "Etiquettes :").
 * Cherchee d'abord en tete (place demandee, juste apres TITRE), puis sur une
 * ligne seule n'importe ou. Sans ligne : tags [].
 */
export function parseTagsLine(text: string): { html: string; tags: string[] } {
  const head =
    /^\s*(?:<p\b[^>]*>)?\s*(?:\*\*|<strong>)?\s*(?:TAGS|[EÉ]TIQUETTES)\s*:\s*(?:\*\*|<\/strong>)?\s*([^\n<]*?)\s*(?:\*\*)?\s*(?:<\/strong>)?\s*(?:<\/p>)?\s*(?:\n|$|(?=<))/i;
  const m = head.exec(text);
  if (m) return { html: text.slice(m[0].length).trim(), tags: splitTagList(m[1]) };
  const anywhere =
    /(?:^|\n)\s*(?:<p\b[^>]*>)?\s*(?:\*\*|<strong>)?\s*(?:TAGS|[EÉ]TIQUETTES)\s*:\s*(?:\*\*|<\/strong>)?\s*([^\n<]*?)\s*(?:<\/p>)?\s*(?=\n|$)/i;
  const a = anywhere.exec(text);
  if (!a) return { html: text, tags: [] };
  return {
    html: (text.slice(0, a.index) + text.slice(a.index + a[0].length)).trim(),
    tags: splitTagList(a[1]),
  };
}

/** Remplace `from` par `to` (a la cle foldTag pres) ; fusion sans doublon. */
export function renameTagInList(tags: string[], from: string, to: string): string[] {
  const ff = foldTag(from);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags || []) {
    const v = foldTag(t) === ff ? to : t;
    const f = foldTag(v);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(v);
  }
  return out;
}

/** Semaine ISO "2026-W42" d'une date (calendrier de Paris). */
export function isoWeekKey(d: Date): string {
  const [y, m, day] = parisDay(d).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, day));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Ajoute `n` jours a un jour "YYYY-MM-DD". */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Jours "YYYY-MM-DD" de from a to inclus. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 1000; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Lundi (jour "YYYY-MM-DD") de la semaine d'un jour donne. */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return addDays(day, 1 - dow);
}

export interface TagStat {
  tag: string;
  count: number;
  prevCount: number;
  /** Variation absolue par rapport a la periode precedente. */
  delta: number;
}

export interface NewsletterStats {
  from: string;
  to: string;
  total: number;
  prevTotal: number;
  untagged: number;
  perDay: { date: string; count: number }[];
  tags: TagStat[];
  rising: TagStat[];
  series: {
    granularity: "day" | "week";
    tags: string[];
    points: Array<{ date: string } & Record<string, number | string>>;
  };
}

type StatPost = Pick<PBNewsletterPost, "message_date" | "tags">;

function postDay(p: StatPost): string {
  const t = Date.parse((p.message_date || "").replace(" ", "T"));
  return Number.isFinite(t) ? parisDay(new Date(t)) : "";
}

/**
 * Statistiques d'une periode [from, to] (jours de Paris, inclus), comparees a
 * la periode precedente de meme longueur. `posts` couvre les deux periodes.
 */
export function computeNewsletterStats(posts: StatPost[], from: string, to: string, seriesTop = 6): NewsletterStats {
  const days = dayRange(from, to);
  const len = days.length;
  const prevFrom = addDays(from, -len);
  const prevTo = addDays(from, -1);

  const perDay = new Map(days.map((d) => [d, 0]));
  const cur = new Map<string, number>();
  const prev = new Map<string, number>();
  // Ecriture affichee d'un sujet : la plus frequente (a egalite, la premiere vue).
  const spellings = new Map<string, Map<string, number>>();
  const curPosts: { day: string; tags: string[] }[] = [];
  let total = 0;
  let prevTotal = 0;
  let untagged = 0;

  for (const p of posts) {
    const day = postDay(p);
    if (!day) continue;
    const tags = Array.isArray(p.tags) ? p.tags : [];
    const inCur = day >= from && day <= to;
    const inPrev = day >= prevFrom && day <= prevTo;
    if (!inCur && !inPrev) continue;
    if (inCur) {
      total++;
      perDay.set(day, (perDay.get(day) || 0) + 1);
      if (tags.length === 0) untagged++;
      curPosts.push({ day, tags });
    } else {
      prevTotal++;
    }
    const seen = new Set<string>();
    for (const t of tags) {
      const f = foldTag(t);
      if (!f || seen.has(f)) continue;
      seen.add(f);
      const sp = spellings.get(f) || new Map<string, number>();
      sp.set(t, (sp.get(t) || 0) + 1);
      spellings.set(f, sp);
      const m = inCur ? cur : prev;
      m.set(f, (m.get(f) || 0) + 1);
    }
  }

  const label = (f: string): string => {
    let best = f;
    let n = 0;
    for (const [t, c] of spellings.get(f) || []) if (c > n) [best, n] = [t, c];
    return best;
  };
  const tags: TagStat[] = Array.from(new Set([...cur.keys(), ...prev.keys()]))
    .map((f) => {
      const count = cur.get(f) || 0;
      const prevCount = prev.get(f) || 0;
      return { tag: label(f), count, prevCount, delta: count - prevCount };
    })
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count || b.delta - a.delta || a.tag.localeCompare(b.tag));

  const rising = tags
    .filter((s) => s.delta > 0)
    .sort((a, b) => b.delta - a.delta || b.count - a.count)
    .slice(0, 5);

  const granularity: "day" | "week" = len <= 45 ? "day" : "week";
  const top = tags.slice(0, seriesTop).map((s) => s.tag);
  const topFold = new Map(top.map((t) => [foldTag(t), t]));
  const bucketOf = (day: string) => (granularity === "day" ? day : mondayOf(day));
  const buckets = Array.from(new Set(days.map(bucketOf)));
  const points = new Map<string, { date: string } & Record<string, number | string>>(
    buckets.map((b) => [b, { date: b, ...Object.fromEntries(top.map((t) => [t, 0])) }])
  );
  for (const p of curPosts) {
    const pt = points.get(bucketOf(p.day));
    if (!pt) continue;
    const seen = new Set<string>();
    for (const t of p.tags) {
      const f = foldTag(t);
      const name = topFold.get(f);
      if (!name || seen.has(f)) continue;
      seen.add(f);
      pt[name] = (Number(pt[name]) || 0) + 1;
    }
  }

  return {
    from,
    to,
    total,
    prevTotal,
    untagged,
    perDay: days.map((d) => ({ date: d, count: perDay.get(d) || 0 })),
    tags,
    rising,
    series: { granularity, tags: top, points: Array.from(points.values()) },
  };
}

// ---------------------------------------------------------------------------
// Etiquettes connues d'un utilisateur (consigne IA + suggestions)
// ---------------------------------------------------------------------------

const KNOWN_TTL_MS = 10 * 60 * 1000;
const knownCache = new Map<string, { at: number; tags: string[] }>();

export function invalidateKnownTags(userId: string): void {
  knownCache.delete(userId);
}

function pbDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ");
}

/** Etiquettes employees sur 180 jours, les plus frequentes d'abord. */
export async function listKnownTags(userId: string, limit = 80): Promise<string[]> {
  const hit = knownCache.get(userId);
  if (hit && Date.now() - hit.at < KNOWN_TTL_MS) return hit.tags.slice(0, limit);
  const posts = await listAllNewsletterPosts(
    `user = "${userId}" && message_date >= "${pbDate(Date.now() - 180 * DAY_MS)}"`,
    "tags",
    10
  );
  const counts = new Map<string, { tag: string; n: number }>();
  for (const p of posts) {
    for (const t of Array.isArray(p.tags) ? p.tags : []) {
      const f = foldTag(t);
      if (!f) continue;
      const c = counts.get(f);
      if (c) c.n++;
      else counts.set(f, { tag: t, n: 1 });
    }
  }
  const tags = Array.from(counts.values())
    .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
    .map((c) => c.tag);
  knownCache.set(userId, { at: Date.now(), tags });
  return tags.slice(0, limit);
}

/** Consigne a ajouter au prompt de synthese (ligne TAGS apres TITRE). */
export function tagsInstruction(known: string[]): string {
  const list = known.length ? `\nEtiquettes deja employees (reprends EXACTEMENT leur ecriture quand le sujet est le meme) : ${known.join(", ")}.` : "";
  return `

ETIQUETTES : juste apres la ligne TITRE et avant le HTML, ajoute UNE ligne exactement au format "TAGS: sujet1, sujet2" avec 1 a 5 etiquettes de sujet courtes (1 a 3 mots) : produits, modeles, entreprises ou themes REELLEMENT traites (pas une simple mention), par exemple GPT, Gemini, Grok, Claude, Securite, Generation d'images, Open source. Garde l'ecriture officielle des noms propres ; un theme commence par une majuscule. Une etiquette par sujet, du plus important au moins important.${list}`;
}

// ---------------------------------------------------------------------------
// Rattrapage des 90 derniers jours (tache de fond, une seule fois par post)
// ---------------------------------------------------------------------------

const BACKFILL_DAYS = 90;
const BATCH = 15;
const BATCH_DELAY_MS = 2000;
let backfillRunning = false;

function newsletterModel(): string {
  return backgroundModel("OPENROUTER_MODEL_NEWSLETTER");
}

/** Etiquette un lot de newsletters ; un tableau par entree, null si echec. */
export async function tagNewsletterBatch(
  items: { title: string; summary: string }[],
  known: string[],
  apiKey: string
): Promise<string[][] | null> {
  if (items.length === 0) return [];
  const list = items
    .map((it, i) => `${i + 1}. Titre : ${it.title || "(sans titre)"}\n   Contenu : ${htmlToPlain(it.summary || "").replace(/\s+/g, " ").trim().slice(0, 500)}`)
    .join("\n");
  const knownLine = known.length ? ` Etiquettes deja employees (reprends EXACTEMENT leur ecriture quand le sujet est le meme) : ${known.join(", ")}.` : "";
  try {
    const res = await aiFetch("newsletter-tags", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://imiel.example.com",
        "X-Title": "iMiel",
      },
      body: JSON.stringify({
        model: newsletterModel(),
        messages: [
          {
            role: "system",
            content: `Pour chaque newsletter numerotee, donne 1 a 5 etiquettes de sujet courtes (1 a 3 mots) : produits, modeles, entreprises ou themes REELLEMENT traites, par exemple GPT, Gemini, Grok, Claude, Securite, Generation d'images, Open source. Garde l'ecriture officielle des noms propres ; un theme commence par une majuscule.${knownLine} Reponds UNIQUEMENT par une ligne par newsletter, au format "1: etiquette, etiquette".`,
          },
          { role: "user", content: list },
        ],
        temperature: 0.1,
        max_tokens: 40 * items.length + 100,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.warn(`[newsletter-tags] HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content || "";
    const out: string[][] = items.map(() => []);
    for (const line of content.split("\n")) {
      const m = /^\s*(\d+)\s*[:.)-]\s*(.+)$/.exec(line);
      if (!m) continue;
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < out.length && out[idx].length === 0) out[idx] = splitTagList(m[2]);
    }
    return out;
  } catch (err) {
    console.warn("[newsletter-tags] error:", (err as Error).message);
    return null;
  }
}

/**
 * Etiquette les syntheses des 90 derniers jours encore sans etiquettes (tous
 * les utilisateurs). Idempotent (`tags_done`), borne, s'arrete au premier
 * refus du budget IA (le passage suivant reprendra).
 */
export async function backfillNewsletterTags(): Promise<{ tagged: number; calls: number }> {
  if (backfillRunning) return { tagged: 0, calls: 0 };
  backfillRunning = true;
  let tagged = 0;
  let calls = 0;
  try {
    const since = pbDate(Date.now() - BACKFILL_DAYS * DAY_MS);
    for (let round = 0; round < 200; round++) {
      const res = await listNewsletterPostsPage({
        filter: `tags_done != true && status = "done" && message_date >= "${since}"`,
        perPage: 60,
        fields: "id,user,title,summary,tags",
      });
      if (res.items.length === 0) break;
      const byUser = new Map<string, PBNewsletterPost[]>();
      for (const p of res.items) byUser.set(p.user, [...(byUser.get(p.user) || []), p]);
      let progressed = false;
      for (const [userId, list] of byUser) {
        const apiKey = (await getUserOpenRouterKey(userId)) || serverOpenRouterKey() || "";
        if (!apiKey) {
          // Sans cle, on marque quand meme : sinon la boucle reprendrait ces posts.
          for (const p of list) await updateNewsletterPost(p.id, { tags_done: true });
          progressed = true;
          continue;
        }
        const known = await listKnownTags(userId);
        for (let i = 0; i < list.length; i += BATCH) {
          const batch = list.slice(i, i + BATCH);
          calls++;
          const result = await tagNewsletterBatch(
            batch.map((p) => ({ title: p.title, summary: p.summary })),
            known,
            apiKey
          );
          if (!result) {
            console.warn(`[newsletter-tags] backfill stoppe (${tagged} etiquetees) : on reprendra plus tard`);
            return { tagged, calls };
          }
          for (let j = 0; j < batch.length; j++) {
            const existing = Array.isArray(batch[j].tags) ? (batch[j].tags as string[]) : [];
            const tags = existing.length ? existing : canonicalTags(result[j], known);
            await updateNewsletterPost(batch[j].id, { tags, tags_done: true });
            for (const t of tags) if (!known.some((k) => foldTag(k) === foldTag(t))) known.push(t);
            tagged++;
          }
          progressed = true;
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
        invalidateKnownTags(userId);
      }
      if (!progressed) break;
    }
    if (tagged) console.log(`[newsletter-tags] backfill : ${tagged} newsletter(s) etiquetee(s), ${calls} appel(s)`);
    return { tagged, calls };
  } finally {
    backfillRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Renommage / fusion et statistiques (routes /newsletters/tags/rename, /stats)
// ---------------------------------------------------------------------------

/**
 * Renomme une etiquette sur TOUTES les newsletters de l'utilisateur. Si `to`
 * existe deja, les deux sont fusionnees (sans doublon dans un post).
 */
export async function renameNewsletterTag(
  userId: string,
  from: string,
  toRaw: string
): Promise<{ updated: number; merged: boolean; to: string }> {
  const known = await listKnownTags(userId, 1000);
  const cleaned = cleanTag(toRaw);
  if (!cleaned || !foldTag(from)) throw new Error("invalid tag");
  // Fusion : un nom egal a une AUTRE etiquette existante prend son ecriture.
  const target =
    known.find((k) => foldTag(k) === foldTag(cleaned) && foldTag(k) !== foldTag(from)) || cleaned;
  const merged = known.some((k) => foldTag(k) === foldTag(target) && foldTag(k) !== foldTag(from));
  // Pre-filtre large (texte du JSON), verifie ensuite a la cle foldTag.
  const needle = from.trim().replace(/["\\]/g, "").slice(0, 40);
  const posts = await listAllNewsletterPosts(`user = "${userId}" && tags ~ "${needle}"`, "id,tags", 40);
  let updated = 0;
  for (const p of posts) {
    const tags = Array.isArray(p.tags) ? p.tags : [];
    if (!tags.some((t) => foldTag(t) === foldTag(from))) continue;
    const next = renameTagInList(tags, from, target);
    await updateNewsletterPost(p.id, { tags: next });
    updated++;
  }
  invalidateKnownTags(userId);
  return { updated, merged, to: target };
}

/** Bornes UTC larges couvrant des jours de Paris (decoupe fine ensuite). */
function utcBounds(fromDay: string, toDay: string): { lo: string; hi: string } {
  const lo = Date.parse(`${addDays(fromDay, -1)}T00:00:00Z`);
  const hi = Date.parse(`${addDays(toDay, 2)}T00:00:00Z`);
  return { lo: pbDate(lo), hi: pbDate(hi) };
}

export async function getNewsletterStats(userId: string, from: string, to: string): Promise<NewsletterStats> {
  const len = dayRange(from, to).length;
  const { lo, hi } = utcBounds(addDays(from, -len), to);
  const posts = await listAllNewsletterPosts(
    `user = "${userId}" && message_date >= "${lo}" && message_date < "${hi}"`,
    "message_date,tags",
    40
  );
  return computeNewsletterStats(posts, from, to);
}
