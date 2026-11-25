"use client";

// Execution CLIENT des gestes "application" proposes par l'assistant IA
// (comptes, signatures, etiquettes, dossiers, regles, bloques, newsletters,
// alertes, contacts, suivis, mails, reglages), apres clic sur Accepter.
// Chaque geste reprend EXACTEMENT le chemin de l'ecran correspondant (memes
// collections PocketBase, memes routes worker), avec l'auth de l'utilisateur.
import pb, {
  accounts,
  contacts,
  deleteMessageViaWorker,
  filterRules,
  folders,
  getCurrentUserId,
  labels,
  messages,
  trackingEvents,
  trackingItems,
  updateMessageFlags,
  updateMessageViaWorker,
  users,
  type Account,
  type Folder,
  type Label,
} from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import { clearMailListPageCache } from "@/lib/mail-list-api";
import { loadAccounts } from "@/lib/hooks/useAccounts";
import { loadLabels } from "@/lib/hooks/useLabels";
import { reloadNewsletterSources } from "@/lib/hooks/useNewsletterSources";
import { applyUiScale, blockSender, notifySettingsUpdated, unblockSender, type UiScale } from "@/lib/hooks/useSettings";
import { getNextAvailableColor } from "@/lib/utils/account-colors";
import { getOAuthRedirectOrigin } from "@/lib/oauth-origin";
import { isSignatureEmpty, toEmailSignatureHtml } from "@/lib/signature";
import { formatFieldValue, isMasked, MAIL_OP_LABELS, RECORD_FIELDS } from "@/lib/ai-actions-fields";
import type {
  AccountCreatePayload,
  AiAction,
  AiCreatedRef,
  FieldValue,
  FilterRuleCreatePayload,
  MailActionPayload,
  RecordKind,
  RecordPayload,
  SignaturePayload,
} from "@/lib/ai-actions-types";

export interface AppExecResult {
  created: AiCreatedRef[];
  label: string;
}

/** Gestes dont les creations du jour s'annulent depuis l'historique. */
export const APP_UNDOABLE_KINDS = [
  "account_create",
  "label_create",
  "folder_create",
  "filter_rule_create",
  "alert_topic_create",
  "newsletter_source_add",
  "blocked_add",
];

function refreshMail() {
  clearMailListPageCache();
  const st = useMailStore.getState();
  st.invalidateMessages();
  st.invalidateFolders();
}

