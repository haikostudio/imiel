// Outils de l'assistant IA (tool calling OpenAI-compatible via OpenRouter).
//
// Deux familles :
//  - LECTURE (search_*) : executees ICI, cote serveur, sans confirmation.
//    Les collections PocketBase sont lues avec le JETON de l'utilisateur
//    (transmis par le client) : les regles d'acces PB s'appliquent. Les
//    recherches worker (emails, suivi) reprennent le userId comme l'ancien RAG.
//  - ECRITURE (propose_*) : JAMAIS executees ici. Elles deviennent une ACTION
//    (carte Accepter/Refuser dans le chat) ; l'execution se fait cote client
//    apres validation (lib/ai-actions.ts).
import type {
  AiAction,
  AiActionKind,
  AiEventFields,
  TrackingEmailRef,
} from "@/lib/ai-actions-types";
import { APP_TOOL_DEFINITIONS, APP_TOOL_NAMES, appListCount, buildAppAction, runAppReadTool } from "./tools-app";

const WORKER_URL =
  process.env.WORKER_INTERNAL_URL ||
  process.env.MAIL_WORKER_URL ||
  "http://127.0.0.1:4001";
const PB_URL = process.env.POCKETBASE_INTERNAL_URL || "http://127.0.0.1:8090";
const TOOL_TIMEOUT_MS = 20_000;

export interface ToolContext {
  userId: string;
  authToken: string;
  timezone: string;
  /** Texte des messages de l'utilisateur (controle des mots de passe). */
  userText?: string;
}

type JsonSchema = Record<string, unknown>;

const eventFieldsSchema: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    start: { type: "string", description: "Heure LOCALE YYYY-MM-DDTHH:mm, ou YYYY-MM-DD si journee entiere" },
    end: { type: "string", description: "Heure LOCALE YYYY-MM-DDTHH:mm (defaut: start + 1h), ou YYYY-MM-DD" },
    all_day: { type: "boolean" },
    location: { type: "string" },
    description: { type: "string" },
  },
};

function fn(name: string, description: string, parameters: JsonSchema) {
  return { type: "function" as const, function: { name, description, parameters } };
}

export const TOOL_DEFINITIONS = [
  fn("search_emails", "Recherche hybride (sens + mots-cles) dans TOUS les emails. Rend id, thread_id, sujet, expediteur, date, extrait.", {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  }),
  fn("search_calendar", "Liste les evenements d'agenda entre deux dates locales (YYYY-MM-DD), filtre texte optionnel. Rend les id necessaires pour modifier/supprimer.", {
    type: "object",
    properties: { from: { type: "string" }, to: { type: "string" }, query: { type: "string" } },
    required: ["from", "to"],
  }),
  fn("search_contacts", "Cherche des contacts (nom ou adresse) dans le carnet.", {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  }),
  fn("search_newsletters", "Cherche dans les syntheses IA des newsletters suivies. query = mots du SUJET seulement (jamais des mots de date) ; periode via from/to (YYYY-MM-DD).", {
    type: "object",
    properties: { query: { type: "string" }, from: { type: "string" }, to: { type: "string" }, limit: { type: "number" } },
  }),
  fn("search_tracking", "Cherche dans les fiches de Suivi d'affaires (commandes, livraisons, dossiers).", {
    type: "object",
    properties: { query: { type: "string" } },
  }),
  fn("propose_draft", "Propose un BROUILLON d'email (jamais envoye). L'utilisateur valide par une carte.", {
    type: "object",
    properties: {
      to: { type: "array", items: { type: "string" }, description: "Adresses email" },
      cc: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      body: { type: "string", description: "Texte brut, paragraphes separes par une ligne vide" },
      from: { type: "string", description: "Adresse du compte d'envoi si precisee" },
    },
    required: ["to", "subject", "body"],
  }),
  fn("propose_create_events", "Propose de CREER un ou plusieurs evenements d'agenda.", {
    type: "object",
    properties: { events: { type: "array", items: eventFieldsSchema } },
    required: ["events"],
  }),
  fn("propose_update_events", "Propose de MODIFIER un ou plusieurs evenements existants (id issus de search_calendar). Ne donner que les champs qui changent.", {
    type: "object",
    properties: {
      changes: {
        type: "array",
        items: { type: "object", properties: { id: { type: "string" }, ...(eventFieldsSchema.properties as object) }, required: ["id"] },
      },
    },
    required: ["changes"],
  }),
  fn("propose_delete_events", "Propose de SUPPRIMER un ou plusieurs evenements (id issus de search_calendar).", {
    type: "object",
    properties: { ids: { type: "array", items: { type: "string" } } },
    required: ["ids"],
  }),
  fn("propose_create_contact", "Propose de CREER un contact.", {
    type: "object",
    properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, company: { type: "string" } },
    required: ["email"],
  }),
  fn("propose_create_tracking", "Propose de CREER une fiche de Suivi sur un sujet, rattachee a des emails (message_ids issus de search_emails ; sinon query pour les chercher).", {
    type: "object",
    properties: {
      title: { type: "string" },
      message_ids: { type: "array", items: { type: "string" } },
      query: { type: "string" },
    },
    required: ["title"],
  }),
  // Le reste de l'application (comptes, signatures, etiquettes, dossiers,
  // regles, bloques, newsletters, alertes, contacts, suivis, mails, reglages).
  ...APP_TOOL_DEFINITIONS,
];

