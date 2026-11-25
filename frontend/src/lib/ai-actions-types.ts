// Types partages (route /api/ai/chat <-> panneau AiChatPanel) des ACTIONS
// proposees par l'assistant IA. Une action qui cree/modifie/supprime n'est
// JAMAIS executee par le serveur : elle arrive en carte dans le chat et ne
// s'execute (cote client, avec l'auth PocketBase de l'utilisateur) qu'apres
// clic sur Accepter. Les dates d'evenement circulent en HEURE LOCALE
// "YYYY-MM-DDTHH:mm" (ou "YYYY-MM-DD" pour une journee entiere).

export type AiActionKind =
  | "draft"
  | "event_create"
  | "event_update"
  | "event_delete"
  | "contact_create"
  | "tracking_create"
  | "account_create"
  | "signature_set"
  | "filter_rule_create"
  | "mail_action"
  | RecordKind;

/**
 * Gestes "enregistrement" : une liste d'elements avec leur etat AVANT et
 * APRES (champs decrits dans lib/ai-actions-fields.ts). Un seul resume et un
 * seul editeur de carte pour tous (creation : pas d'avant ; suppression : pas
 * d'apres, la carte liste ce qui part et se decoche).
 */
export type RecordKind =
  | "account_update"
  | "account_delete"
  | "label_create"
  | "label_update"
  | "label_delete"
  | "folder_create"
  | "folder_update"
  | "folder_delete"
  | "filter_rule_update"
  | "filter_rule_delete"
  | "blocked_add"
  | "blocked_remove"
  | "newsletter_source_add"
  | "newsletter_source_remove"
  | "alert_topic_create"
  | "alert_topic_update"
  | "alert_topic_delete"
  | "contact_update"
  | "contact_delete"
  | "tracking_update"
  | "settings_update";

export interface AiEventFields {
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  description: string;
}

export interface DraftPayload {
  /** Adresse du compte d'envoi souhaite (vide = compte par defaut). */
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

export interface EventCreatePayload {
  events: AiEventFields[];
}

export interface EventUpdatePayload {
  changes: { id: string; before: AiEventFields; after: AiEventFields }[];
}

export interface EventDeletePayload {
  events: (AiEventFields & { id: string })[];
}

export interface ContactPayload {
  name: string;
  email: string;
  phone: string;
  company: string;
}

export interface TrackingEmailRef {
  id: string;
  thread_id: string;
  subject: string;
  from: string;
  date: string;
}

export interface TrackingPayload {
  title: string;
  emails: TrackingEmailRef[];
}

export type FieldValue = string | number | boolean;

export interface RecordItem {
  /** Id de l'enregistrement ("" pour une creation ; adresse pour un bloque/une source). */
  id: string;
  /** Ce que c'est, lisible : nom de l'etiquette, adresse du compte... */
  title: string;
  /** Precision affichee sous le titre (compte d'un dossier, nb de mails...). */
  context?: string;
  /** Reference technique non editable (ex: compte d'un dossier a creer). */
  ref?: string;
  before?: Record<string, FieldValue>;
  after: Record<string, FieldValue>;
}

export interface RecordPayload {
  items: RecordItem[];
}

export interface AccountCreatePayload {
  /** Cle du fournisseur reconnu (infomaniak, gmail, ovh...) ou "custom". */
  provider: string;
  providerName: string;
  /** "google" : connexion par le bouton Google (pas de mot de passe). */
  oauth: "" | "google";
  email: string;
  display_name: string;
  label: string;
  imap_host: string;
  imap_port: number;
  imap_security: "none" | "ssl" | "starttls";
  imap_username: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: "none" | "ssl" | "starttls";
  smtp_username: string;
  /** Secret : masque dans la carte, jamais conserve apres decision. */
  password: string;
}

export interface SignaturePayload {
  account_id: string;
  account_email: string;
  before: string;
  html: string;
}

export interface FilterRuleCreatePayload {
  name: string;
  match_mode: "all" | "any";
  criteria: { field: string; operator: string; value: string }[];
  actions: { type: string; labelId?: string; labelName?: string }[];
}

export type MailOp =
  | "archive"
  | "trash"
  | "spam"
  | "inbox"
  | "move"
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "label_add"
  | "label_remove"
  | "delete_forever";

export interface MailActionPayload {
  op: MailOp;
  folder_id?: string;
  folder_name?: string;
  label_id?: string;
  label_name?: string;
  messages: TrackingEmailRef[];
}

export type AiActionPayload =
  | DraftPayload
  | EventCreatePayload
  | EventUpdatePayload
  | EventDeletePayload
  | ContactPayload
  | TrackingPayload
  | RecordPayload
  | AccountCreatePayload
  | SignaturePayload
  | FilterRuleCreatePayload
  | MailActionPayload;

export type AiActionStatus = "pending" | "running" | "done" | "refused" | "error";

/** Ce qui a ete cree, pour pouvoir l'annuler (creations uniquement). */
export interface AiCreatedRef {
  type:
    | "draft"
    | "event"
    | "contact"
    | "tracking"
    | "account"
    | "label"
    | "folder"
    | "filter_rule"
    | "alert_topic"
    | "newsletter_source"
    | "blocked";
  id: string;
  /** Tracking : mail d'ancrage (untrack) ; bloque : l'adresse ; brouillon : rien. */
  messageId?: string;
}

export interface AiAction {
  id: string;
  kind: AiActionKind;
  /** Une reponse de l'assistant = un groupe ("Tout accepter"). */
  groupId: string;
  payload: AiActionPayload;
  /** Proposition d'origine, pour signaler a l'assistant ce qui a ete modifie. */
  original?: AiActionPayload;
  status: AiActionStatus;
  edited?: boolean;
  error?: string;
  resultLabel?: string;
  created?: AiCreatedRef[];
  historyId?: string;
}
