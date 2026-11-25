// Description PARTAGEE (serveur /api/ai/chat <-> carte AiActionCard <->
// execution lib/ai-actions.ts) des gestes "enregistrement" de l'assistant IA :
// quels champs chaque geste peut toucher, comment les afficher et les editer.
// Une liste blanche explicite : un champ absent d'ici n'est JAMAIS ecrit par
// l'assistant (cles, jetons, mots de passe d'API...).
import type {
  AccountCreatePayload,
  AiActionKind,
  AiActionPayload,
  FieldValue,
  MailOp,
  RecordKind,
  RecordPayload,
} from "@/lib/ai-actions-types";

export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "bool" | "select" | "color" | "password";
  options?: string[];
}

const SECURITY = ["ssl", "starttls", "none"];

const ACCOUNT_FIELDS: FieldSpec[] = [
  { key: "label", label: "Nom du compte", type: "text" },
  { key: "display_name", label: "Nom affiche", type: "text" },
  { key: "color", label: "Couleur", type: "color" },
  { key: "is_active", label: "Actif", type: "bool" },
  { key: "check_interval", label: "Releve (minutes)", type: "number" },
  { key: "imap_host", label: "Serveur IMAP", type: "text" },
  { key: "imap_port", label: "Port IMAP", type: "number" },
  { key: "imap_security", label: "Securite IMAP", type: "select", options: SECURITY },
  { key: "imap_username", label: "Identifiant IMAP", type: "text" },
  { key: "imap_password", label: "Mot de passe IMAP", type: "password" },
  { key: "smtp_host", label: "Serveur SMTP", type: "text" },
  { key: "smtp_port", label: "Port SMTP", type: "number" },
  { key: "smtp_security", label: "Securite SMTP", type: "select", options: SECURITY },
  { key: "smtp_username", label: "Identifiant SMTP", type: "text" },
  { key: "smtp_password", label: "Mot de passe SMTP", type: "password" },
];

const LABEL_FIELDS: FieldSpec[] = [
  { key: "name", label: "Nom", type: "text" },
  { key: "color", label: "Couleur", type: "color" },
  { key: "is_secondary", label: "Hors boite de reception", type: "bool" },
];

const ALERT_FIELDS: FieldSpec[] = [
  { key: "name", label: "Sujet", type: "text" },
  { key: "description", label: "Precision", type: "textarea" },
];

/** Reglages generaux modifiables par l'assistant (memes champs que l'ecran Reglages). */
export const SETTINGS_FIELDS: FieldSpec[] = [
  { key: "theme", label: "Theme", type: "select", options: ["light", "dark", "system"] },
  { key: "language", label: "Langue", type: "select", options: ["fr", "en", "de", "it"] },
  { key: "density", label: "Densite", type: "select", options: ["compact", "comfortable", "spacious"] },
  { key: "ui_scale", label: "Taille de l'interface", type: "select", options: ["small", "medium", "large"] },
  { key: "reading_pane", label: "Volet de lecture", type: "select", options: ["right", "bottom", "off"] },
  { key: "preview_lines", label: "Lignes d'apercu", type: "number" },
  { key: "conversation_view", label: "Vue conversation", type: "bool" },
  { key: "auto_mark_read_seconds", label: "Marquer lu apres (s)", type: "number" },
  { key: "default_reply_all", label: "Repondre a tous par defaut", type: "bool" },
  { key: "auto_save_interval", label: "Sauvegarde brouillon (s)", type: "number" },
  { key: "notification_sound", label: "Son des notifications", type: "bool" },
  { key: "sync_paused", label: "Synchronisation en pause", type: "bool" },
  { key: "ai_embeddings_paused", label: "Indexation IA en pause", type: "bool" },
  { key: "tracking_paused", label: "Suivi en pause", type: "bool" },
  { key: "cerveau_paused", label: "Envoi au Cerveau en pause", type: "bool" },
];