/**
 * Garde-fou "carte imaginaire" : le modele ecrit qu'une proposition / carte
 * attend la validation (ou recopie la trace "[Actions: ...]" de l'historique)
 * sans avoir appele de propose_* dans CETTE reponse : aucune carte n'existe.
 */
const FAKE_CARD_RE =
  /(\[actions:|carte (vous )?(sera|est) (presentee|affichee|proposee)|carte ci-dessous|en attente de (votre )?validation|proposition .{0,60}(en attente|a valider|prete)|card (is |will be )?(shown|displayed)|awaiting (your )?(validation|approval))/;
export function claimsCardWithoutAction(text: string): boolean {
  const norm = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u2019/g, "'").toLowerCase();
  return FAKE_CARD_RE.test(norm);
}

export function isWriteTool(name: string): boolean {
  return name.startsWith("propose_");
}

export function toolLabel(name: string): string {
  switch (name) {
    case "search_emails": return "Recherche dans les emails";
    case "search_calendar": return "Consultation de l'agenda";
    case "search_contacts": return "Recherche dans les contacts";
    case "search_newsletters": return "Recherche dans les newsletters";
    case "search_tracking": return "Consultation du suivi";
    case "list_app_data": return "Lecture de la configuration";
    default: return "Preparation d'une proposition";
  }
}

/**
 * Ce que le deroule du chat montre d'une etape de lecture : ce qui a ete
 * cherche (mots ou periode) et combien de resultats sont revenus. Le libelle
 * lui-meme est traduit cote ecran (cle aiChat.step.<nom>).
 */
export function toolStepSummary(name: string, args: Record<string, unknown>, result: unknown): { detail: string; count: number | null } {
  const q = str(args.query).slice(0, 80);
  const from = str(args.from).slice(0, 10);
  const to = str(args.to).slice(0, 10);
  const period = from ? (to && to !== from ? `${from} -> ${to}` : from) : "";
  const detail = name === "search_calendar" ? [period, q].filter(Boolean).join(" · ") : [q, period].filter(Boolean).join(" · ");
  if (name === "list_app_data") return { detail: (Array.isArray(args.what) ? args.what : []).join(", ").slice(0, 80), count: appListCount(result) };
  const r = (result || {}) as Record<string, unknown>;
  const list = r.results ?? r.events ?? r.contacts ?? r.newsletters ?? r.fiches;
  return { detail, count: Array.isArray(list) ? list.length : null };
}

// --- helpers ---------------------------------------------------------------

