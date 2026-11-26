// Routes de la base, servies DANS LE NAVIGATEUR pour l'app web iMiel Cloud :
// API des fiches (liste, lecture, creation, mise a jour, suppression),
// session de l'utilisateur local, et routes de l'app utilisees par
// l'interface (liste des mails, compteurs, brouillons, routes iMiel Cloud).
// Memes formes de reponse que backend/pb_hooks/*.pb.js.
import { filtrer, trier, datePb, type Fiche, type Contexte } from "./filtre";
import {
  UTILISATEUR_ID,
  cibleRelation,
  collection,
  corpsDe,
  ecrire,
  ecrireFichier,
  lire,
  lireFichier,
  supprimer,
} from "./base";

export interface Reponse {
  statut: number;
  json?: unknown;
  blob?: Blob;
}

const ok = (json: unknown, statut = 200): Reponse => ({ statut, json });
const erreur = (statut: number, message: string): Reponse => ({ statut, json: { status: statut, message, data: {} } });

const ctx = (col: string): Contexte => ({
  col,
  auth: UTILISATEUR_ID,
  resoudre: (c, champ, id) => {
    const cible = cibleRelation(c, champ);
    return cible ? lire(cible, id) : null;
  },
});

/** Jeton de session local (non signe : il ne sort jamais du navigateur). */
export function jetonLocal(): string {
  const b = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b({ alg: "none", typ: "JWT" })}.${b({ id: UTILISATEUR_ID, type: "auth", collectionId: "_pb_users_auth_", exp: Math.floor(Date.now() / 1000) + 3600 * 24 * 365 * 5 })}.local`;
}

export function utilisateurLocal(): Fiche {
  let u = lire("users", UTILISATEUR_ID);
  if (!u) {
    u = ecrire(
      "users",
      { id: UTILISATEUR_ID, email: "moi@imiel.local", name: "Moi", verified: true, theme: "system", language: "fr", conversation_view: true, collectionId: "_pb_users_auth_", collectionName: "users" },
      { silencieux: true }
    );
  }
  return u;
}

// --- Projection, expansion, corps ---
function projeter(f: Fiche, champs: string | null): Record<string, unknown> {
  if (!champs) return f;
  const out: Record<string, unknown> = {};
  for (const c of champs.split(",").map((x) => x.trim())) {
    if (c === "*") Object.assign(out, f);
    else if (c.startsWith("expand.")) {
      const [, rel, ...reste] = c.split(".");
      const ex = (f.expand as Record<string, Record<string, unknown>>)?.[rel];
      if (!ex) continue;
      const cible = ((out.expand as Record<string, Record<string, unknown>>) ||= {});
      const sous = (cible[rel] ||= {});
      if (reste.length) sous[reste.join(".")] = ex[reste.join(".")];
      else Object.assign(sous, ex);
    } else if (c.includes(":")) {
      const [nom, mod] = c.split(":");
      if (mod.startsWith("excerpt")) out[nom] = String(f[nom] || "").replace(/<[^>]+>/g, " ").slice(0, Number(mod.match(/\d+/)?.[0] || 200));
    } else if (c in f) out[c] = f[c];
  }
  return out;
}

function etendre(col: string, f: Fiche, expand: string | null): Fiche {
  if (!expand) return f;
  const ex: Record<string, unknown> = {};
  for (const chemin of expand.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [rel, ...reste] = chemin.split(".");
    const cible = cibleRelation(col, rel);
    if (!cible) continue;
    const v = f[rel];
    const fiches = (Array.isArray(v) ? v : [v]).map((id) => lire(cible, id)).filter(Boolean) as Fiche[];
    const etendues = fiches.map((x) => (reste.length ? etendre(cible, x, reste.join(".")) : x));
    ex[rel] = Array.isArray(v) ? etendues : etendues[0];
  }
  return { ...f, expand: ex };
}

async function avecCorps(col: string, fiches: Fiche[], champs: string | null): Promise<Fiche[]> {
  if (col !== "messages") return fiches;
  if (champs && !/(^|,)\s*(\*|text_body|html_body|raw_headers)/.test(champs)) return fiches;
  const corps = await corpsDe(fiches.map((f) => f.id));
  return fiches.map((f) => ({ text_body: "", html_body: "", raw_headers: "", ...f, ...(corps.get(f.id) || {}) }));
}

function proprietaire(col: string, f: Fiche): boolean {
  if (col === "users") return f.id === UTILISATEUR_ID;
  return true; // un seul utilisateur dans le navigateur
}

// --- Fiches ---
async function liste(col: string, q: URLSearchParams): Promise<Reponse> {
  const page = Math.max(1, Number(q.get("page") || 1));
  const parPage = Math.min(1000, Math.max(1, Number(q.get("perPage") || 30)));
  const c = ctx(col);
  let tout = [...collection(col).values()].filter((f) => proprietaire(col, f) && filtrer(q.get("filter"), f, c));
  tout = trier(tout, q.get("sort"));
  const total = tout.length;
  const tranche = tout.slice((page - 1) * parPage, page * parPage).map((f) => etendre(col, f, q.get("expand")));
  const items = (await avecCorps(col, tranche, q.get("fields"))).map((f) => projeter(f, q.get("fields")));
  return ok({ page, perPage: parPage, totalItems: q.get("skipTotal") ? -1 : total, totalPages: q.get("skipTotal") ? -1 : Math.ceil(total / parPage), items });
}

async function corpsRequete(corps: unknown, col: string, id: string): Promise<Record<string, unknown>> {
  if (corps instanceof FormData) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of corps.entries()) {
      if (typeof v === "string") {
        const nom = k.replace(/\[\]$/, "");
        try {
          out[nom] = /^[[{]/.test(v) ? JSON.parse(v) : v;
        } catch {
          out[nom] = v;
        }
      } else {
        const nom = `${Date.now().toString(36)}_${v.name.replace(/[^\w.-]/g, "_")}`;
        await ecrireFichier(`${col}/${id}/${nom}`, v);
        out[k.replace(/[+\-]$/, "")] = nom;
      }
    }
    return out;
  }
  return (corps as Record<string, unknown>) || {};
}

function appliquerModificateurs(existant: Fiche | null, d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (k.endsWith("+") || k.startsWith("+")) {
      const nom = k.replace(/\+/g, "");
      const avant = existant?.[nom];
      out[nom] = typeof avant === "number" ? avant + Number(v) : [...(Array.isArray(avant) ? avant : []), ...(Array.isArray(v) ? v : [v])];
    } else if (k.endsWith("-")) {
      const nom = k.slice(0, -1);
      const avant = existant?.[nom];
      const retirer = new Set(Array.isArray(v) ? v : [v]);
      out[nom] = typeof avant === "number" ? avant - Number(v) : (Array.isArray(avant) ? avant : []).filter((x) => !retirer.has(x));
    } else out[k] = v;
  }
  return out;
}

const SYSTEME = new Set(["collectionId", "collectionName", "created", "updated", "expand", "password", "passwordConfirm", "oldPassword"]);

async function creerOuMaj(col: string, id: string | null, corps: unknown, q: URLSearchParams): Promise<Reponse> {
  const existant = id ? lire(col, id) : null;
  if (id && !existant) return erreur(404, "The requested resource wasn't found.");
  const fid = id || (typeof (corps as Record<string, unknown>)?.id === "string" ? String((corps as Record<string, unknown>).id) : "") || undefined;
  const d = appliquerModificateurs(existant, await corpsRequete(corps, col, fid || "nouveau"));
  for (const k of Object.keys(d)) if (SYSTEME.has(k)) delete d[k];
  if (col !== "users" && !existant && collection(col) && d.user === undefined && ["labels", "accounts", "filter_rules", "newsletter_sources", "contacts", "tracking_items", "tracking_events", "calendar_groups", "calendar_events", "alert_topics", "ai_chat_messages", "ai_actions", "thread_labels", "importance_rules", "push_tokens", "activities"].includes(col)) d.user = UTILISATEUR_ID;
  const f = ecrire(col, { ...(existant ? { id: existant.id } : fid ? { id: fid } : {}), ...d });
  const [rep] = await avecCorps(col, [etendre(col, f, q.get("expand"))], q.get("fields"));
  return ok(projeter(rep, q.get("fields")));
}

// --- Routes de l'app (backend/pb_hooks) ---
function messages(): Fiche[] {
  return [...collection("messages").values()];
}
const dossier = (id: unknown) => lire("folders", id);
const typeDe = (m: Fiche) => String(dossier(m.folder)?.type || "");
const vrai = (v: string | null) => v === "true" || v === "1";

const CHAMPS_LISTE = "id,account,folder,thread_id,message_id,in_reply_to,references,from_address,to_addresses,cc_addresses,subject,snippet,date,is_read,is_starred,is_answered,is_draft,is_sent,has_attachments,priority,uid,labels,spam_score,spam_action,scheduled_at,importance".split(",");

function listeMails(q: URLSearchParams): Reponse {
  const page = Math.max(1, Number(q.get("page") || 1));
  const parPage = Math.min(500, Math.max(1, Number(q.get("per_page") || 100)));
  const secondaires = new Set([...collection("labels").values()].filter((l) => l.is_secondary).map((l) => l.id));
  const dossiers = q.get("folder_ids")?.split(",").filter(Boolean);
  const texte = (q.get("search_text") || "").toLowerCase();
  const de = (q.get("from_text") || "").toLowerCase();
  let l = messages().filter((m) => {
    if (q.get("account_id") && m.account !== q.get("account_id")) return false;
    const v = q.get("view");
    if (v === "starred" && !m.is_starred) return false;
    if (v === "all_mail" && m.is_sent) return false;
    if (v === "unread" && m.is_read) return false;
    if (q.get("folder_id") && m.folder !== q.get("folder_id")) return false;
    if (dossiers && !dossiers.includes(String(m.folder))) return false;
    if (q.get("folder_type") && typeDe(m) !== q.get("folder_type")) return false;
    const labels = (m.labels as string[]) || [];
    if (q.get("label_id") && !labels.includes(q.get("label_id")!)) return false;
    if (vrai(q.get("exclude_secondary")) && labels.some((x) => secondaires.has(x))) return false;
    for (const k of ["is_draft", "is_read", "is_starred", "has_attachments"]) if (q.get(k) !== null && !!m[k] !== vrai(q.get(k))) return false;
    if (q.get("priority") && m.priority !== q.get("priority")) return false;
    if (q.get("importance") && m.importance !== q.get("importance")) return false;
    if (de) {
      const f = m.from_address as { name?: string; address?: string };
      if (!`${f?.name || ""} ${f?.address || ""}`.toLowerCase().includes(de)) return false;
    }
    if (texte && !`${m.subject || ""} ${m.snippet || ""}`.toLowerCase().includes(texte)) return false;
    return true;
  });
  l = trier(l, q.get("sort") === "unread_date" ? "is_read,-date" : "-date");
  const items = l.slice((page - 1) * parPage, page * parPage).map((m) => Object.fromEntries(CHAMPS_LISTE.map((k) => [k, m[k] ?? (k === "labels" || k.endsWith("addresses") || k === "references" ? [] : "")])));
  return ok({ items, page, perPage: parPage, totalItems: l.length, totalPages: Math.ceil(l.length / parPage), thread_tails: null, importance_counts: null });
}

function compteurs(q: URLSearchParams): Reponse {
  const a = q.get("account_id");
  const ms = messages().filter((m) => !a || m.account === a);
  const parType = (t: string) => ms.filter((m) => typeDe(m) === t);
  const trente = datePb(new Date(Date.now() - 30 * 86400_000).toISOString()) as string;
  const nonLus = (l: Fiche[]) => l.filter((m) => !m.is_read).length;
  const inbox = parType("inbox");
  return ok({
    inboxUnread: nonLus(inbox),
    inboxTotal: inbox.length,
    starred: ms.filter((m) => m.is_starred).length,
    unread: ms.filter((m) => !m.is_read && !["spam", "trash", "sent", "drafts"].includes(typeDe(m))).length,
    sent: parType("sent").length,
    drafts: ms.filter((m) => m.is_draft).length,
    trash: parType("trash").length,
    spam: parType("spam").length,
    archive: parType("archive").length,
    allMail: ms.filter((m) => !m.is_sent).length,
    allMailUnread30: ms.filter((m) => !m.is_read && !m.is_sent && String(m.date) >= trente).length,
  });
}

function compteursEtiquettes(q: URLSearchParams): Reponse {
  const a = q.get("account_id");
  const ms = messages().filter((m) => !a || m.account === a);
  const items = [...collection("labels").values()].map((l) => {
    const avec = ms.filter((m) => ((m.labels as string[]) || []).includes(l.id));
    return { id: l.id, name: l.name, color: l.color, is_secondary: !!l.is_secondary, total: avec.length, unread: avec.filter((m) => !m.is_read).length };
  });
  return ok({ items });
}

function brouillonAuto(b: Record<string, unknown>): Reponse {
  const compte = lire("accounts", b.account_id);
  if (!compte) return erreur(400, "account_id is required");
  let dossierBrouillons = [...collection("folders").values()].find((d) => d.account === compte.id && d.type === "drafts");
  if (!dossierBrouillons) dossierBrouillons = ecrire("folders", { account: compte.id, name: "Drafts", path: "Drafts", type: "drafts", delimiter: "/", sort_order: 2 });
  const existant = typeof b.draft_id === "string" ? lire("messages", b.draft_id) : null;
  const champs: Record<string, unknown> = {
    account: compte.id,
    folder: existant?.folder || dossierBrouillons.id,
    is_draft: true,
    is_read: true,
    date: datePb(new Date().toISOString()),
    auto_saved_at: datePb(new Date().toISOString()),
  };
  const map: Record<string, string> = { to: "to_addresses", cc: "cc_addresses", bcc: "bcc_addresses" };
  for (const k of ["to", "cc", "bcc", "subject", "text_body", "html_body", "in_reply_to", "draft_reply_to", "priority", "references", "thread_id"]) {
    if (b[k] !== undefined) champs[map[k] || k] = b[k];
  }
  if (champs.text_body !== undefined) champs.snippet = String(champs.text_body || "").slice(0, 200);
  const f = ecrire("messages", { ...(existant ? { id: existant.id } : {}), ...champs });
  return ok({ status: existant ? "updated" : "created", draft_id: f.id, auto_saved_at: f.auto_saved_at });
}

// --- Routes iMiel Cloud (memes formes que backend/pb_hooks/cloud.pb.js) ---
type Boite = { id: string; email: string; label?: string; display_name?: string; color?: string; signature?: string; auth?: string; oauth_provider?: string; imap?: Record<string, unknown>; smtp?: Record<string, unknown>; a_reconnecter?: boolean };

function cloudBoites(b: { boites?: Boite[]; complet?: boolean }): Reponse {
  const gardes = new Set<string>();
  let cree = 0;
  for (const x of b.boites || []) {
    gardes.add(x.id);
    if (!lire("accounts", x.id)) cree++;
    ecrire("accounts", {
      id: x.id,
      user: UTILISATEUR_ID,
      cloud_managed: true,
      protocol: "imap",
      is_active: true,
      email: x.email,
      label: x.label || x.email,
      display_name: x.display_name || "",
      color: x.color || "",
      signature: x.signature || "",
      auth_type: x.auth === "oauth2" ? "oauth2" : "password",
      oauth_provider: x.oauth_provider || "",
      imap_host: x.imap?.host || "cloud",
      smtp_host: x.smtp?.host || "cloud",
      sync_status: "idle",
      sync_error: x.a_reconnecter ? "Boite a reconnecter dans Reglages > Comptes." : "",
    });
  }
  let retire = 0;
  if (b.complet) for (const a of [...collection("accounts").values()]) if (a.cloud_managed && !gardes.has(a.id)) (supprimer("accounts", a.id), retire++);
  return ok({ cree, retire });
}

function cloudCurseurs(q: URLSearchParams): Reponse {
  const a = q.get("account");
  const out: Record<string, { v: number; u: number; min: number; n: number }> = {};
  for (const d of collection("folders").values()) {
    if (d.account !== a || !d.uid_validity) continue;
    const ms = messages().filter((m) => m.folder === d.id && Number(m.uid) > 0 && !m.is_draft);
    const uids = ms.map((m) => Number(m.uid));
    out[String(d.path)] = { v: Number(d.uid_validity), u: uids.length ? Math.max(...uids) : 0, min: uids.length ? Math.min(...uids) : 0, n: uids.length };
  }
  return ok({ curseurs: out });
}

interface Resultat { v: number; remise?: boolean; mails?: Record<string, unknown>[]; presents?: number[]; jusqua?: number; drapeaux?: { uid: number; lu: boolean; favori: boolean; repondu: boolean }[]; min?: number; u?: number }

function cloudIngest(b: { boite: string; dossiers?: Record<string, unknown>[]; resultats?: Record<string, Resultat> }): Reponse {
  if (!lire("accounts", b.boite)) return erreur(404, "Boite inconnue.");
  const bilan = { crees: 0, maj: 0, retires: 0, dossiers: 0, nouveaux: [] as unknown[] };
  const parChemin = new Map<string, { id: string; type: string; ancienne: number }>();
  for (const d of b.dossiers || []) {
    const ancien = lire("folders", d.id);
    if (!ancien) bilan.dossiers++;
    const r = b.resultats?.[String(d.path)];
    ecrire("folders", { id: d.id, account: b.boite, name: d.name || d.path, path: d.path, type: d.type || "custom", delimiter: d.delimiter || "/", sort_order: d.sort_order || 0, ...(r?.v ? { uid_validity: r.v } : {}) }, { silencieux: !!ancien });
    parChemin.set(String(d.path), { id: String(d.id), type: String(d.type || "custom"), ancienne: Number(ancien?.uid_validity || 0) });
  }
  for (const [chemin, res] of Object.entries(b.resultats || {})) {
    const dos = parChemin.get(chemin);
    if (!dos) continue;
    const dansDossier = () => messages().filter((m) => m.folder === dos.id && !m.is_draft);
    if (res.remise && dos.ancienne && dos.ancienne !== res.v) for (const m of dansDossier()) (supprimer("messages", m.id), bilan.retires++);
    for (const x of res.mails || []) {
      if (lire("messages", x.id)) continue;
      const { pieces, ...reste } = x as { pieces?: Record<string, unknown>[] } & Record<string, unknown>;
      ecrire("messages", { ...reste, account: b.boite, folder: dos.id, is_draft: false, is_sent: dos.type === "sent", priority: "normal", labels: [] });
      bilan.crees++;
      if (dos.type === "inbox" && !x.is_read) bilan.nouveaux.push({ id: x.id, subject: x.subject, from: x.from_address });
      for (const p of pieces || []) ecrire("attachments", { id: p.id, message: x.id, filename: p.filename, content_type: p.content_type, size: p.size, content_id: p.content_id, is_inline: p.is_inline, cloud_index: p.index, file: "" }, { silencieux: true });
    }
    if (res.drapeaux?.length) {
      const parUid = new Map(res.drapeaux.map((d) => [d.uid, d]));
      for (const m of dansDossier()) {
        const d = parUid.get(Number(m.uid));
        if (d && (!!m.is_read !== d.lu || !!m.is_starred !== d.favori || !!m.is_answered !== d.repondu)) {
          ecrire("messages", { id: m.id, is_read: d.lu, is_starred: d.favori, is_answered: d.repondu });
          bilan.maj++;
        }
      }
    }
    // Plage deja connue de l'appareil : [min, jusqua] (jamais les mails du lot).
    const jusqua = res.jusqua ?? res.u ?? 0;
    if (!res.remise && res.presents && res.min && jusqua >= res.min) {
      const presents = new Set(res.presents);
      const nouveaux = new Set((res.mails || []).map((x) => Number(x.uid)));
      for (const m of dansDossier()) {
        const u = Number(m.uid);
        if (u >= res.min && u <= jusqua && !presents.has(u) && !nouveaux.has(u)) (supprimer("messages", m.id), bilan.retires++);
      }
    }
  }
  ecrire("accounts", { id: b.boite, last_synced_at: datePb(new Date().toISOString()), sync_status: "idle", sync_error: "" }, { silencieux: true });
  return ok(bilan);
}

function cloudFiches(b: { fiches?: Record<string, unknown>[] }): Reponse {
  const bilan = { appliquees: 0, ignorees: 0 };
  for (const f of b.fiches || []) {
    if (f.col === "messages") {
      if (lire("messages", f.id)) (ecrire("messages", { id: f.id, labels: f.labels || [], ...(f.importance ? { importance: f.importance } : {}) }), bilan.appliquees++);
      else bilan.ignorees++;
      continue;
    }
    const col = String(f.col || "");
    const fiche = (f.fiche || {}) as Record<string, unknown>;
    const id = String(fiche.id || f.id || "");
    if (!/^[a-z0-9]{15}$/.test(id) || col === "users" || col === "accounts" || col === "messages") {
      bilan.ignorees++;
      continue;
    }
    if (f.action === "suppr") supprimer(col, id);
    else ecrire(col, { ...fiche, id, user: UTILISATEUR_ID });
    bilan.appliquees++;
  }
  return ok(bilan);
}

async function cloudPieceBrouillon(corps: unknown): Promise<Reponse> {
  if (!(corps instanceof FormData)) return erreur(400, "Formulaire attendu.");
  const messageId = String(corps.get("messageId") || "");
  if (!lire("messages", messageId)?.is_draft) return erreur(400, "Ce mail n'est pas un brouillon.");
  const inline = corps.get("inline") === "1";
  const out = [];
  for (const v of corps.getAll("files")) {
    if (typeof v === "string") continue;
    const id = (await import("./base")).nouvelId();
    const nom = v.name.replace(/[^\w.-]/g, "_");
    await ecrireFichier(`attachments/${id}/${nom}`, v);
    const a = ecrire("attachments", { id, message: messageId, filename: v.name, size: v.size, content_type: v.type, file: nom, is_inline: inline, content_id: inline ? `${id}@imiel` : "" });
    out.push({ id: a.id, filename: v.name, size: v.size, file: nom, content_id: a.content_id, is_inline: inline });
  }
  ecrire("messages", { id: messageId, has_attachments: true });
  return ok({ success: true, attachments: out });
}

/** Point d'entree : une requete de l'interface vers sa base. */
export async function servir(methode: string, url: URL, corps: unknown): Promise<Reponse> {
  const p = url.pathname;
  const q = url.searchParams;
  let m: RegExpMatchArray | null;
  if (p === "/api/health") return ok({ message: "API is healthy.", code: 200, data: {} });
  if (p === "/api/realtime") return { statut: 204 };
  if (/^\/api\/collections\/(users|_pb_users_auth_)\/(auth-refresh|auth-with-password)$/.test(p)) return ok({ token: jetonLocal(), record: utilisateurLocal() });
  if ((m = p.match(/^\/api\/collections\/([\w]+)\/records(?:\/([\w]+))?$/))) {
    const col = m[1] === "_pb_users_auth_" ? "users" : m[1];
    const id = m[2] || null;
    if (methode === "GET" && !id) return liste(col, q);
    if (methode === "GET") {
      const f = lire(col, id);
      if (!f) return erreur(404, "The requested resource wasn't found.");
      const [x] = await avecCorps(col, [etendre(col, f, q.get("expand"))], q.get("fields"));
      return ok(projeter(x, q.get("fields")));
    }
    if (methode === "POST" && !id) return creerOuMaj(col, null, corps, q);
    if (methode === "PATCH" && id) return creerOuMaj(col, id, corps, q);
    if (methode === "DELETE" && id) {
      supprimer(col, id);
      return { statut: 204 };
    }
  }
  if ((m = p.match(/^\/api\/files\/([\w]+)\/([\w]+)\/(.+)$/))) {
    const b = await lireFichier(`${m[1]}/${m[2]}/${decodeURIComponent(m[3])}`);
    return b ? { statut: 200, blob: b } : erreur(404, "Fichier introuvable.");
  }
  switch (`${methode} ${p}`) {
    case "GET /api/mail/list":
      return listeMails(q);
    case "GET /api/mail/sidebar-counts":
      return compteurs(q);
    case "GET /api/mail/label-counts":
      return compteursEtiquettes(q);
    case "GET /api/mail/thread-counts": {
      const ids = (q.get("thread_ids") || "").split(",").filter(Boolean);
      const counts: Record<string, number> = {};
      for (const m2 of messages()) if (ids.includes(String(m2.thread_id))) counts[String(m2.thread_id)] = (counts[String(m2.thread_id)] || 0) + 1;
      return ok({ counts });
    }
    case "POST /api/mail/auto-save":
      return brouillonAuto(corps as Record<string, unknown>);
    case "GET /api/mail/dashboard-stats":
      return ok({ unreadCount: messages().filter((x) => !x.is_read && typeDe(x) === "inbox").length, unansweredCount: 0 });
    case "GET /api/mail/correspondents":
      return ok({ addresses: [...new Set(messages().map((x) => String((x.from_address as { address?: string })?.address || "")).filter(Boolean))].slice(0, 2000) });
    case "POST /api/mail/importance": {
      const b = corps as { message_id: string; importance: string; scope?: string };
      if (lire("messages", b.message_id)) ecrire("messages", { id: b.message_id, importance: b.importance, importance_source: "user" });
      return ok({ ok: true, scope: "message", importance: b.importance, updated: 1 });
    }
    case "POST /api/mail/schedule":
      return erreur(400, "L'envoi programme n'est pas encore disponible dans l'app web.");
    case "POST /api/cloud/boites":
      return cloudBoites(corps as { boites?: Boite[]; complet?: boolean });
    case "GET /api/cloud/curseurs":
      return cloudCurseurs(q);
    case "POST /api/cloud/ingest":
      return cloudIngest(corps as Parameters<typeof cloudIngest>[0]);
    case "POST /api/cloud/fiches":
      return cloudFiches(corps as { fiches?: Record<string, unknown>[] });
    case "POST /api/cloud/piece-brouillon":
      return cloudPieceBrouillon(corps);
  }
  if ((m = p.match(/^\/api\/mail\/draft\/([\w]+)$/)) && methode === "DELETE") {
    supprimer("messages", m[1]);
    return ok({ success: true });
  }
  if ((m = p.match(/^\/api\/cloud\/piece-brouillon\/([\w]+)$/)) && methode === "DELETE") {
    supprimer("attachments", m[1]);
    return ok({ success: true });
  }
  if ((m = p.match(/^\/api\/mail\/thread\/([^/]+)\/labels$/))) {
    const tid = decodeURIComponent(m[1]);
    const labels = new Set<string>();
    for (const x of messages()) if (x.thread_id === tid) for (const l of (x.labels as string[]) || []) labels.add(l);
    return ok({ labels: [...labels].map((id) => lire("labels", id)).filter(Boolean), overrides: [] });
  }
  if ((m = p.match(/^\/api\/mail\/thread\/([^/]+)\/label\/([\w]+)$/))) {
    const tid = decodeURIComponent(m[1]);
    for (const x of messages()) {
      if (x.thread_id !== tid) continue;
      const l = new Set((x.labels as string[]) || []);
      if (methode === "DELETE") l.delete(m[2]);
      else l.add(m[2]);
      ecrire("messages", { id: x.id, labels: [...l] });
    }
    return ok({ ok: true });
  }
  return erreur(503, "Indisponible dans l'app web.");
}