async function testConnection(type: "imap" | "smtp", host: string, port: number, username: string, password: string): Promise<string | null> {
  // Meme route que le bouton "Tester la connexion" du formulaire de compte.
  try {
    const res = await fetch("/api/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: pb.authStore.token },
      body: JSON.stringify({ type, host, port, email: username, password }),
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    return data.success ? null : data.error || "connexion refusee";
  } catch {
    return "impossible de contacter le service mail";
  }
}

/** Execute les items un par un ; un echec n'arrete pas les suivants. */
async function eachItem(
  p: RecordPayload,
  run: (it: RecordPayload["items"][number]) => Promise<AiCreatedRef | void>
): Promise<{ n: number; created: AiCreatedRef[] }> {
  const created: AiCreatedRef[] = [];
  const errors: string[] = [];
  let n = 0;
  for (const it of p.items) {
    try {
      const ref = await run(it);
      if (ref) created.push(ref);
      n++;
    } catch (err) {
      errors.push(`${it.title} : ${(err as Error).message}`);
    }
  }
  if (n === 0 && errors.length) throw new Error(errors.join(" ; "));
  if (errors.length) throw Object.assign(new Error(`${n} fait(s), echec : ${errors.join(" ; ")}`), { created });
  return { n, created };
}

async function findOrCreateLabel(userId: string, name: string, created: AiCreatedRef[]): Promise<string> {
  const safe = name.replace(/"/g, "");
  const existing = await labels().getFirstListItem<Label>(`user = "${userId}" && name = "${safe}"`).catch(() => null);
  if (existing) return existing.id;
  const rec = await labels().create<Label>({ user: userId, name, color: "#3b82f6", is_secondary: false });
  created.push({ type: "label", id: rec.id });
  return rec.id;
}

/** Garde les champs editables du geste (liste blanche), sans mot de passe masque. */
function cleanAfter(kind: RecordKind, after: Record<string, FieldValue>): Record<string, FieldValue> {
  const allowed = new Set(RECORD_FIELDS[kind].map((f) => f.key));
  const out: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(after)) {
    if (!allowed.has(k) || isMasked(v)) continue;
    if ((k === "imap_password" || k === "smtp_password") && !v) continue;
    out[k] = v;
  }
  return out;
}

async function executeAccountCreate(p: AccountCreatePayload, userId: string): Promise<AppExecResult> {
  if (p.oauth === "google") {
    // Meme parcours que le bouton "Se connecter avec Google" du formulaire.
    const res = await fetch(`/worker/oauth/google/url?userId=${userId}&origin=${encodeURIComponent(getOAuthRedirectOrigin())}`);
    const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!data.url) throw new Error(data.error || "connexion Google indisponible");
    window.location.href = data.url;
    return { created: [], label: "Ouverture de Google pour autoriser le compte" };
  }
  if (!p.password || isMasked(p.password)) throw new Error("mot de passe requis : clique sur Modifier pour le saisir");
  const list = await accounts().getFullList<Account>({ filter: `user = "${userId}"` });
  if (list.some((a) => a.email.toLowerCase() === p.email.toLowerCase())) throw new Error(`le compte ${p.email} existe deja`);

  // Connexion verifiee AVANT la creation : un compte aux reglages faux
  // tournerait en erreur de synchronisation. Echec = rien n'est cree.
  const [imapErr, smtpErr] = await Promise.all([
    testConnection("imap", p.imap_host, p.imap_port, p.imap_username, p.password),
    testConnection("smtp", p.smtp_host, p.smtp_port, p.smtp_username, p.password),
  ]);
  if (imapErr || smtpErr) {
    const parts = [imapErr && `reception (IMAP ${p.imap_host}) : ${imapErr}`, smtpErr && `envoi (SMTP ${p.smtp_host}) : ${smtpErr}`].filter(Boolean);
    throw new Error(`Connexion refusee, rien n'a ete cree. ${parts.join(" ; ")}`);
  }

  const rec = await accounts().create<Account>({
    user: userId,
    label: p.label || p.email,
    email: p.email,
    display_name: p.display_name,
    color: getNextAvailableColor(list.map((a) => a.color).filter(Boolean) as string[]),
    protocol: "imap",
    imap_host: p.imap_host,
    imap_port: p.imap_port,
    imap_security: p.imap_security,
    imap_username: p.imap_username,
    imap_password: p.password,
    smtp_host: p.smtp_host,
    smtp_port: p.smtp_port,
    smtp_security: p.smtp_security,
    smtp_username: p.smtp_username,
    smtp_password: p.password,
    check_interval: 5,
    is_active: true,
  });
  await loadAccounts();
  return { created: [{ type: "account", id: rec.id }], label: `Compte ${p.email} ajoute, connexion verifiee : la synchronisation demarre` };
}