function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function pbList<T>(collection: string, ctx: ToolContext, params: Record<string, string>): Promise<T[]> {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${PB_URL}/api/collections/${collection}/records?${qs}`, {
    headers: { Authorization: ctx.authToken },
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`${collection} HTTP ${r.status}`);
  const d = (await r.json()) as { items?: T[] };
  return d.items || [];
}

/** Date PB (UTC, "YYYY-MM-DD HH:MM:SS.sssZ") -> heure locale "YYYY-MM-DDTHH:mm". */
export function toLocal(value: string, tz: string, allDay = false): string {
  if (!value) return "";
  const d = new Date(value.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return value;
  if (allDay) return d.toISOString().slice(0, 10);
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).formatToParts(d).map((p) => [p.type, p.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    return d.toISOString().slice(0, 16);
  }
}

function inclusiveEnd(value: string): string {
  const d = new Date((value || "").replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return value;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface PbEvent { id: string; title: string; start: string; end: string; all_day: boolean; location: string; description: string }

function eventToFields(e: PbEvent, tz: string): AiEventFields {
  return {
    title: e.title || "",
    start: toLocal(e.start, tz, e.all_day),
    // Journee entiere : PB stocke une fin EXCLUSIVE (lendemain minuit UTC) ;
    // la carte montre le dernier jour INCLUS.
    end: e.all_day ? inclusiveEnd(e.end) : toLocal(e.end, tz),
    all_day: !!e.all_day,
    location: e.location || "",
    description: (e.description || "").slice(0, 1000),
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  if (typeof v === "string") return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function normEventFields(raw: Record<string, unknown>): AiEventFields {
  const allDay = raw.all_day === true || (/^\d{4}-\d{2}-\d{2}$/.test(str(raw.start)));
  const start = str(raw.start);
  let end = str(raw.end);
  if (!end && start) {
    if (allDay) end = start;
    else {
      const d = new Date(start);
      if (!Number.isNaN(d.getTime())) {
        d.setHours(d.getHours() + 1);
        const pad = (n: number) => String(n).padStart(2, "0");
        end = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    }
  }
  return {
    title: str(raw.title),
    start: start.slice(0, allDay ? 10 : 16),
    end: end.slice(0, allDay ? 10 : 16),
    all_day: allDay,
    location: str(raw.location),
    description: str(raw.description),
  };
}

async function searchEmails(ctx: ToolContext, query: string, limit: number): Promise<(TrackingEmailRef & { snippet: string })[]> {
  const r = await fetch(`${WORKER_URL}/embeddings/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: ctx.userId, query, limit, mode: "focused" }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error(`recherche emails HTTP ${r.status}`);
  const d = (await r.json()) as { results?: { id: string; thread_id: string; subject: string; from: string; date: string; snippet?: string; body?: string }[] };
  return (d.results || []).map((h) => ({
    id: h.id,
    thread_id: h.thread_id,
    subject: h.subject,
    from: h.from,
    date: (h.date || "").slice(0, 10),
    snippet: (h.snippet || h.body || "").replace(/\s+/g, " ").slice(0, 300),
  }));
}

// --- LECTURE ---------------------------------------------------------------

