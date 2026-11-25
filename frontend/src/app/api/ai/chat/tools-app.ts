// Outils de l'assistant IA pour TOUTE l'application (comptes, signatures,
// etiquettes, dossiers, regles, bloques, newsletters, alertes, contacts,
// suivis, gestes sur les mails, reglages).
//
//  - LECTURE (list_app_data) : executee ici avec le JETON PocketBase de
//    l'utilisateur ; jamais un mot de passe ni une cle dans la reponse.
//  - ECRITURE (propose_*) : construite ici en CARTE (etat avant -> apres),
//    executee cote client apres "Accepter" (lib/ai-actions.ts), par les memes
//    chemins que les ecrans de l'app.
import { promises as dns } from "node:dns";
import type {
  AccountCreatePayload,
  AiAction,
  AiActionKind,
  FieldValue,
  FilterRuleCreatePayload,
  MailOp,
  RecordItem,
  RecordKind,
  TrackingEmailRef,
} from "@/lib/ai-actions-types";
import { RECORD_FIELDS, SETTINGS_FIELDS } from "@/lib/ai-actions-fields";
import { providerByEmail, providerByMx, providerByName, type MailProvider } from "@/lib/mail-providers";

const PB_URL = process.env.POCKETBASE_INTERNAL_URL || "http://127.0.0.1:8090";
const TIMEOUT_MS = 20_000;

export interface AppToolContext {
  userId: string;
  authToken: string;
  userText?: string;
}

type JsonSchema = Record<string, unknown>;

function fn(name: string, description: string, parameters: JsonSchema) {
  return { type: "function" as const, function: { name, description, parameters } };
}

const LIST_WHAT = ["accounts", "signature", "labels", "folders", "filter_rules", "blocked", "newsletter_sources", "alert_topics", "settings"];

const opItems = (ops: string[], itemProps: JsonSchema, extra: JsonSchema = {}) => ({
  type: "object",
  properties: {
    op: { type: "string", enum: ops },
    items: { type: "array", items: { type: "object", properties: itemProps } },
    ...extra,
  },
  required: ["op", "items"],
});