export const RECORD_FIELDS: Record<RecordKind, FieldSpec[]> = {
  account_update: ACCOUNT_FIELDS,
  account_delete: [],
  label_create: LABEL_FIELDS,
  label_update: LABEL_FIELDS,
  label_delete: [],
  folder_create: [{ key: "name", label: "Nom", type: "text" }],
  folder_update: [{ key: "name", label: "Nom", type: "text" }],
  folder_delete: [],
  filter_rule_update: [
    { key: "name", label: "Nom", type: "text" },
    { key: "is_active", label: "Active", type: "bool" },
    { key: "match_mode", label: "Conditions", type: "select", options: ["all", "any"] },
  ],
  filter_rule_delete: [],
  blocked_add: [],
  blocked_remove: [],
  newsletter_source_add: [{ key: "name", label: "Nom", type: "text" }],
  newsletter_source_remove: [],
  alert_topic_create: ALERT_FIELDS,
  alert_topic_update: ALERT_FIELDS,
  alert_topic_delete: [],
  contact_update: [
    { key: "name", label: "Nom", type: "text" },
    { key: "email", label: "Email", type: "text" },
    { key: "phone", label: "Telephone", type: "text" },
    { key: "company", label: "Societe", type: "text" },
  ],
  contact_delete: [],
  tracking_update: [
    { key: "title", label: "Titre", type: "text" },
    { key: "status", label: "Statut", type: "select", options: ["active", "done"] },
    { key: "archived", label: "Ne plus suivre", type: "bool" },
    { key: "pinned", label: "Epingle", type: "bool" },
  ],
  settings_update: SETTINGS_FIELDS,
};

export const RECORD_KINDS = Object.keys(RECORD_FIELDS) as RecordKind[];

export function isRecordKind(kind: AiActionKind): kind is RecordKind {
  return kind in RECORD_FIELDS;
}

/** Suppression / retrait : la carte liste ce qui part, cochable. */
export function isRemovalKind(kind: AiActionKind): boolean {
  return /_(delete|remove)$/.test(kind) || kind === "blocked_add";
}

/** Suppressions qui effacent des donnees (mise en garde rouge dans la carte). */
export function isDestructiveKind(kind: AiActionKind): boolean {
  return /_delete$/.test(kind);
}

/** Libelles lisibles des valeurs de champs select. */
const VALUE_LABELS: Record<string, string> = {
  light: "clair", dark: "sombre", system: "systeme",
  compact: "compacte", comfortable: "confortable", spacious: "aeree",
  small: "petite", medium: "moyenne", large: "grande",
  right: "a droite", bottom: "en bas", off: "masque",
  all: "toutes", any: "au moins une",
  active: "ouvert", done: "cloture",
  ssl: "SSL/TLS", starttls: "STARTTLS", none: "aucune",
};

export function formatFieldValue(spec: FieldSpec | undefined, v: FieldValue | undefined): string {
  if (v === undefined || v === null || v === "") return "-";
  if (spec?.type === "password") return "••••••••";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (spec?.type === "select") return VALUE_LABELS[String(v)] || String(v);
  return String(v);
}

export const MAIL_OP_LABELS: Record<MailOp, string> = {
  archive: "Archiver",
  trash: "Mettre a la corbeille",
  spam: "Signaler comme indesirable",
  inbox: "Remettre en boite de reception",
  move: "Deplacer",
  read: "Marquer comme lu",
  unread: "Marquer comme non lu",
  star: "Ajouter aux favoris",
  unstar: "Retirer des favoris",
  label_add: "Ajouter l'etiquette",
  label_remove: "Retirer l'etiquette",
  delete_forever: "Supprimer definitivement",
};

export const FILTER_FIELD_LABELS: Record<string, string> = {
  from: "Expediteur", to: "Destinataire", subject: "Sujet", body: "Texte", has_attachments: "Pieces jointes",
};
export const FILTER_OPERATOR_LABELS: Record<string, string> = {
  equals: "est", contains: "contient", starts_with: "commence par", ends_with: "finit par",
  not_contains: "ne contient pas", is_true: "oui", is_false: "non",
};
export const FILTER_ACTION_LABELS: Record<string, string> = {
  move_to_spam: "Indesirables", move_to_trash: "Corbeille", archive: "Archiver",
  mark_as_read: "Marquer comme lu", add_label: "Etiquette", block_sender: "Bloquer l'expediteur",
};

const MASK = "••••••••";

/**
 * Retire les secrets d'une action (mot de passe d'un compte) : appele avant
 * d'inscrire l'action dans l'historique et des que la carte est tranchee, pour
 * que le mot de passe ne reste ni dans `ai_actions` ni dans la conversation
 * synchronisee.
 */
export function scrubSecrets(kind: AiActionKind, payload: AiActionPayload | undefined): AiActionPayload | undefined {
  if (!payload) return payload;
  if (kind === "account_create") {
    const p = payload as AccountCreatePayload;
    return p.password ? { ...p, password: MASK } : p;
  }
  if (kind === "account_update") {
    const p = payload as RecordPayload;
    return {
      items: p.items.map((it) => {
        const after = { ...it.after };
        for (const k of ["imap_password", "smtp_password"]) if (after[k]) after[k] = MASK;
        return { ...it, after };
      }),
    };
  }
  return payload;
}

export function isMasked(v: unknown): boolean {
  return v === MASK;
}
