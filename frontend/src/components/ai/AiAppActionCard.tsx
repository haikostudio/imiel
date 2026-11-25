"use client";

// Resume et editeur des cartes "application" de l'assistant IA (comptes,
// signatures, etiquettes, dossiers, regles, bloques, newsletters, alertes,
// contacts, suivis, mails, reglages). Rendus par AiActionCard.
import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Ban,
  BellRing,
  ContactRound,
  Eye,
  EyeOff,
  FolderPen,
  FolderPlus,
  Funnel,
  Mails,
  MailPlus,
  Newspaper,
  PackageCheck,
  Settings2,
  Signature,
  Tag,
  Trash2,
  UserCog,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { sanitizeHtml } from "@/lib/utils/sanitize";
import {
  FILTER_ACTION_LABELS,
  FILTER_FIELD_LABELS,
  FILTER_OPERATOR_LABELS,
  formatFieldValue,
  isDestructiveKind,
  isMasked,
  MAIL_OP_LABELS,
  RECORD_FIELDS,
  type FieldSpec,
} from "@/lib/ai-actions-fields";
import { MAIL_PROVIDERS } from "@/lib/mail-providers";
import type {
  AccountCreatePayload,
  AiAction,
  AiActionKind,
  AiActionPayload,
  FieldValue,
  FilterRuleCreatePayload,
  MailActionPayload,
  RecordKind,
  RecordPayload,
  SignaturePayload,
} from "@/lib/ai-actions-types";

const ic = "size-3.5";
export const APP_KIND_ICON: Partial<Record<AiActionKind, ReactNode>> = {
  account_create: <MailPlus className={ic} />,
  account_update: <UserCog className={ic} />,
  account_delete: <Trash2 className={ic} />,
  signature_set: <Signature className={ic} />,
  label_create: <Tag className={ic} />,
  label_update: <Tag className={ic} />,
  label_delete: <Trash2 className={ic} />,
  folder_create: <FolderPlus className={ic} />,
  folder_update: <FolderPen className={ic} />,
  folder_delete: <Trash2 className={ic} />,
  filter_rule_create: <Funnel className={ic} />,
  filter_rule_update: <Funnel className={ic} />,
  filter_rule_delete: <Trash2 className={ic} />,
  blocked_add: <Ban className={ic} />,
  blocked_remove: <Ban className={ic} />,
  newsletter_source_add: <Newspaper className={ic} />,
  newsletter_source_remove: <Newspaper className={ic} />,
  alert_topic_create: <BellRing className={ic} />,
  alert_topic_update: <BellRing className={ic} />,
  alert_topic_delete: <Trash2 className={ic} />,
  contact_update: <ContactRound className={ic} />,
  contact_delete: <Trash2 className={ic} />,
  tracking_update: <PackageCheck className={ic} />,
  mail_action: <Mails className={ic} />,
  settings_update: <Settings2 className={ic} />,
};

const inputCls = "h-8 text-sm";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** Mot de passe masque, avec l'oeil pour le relire avant d'accepter. */
export function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        type={shown ? "text" : "password"}
        value={isMasked(value) ? "" : value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        data-ref="ai-action-secret"
        className={cn(inputCls, "pr-8")}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground hover:text-foreground"
        title={shown ? "Masquer" : "Afficher"}
      >
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  );
}