export async function runReadTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  if (APP_TOOL_NAMES.has(name)) return runAppReadTool(name, args, ctx);
  switch (name) {
    case "search_emails": {
      const q = str(args.query);
      if (!q) return { error: "query requis" };
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
      return {
        results: await searchEmails(ctx, q, limit),
        next_step: "Pour un suivi, appelle propose_create_tracking avec les id PERTINENTS ; pour un brouillon, propose_draft. Sans cet appel, aucune carte n'existe.",
      };
    }
    case "search_calendar": {
      const from = str(args.from).slice(0, 10);
      const to = str(args.to).slice(0, 10) || from;
      if (!from) return { error: "from requis" };
      // Marge d'un jour de chaque cote (fuseau), filtre fin sur l'heure locale.
      const lo = new Date(`${from}T00:00:00Z`); lo.setUTCDate(lo.getUTCDate() - 1);
      const hi = new Date(`${to}T23:59:59Z`); hi.setUTCDate(hi.getUTCDate() + 1);
      const fmt = (d: Date) => d.toISOString().replace("T", " ");
      const items = await pbList<PbEvent & { status: string }>("calendar_events", ctx, {
        filter: `user = "${esc(ctx.userId)}" && start < "${fmt(hi)}" && end > "${fmt(lo)}" && status != "cancelled"`,
        sort: "start",
        perPage: "200",
      });
      const q = str(args.query).toLowerCase();
      const events = items
        .map((e) => ({ id: e.id, ...eventToFields(e, ctx.timezone) }))
        .filter((e) => e.start.slice(0, 10) <= to && e.end.slice(0, 10) >= from)
        .filter((e) => !q || `${e.title} ${e.location} ${e.description}`.toLowerCase().includes(q))
        .map((e) => ({ ...e, description: e.description.slice(0, 200) }));
      return {
        timezone: ctx.timezone,
        events,
        next_step:
          "Pour MODIFIER ou SUPPRIMER certains de ces evenements, appelle MAINTENANT propose_update_events / propose_delete_events avec leurs id. Sans cet appel, aucune carte n'existe.",
      };
    }
    case "search_contacts": {
      const q = esc(str(args.query));
      const items = await pbList<{ id: string; name: string; email: string; phone?: string; company?: string; message_count?: number }>("contacts", ctx, {
        filter: `user = "${esc(ctx.userId)}" && (name ~ "${q}" || email ~ "${q}")`,
        sort: "-message_count",
        perPage: "15",
      });
      return { contacts: items.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone || "", company: c.company || "", messages: c.message_count || 0 })) };
    }
    case "search_newsletters": {
      const q = esc(str(args.query));
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
      const from = str(args.from).slice(0, 10);
      const to = str(args.to).slice(0, 10);
      // Format ESPACE obligatoire pour comparer une date PB (sinon 0 ligne).
      const dateFilter = `${/^\d{4}-\d{2}-\d{2}$/.test(from) ? ` && message_date >= "${from} 00:00:00"` : ""}${/^\d{4}-\d{2}-\d{2}$/.test(to) ? ` && message_date <= "${to} 23:59:59"` : ""}`;
      const base = `user = "${esc(ctx.userId)}" && status = "done"${dateFilter}`;
      type Post = { id: string; title: string; summary: string; source_name: string; original_subject: string; message_date: string };
      const list = (filter: string) => pbList<Post>("newsletter_posts", ctx, { filter, sort: "-message_date", perPage: String(limit) });
      let items = await list(q ? `${base} && (title ~ "${q}" || summary ~ "${q}" || source_name ~ "${q}" || original_subject ~ "${q}")` : base);
      let note = "";
      if (items.length === 0 && q) {
        items = await list(base);
        if (items.length) note = "Aucun resultat pour ces mots : voici les plus recentes de la periode.";
      }
      return { note, newsletters: items.map((n) => ({ source: n.source_name, date: (n.message_date || "").slice(0, 10), title: n.title || n.original_subject, summary: (n.summary || "").slice(0, 800) })) };
    }
    case "search_tracking": {
      const r = await fetch(`${WORKER_URL}/tracking/context?userId=${encodeURIComponent(ctx.userId)}`, { signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`suivi HTTP ${r.status}`);
      const d = (await r.json()) as { fiches?: { title: string; merchant: string; status: string; fields: Record<string, unknown>; last_message_date: string; events?: { date: string; label: string }[] }[] };
      const words = str(args.query).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      // Id des fiches (pour propose_tracking_update) : le contexte worker ne
      // les rend pas, on les rapproche par titre.
      const ids = await pbList<{ id: string; title: string }>("tracking_items", ctx, {
        filter: `user = "${esc(ctx.userId)}" && archived = false`, fields: "id,title", perPage: "200",
      }).catch(() => []);
      const idByTitle = new Map(ids.map((t) => [t.title, t.id]));
      const fiches = (d.fiches || [])
        .filter((f) => words.length === 0 || words.some((w) => `${f.title} ${f.merchant} ${JSON.stringify(f.fields || {})}`.toLowerCase().includes(w)))
        .slice(0, 20)
        .map((f) => ({
          id: idByTitle.get(f.title) || "",
          title: f.title,
          merchant: f.merchant,
          ouvert: !(f.status === "done" || f.status === "cancelled"),
          dernier_message: (f.last_message_date || "").slice(0, 10),
          infos: f.fields,
          timeline: (f.events || []).slice(-5).map((e) => `${(e.date || "").slice(0, 10)} ${e.label}`),
        }));
      return { fiches };
    }
  }
  return { error: `outil inconnu: ${name}` };
}

// --- ECRITURE -> ACTION ----------------------------------------------------