async function executeMailAction(p: MailActionPayload): Promise<AppExecResult> {
  if (p.messages.length === 0) throw new Error("aucun mail");
  const folderCache = new Map<string, string>();
  const folderFor = async (account: string, type: string) => {
    const key = `${account}:${type}`;
    if (!folderCache.has(key)) {
      const f = await folders().getFirstListItem<Folder>(`account = "${account}" && type = "${type}"`);
      folderCache.set(key, f.id);
    }
    return folderCache.get(key)!;
  };
  let n = 0;
  const errors: string[] = [];
  if (p.op === "label_add" || p.op === "label_remove") {
    // Etiquette au niveau CONVERSATION, comme la barre d'etiquettes du fil.
    const threads = Array.from(new Set(p.messages.map((m) => m.thread_id).filter(Boolean)));
    for (const tid of threads) {
      try {
        await pb.send(`/api/mail/thread/${encodeURIComponent(tid)}/label/${encodeURIComponent(p.label_id || "")}`, {
          method: "POST",
          body: { mode: p.op === "label_add" ? "included" : "excluded" },
        });
        n++;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  } else {
    for (const m of p.messages) {
      try {
        switch (p.op) {
          case "read":
          case "unread":
            await updateMessageFlags(m.id, { is_read: p.op === "read" });
            break;
          case "star":
          case "unstar":
            await updateMessageFlags(m.id, { is_starred: p.op === "star" });
            break;
          case "delete_forever":
            await deleteMessageViaWorker(m.id);
            break;
          case "move":
            await updateMessageViaWorker(m.id, { folder: p.folder_id });
            break;
          default: {
            const msg = await messages().getOne(m.id, { fields: "id,account" });
            await updateMessageViaWorker(m.id, { folder: await folderFor(msg.account, p.op) });
            if (p.op === "spam") {
              fetch("/worker/spam/learn", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountId: msg.account, messageId: m.id, type: "spam" }),
              }).catch(() => {});
            }
          }
        }
        n++;
      } catch (err) {
        errors.push(`${m.subject} : ${(err as Error).message}`);
      }
    }
  }
  refreshMail();
  if (n === 0) throw new Error(errors.join(" ; ") || "aucun mail traite");
  const what = p.op === "label_add" || p.op === "label_remove" ? `${n} conversation(s)` : `${n} mail(s)`;
  const target = p.folder_name ? ` -> ${p.folder_name}` : p.label_name ? ` « ${p.label_name} »` : "";
  if (errors.length) throw new Error(`${MAIL_OP_LABELS[p.op]}${target} : ${what} fait(s), echec : ${errors.join(" ; ")}`);
  return { created: [], label: `${MAIL_OP_LABELS[p.op]}${target} : ${what}` };
}