function FieldInput({ spec, value, onChange }: { spec: FieldSpec; value: FieldValue | undefined; onChange: (v: FieldValue) => void }) {
  switch (spec.type) {
    case "bool":
      return (
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {spec.label}
        </label>
      );
    case "select":
      return (
        <Field label={spec.label}>
          <select
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-full rounded-md border bg-background px-2 text-sm"
          >
            {(spec.options || []).map((o) => (
              <option key={o} value={o}>{formatFieldValue(spec, o)}</option>
            ))}
          </select>
        </Field>
      );
    case "number":
      return (
        <Field label={spec.label}>
          <Input type="number" value={String(value ?? "")} onChange={(e) => onChange(Number(e.target.value))} className={inputCls} />
        </Field>
      );
    case "color":
      return (
        <Field label={spec.label}>
          <div className="flex items-center gap-1.5">
            <input type="color" value={String(value || "#3b82f6")} onChange={(e) => onChange(e.target.value)} className="h-8 w-10 rounded border bg-background" />
            <Input value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputCls} />
          </div>
        </Field>
      );
    case "textarea":
      return (
        <Field label={spec.label}>
          <Textarea value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} rows={3} className="text-sm" />
        </Field>
      );
    case "password":
      return (
        <Field label={spec.label}>
          <SecretInput value={String(value ?? "")} onChange={onChange} />
        </Field>
      );
    default:
      return (
        <Field label={spec.label}>
          <Input value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputCls} />
        </Field>
      );
  }
}

