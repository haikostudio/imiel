import PocketBase, { RecordModel } from "pocketbase";

export type { RecordModel };

// --- Collection Types (aligned with PocketBase migration schema) ---

export interface Account extends RecordModel {
  user: string;
  label: string;
  email: string;
  display_name: string;
  protocol: "imap" | "pop3";
  imap_host: string;
  imap_port: number;
  imap_security: "none" | "ssl" | "starttls";
  imap_username: string;
  imap_password: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: "none" | "ssl" | "starttls";
  smtp_username: string;
  smtp_password: string;
  check_interval: number;
  signature: string;
  /** Images de signature (champ fichier public, migration 066). */
  signature_images?: string[];
  sync_status: "idle" | "syncing" | "error" | "initial";
  sync_error: string;
  last_synced_at: string;
  is_active: boolean;
  color: string;
  auth_type: "password" | "oauth2";
  oauth_provider: string;
  oauth_token_expiry: string;
}

export interface Folder extends RecordModel {
  account: string;
  name: string;
  path: string;
  type: "inbox" | "sent" | "drafts" | "trash" | "spam" | "archive" | "custom";
  unread_count: number;
  total_count: number;
  sort_order: number;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface Message extends RecordModel {
  account: string;
  folder: string;
  message_id: string;
  in_reply_to: string;
  references: string[];
  thread_id: string;
  from_address: EmailAddress;
  to_addresses: EmailAddress[];
  cc_addresses: EmailAddress[];
  bcc_addresses: EmailAddress[];
  subject: string;
  text_body: string;
  html_body: string;
  snippet: string;
  date: string;
  is_read: boolean;
  is_starred: boolean;
  is_answered: boolean;
  is_draft: boolean;
  is_sent: boolean;
  has_attachments: boolean;
  priority: "low" | "normal" | "high";
  labels: string[];
  uid: number;
  attachments: string[];
  draft_reply_to: string;
  auto_saved_at: string;
  raw_headers: string;
  spam_score: number;
  spam_action: string;
  /** ISO datetime d'envoi programme (fonctionnalite "envoyer plus tard"), "" sinon */
  scheduled_at: string;
  /** Tri en trois niveaux (migration 075) : "" = pas encore classe. */
  importance?: "important" | "secondary" | "low" | "";
  importance_source?: "ai" | "rule" | "user" | "heuristic" | "";
}

export interface Label extends RecordModel {
  user: string;
  name: string;
  color: string;
  is_secondary?: boolean;
}

export interface Attachment extends RecordModel {
  message: string;
  filename: string;
  content_type: string;
  size: number;
  file: string;
  content_id: string;
  is_inline: boolean;
}

export interface PushToken extends RecordModel {
  user: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  device_name: string;
  is_active: boolean;
}

// --- Filter Rules ---

export type CriterionField =
  | "from_address"
  | "from_domain"
  | "to_address"
  | "subject"
  | "body"
  | "has_attachments";

export type CriterionOperator =
  | "equals"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "not_contains"
  | "is_true"
  | "is_false";

export interface FilterCriterion {
  field: CriterionField;
  operator: CriterionOperator;
  value: string;
}

export type FilterActionType =
  | "move_to_spam"
  | "move_to_trash"
  | "archive"
  | "mark_as_read"
  | "add_label"
  | "block_sender";

export interface FilterAction {
  type: FilterActionType;
  labelId?: string;
}

// --- Contacts ---

export interface Contact extends RecordModel {
  user: string;
  name: string;
  email: string;
  last_contact_date: string;
  message_count: number;
  /** Numero de telephone du contact. */
  phone?: string;
  /** Societe du contact (migration 062). */
  company?: string;
}

export function contacts() {
  return pb.collection<Contact>("contacts");
}

/**
 * Memoire "qui est qui" d'une personne, donnee a l'IA de reponse (migration
 * 073, worker contact-memory.ts). key = adresse principale, ou "me" pour la
 * fiche de l'utilisateur. Les corrections de l'utilisateur priment : un champ
 * de `locked` n'est plus reecrit par l'IA, un fait de `dismissed` ne revient
 * pas, `user_notes` n'est jamais touchee.
 */
export interface ContactMemory extends RecordModel {
  user: string;
  key: string;
  name: string;
  addresses: string[] | null;
  role: string;
  organization: string;
  relation: string;
  facts: string[] | null;
  related: { name: string; address: string; role: string }[] | null;
  user_notes: string;
  locked: string[] | null;
  dismissed: string[] | null;
  last_message_date: string;
  analyzed_count: number;
  model: string;
  built_at: string;
  updated: string;
}

export function contactMemories() {
  return pb.collection<ContactMemory>("contact_memories");
}

// --- Calendar (Agenda) ---

export interface CalendarGroup extends RecordModel {
  user: string;
  name: string;
  color: string;
  account: string;
  google_calendar_id: string;
  sync_token: string;
  is_visible: boolean;
  /** Agenda des rendez-vous lus dans les mails, coche d'office (migration 078). */
  is_default?: boolean;
  /** Agenda principal Google : jamais supprimable. */
  is_primary?: boolean;
  /** Role Google (owner|writer|reader|freeBusyReader), vide = agenda local. */
  access_role?: string;
}

export interface CalendarAttendee {
  name?: string;
  email: string;
  status?: string;
}

export interface CalendarEvent extends RecordModel {
  user: string;
  group: string;
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  all_day: boolean;
  source: "local" | "google" | "email";
  google_event_id: string;
  google_calendar_id: string;
  etag: string;
  ics_uid: string;
  attendees: CalendarAttendee[];
  status: "confirmed" | "tentative" | "cancelled";
  /** Offsets (minutes avant le debut) auxquels notifier. Vide => defauts. */
  reminders?: number[];
  /** Offsets deja notifies (gere cote worker). */
  reminders_sent?: number[];
  /** Invitation (migration 076) : vide = pas une invitation. */
  invitation_status?: "needs_action" | "accepted" | "declined" | "tentative" | "";
  organizer_email?: string;
  organizer_name?: string;
  attendee_email?: string;
  message?: string;
  /** Meme valeur sur les copies d'un evenement range dans plusieurs agendas. */
  copy_key?: string;
}

export function calendarGroups() {
  return pb.collection<CalendarGroup>("calendar_groups");
}

export function calendarEvents() {
  return pb.collection<CalendarEvent>("calendar_events");
}

export interface FilterRule extends RecordModel {
  user: string;
  name: string;
  criteria: FilterCriterion[];
  actions: FilterAction[];
  is_active: boolean;
  match_mode: "all" | "any";
  source_email: string;
}

export interface ThreadBrief extends RecordModel {
  user: string;
  thread_id: string;
  content: string;
  message_count: number;
  last_message_id: string;
  last_message_date: string;
  /** Autodate (migration 015) : `updated` = date de la derniere generation,
   * qui place la note dans le fil. */
  created?: string;
  updated?: string;
}

export interface NewsletterPost extends RecordModel {
  user: string;
  message: string;
  account: string;
  source_name: string;
  source_address: string;
  original_subject: string;
  title: string;
  summary: string;
  language: string;
  message_date: string;
  thread_id: string;
  status: "pending" | "done" | "error";
  is_read: boolean;
  /** Sujets d'alerte trouves par l'IA dans cette newsletter (migration 060). */
  matched_alerts?: { id: string; name: string }[] | null;
  /** Etiquettes de sujet (IA + corrections a la main, migration 069). */
  tags?: string[] | null;
}

/** Cle d'acces du connecteur MCP en ligne (Reglages > Connectivite, migration 068). */
export interface ApiKey extends RecordModel {
  user: string;
  name: string;
  scope: "read" | "full";
  prefix: string;
  last_used: string;
  inactive_notified_at: string;
}

/** Sujet d'alerte newsletter surveille par l'utilisateur (migration 060). */
export interface AlertTopic extends RecordModel {
  user: string;
  name: string;
  description: string;
}

export interface NewsletterSource extends RecordModel {
  user: string;
  email: string;
  name: string;
}

export type TrackingStatus = "active" | "waiting" | "done" | "cancelled";

/** QR code / code-barres trouve dans un mail des fils de la fiche (scan worker) :
 * soit une PJ (attachment+file), soit une image distante du corps HTML
 * (url, avec copie embarquee `image` en data URI quand raisonnable). */
export interface TrackingQrAsset {
  attachment: string;
  message: string;
  file: string;
  filename: string;
  data: string;
  date: string;
  url?: string;
  image?: string;
}

export interface TrackingAssets {
  scanned: string[];
  scanned_urls?: string[];
  qr: TrackingQrAsset[];
}

export interface TrackingItem extends RecordModel {
  user: string;
  account: string;
  type: string;
  title: string;
  status: TrackingStatus;
  closure_suggested: boolean;
  status_label: string;
  // Synthese d'identite de l'affaire (registre) : marchand, produit, numeros,
  // montant, adresse... Affichee en ligne du tableau d'infos (migration 047).
  context_summary?: string;
  fields: Record<string, string>;
  image_attachment: string;
  assets?: TrackingAssets | null;
  merchant: string;
  sender_domain: string;
  thread_id: string;
  first_message: string;
  last_message_id: string;
  last_message_date: string;
  event_count: number;
  pinned: boolean;
  archived: boolean;
  is_read: boolean;
  expand?: {
    image_attachment?: Attachment;
  };
}

export interface TrackingEvent extends RecordModel {
  user: string;
  item: string;
  message: string;
  date: string;
  kind: "created" | "update" | "status_change" | "manual";
  author: string;
  label: string;
  detail: string;
  changed_fields: Record<string, string>;
}

/** Evenement de suivi de lecture d'un mail envoye (pixel de tracking).
 * "sent" = acceptation SMTP ; "opened" = chargement du pixel par le
 * destinataire (1ere ouverture = Lu, suivantes = Relu). Ecrit par le worker. */
export interface ReadReceipt extends RecordModel {
  user: string;
  account: string;
  message: string;
  /** "received" = passage de controle de la messagerie du destinataire a
   * l'arrivee (scan Gmail/Outlook), jamais compte comme une vue. */
  kind: "sent" | "opened" | "received";
  date: string;
  user_agent: string;
  ip: string;
  client: string;
  /** Adresse du destinataire qui a ouvert ; vide pour "sent" ou l'ancien suivi. */
  recipient?: string;
}

export type CalendarSuggestionStatus = "pending" | "accepted" | "refused";

/** Proposition d'echeance/livraison/RDV detectee dans une fiche de suivi, en
 * attente de la decision de l'utilisateur (ajouter a l'agenda / refuser). */
export interface CalendarSuggestion extends RecordModel {
  user: string;
  item: string;
  dedup_key: string;
  kind: string;
  label: string;
  title: string;
  fiche_title: string;
  start: string;
  end: string;
  all_day: boolean;
  status: CalendarSuggestionStatus;
  event: string;
}

export type ActivityType =
  | "new_email"
  | "mail_sent"
  | "newsletter"
  | "tracking_new"
  | "tracking_status"
  | "calendar_reminder"
  | "calendar_suggestion";

/** Entree du journal d'activite / centre de notifications (ecrite par le worker
 * a chaque evenement notable : mail recu/envoye, suivi cree/mis a jour,
 * newsletter, rappel/echeance agenda). Cf collection `activities`. */
export interface Activity extends RecordModel {
  user: string;
  account: string;
  type: ActivityType;
  title: string;
  body: string;
  icon: string;
  url: string;
  source_collection: string;
  source_id: string;
  thread_id: string;
  metadata: Record<string, unknown>;
  is_read: boolean;
  event_date: string;
}

export interface UserSettings extends RecordModel {
  theme: "light" | "dark" | "system";
  language: "fr" | "en" | "de" | "it";
  notifications_enabled: boolean;
  notification_sound: boolean;
  preview_lines: number;
  density: "compact" | "comfortable" | "spacious";
  ui_scale: "small" | "medium" | "large";
  /** Apparence : "" = miel (defaut). Migration 079. */
  design?: "" | "miel" | "minimal";
  /** Fond de l'apparence Miel : "" = vagues. Migration 079. */
  design_background?: "" | "vagues" | "alveoles" | "matin" | "uni";
  reading_pane: "right" | "bottom" | "off";
  default_reply_all: boolean;
  conversation_view: boolean;
  auto_mark_read_seconds: number;
  default_account: string;
  auto_save_interval: number;
  sidebar_width: number;
  folder_nav_size: number;
  mail_list_size: number;
  blocked_senders: string[];
  grouped_senders: string[];
  openrouter_api_key: string;
  cerveau_api_key: string;
  cerveau_paused: boolean;
  tracking_paused: boolean;
  /** Modele du menu IA de la fenetre d'ecriture (vide = Claude Haiku 5.5). Migration 071. */
  ai_compose_model?: string;
  /** Recapitulatif du matin COUPE (inverse : false = actif par defaut). Migration 074. */
  daily_digest_disabled?: boolean;
  /** Niveaux de mails qui notifient (vide = important_secondary). Migration 075. */
  notify_importance?: "important" | "important_secondary" | "all" | "";
}

// --- PocketBase Client Singleton ---

const pbUrl = process.env.NEXT_PUBLIC_POCKETBASE_URL || "/";
const pb = new PocketBase(pbUrl);
const AUTH_REFRESH_TIMEOUT_MS = 5000;

// Désactiver l'auto-cancel des requêtes en cours
pb.autoCancellation(false);

export default pb;

// --- Retry Helper for updates ---

/**
 * Retente un update PocketBase en cas d'echec (400/500).
 * Le serveur PB retourne parfois 400 de maniere transitoire
 * (e.g. verrou SQLite, race condition sur les hooks).
 */
export async function retryUpdate<T extends RecordModel>(
  collection: ReturnType<typeof pb.collection<T>>,
  id: string,
  data: Record<string, unknown>,
  maxRetries = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await collection.update<T>(id, data);
    } catch (err: unknown) {
      lastError = err;
      const pbErr = err as { status?: number; response?: { data?: Record<string, unknown>; message?: string } };
      console.warn(
        `[retryUpdate] ${id} attempt ${attempt + 1}/${maxRetries + 1} failed:`,
        pbErr.status,
        pbErr.response?.message,
        pbErr.response?.data
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

// --- Fast message flag toggle via mail-worker (admin token, bypasses PB validation) ---

export async function updateMessageFlags(
  id: string,
  flags: { is_read?: boolean; is_starred?: boolean }
): Promise<void> {
  const res = await fetch(`/worker/message-flags/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(flags),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error((data as { error?: string }).error || `Failed to update flags (${res.status})`);
  }
}

// --- Worker-proxied message operations (admin token, bypasses PB validation) ---

export async function updateMessageViaWorker(
  id: string,
  data: Record<string, unknown>
): Promise<void> {
  const res = await fetch(`/worker/message-update/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error((body as { error?: string }).error || `Failed to update message (${res.status})`);
  }
}

export async function deleteMessageViaWorker(id: string): Promise<void> {
  const res = await fetch(`/worker/message-delete/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error((body as { error?: string }).error || `Failed to delete message (${res.status})`);
  }
}

// --- Auth Helpers ---

export async function login(email: string, password: string) {
  return pb.collection("users").authWithPassword(email, password);
}

export async function logout() {
  // Application iPhone : revoquer la cle d'appareil (widgets, actions de
  // notification) AVANT de fermer la session.
  try {
    const { revokeNativeDevice } = await import("@/lib/native-app");
    await revokeNativeDevice();
  } catch {
    /* hors application : rien a revoquer */
  }
  pb.authStore.clear();
}

export function isAuthenticated(): boolean {
  return pb.authStore.isValid;
}

export function getCurrentUserId(): string | null {
  return pb.authStore.record?.id ?? null;
}

/**
 * Renouvelle le token auth si valide. Retourne true si la session est
 * toujours utilisable (refresh OK ou erreur reseau temporaire), false
 * uniquement si le serveur dit explicitement "non authentifie" (401/403).
 *
 * Why: une erreur reseau / un PB sature ne doit PAS deconnecter l'utilisateur.
 * Avant, n'importe quel catch faisait `authStore.clear()` puis redirige login.
 */
export async function refreshAuth(): Promise<boolean> {
  if (!pb.authStore.isValid) return false;
  try {
    await Promise.race([
      pb.collection("users").authRefresh(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("auth refresh timeout")), AUTH_REFRESH_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (err: unknown) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 401 || status === 403) {
      pb.authStore.clear();
      return false;
    }
    // Erreur reseau / timeout / 5xx : on garde le token existant.
    // Le prochain refresh periodique retentera.
    console.warn("[refreshAuth] transient error, keeping token", status, err);
    return true;
  }
}

// --- File URL Helper ---

export function getFileUrl(
  record: RecordModel,
  filename: string,
  thumb?: string
): string {
  return pb.files.getURL(record, filename, { thumb });
}

// --- Collection Helpers ---

export function accounts() {
  return pb.collection<Account>("accounts");
}

export function folders() {
  return pb.collection<Folder>("folders");
}

export function messages() {
  return pb.collection<Message>("messages");
}

export function labels() {
  return pb.collection<Label>("labels");
}

export function pushTokens() {
  return pb.collection<PushToken>("push_tokens");
}

export function users() {
  return pb.collection<UserSettings>("users");
}

export function attachments() {
  return pb.collection<Attachment>("attachments");
}

export function trackingItems() {
  return pb.collection<TrackingItem>("tracking_items");
}

export function trackingEvents() {
  return pb.collection<TrackingEvent>("tracking_events");
}

export function calendarSuggestions() {
  return pb.collection<CalendarSuggestion>("calendar_suggestions");
}

export function apiKeys() {
  return pb.collection<ApiKey>("api_keys");
}

export function readReceipts() {
  return pb.collection<ReadReceipt>("read_receipts");
}

export function activities() {
  return pb.collection<Activity>("activities");
}

export function filterRules() {
  return pb.collection<FilterRule>("filter_rules");
}

export function threadBriefs() {
  return pb.collection<ThreadBrief>("thread_briefs");
}

// --- Mail Worker ---

export async function sendMessage(
  accountId: string,
  messageId: string,
  files?: File[]
): Promise<{ status: string; message_id?: string }> {
  // Call local mail-worker directly via /worker proxy
  // (bypasses PB hooks which run on production server and can't reach local worker)
  let res: Response;
  if (files && files.length > 0) {
    const formData = new FormData();
    formData.append("accountId", accountId);
    formData.append("messageId", messageId);
    for (const file of files) {
      formData.append("files", file);
    }
    res = await fetch("/worker/send", { method: "POST", body: formData });
  } else {
    res = await fetch("/worker/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, messageId }),
    });
  }

  const text = await res.text();
  let data: { success?: boolean; messageId?: string; error?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Erreur serveur (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok || !data.success) {
    throw new Error(data.error || "Erreur lors de l'envoi");
  }

  return { status: "sent", message_id: data.messageId || "" };
}

export interface UploadedDraftAttachment {
  id: string;
  filename: string;
  size: number;
  file?: string;
  content_id?: string;
  is_inline?: boolean;
}

export async function uploadDraftAttachments(
  messageId: string,
  files: File[],
  opts: { inline?: boolean } = {}
): Promise<UploadedDraftAttachment[]> {
  const formData = new FormData();
  formData.append("messageId", messageId);
  if (opts.inline) formData.append("inline", "1");
  for (const file of files) {
    formData.append("files", file);
  }
  const res = await fetch("/worker/draft-attachments", {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || "Erreur lors de l'upload");
  }
  return data.attachments;
}

export async function deleteDraftAttachment(attachmentId: string): Promise<void> {
  const res = await fetch(`/worker/draft-attachments/${attachmentId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "Erreur lors de la suppression");
  }
}

export async function syncAccount(
  accountId: string
): Promise<{ success: boolean; newMessages?: number }> {
  // Le worker gere sync_status et la protection contre les syncs concurrentes
  // (activeSyncs avec timeout 10 min). Pas de garde cote frontend pour eviter les deadlocks.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3 * 60 * 1000);

  try {
    const res = await fetch(`/worker/sync/${accountId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // 409 = sync deja en cours, pas une erreur
    if (res.status === 409) {
      return { success: true, newMessages: 0 };
    }

    const text = await res.text();
    let data: { success?: boolean; error?: string; newMessages?: number };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Erreur serveur (${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok || !data.success) {
      throw new Error(data.error || "Erreur de synchronisation");
    }

    return { success: true, newMessages: data.newMessages };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