async function executeRecord(kind: RecordKind, p: RecordPayload, userId: string): Promise<AppExecResult> {
  const done = (r: { n: number; created: AiCreatedRef[] }, label: string): AppExecResult => ({ created: r.created, label: `${r.n} ${label}` });
  switch (kind) {
    case "account_update": {
      const r = await eachItem(p, async (it) => { await accounts().update(it.id, cleanAfter(kind, it.after)); });
      await loadAccounts();
      return done(r, "compte(s) modifie(s)");
    }
    case "account_delete": {
      const r = await eachItem(p, async (it) => { await accounts().delete(it.id); });
      await loadAccounts();
      refreshMail();
      return done(r, "compte(s) retire(s)");
    }
    case "label_create": {
      const r = await eachItem(p, async (it) => {
        const rec = await labels().create<Label>({ user: userId, ...cleanAfter(kind, it.after) });
        return { type: "label", id: rec.id };
      });
      await loadLabels();
      return done(r, "etiquette(s) creee(s)");
    }
    case "label_update": {
      const r = await eachItem(p, async (it) => { await labels().update(it.id, cleanAfter(kind, it.after)); });
      await loadLabels();
      refreshMail();
      return done(r, "etiquette(s) modifiee(s)");
    }
    case "label_delete": {
      const r = await eachItem(p, async (it) => { await labels().delete(it.id); });
      await loadLabels();
      refreshMail();
      return done(r, "etiquette(s) supprimee(s)");
    }
    case "folder_create": {
      // Memes valeurs que Reglages > Dossiers.
      const r = await eachItem(p, async (it) => {
        const name = String(it.after.name || it.title).trim();
        const rec = await folders().create<Folder>({ name, path: name, account: it.ref, type: "custom", sort_order: 100, unread_count: 0, total_count: 0 });
        return { type: "folder", id: rec.id };
      });
      refreshMail();
      return done(r, "dossier(s) cree(s)");
    }
    case "folder_update": {
      const r = await eachItem(p, async (it) => {
        const name = String(it.after.name || "").trim();
        if (!name) throw new Error("nom vide");
        await folders().update(it.id, { name, path: name });
      });
      refreshMail();
      return done(r, "dossier(s) renomme(s)");
    }
    case "folder_delete": {
      const r = await eachItem(p, async (it) => { await folders().delete(it.id); });
      refreshMail();
      return done(r, "dossier(s) supprime(s)");
    }
    case "filter_rule_update":
      return done(await eachItem(p, async (it) => { await filterRules().update(it.id, cleanAfter(kind, it.after)); }), "regle(s) modifiee(s)");
    case "filter_rule_delete":
      return done(await eachItem(p, async (it) => { await filterRules().delete(it.id); }), "regle(s) supprimee(s)");
    case "blocked_add":
      return done(await eachItem(p, async (it) => { await blockSender(it.id); return { type: "blocked", id: it.id }; }), "expediteur(s) bloque(s)");
    case "blocked_remove":
      return done(await eachItem(p, async (it) => { await unblockSender(it.id); }), "expediteur(s) debloque(s)");
    case "newsletter_source_add": {
      const r = await eachItem(p, async (it) => {
        const email = (it.ref || it.title).toLowerCase();
        const rec = await pb.collection("newsletter_sources").create({ user: userId, email, name: String(it.after.name || "") });
        // Meme rattrapage que "Suivre cette newsletter" : synthese de l'historique recent.
        void fetch("/worker/newsletters/backfill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, email }),
        }).catch(() => {});
        return { type: "newsletter_source", id: rec.id };
      });
      await reloadNewsletterSources();
      return done(r, "newsletter(s) suivie(s)");
    }
    case "newsletter_source_remove": {
      const r = await eachItem(p, async (it) => { await pb.collection("newsletter_sources").delete(it.id); });
      await reloadNewsletterSources();
      return done(r, "newsletter(s) retiree(s)");
    }
    case "alert_topic_create":
      return done(
        await eachItem(p, async (it) => {
          const a = cleanAfter(kind, it.after);
          const rec = await pb.collection("alert_topics").create({ user: userId, name: String(a.name || "").trim(), description: String(a.description || "").trim() });
          return { type: "alert_topic", id: rec.id };
        }),
        "alerte(s) creee(s)"
      );
    case "alert_topic_update":
      return done(await eachItem(p, async (it) => { await pb.collection("alert_topics").update(it.id, cleanAfter(kind, it.after)); }), "alerte(s) modifiee(s)");
    case "alert_topic_delete":
      return done(await eachItem(p, async (it) => { await pb.collection("alert_topics").delete(it.id); }), "alerte(s) supprimee(s)");
    case "contact_update":
      return done(await eachItem(p, async (it) => { await contacts().update(it.id, cleanAfter(kind, it.after)); }), "contact(s) modifie(s)");
    case "contact_delete":
      return done(await eachItem(p, async (it) => { await contacts().delete(it.id); }), "contact(s) supprime(s)");
    case "tracking_update":
      return done(
        await eachItem(p, async (it) => {
          const data = cleanAfter(kind, it.after);
          if (data.status !== undefined) data.closure_suggested = false;
          await trackingItems().update(it.id, data);
          // Meme trace de chronologie que Cloturer / Rouvrir dans le Suivi.
          if (data.status !== undefined && data.status !== it.before?.status) {
            await trackingEvents()
              .create({ user: userId, item: it.id, date: new Date().toISOString(), kind: "status_change", label: data.status === "done" ? "Cloture" : "Rouvert", detail: "", changed_fields: {} })
              .catch(() => {});
          }
        }),
        "fiche(s) de suivi modifiee(s)"
      );
    case "settings_update": {
      const data = cleanAfter(kind, p.items[0]?.after || {});
      await users().update(userId, data);
      if (typeof data.ui_scale === "string") {
        try { localStorage.setItem("imiel:uiScale", data.ui_scale); } catch {}
        applyUiScale(data.ui_scale as UiScale);
      }
      notifySettingsUpdated();
      const spec = RECORD_FIELDS.settings_update;
      const what = Object.entries(data).map(([k, v]) => {
        const f = spec.find((s) => s.key === k);
        return `${f?.label || k} : ${formatFieldValue(f, v)}`;
      });
      return { created: [], label: `Reglages enregistres (${what.join(", ")})` };
    }
  }
}