function ColorDot({ v }: { v: FieldValue | undefined }) {
  if (typeof v !== "string" || !v.startsWith("#")) return null;
  return <span className="inline-block size-2.5 rounded-full align-middle" style={{ backgroundColor: v }} />;
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

// --- Resume ----------------------------------------------------------------

function RecordSummary({ kind, p }: { kind: RecordKind; p: RecordPayload }) {
  const specs = RECORD_FIELDS[kind];
  return (
    <div className="space-y-1.5">
      {isDestructiveKind(kind) && <Warning>Suppression : ce qui suit disparait d'iMiel.</Warning>}
      {p.items.map((it, i) => {
        // Ordre des champs du geste (nom avant couleur...), puis le reste.
        const keys = [...specs.map((s) => s.key).filter((k) => k in it.after), ...Object.keys(it.after).filter((k) => !specs.some((s) => s.key === k))];
        return (
          <div key={`${it.id}-${i}`} className="min-w-0 space-y-0.5">
            {kind !== "settings_update" && <div className="truncate font-medium">{it.title}</div>}
            {it.context && <div className="text-xs text-muted-foreground">{it.context}</div>}
            {keys.map((k) => {
              const spec = specs.find((s) => s.key === k);
              const before = it.before?.[k];
              const changed = it.before !== undefined;
              return (
                <div key={k} className="flex flex-wrap items-center gap-x-1 text-xs">
                  <span className="text-muted-foreground">{spec?.label || k} :</span>
                  {changed && (
                    <>
                      <span className="text-muted-foreground line-through">{formatFieldValue(spec, before)}</span>
                      <span className="text-muted-foreground">-&gt;</span>
                    </>
                  )}
                  <ColorDot v={it.after[k]} />
                  <span>{formatFieldValue(spec, it.after[k])}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function AccountCreateSummary({ p }: { p: AccountCreatePayload }) {
  const note = MAIL_PROVIDERS.find((x) => x.key === p.provider)?.note;
  const sec = (s: string) => formatFieldValue({ key: "", label: "", type: "select" }, s);
  return (
    <div className="space-y-1 text-xs">
      <div className="text-sm font-medium">{p.email}</div>
      <div><span className="text-muted-foreground">Fournisseur : </span>{p.providerName}</div>
      {p.oauth === "google" ? (
        <div className="text-muted-foreground">Connexion par Google : Accepter ouvre la page d&apos;autorisation de Google, aucun mot de passe a saisir.</div>
      ) : (
        <>
          <div><span className="text-muted-foreground">Reception : </span>{p.imap_host}:{p.imap_port} · {sec(p.imap_security)}</div>
          <div><span className="text-muted-foreground">Envoi : </span>{p.smtp_host}:{p.smtp_port} · {sec(p.smtp_security)}</div>
          <div><span className="text-muted-foreground">Identifiant : </span>{p.imap_username}</div>
          {p.display_name && <div><span className="text-muted-foreground">Nom affiche : </span>{p.display_name}</div>}
          <div>
            <span className="text-muted-foreground">Mot de passe : </span>
            {p.password ? "••••••••" : <span className="text-orange-600 dark:text-orange-400">a saisir (Modifier)</span>}
          </div>
          <div className="text-muted-foreground">La connexion est testee avant l&apos;ajout : si elle echoue, rien n&apos;est cree.</div>
        </>
      )}
      {note && <div className="text-orange-600 dark:text-orange-400">{note}</div>}
    </div>
  );
}

function SignaturePreview({ html, muted }: { html: string; muted?: boolean }) {
  const safe = useMemo(() => sanitizeHtml(html, { allowExternalImages: true }), [html]);
  if (!html.trim()) return <div className="text-xs text-muted-foreground">(aucune signature)</div>;
  return (
    <div
      className={cn("max-h-48 overflow-auto rounded-md bg-white p-2 text-xs text-black", muted && "opacity-60")}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

function SignatureSummary({ p }: { p: SignaturePayload }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs"><span className="text-muted-foreground">Compte : </span>{p.account_email}</div>
      {p.before.trim() && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Signature actuelle (remplacee)</summary>
          <div className="mt-1"><SignaturePreview html={p.before} muted /></div>
        </details>
      )}
      <SignaturePreview html={p.html} />
    </div>
  );
}

function ruleLine(c: FilterRuleCreatePayload["criteria"][number]): string {
  const f = FILTER_FIELD_LABELS[c.field] || c.field;
  const o = FILTER_OPERATOR_LABELS[c.operator] || c.operator;
  return c.operator.startsWith("is_") ? `${f} : ${o}` : `${f} ${o} « ${c.value} »`;
}

function FilterRuleSummary({ p }: { p: FilterRuleCreatePayload }) {
  return (
    <div className="space-y-1 text-xs">
      <div className="text-sm font-medium">{p.name}</div>
      <div className="text-muted-foreground">{p.criteria.length > 1 ? (p.match_mode === "any" ? "Si au moins une condition :" : "Si toutes les conditions :") : "Si :"}</div>
      <ul className="list-disc pl-4">{p.criteria.map((c, i) => <li key={i}>{ruleLine(c)}</li>)}</ul>
      <div>
        <span className="text-muted-foreground">Alors : </span>
        {p.actions.map((a) => (a.type === "add_label" ? `Etiquette « ${a.labelName || "?"} »${a.labelId ? "" : " (creee)"}` : FILTER_ACTION_LABELS[a.type] || a.type)).join(", ")}
      </div>
    </div>
  );
}

function MailLines({ p }: { p: MailActionPayload }) {
  return (
    <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
      {p.messages.map((m) => (
        <li key={m.id} className="truncate"><span className="text-muted-foreground">{m.date} · {m.from} · </span>{m.subject}</li>
      ))}
    </ul>
  );
}

function MailActionSummary({ p }: { p: MailActionPayload }) {
  const target = p.folder_name ? ` -> ${p.folder_name}` : p.label_name ? ` « ${p.label_name} »` : "";
  return (
    <div className="space-y-1">
      {p.op === "delete_forever" && <Warning>Suppression definitive : ces mails ne pourront pas etre recuperes.</Warning>}
      <div className="font-medium">{MAIL_OP_LABELS[p.op]}{target} · {p.messages.length} mail(s)</div>
      <MailLines p={p} />
    </div>
  );
}

export function AppSummary({ action }: { action: AiAction }): ReactNode {
  switch (action.kind) {
    case "account_create": return <AccountCreateSummary p={action.payload as AccountCreatePayload} />;
    case "signature_set": return <SignatureSummary p={action.payload as SignaturePayload} />;
    case "filter_rule_create": return <FilterRuleSummary p={action.payload as FilterRuleCreatePayload} />;
    case "mail_action": return <MailActionSummary p={action.payload as MailActionPayload} />;
  }
  if (action.kind in RECORD_FIELDS) return <RecordSummary kind={action.kind as RecordKind} p={action.payload as RecordPayload} />;
  return null;
}

// --- Editeur ---------------------------------------------------------------

function Checklist<T extends { id: string }>({ all, kept, onChange, render }: { all: T[]; kept: T[]; onChange: (v: T[]) => void; render: (x: T) => ReactNode }) {
  const keep = new Set(kept.map((x) => x.id));
  return (
    <div className="space-y-1">
      {all.map((x) => (
        <label key={x.id} className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={keep.has(x.id)}
            onChange={(e) => onChange(e.target.checked ? all.filter((y) => keep.has(y.id) || y.id === x.id) : kept.filter((y) => y.id !== x.id))}
          />
          <span className="min-w-0 truncate">{render(x)}</span>
        </label>
      ))}
    </div>
  );
}

function RecordEditor({ kind, action, draft, setDraft }: { kind: RecordKind; action: AiAction; draft: RecordPayload; setDraft: (p: AiActionPayload) => void }) {
  const specs = RECORD_FIELDS[kind];
  const all = ((action.original ?? action.payload) as RecordPayload).items.map((it, i) => ({ ...it, id: it.id || `new-${i}` }));
  if (specs.length === 0 || kind.endsWith("_delete")) {
    const kept = draft.items.map((it, i) => ({ ...it, id: it.id || `new-${i}` }));
    return <Checklist all={all} kept={kept} onChange={(v) => setDraft({ items: v })} render={(x) => (<><span className="font-medium">{x.title}</span>{x.context ? <span className="text-muted-foreground"> · {x.context}</span> : null}</>)} />;
  }
  const isCreate = kind.endsWith("_create") || kind.endsWith("_add");
  return (
    <div className="space-y-2">
      {draft.items.map((it, i) => {
        const shown = isCreate ? specs : specs.filter((s) => s.key in it.after);
        const set = (k: string, v: FieldValue) =>
          setDraft({ items: draft.items.map((x, j) => (j === i ? { ...x, after: { ...x.after, [k]: v } } : x)) });
        return (
          <div key={`${it.id}-${i}`} className="space-y-1.5 rounded-md bg-background p-2">
            {kind !== "settings_update" && <div className="truncate text-xs font-medium">{it.title}</div>}
            {shown.map((s) => <FieldInput key={s.key} spec={s} value={it.after[s.key]} onChange={(v) => set(s.key, v)} />)}
          </div>
        );
      })}
    </div>
  );
}

const SEC_SPEC: FieldSpec = { key: "", label: "", type: "select", options: ["ssl", "starttls", "none"] };

function AccountCreateEditor({ p, setDraft }: { p: AccountCreatePayload; setDraft: (p: AiActionPayload) => void }) {
  const set = (patch: Partial<AccountCreatePayload>) => setDraft({ ...p, ...patch });
  if (p.oauth === "google") return <AccountCreateSummary p={p} />;
  return (
    <div className="space-y-1.5 rounded-md bg-background p-2">
      <Field label="Adresse"><Input value={p.email} onChange={(e) => set({ email: e.target.value.trim() })} className={inputCls} /></Field>
      <Field label="Mot de passe">
        <SecretInput value={p.password} onChange={(v) => set({ password: v })} placeholder="Mot de passe de la boite mail" />
      </Field>
      <div className="grid grid-cols-2 gap-1.5">
        <Field label="Nom affiche"><Input value={p.display_name} onChange={(e) => set({ display_name: e.target.value })} className={inputCls} /></Field>
        <Field label="Nom du compte"><Input value={p.label} onChange={(e) => set({ label: e.target.value })} className={inputCls} /></Field>
      </div>
      <Field label="Identifiant">
        <Input value={p.imap_username} onChange={(e) => set({ imap_username: e.target.value.trim(), smtp_username: e.target.value.trim() })} className={inputCls} />
      </Field>
      <div className="grid grid-cols-[1fr_4.5rem_6rem] gap-1.5">
        <Field label="Serveur IMAP"><Input value={p.imap_host} onChange={(e) => set({ imap_host: e.target.value.trim() })} className={inputCls} /></Field>
        <Field label="Port"><Input type="number" value={String(p.imap_port)} onChange={(e) => set({ imap_port: Number(e.target.value) })} className={inputCls} /></Field>
        <FieldInput spec={{ ...SEC_SPEC, label: "Securite" }} value={p.imap_security} onChange={(v) => set({ imap_security: v as AccountCreatePayload["imap_security"] })} />
      </div>
      <div className="grid grid-cols-[1fr_4.5rem_6rem] gap-1.5">
        <Field label="Serveur SMTP"><Input value={p.smtp_host} onChange={(e) => set({ smtp_host: e.target.value.trim() })} className={inputCls} /></Field>
        <Field label="Port"><Input type="number" value={String(p.smtp_port)} onChange={(e) => set({ smtp_port: Number(e.target.value) })} className={inputCls} /></Field>
        <FieldInput spec={{ ...SEC_SPEC, label: "Securite" }} value={p.smtp_security} onChange={(v) => set({ smtp_security: v as AccountCreatePayload["smtp_security"] })} />
      </div>
    </div>
  );
}

export function AppEditor({ action, draft, setDraft }: { action: AiAction; draft: AiActionPayload; setDraft: (p: AiActionPayload) => void }): ReactNode {
  switch (action.kind) {
    case "account_create":
      return <AccountCreateEditor p={draft as AccountCreatePayload} setDraft={setDraft} />;
    case "signature_set": {
      const p = draft as SignaturePayload;
      return (
        <div className="space-y-1.5">
          <Field label="Signature (HTML)">
            <Textarea value={p.html} onChange={(e) => setDraft({ ...p, html: e.target.value })} rows={8} className="font-mono text-xs" />
          </Field>
          <SignaturePreview html={p.html} />
        </div>
      );
    }
    case "filter_rule_create": {
      const p = draft as FilterRuleCreatePayload;
      return (
        <div className="space-y-1.5 rounded-md bg-background p-2">
          <Field label="Nom"><Input value={p.name} onChange={(e) => setDraft({ ...p, name: e.target.value })} className={inputCls} /></Field>
          {p.criteria.map((c, i) =>
            c.operator.startsWith("is_") ? null : (
              <Field key={i} label={`${FILTER_FIELD_LABELS[c.field] || c.field} ${FILTER_OPERATOR_LABELS[c.operator] || c.operator}`}>
                <Input
                  value={c.value}
                  onChange={(e) => setDraft({ ...p, criteria: p.criteria.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  className={inputCls}
                />
              </Field>
            )
          )}
          <FilterRuleSummary p={p} />
        </div>
      );
    }
    case "mail_action": {
      const p = draft as MailActionPayload;
      const all = ((action.original ?? action.payload) as MailActionPayload).messages;
      return (
        <Checklist
          all={all}
          kept={p.messages}
          onChange={(v) => setDraft({ ...p, messages: v })}
          render={(m) => (<><span className="text-muted-foreground">{m.date} · {m.from} · </span>{m.subject}</>)}
        />
      );
    }
  }
  if (action.kind in RECORD_FIELDS) {
    return <RecordEditor kind={action.kind as RecordKind} action={action} draft={draft as RecordPayload} setDraft={setDraft} />;
  }
  return null;
}

/** La carte s'ouvre d'emblee en mode Modifier quand il manque une saisie (mot de passe). */
export function needsInput(action: AiAction): boolean {
  if (action.kind !== "account_create") return false;
  const p = action.payload as AccountCreatePayload;
  return p.oauth !== "google" && !p.password;
}