let seq = 0;
function actionId(): string {
  seq = (seq + 1) % 1_000_000;
  return `act_${Date.now().toString(36)}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Transforme un appel propose_* en ACTION affichable. Enrichit ce que la carte
 * doit montrer (avant/apres d'un evenement, emails d'un suivi). Leve une erreur
 * lisible si la proposition est inexploitable (renvoyee au modele).
 */
export async function buildAction(name: string, args: Record<string, unknown>, ctx: ToolContext, groupId: string): Promise<AiAction> {
  const base = (kind: AiActionKind, payload: AiAction["payload"]): AiAction => ({
    id: actionId(), kind, groupId, payload, status: "pending",
  });

  if (APP_TOOL_NAMES.has(name)) return buildAppAction(name, args, ctx, groupId);
  switch (name) {
    case "propose_draft": {
      const to = strList(args.to);
      if (to.length === 0) throw new Error("aucun destinataire : cherche l'adresse avec search_contacts ou search_emails");
      return base("draft", { from: str(args.from), to, cc: strList(args.cc), subject: str(args.subject), body: str(args.body) });
    }
    case "propose_create_events": {
      const raw = Array.isArray(args.events) ? args.events : [];
      const events = raw.map((e) => normEventFields((e || {}) as Record<string, unknown>)).filter((e) => e.title && e.start);
      if (events.length === 0) throw new Error("aucun evenement valide (titre et debut requis)");
      return base("event_create", { events });
    }
    case "propose_update_events": {
      const raw = (Array.isArray(args.changes) ? args.changes : []) as Record<string, unknown>[];
      const ids = raw.map((c) => str(c?.id)).filter(Boolean);
      if (ids.length === 0) throw new Error("aucun id d'evenement : utilise search_calendar d'abord");
      const found = await pbList<PbEvent>("calendar_events", ctx, { filter: ids.map((id) => `id = "${esc(id)}"`).join(" || "), perPage: "100" });
      const byId = new Map(found.map((e) => [e.id, e]));
      const changes = raw.flatMap((c) => {
        const ev = byId.get(str(c.id));
        if (!ev) return [];
        const before = eventToFields(ev, ctx.timezone);
        const after = { ...before };
        for (const k of ["title", "location", "description"] as const) if (typeof c[k] === "string") after[k] = str(c[k]);
        if (typeof c.all_day === "boolean") after.all_day = c.all_day;
        if (typeof c.start === "string" && c.start) after.start = str(c.start).slice(0, after.all_day ? 10 : 16);
        if (typeof c.end === "string" && c.end) after.end = str(c.end).slice(0, after.all_day ? 10 : 16);
        return [{ id: ev.id, before, after }];
      });
      if (changes.length === 0) throw new Error("evenements introuvables : verifie les id avec search_calendar");
      return base("event_update", { changes });
    }
    case "propose_delete_events": {
      const ids = strList(args.ids);
      if (ids.length === 0) throw new Error("aucun id d'evenement : utilise search_calendar d'abord");
      const found = await pbList<PbEvent>("calendar_events", ctx, { filter: ids.map((id) => `id = "${esc(id)}"`).join(" || "), perPage: "100" });
      if (found.length === 0) throw new Error("evenements introuvables : verifie les id avec search_calendar");
      return base("event_delete", { events: found.map((e) => ({ id: e.id, ...eventToFields(e, ctx.timezone) })) });
    }
    case "propose_create_contact": {
      const email = str(args.email);
      if (!email) throw new Error("adresse email requise");
      return base("contact_create", { name: str(args.name), email, phone: str(args.phone), company: str(args.company) });
    }
    case "propose_create_tracking": {
      const title = str(args.title);
      let emails: TrackingEmailRef[] = [];
      const ids = strList(args.message_ids);
      if (ids.length > 0) {
        const found = await pbList<{ id: string; thread_id: string; subject: string; from_address: { name?: string; address?: string } | null; date: string }>("messages", ctx, {
          filter: ids.slice(0, 30).map((id) => `id = "${esc(id)}"`).join(" || "),
          fields: "id,thread_id,subject,from_address,date",
          perPage: "30",
        });
        emails = found.map((m) => ({
          id: m.id, thread_id: m.thread_id, subject: m.subject,
          from: m.from_address?.name || m.from_address?.address || "", date: (m.date || "").slice(0, 10),
        }));
      } else if (str(args.query)) {
        emails = (await searchEmails(ctx, str(args.query), 8)).map(({ id, thread_id, subject, from, date }) => ({ id, thread_id, subject, from, date }));
      }
      if (emails.length === 0) throw new Error("aucun email a rattacher : cherche-les avec search_emails puis passe leurs id");
      emails.sort((a, b) => a.date.localeCompare(b.date));
      return base("tracking_create", { title, emails });
    }
  }
  throw new Error(`outil inconnu: ${name}`);
}