export const APP_TOOL_DEFINITIONS = [
  fn(
    "list_app_data",
    "LIT la configuration d'iMiel (plusieurs rubriques en UN appel) : accounts (comptes mail, jamais les mots de passe), signature (HTML de la signature d'un compte : account_id), labels (etiquettes), folders (dossiers, account_id facultatif), filter_rules (regles de tri), blocked (expediteurs bloques), newsletter_sources (newsletters suivies), alert_topics (alertes par sujet), settings (reglages generaux). Rend les id necessaires aux propose_*.",
    {
      type: "object",
      properties: {
        what: { type: "array", items: { type: "string", enum: LIST_WHAT } },
        account_id: { type: "string" },
      },
      required: ["what"],
    }
  ),
  fn(
    "propose_account_create",
    "Propose d'AJOUTER un compte mail. Les serveurs IMAP/SMTP des fournisseurs connus (Infomaniak, Gmail, Outlook, OVH, iCloud, Gandi, IONOS, Orange, Free...) sont remplis automatiquement, y compris pour un domaine perso (reconnu par ses serveurs MX). Ne donne les serveurs que si l'utilisateur les a precises. Le mot de passe est facultatif : sans lui, l'utilisateur le saisit dans la carte.",
    {
      type: "object",
      properties: {
        email: { type: "string" },
        password: { type: "string", description: "Seulement si l'utilisateur l'a donne" },
        provider: { type: "string", description: "Fournisseur nomme par l'utilisateur (ex: Infomaniak)" },
        display_name: { type: "string", description: "Nom affiche aux destinataires" },
        label: { type: "string", description: "Nom du compte dans l'app" },
        imap_host: { type: "string" }, imap_port: { type: "number" }, imap_security: { type: "string", enum: ["ssl", "starttls", "none"] },
        smtp_host: { type: "string" }, smtp_port: { type: "number" }, smtp_security: { type: "string", enum: ["ssl", "starttls", "none"] },
        username: { type: "string", description: "Identifiant de connexion s'il differe de l'adresse" },
      },
      required: ["email"],
    }
  ),
  fn("propose_account_update", "Propose de MODIFIER un compte (id issu de list_app_data accounts). Ne donner que les champs qui changent.", {
    type: "object",
    properties: {
      account_id: { type: "string" },
      label: { type: "string" }, display_name: { type: "string" }, color: { type: "string" }, is_active: { type: "boolean" },
      check_interval: { type: "number" },
      imap_host: { type: "string" }, imap_port: { type: "number" }, imap_security: { type: "string" }, imap_username: { type: "string" }, imap_password: { type: "string" },
      smtp_host: { type: "string" }, smtp_port: { type: "number" }, smtp_security: { type: "string" }, smtp_username: { type: "string" }, smtp_password: { type: "string" },
    },
    required: ["account_id"],
  }),
  fn("propose_account_delete", "Propose de RETIRER un compte d'iMiel (ses mails disparaissent de l'app, pas du serveur du fournisseur).", {
    type: "object",
    properties: { account_id: { type: "string" } },
    required: ["account_id"],
  }),
  fn(
    "propose_signature",
    "Propose la SIGNATURE d'un compte (remplace l'actuelle). html = HTML simple : <p>, <strong>, <em>, <a href>, <br>, <table> pour une mise en colonnes, <img src> seulement avec une adresse d'image deja connue (sinon l'utilisateur ajoute l'image dans Reglages > Signatures). Chaine vide = retirer la signature.",
    {
      type: "object",
      properties: { account_id: { type: "string" }, html: { type: "string" } },
      required: ["account_id", "html"],
    }
  ),
  fn("propose_labels", "Propose de CREER, MODIFIER ou SUPPRIMER des etiquettes (id issus de list_app_data labels pour update/delete). is_secondary = l'etiquette sort ses mails de la boite de reception.", opItems(
    ["create", "update", "delete"],
    { id: { type: "string" }, name: { type: "string" }, color: { type: "string", description: "Hex #rrggbb" }, is_secondary: { type: "boolean" } }
  )),
  fn("propose_folders", "Propose de CREER (account_id requis), RENOMMER (update) ou SUPPRIMER des dossiers personnels (id issus de list_app_data folders).", opItems(
    ["create", "update", "delete"],
    { id: { type: "string" }, name: { type: "string" } },
    { account_id: { type: "string" } }
  )),
  fn(
    "propose_filter_rule_create",
    "Propose une REGLE DE TRI automatique. criteria : field from|to|subject|body|has_attachments, operator equals|contains|starts_with|ends_with|not_contains|is_true|is_false, value. actions : type move_to_spam|move_to_trash|archive|mark_as_read|add_label|block_sender ; add_label avec label_id (existant) ou label_name (cree si absent).",
    {
      type: "object",
      properties: {
        name: { type: "string" },
        match_mode: { type: "string", enum: ["all", "any"] },
        criteria: { type: "array", items: { type: "object", properties: { field: { type: "string" }, operator: { type: "string" }, value: { type: "string" } } } },
        actions: { type: "array", items: { type: "object", properties: { type: { type: "string" }, label_id: { type: "string" }, label_name: { type: "string" } } } },
      },
      required: ["name", "criteria", "actions"],
    }
  ),
  fn("propose_filter_rules", "Propose de MODIFIER (nom, activer/desactiver) ou SUPPRIMER des regles de tri (id issus de list_app_data filter_rules).", opItems(
    ["update", "delete"],
    { id: { type: "string" }, name: { type: "string" }, is_active: { type: "boolean" }, match_mode: { type: "string", enum: ["all", "any"] } }
  )),
  fn("propose_blocked", "Propose de BLOQUER (add) ou DEBLOQUER (remove) des expediteurs (adresses).", {
    type: "object",
    properties: { op: { type: "string", enum: ["add", "remove"] }, emails: { type: "array", items: { type: "string" } } },
    required: ["op", "emails"],
  }),
  fn("propose_newsletter_sources", "Propose de SUIVRE (add) ou ne plus suivre (remove) des newsletters, designees par l'adresse de l'expediteur.", opItems(
    ["add", "remove"],
    { email: { type: "string" }, name: { type: "string" } }
  )),
  fn("propose_alert_topics", "Propose de CREER, MODIFIER ou SUPPRIMER des alertes newsletters par sujet (id issus de list_app_data alert_topics).", opItems(
    ["create", "update", "delete"],
    { id: { type: "string" }, name: { type: "string" }, description: { type: "string" } }
  )),
  fn("propose_contacts", "Propose de MODIFIER ou SUPPRIMER des contacts (id issus de search_contacts).", opItems(
    ["update", "delete"],
    { id: { type: "string" }, name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, company: { type: "string" } }
  )),
  fn("propose_tracking_update", "Propose de MODIFIER des fiches de Suivi (id issus de search_tracking) : titre, status active (ouvert) | done (cloture), archived (ne plus suivre), pinned.", {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string", enum: ["active", "done"] }, archived: { type: "boolean" }, pinned: { type: "boolean" } } } },
    },
    required: ["items"],
  }),
  fn(
    "propose_mail_action",
    "Propose un GESTE sur des mails (message_ids issus de search_emails) : archive, trash (corbeille), spam, inbox, move (folder_id), read, unread, star, unstar, label_add / label_remove (label_id ou label_name), delete_forever (UNIQUEMENT si l'utilisateur demande explicitement une suppression definitive). Un seul geste par appel.",
    {
      type: "object",
      properties: {
        op: { type: "string", enum: ["archive", "trash", "spam", "inbox", "move", "read", "unread", "star", "unstar", "label_add", "label_remove", "delete_forever"] },
        message_ids: { type: "array", items: { type: "string" } },
        folder_id: { type: "string" },
        label_id: { type: "string" },
        label_name: { type: "string" },
      },
      required: ["op", "message_ids"],
    }
  ),
  fn("propose_settings", "Propose de changer des REGLAGES generaux : " + SETTINGS_FIELDS.map((f) => `${f.key}${f.options ? ` (${f.options.join("|")})` : ""}`).join(", ") + ".", {
    type: "object",
    properties: Object.fromEntries(
      SETTINGS_FIELDS.map((f) => [f.key, f.type === "bool" ? { type: "boolean" } : f.type === "number" ? { type: "number" } : f.options ? { type: "string", enum: f.options } : { type: "string" }])
    ),
  }),
];