/** Execute un geste "application" ; null si le geste n'en est pas un. */
export async function executeAppAction(action: AiAction): Promise<AppExecResult | null> {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("session expiree");
  switch (action.kind) {
    case "account_create":
      return executeAccountCreate(action.payload as AccountCreatePayload, userId);
    case "signature_set": {
      const p = action.payload as SignaturePayload;
      // Meme mise en forme que l'editeur de Reglages > Signatures.
      const out = isSignatureEmpty(p.html) ? "" : toEmailSignatureHtml(p.html);
      await accounts().update(p.account_id, { signature: out });
      await loadAccounts();
      return { created: [], label: out ? `Signature de ${p.account_email} enregistree` : `Signature de ${p.account_email} retiree` };
    }
    case "filter_rule_create": {
      const p = action.payload as FilterRuleCreatePayload;
      const created: AiCreatedRef[] = [];
      const ruleActions = [];
      for (const a of p.actions) {
        if (a.type === "add_label") {
          const labelId = a.labelId || (a.labelName ? await findOrCreateLabel(userId, a.labelName, created) : "");
          if (labelId) ruleActions.push({ type: a.type, labelId });
        } else ruleActions.push({ type: a.type });
      }
      if (created.length) await loadLabels();
      // Memes champs que la creation depuis un message (useFilterRules).
      const rule = await filterRules().create({
        user: userId, name: p.name, criteria: p.criteria, actions: ruleActions, is_active: true, match_mode: p.match_mode, source_email: "",
      });
      created.push({ type: "filter_rule", id: rule.id });
      return { created, label: `Regle « ${p.name} » creee (s'applique aux prochains mails)` };
    }
    case "mail_action":
      return executeMailAction(action.payload as MailActionPayload);
    default:
      if (action.kind in RECORD_FIELDS) return executeRecord(action.kind as RecordKind, action.payload as RecordPayload, userId);
      return null;
  }
}

/** Resume d'une ligne, sans secret (historique + retour [Actions] au modele). */
export function summarizeAppAction(action: AiAction): string | null {
  const titles = (p: RecordPayload) => p.items.map((i) => i.title).join(", ");
  switch (action.kind) {
    case "account_create": {
      const p = action.payload as AccountCreatePayload;
      return `Ajout du compte ${p.email} (${p.providerName})`;
    }
    case "signature_set":
      return `Signature de ${(action.payload as SignaturePayload).account_email}`;
    case "filter_rule_create":
      return `Regle de tri : ${(action.payload as FilterRuleCreatePayload).name}`;
    case "mail_action": {
      const p = action.payload as MailActionPayload;
      const target = p.folder_name ? ` -> ${p.folder_name}` : p.label_name ? ` « ${p.label_name} »` : "";
      return `${MAIL_OP_LABELS[p.op]}${target} : ${p.messages.length} mail(s)`;
    }
  }
  if (!(action.kind in RECORD_FIELDS)) return null;
  const p = action.payload as RecordPayload;
  const verb: Record<RecordKind, string> = {
    account_update: "Compte modifie", account_delete: "Compte retire",
    label_create: "Etiquette creee", label_update: "Etiquette modifiee", label_delete: "Etiquette supprimee",
    folder_create: "Dossier cree", folder_update: "Dossier renomme", folder_delete: "Dossier supprime",
    filter_rule_update: "Regle modifiee", filter_rule_delete: "Regle supprimee",
    blocked_add: "Blocage", blocked_remove: "Deblocage",
    newsletter_source_add: "Newsletter suivie", newsletter_source_remove: "Newsletter retiree",
    alert_topic_create: "Alerte creee", alert_topic_update: "Alerte modifiee", alert_topic_delete: "Alerte supprimee",
    contact_update: "Contact modifie", contact_delete: "Contact supprime",
    tracking_update: "Suivi modifie", settings_update: "Reglages",
  };
  if (action.kind === "settings_update") {
    const keys = Object.keys(p.items[0]?.after || {});
    return `Reglages : ${keys.join(", ")}`;
  }
  return `${verb[action.kind as RecordKind]} : ${titles(p)}`;
}

/** Annule une creation (historique, le jour meme) ; false si le type n'est pas d'ici. */
export async function undoAppRef(ref: AiCreatedRef): Promise<boolean> {
  switch (ref.type) {
    case "account":
      await accounts().delete(ref.id);
      await loadAccounts();
      refreshMail();
      return true;
    case "label":
      await labels().delete(ref.id);
      await loadLabels();
      return true;
    case "folder":
      await folders().delete(ref.id);
      refreshMail();
      return true;
    case "filter_rule":
      await filterRules().delete(ref.id);
      return true;
    case "alert_topic":
      await pb.collection("alert_topics").delete(ref.id);
      return true;
    case "newsletter_source":
      await pb.collection("newsletter_sources").delete(ref.id);
      await reloadNewsletterSources();
      return true;
    case "blocked":
      await unblockSender(ref.id);
      return true;
  }
  return false;
}