export const APP_TOOL_NAMES = new Set(APP_TOOL_DEFINITIONS.map((d) => d.function.name));

// --- helpers ---------------------------------------------------------------

function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  if (typeof v === "string") return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return [];
}
function idFilter(ids: string[]): string {
  return ids.map((id) => `id = "${esc(id)}"`).join(" || ");
}

async function pbList<T>(collection: string, ctx: AppToolContext, params: Record<string, string>): Promise<T[]> {
  const qs = new URLSearchParams({ perPage: "200", ...params }).toString();
  const r = await fetch(`${PB_URL}/api/collections/${collection}/records?${qs}`, {
    headers: { Authorization: ctx.authToken },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`${collection} HTTP ${r.status}`);
  const d = (await r.json()) as { items?: T[] };
  return d.items || [];
}

async function pbGet<T>(collection: string, id: string, ctx: AppToolContext, fields?: string): Promise<T> {
  const qs = fields ? `?fields=${encodeURIComponent(fields)}` : "";
  const r = await fetch(`${PB_URL}/api/collections/${collection}/records/${encodeURIComponent(id)}${qs}`, {
    headers: { Authorization: ctx.authToken },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(r.status === 404 ? `${collection} introuvable : ${id}` : `${collection} HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Champs lisibles d'un compte : JAMAIS de mot de passe ni de jeton OAuth. */
const ACCOUNT_SAFE_FIELDS =
  "id,email,label,display_name,protocol,auth_type,is_active,color,check_interval,imap_host,imap_port,imap_security,imap_username,smtp_host,smtp_port,smtp_security,smtp_username,sync_status,sync_error,last_synced_at,signature";

interface PbAccount {
  id: string; email: string; label: string; display_name: string; protocol: string; auth_type: string; is_active: boolean; color: string;
  check_interval: number; imap_host: string; imap_port: number; imap_security: string; imap_username: string;
  smtp_host: string; smtp_port: number; smtp_security: string; smtp_username: string; sync_status: string; sync_error: string; last_synced_at: string;
  signature: string;
}
interface PbLabel { id: string; name: string; color: string; is_secondary: boolean }
interface PbFolder { id: string; name: string; type: string; account: string; total_count: number; unread_count: number }
interface PbRule { id: string; name: string; is_active: boolean; match_mode: string; criteria: unknown; actions: unknown }

async function listAccounts(ctx: AppToolContext): Promise<PbAccount[]> {
  return pbList<PbAccount>("accounts", ctx, { filter: `user = "${esc(ctx.userId)}"`, sort: "created", fields: ACCOUNT_SAFE_FIELDS });
}

async function getUser(ctx: AppToolContext): Promise<Record<string, unknown>> {
  const fields = ["id", "blocked_senders", ...SETTINGS_FIELDS.map((f) => f.key)].join(",");
  return pbGet<Record<string, unknown>>("users", ctx.userId, ctx, fields);
}

function pick(rec: Record<string, unknown>, keys: string[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = "";
  }
  return out;
}

/** Garde les champs autorises du geste, convertis au bon type. */
function changesFor(kind: RecordKind, raw: Record<string, unknown>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const spec of RECORD_FIELDS[kind]) {
    const v = raw[spec.key];
    if (v === undefined || v === null) continue;
    if (spec.type === "bool") {
      if (typeof v === "boolean") out[spec.key] = v;
      else if (v === "true" || v === "false") out[spec.key] = v === "true";
    } else if (spec.type === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) out[spec.key] = n;
    } else if (typeof v === "string") {
      const s = v.trim();
      if (spec.options && !spec.options.includes(s)) continue;
      if (spec.type === "color" && s && !/^#[0-9a-f]{3,8}$/i.test(s)) continue;
      out[spec.key] = s;
    }
  }
  return out;
}

const LABEL_PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#64748b"];

function stripTags(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// --- LECTURE ---------------------------------------------------------------

export async function runAppReadTool(name: string, args: Record<string, unknown>, ctx: AppToolContext): Promise<unknown> {
  if (name !== "list_app_data") return { error: `outil inconnu: ${name}` };
  const what = strList(args.what).filter((w) => LIST_WHAT.includes(w));
  if (what.length === 0) return { error: `what requis parmi ${LIST_WHAT.join(", ")}` };
  const accountId = str(args.account_id);
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  let accountsCache: PbAccount[] | null = null;
  const accounts = async () => (accountsCache ??= await listAccounts(ctx));
  let userCache: Record<string, unknown> | null = null;
  const user = async () => (userCache ??= await getUser(ctx));

  for (const w of what) {
    try {
      switch (w) {
        case "accounts":
          out.accounts = (await accounts()).map((a) => ({
            id: a.id, email: a.email, label: a.label, display_name: a.display_name, protocol: a.protocol,
            connexion: a.auth_type === "oauth2" ? "google" : "mot de passe", active: a.is_active !== false, color: a.color,
            check_interval: a.check_interval, imap: `${a.imap_host || ""}:${a.imap_port || ""} ${a.imap_security || ""}`.trim(),
            smtp: `${a.smtp_host || ""}:${a.smtp_port || ""} ${a.smtp_security || ""}`.trim(),
            sync: a.sync_status, sync_error: a.sync_error || "", has_signature: !!stripTags(a.signature || ""),
          }));
          break;
        case "signature": {
          const list = await accounts();
          const targets = accountId ? list.filter((a) => a.id === accountId) : list;
          out.signatures = targets.map((a) => ({ account_id: a.id, email: a.email, html: (a.signature || "").slice(0, 6000) }));
          break;
        }
        case "labels": {
          const items = await pbList<PbLabel>("labels", ctx, { filter: `user = "${esc(ctx.userId)}"`, sort: "name", perPage: "500" });
          out.labels = items.map((l) => ({ id: l.id, name: l.name, color: l.color, hors_boite: !!l.is_secondary }));
          break;
        }
        case "folders": {
          const list = await accounts();
          const emailOf = new Map(list.map((a) => [a.id, a.email]));
          const filter = accountId ? `account = "${esc(accountId)}"` : list.map((a) => `account = "${esc(a.id)}"`).join(" || ");
          if (!filter) { out.folders = []; break; }
          const items = await pbList<PbFolder>("folders", ctx, { filter, sort: "sort_order,name", perPage: "500", fields: "id,name,type,account,total_count,unread_count" });
          out.folders = items.map((f) => ({ id: f.id, name: f.name, type: f.type, account_id: f.account, account: emailOf.get(f.account) || "", mails: f.total_count || 0, non_lus: f.unread_count || 0 }));
          break;
        }
        case "filter_rules": {
          const items = await pbList<PbRule>("filter_rules", ctx, { filter: `user = "${esc(ctx.userId)}"`, sort: "-created" });
          out.filter_rules = items.map((r) => ({ id: r.id, name: r.name, active: r.is_active, match_mode: r.match_mode, criteria: r.criteria, actions: r.actions }));
          break;
        }
        case "blocked": {
          const u = await user();
          out.blocked = Array.isArray(u.blocked_senders) ? u.blocked_senders : [];
          break;
        }
        case "newsletter_sources": {
          const items = await pbList<{ id: string; email: string; name: string }>("newsletter_sources", ctx, { filter: `user = "${esc(ctx.userId)}"`, sort: "name", perPage: "500" });
          out.newsletter_sources = items.map((s) => ({ id: s.id, email: s.email, name: s.name }));
          break;
        }
        case "alert_topics": {
          const items = await pbList<{ id: string; name: string; description: string }>("alert_topics", ctx, { filter: `user = "${esc(ctx.userId)}"`, sort: "name" });
          out.alert_topics = items.map((a) => ({ id: a.id, name: a.name, description: a.description }));
          break;
        }
        case "settings":
          out.settings = pick(await user(), SETTINGS_FIELDS.map((f) => f.key));
          break;
      }
    } catch (err) {
      errors.push(`${w} : ${(err as Error).message}`);
    }
  }
  if (errors.length) out.errors = errors;
  out.next_step = "Pour creer / modifier / supprimer, appelle MAINTENANT le propose_* correspondant avec ces id. Sans cet appel, aucune carte n'existe.";
  return out;
}

/** Nombre d'elements rendus par list_app_data, pour le deroule du chat. */
export function appListCount(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  let n = 0;
  let any = false;
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (k === "errors") continue;
    if (Array.isArray(v)) { n += v.length; any = true; }
  }
  return any ? n : null;
}

// --- ECRITURE -> ACTION ----------------------------------------------------

let seq = 0;
function actionId(): string {
  seq = (seq + 1) % 1_000_000;
  return `act_${Date.now().toString(36)}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function resolveMx(domain: string): Promise<string[]> {
  try {
    const recs = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
    return recs.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  } catch {
    return [];
  }
}

/** Fournisseur : nom donne, sinon domaine grand public, sinon serveurs MX. */
export async function detectProvider(email: string, providerName: string): Promise<MailProvider | undefined> {
  const named = providerByName(providerName);
  if (named) return named;
  const byDomain = providerByEmail(email);
  if (byDomain) return byDomain;
  const domain = email.split("@")[1] || "";
  return domain ? providerByMx(await resolveMx(domain)) : undefined;
}

const SEC = ["ssl", "starttls", "none"] as const;
function security(v: unknown, fallback: "ssl" | "starttls" | "none"): "ssl" | "starttls" | "none" {
  return (SEC as readonly string[]).includes(str(v)) ? (str(v) as "ssl" | "starttls" | "none") : fallback;
}

async function buildAccountCreate(args: Record<string, unknown>, ctx: AppToolContext): Promise<AccountCreatePayload> {
  const email = str(args.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("adresse email invalide");
  const existing = await listAccounts(ctx);
  if (existing.some((a) => (a.email || "").toLowerCase() === email)) throw new Error(`le compte ${email} est deja configure dans iMiel`);
  const provider = await detectProvider(email, str(args.provider));
  const imapHost = str(args.imap_host) || provider?.imap.host || "";
  const smtpHost = str(args.smtp_host) || provider?.smtp.host || "";
  if (!imapHost || !smtpHost) {
    throw new Error(
      "fournisseur non reconnu : demande a l'utilisateur chez qui est heberge ce compte (ou ses serveurs IMAP/SMTP), puis rappelle propose_account_create avec provider ou imap_host/smtp_host"
    );
  }
  const username = str(args.username) || email;
  return {
    provider: provider?.key || "custom",
    providerName: provider?.name || "Configuration manuelle",
    oauth: provider?.oauth && !str(args.imap_host) ? provider.oauth : "",
    email,
    display_name: str(args.display_name),
    label: str(args.label) || email,
    imap_host: imapHost,
    imap_port: Number(args.imap_port) || provider?.imap.port || 993,
    imap_security: security(args.imap_security, provider?.imap.security || "ssl"),
    imap_username: username,
    smtp_host: smtpHost,
    smtp_port: Number(args.smtp_port) || provider?.smtp.port || 465,
    smtp_security: security(args.smtp_security, provider?.smtp.security || "ssl"),
    smtp_username: username,
    // Le modele invente parfois un mot de passe : il n'est garde que s'il a
    // ete ecrit par l'utilisateur, sinon la carte le fait saisir.
    password: passwordFromUser(args.password, ctx.userText || "", [email, username, str(args.provider), provider?.name || "", provider?.key || ""]),
  };
}

/**
 * Mot de passe propose par le modele : garde SEULEMENT si l'utilisateur l'a
 * ecrit lui-meme en parlant d'un mot de passe, et s'il ne s'agit pas d'un mot
 * de la demande (adresse, identifiant, fournisseur) recopie par le modele.
 * Sinon vide : la carte s'ouvre en saisie, champ masque.
 */
export function passwordFromUser(raw: unknown, userText: string, notThese: string[]): string {
  if (typeof raw !== "string") return "";
  const pw = raw.trim();
  if (pw.length < 4 || !userText.includes(pw)) return "";
  const low = pw.toLowerCase();
  if (notThese.some((x) => x && (x.toLowerCase() === low || x.toLowerCase().split("@")[0] === low || x.toLowerCase().includes(low)))) return "";
  if (!/(mot de passe|mdp|password|passwort|pass\b|pwd|parola d'ordine)/i.test(userText)) return "";
  return pw;
}

const MAIL_OPS: MailOp[] = ["archive", "trash", "spam", "inbox", "move", "read", "unread", "star", "unstar", "label_add", "label_remove", "delete_forever"];

/**
 * Transforme un appel propose_* "application" en ACTION affichable. Leve une
 * erreur lisible (renvoyee au modele) si la proposition est inexploitable.
 */
export async function buildAppAction(name: string, args: Record<string, unknown>, ctx: AppToolContext, groupId: string): Promise<AiAction> {
  const base = (kind: AiActionKind, payload: AiAction["payload"]): AiAction => ({ id: actionId(), kind, groupId, payload, status: "pending" });
  const records = (kind: RecordKind, items: RecordItem[], empty: string): AiAction => {
    if (items.length === 0) throw new Error(empty);
    return base(kind, { items });
  };
  const rawItems = (Array.isArray(args.items) ? args.items : []) as Record<string, unknown>[];
  const op = str(args.op);

  switch (name) {
    case "propose_account_create":
      return base("account_create", await buildAccountCreate(args, ctx));

    case "propose_account_update": {
      const id = str(args.account_id);
      const acc = (await listAccounts(ctx)).find((a) => a.id === id);
      if (!acc) throw new Error("compte introuvable : utilise list_app_data accounts");
      const after = changesFor("account_update", args);
      if (Object.keys(after).length === 0) throw new Error("aucun champ a modifier");
      const before = pick(acc as unknown as Record<string, unknown>, Object.keys(after));
      for (const k of ["imap_password", "smtp_password"]) if (k in before) before[k] = "";
      return records("account_update", [{ id, title: acc.email, before, after }], "aucun compte");
    }

    case "propose_account_delete": {
      const id = str(args.account_id);
      const acc = (await listAccounts(ctx)).find((a) => a.id === id);
      if (!acc) throw new Error("compte introuvable : utilise list_app_data accounts");
      return records("account_delete", [{ id, title: acc.email, context: "Ses mails, dossiers et brouillons disparaissent d'iMiel (pas du serveur du fournisseur).", after: {} }], "aucun compte");
    }

    case "propose_signature": {
      const id = str(args.account_id);
      const acc = (await listAccounts(ctx)).find((a) => a.id === id);
      if (!acc) throw new Error("compte introuvable : utilise list_app_data accounts");
      const html = typeof args.html === "string" ? args.html.trim().slice(0, 20000) : "";
      // Pas de script ni de gestionnaire d'evenement dans une signature.
      if (/<script|\son\w+\s*=|javascript:/i.test(html)) throw new Error("HTML de signature refuse (script)");
      return base("signature_set", { account_id: id, account_email: acc.email, before: acc.signature || "", html });
    }

    case "propose_labels": {
      const all = await pbList<PbLabel>("labels", ctx, { filter: `user = "${esc(ctx.userId)}"`, perPage: "500" });
      const byId = new Map(all.map((l) => [l.id, l]));
      if (op === "create") {
        const taken = new Set(all.map((l) => l.name.toLowerCase()));
        const items = rawItems.flatMap((r, i): RecordItem[] => {
          const after = changesFor("label_create", r);
          const nm = str(after.name);
          if (!nm || taken.has(nm.toLowerCase())) return [];
          taken.add(nm.toLowerCase());
          if (!after.color) after.color = LABEL_PALETTE[(all.length + i) % LABEL_PALETTE.length];
          if (after.is_secondary === undefined) after.is_secondary = false;
          return [{ id: "", title: nm, after }];
        });
        return records("label_create", items, "aucune etiquette nouvelle (nom manquant ou deja existant : list_app_data labels)");
      }
      const items = rawItems.flatMap((r): RecordItem[] => {
        const l = byId.get(str(r.id));
        if (!l) return [];
        if (op === "delete") return [{ id: l.id, title: l.name, after: {} }];
        const after = changesFor("label_update", r);
        if (Object.keys(after).length === 0) return [];
        return [{ id: l.id, title: l.name, before: pick(l as unknown as Record<string, unknown>, Object.keys(after)), after }];
      });
      return records(op === "delete" ? "label_delete" : "label_update", items, "etiquettes introuvables : utilise list_app_data labels");
    }

    case "propose_folders": {
      const accounts = await listAccounts(ctx);
      if (op === "create") {
        const acc = accounts.find((a) => a.id === str(args.account_id)) || (accounts.length === 1 ? accounts[0] : undefined);
        if (!acc) throw new Error("account_id requis : utilise list_app_data accounts");
        const items = rawItems.flatMap((r): RecordItem[] => {
          const nm = str(r.name);
          return nm ? [{ id: "", title: nm, context: acc.email, ref: acc.id, after: { name: nm } }] : [];
        });
        return records("folder_create", items, "aucun nom de dossier");
      }
      const ids = rawItems.map((r) => str(r.id)).filter(Boolean);
      if (ids.length === 0) throw new Error("aucun id de dossier : utilise list_app_data folders");
      const found = await pbList<PbFolder>("folders", ctx, { filter: idFilter(ids), fields: "id,name,type,account,total_count,unread_count" });
      const emailOf = new Map(accounts.map((a) => [a.id, a.email]));
      const byId = new Map(found.filter((f) => emailOf.has(f.account)).map((f) => [f.id, f]));
      const items = rawItems.flatMap((r): RecordItem[] => {
        const f = byId.get(str(r.id));
        if (!f || f.type !== "custom") return [];
        if (op === "delete") return [{ id: f.id, title: f.name, context: `${emailOf.get(f.account)} · ${f.total_count || 0} mail(s) dedans`, after: {} }];
        const nm = str(r.name);
        return nm && nm !== f.name ? [{ id: f.id, title: f.name, context: emailOf.get(f.account), before: { name: f.name }, after: { name: nm } }] : [];
      });
      return records(op === "delete" ? "folder_delete" : "folder_update", items, "dossiers introuvables ou dossiers systeme (boite de reception, envoyes... ne se modifient pas)");
    }

    case "propose_filter_rule_create": {
      const FIELDS = ["from", "to", "subject", "body", "has_attachments"];
      const OPS = ["equals", "contains", "starts_with", "ends_with", "not_contains", "is_true", "is_false"];
      const ACTS = ["move_to_spam", "move_to_trash", "archive", "mark_as_read", "add_label", "block_sender"];
      const criteria = ((Array.isArray(args.criteria) ? args.criteria : []) as Record<string, unknown>[])
        .map((c) => ({ field: str(c.field), operator: str(c.operator), value: str(c.value) }))
        .filter((c) => FIELDS.includes(c.field) && OPS.includes(c.operator) && (c.value || c.operator.startsWith("is_")));
      if (criteria.length === 0) throw new Error("aucune condition valide");
      const labels = await pbList<PbLabel>("labels", ctx, { filter: `user = "${esc(ctx.userId)}"`, perPage: "500" });
      const actions = ((Array.isArray(args.actions) ? args.actions : []) as Record<string, unknown>[]).flatMap((a): FilterRuleCreatePayload["actions"] => {
        const type = str(a.type);
        if (!ACTS.includes(type)) return [];
        if (type !== "add_label") return [{ type }];
        const byId = labels.find((l) => l.id === str(a.label_id));
        const nm = str(a.label_name);
        const byName = nm ? labels.find((l) => l.name.toLowerCase() === nm.toLowerCase()) : undefined;
        const l = byId || byName;
        if (l) return [{ type, labelId: l.id, labelName: l.name }];
        return nm ? [{ type, labelName: nm }] : [];
      });
      if (actions.length === 0) throw new Error("aucune action valide");
      return base("filter_rule_create", { name: str(args.name) || "Regle", match_mode: str(args.match_mode) === "any" ? "any" : "all", criteria, actions });
    }

    case "propose_filter_rules": {
      const ids = rawItems.map((r) => str(r.id)).filter(Boolean);
      if (ids.length === 0) throw new Error("aucun id de regle : utilise list_app_data filter_rules");
      const found = await pbList<PbRule>("filter_rules", ctx, { filter: idFilter(ids) });
      const byId = new Map(found.map((r) => [r.id, r]));
      const items = rawItems.flatMap((r): RecordItem[] => {
        const rule = byId.get(str(r.id));
        if (!rule) return [];
        if (op === "delete") return [{ id: rule.id, title: rule.name, after: {} }];
        const after = changesFor("filter_rule_update", r);
        if (Object.keys(after).length === 0) return [];
        return [{ id: rule.id, title: rule.name, before: pick(rule as unknown as Record<string, unknown>, Object.keys(after)), after }];
      });
      return records(op === "delete" ? "filter_rule_delete" : "filter_rule_update", items, "regles introuvables : utilise list_app_data filter_rules");
    }

    case "propose_blocked": {
      const u = await getUser(ctx);
      const current = new Set((Array.isArray(u.blocked_senders) ? (u.blocked_senders as string[]) : []).map((e) => e.toLowerCase()));
      const emails = Array.from(new Set(strList(args.emails).map((e) => e.toLowerCase()).filter((e) => e.includes("@"))));
      const add = op !== "remove";
      const items = emails.filter((e) => (add ? !current.has(e) : current.has(e))).map((e): RecordItem => ({ id: e, title: e, after: {} }));
      return records(add ? "blocked_add" : "blocked_remove", items, add ? "ces adresses sont deja bloquees (ou invalides)" : "ces adresses ne sont pas bloquees");
    }

    case "propose_newsletter_sources": {
      const current = await pbList<{ id: string; email: string; name: string }>("newsletter_sources", ctx, { filter: `user = "${esc(ctx.userId)}"`, perPage: "500" });
      const byEmail = new Map(current.map((s) => [s.email.toLowerCase(), s]));
      if (op === "remove") {
        const items = rawItems.flatMap((r): RecordItem[] => {
          const s = byEmail.get(str(r.email).toLowerCase());
          return s ? [{ id: s.id, title: s.name ? `${s.name} <${s.email}>` : s.email, ref: s.email, after: {} }] : [];
        });
        return records("newsletter_source_remove", items, "ces newsletters ne sont pas suivies : list_app_data newsletter_sources");
      }
      const items = rawItems.flatMap((r): RecordItem[] => {
        const e = str(r.email).toLowerCase();
        if (!e.includes("@") || byEmail.has(e)) return [];
        return [{ id: "", title: e, ref: e, after: { name: str(r.name) } }];
      });
      return records("newsletter_source_add", items, "aucune newsletter nouvelle (adresse manquante ou deja suivie)");
    }

    case "propose_alert_topics": {
      const all = await pbList<{ id: string; name: string; description: string }>("alert_topics", ctx, { filter: `user = "${esc(ctx.userId)}"` });
      const byId = new Map(all.map((a) => [a.id, a]));
      if (op === "create") {
        const items = rawItems.flatMap((r): RecordItem[] => {
          const after = changesFor("alert_topic_create", r);
          if (!str(after.name)) return [];
          if (after.description === undefined) after.description = "";
          return [{ id: "", title: String(after.name), after }];
        });
        return records("alert_topic_create", items, "aucun sujet d'alerte");
      }
      const items = rawItems.flatMap((r): RecordItem[] => {
        const a = byId.get(str(r.id));
        if (!a) return [];
        if (op === "delete") return [{ id: a.id, title: a.name, after: {} }];
        const after = changesFor("alert_topic_update", r);
        if (Object.keys(after).length === 0) return [];
        return [{ id: a.id, title: a.name, before: pick(a as unknown as Record<string, unknown>, Object.keys(after)), after }];
      });
      return records(op === "delete" ? "alert_topic_delete" : "alert_topic_update", items, "alertes introuvables : utilise list_app_data alert_topics");
    }

    case "propose_contacts": {
      const ids = rawItems.map((r) => str(r.id)).filter(Boolean);
      if (ids.length === 0) throw new Error("aucun id de contact : utilise search_contacts");
      const found = await pbList<{ id: string; name: string; email: string; phone?: string; company?: string }>("contacts", ctx, { filter: idFilter(ids) });
      const byId = new Map(found.map((c) => [c.id, c]));
      const items = rawItems.flatMap((r): RecordItem[] => {
        const c = byId.get(str(r.id));
        if (!c) return [];
        const title = c.name ? `${c.name} <${c.email}>` : c.email;
        if (op === "delete") return [{ id: c.id, title, after: {} }];
        const after = changesFor("contact_update", r);
        if (Object.keys(after).length === 0) return [];
        return [{ id: c.id, title, before: pick(c as unknown as Record<string, unknown>, Object.keys(after)), after }];
      });
      return records(op === "delete" ? "contact_delete" : "contact_update", items, "contacts introuvables : utilise search_contacts");
    }

    case "propose_tracking_update": {
      const ids = rawItems.map((r) => str(r.id)).filter(Boolean);
      if (ids.length === 0) throw new Error("aucun id de fiche : utilise search_tracking");
      const found = await pbList<Record<string, unknown> & { id: string; title: string; first_message?: string }>("tracking_items", ctx, {
        filter: idFilter(ids), fields: "id,title,status,archived,pinned,first_message",
      });
      const byId = new Map(found.map((t) => [t.id, t]));
      const items = rawItems.flatMap((r): RecordItem[] => {
        const t = byId.get(str(r.id));
        if (!t) return [];
        const after = changesFor("tracking_update", r);
        if (Object.keys(after).length === 0) return [];
        return [{ id: t.id, title: t.title, ref: t.first_message || "", before: pick(t, Object.keys(after)), after }];
      });
      return records("tracking_update", items, "fiches introuvables : utilise search_tracking");
    }

    case "propose_mail_action": {
      const mop = str(args.op) as MailOp;
      if (!MAIL_OPS.includes(mop)) throw new Error("geste inconnu");
      const ids = strList(args.message_ids).slice(0, 100);
      if (ids.length === 0) throw new Error("aucun mail : cherche-les avec search_emails puis passe leurs id");
      const found = await pbList<{ id: string; thread_id: string; subject: string; from_address: { name?: string; address?: string } | null; date: string; account: string }>("messages", ctx, {
        filter: idFilter(ids), fields: "id,thread_id,subject,from_address,date,account", perPage: "100",
      });
      if (found.length === 0) throw new Error("mails introuvables : verifie les id avec search_emails");
      let mails = found;
      const payload: { op: MailOp; folder_id?: string; folder_name?: string; label_id?: string; label_name?: string } = { op: mop };
      if (mop === "move") {
        const folder = await pbGet<PbFolder>("folders", str(args.folder_id), ctx, "id,name,type,account").catch(() => null);
        if (!folder) throw new Error("dossier introuvable : utilise list_app_data folders");
        mails = found.filter((m) => m.account === folder.account);
        if (mails.length === 0) throw new Error("ces mails sont sur un autre compte que ce dossier");
        payload.folder_id = folder.id;
        payload.folder_name = folder.name;
      }
      if (mop === "label_add" || mop === "label_remove") {
        const labels = await pbList<PbLabel>("labels", ctx, { filter: `user = "${esc(ctx.userId)}"`, perPage: "500" });
        const nm = str(args.label_name).toLowerCase();
        const l = labels.find((x) => x.id === str(args.label_id)) || labels.find((x) => nm && x.name.toLowerCase() === nm);
        if (!l) throw new Error("etiquette introuvable : utilise list_app_data labels (ou propose_labels create d'abord)");
        payload.label_id = l.id;
        payload.label_name = l.name;
      }
      const messages: TrackingEmailRef[] = mails
        .map((m) => ({ id: m.id, thread_id: m.thread_id, subject: m.subject || "(sans sujet)", from: m.from_address?.name || m.from_address?.address || "", date: (m.date || "").slice(0, 10) }))
        .sort((a, b) => b.date.localeCompare(a.date));
      return base("mail_action", { ...payload, messages });
    }

    case "propose_settings": {
      const u = await getUser(ctx);
      const after = changesFor("settings_update", args);
      const before = pick(u, Object.keys(after));
      for (const k of Object.keys(after)) if (before[k] === after[k]) delete after[k];
      if (Object.keys(after).length === 0) throw new Error("aucun reglage ne change");
      for (const k of Object.keys(before)) if (!(k in after)) delete before[k];
      return records("settings_update", [{ id: ctx.userId, title: "Reglages generaux", before, after }], "aucun reglage");
    }
  }
  throw new Error(`outil inconnu: ${name}`);
}
