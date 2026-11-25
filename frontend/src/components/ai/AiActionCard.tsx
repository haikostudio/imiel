"use client";

import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  CalendarMinus,
  CalendarPlus,
  CalendarSync,
  Check,
  Loader2,
  Mail,
  PackageSearch,
  Pencil,
  UserPlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  AiAction,
  AiActionPayload,
  AiEventFields,
  ContactPayload,
  DraftPayload,
  EventCreatePayload,
  EventDeletePayload,
  EventUpdatePayload,
  TrackingPayload,
} from "@/lib/ai-actions-types";
import { APP_KIND_ICON, AppEditor, AppSummary, needsInput } from "./AiAppActionCard";

// Carte d'une action proposee par l'assistant IA : resume lisible, puis
// Accepter / Refuser / Modifier. Le mode Modifier edite une COPIE du payload ;
// "Accepter" depuis ce mode applique la version corrigee.

const KIND_ICON: Partial<Record<AiAction["kind"], ReactNode>> = {
  ...APP_KIND_ICON,
  draft: <Mail className="size-3.5" />,
  event_create: <CalendarPlus className="size-3.5" />,
  event_update: <CalendarSync className="size-3.5" />,
  event_delete: <CalendarMinus className="size-3.5" />,
  contact_create: <UserPlus className="size-3.5" />,
  tracking_create: <PackageSearch className="size-3.5" />,
};

function fmtWhen(f: AiEventFields): string {
  if (f.all_day) {
    const s = f.start.slice(0, 10);
    const e = (f.end || f.start).slice(0, 10);
    return s === e ? `${s} (journee)` : `${s} -> ${e} (journees)`;
  }
  const s = f.start.replace("T", " ");
  const e = f.end || "";
  const endPart = e.slice(0, 10) === f.start.slice(0, 10) ? e.slice(11, 16) : e.replace("T", " ");
  return endPart ? `${s} - ${endPart}` : s;
}

function EventLine({ f, muted }: { f: AiEventFields; muted?: boolean }) {
  return (
    <div className={cn("min-w-0", muted && "text-muted-foreground line-through")}>
      <div className="truncate font-medium">{f.title || "(sans titre)"}</div>
      <div className="text-xs text-muted-foreground">
        {fmtWhen(f)}
        {f.location ? ` · ${f.location}` : ""}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function EventFieldsEditor({ value, onChange }: { value: AiEventFields; onChange: (v: AiEventFields) => void }) {
  const t = useT();
  const set = (patch: Partial<AiEventFields>) => onChange({ ...value, ...patch });
  const inputType = value.all_day ? "date" : "datetime-local";
  const toggleAllDay = (allDay: boolean) =>
    set({
      all_day: allDay,
      start: allDay ? value.start.slice(0, 10) : `${value.start.slice(0, 10)}T09:00`,
      end: allDay ? (value.end || value.start).slice(0, 10) : `${(value.end || value.start).slice(0, 10)}T10:00`,
    });
  return (
    <div className="space-y-1.5 rounded-md bg-background p-2">
      <Field label={t("aiAction.field.title")}>
        <Input value={value.title} onChange={(e) => set({ title: e.target.value })} className="h-8 text-sm" />
      </Field>
      <div className="grid grid-cols-2 gap-1.5">
        <Field label={t("aiAction.field.start")}>
          <Input type={inputType} value={value.start} onChange={(e) => set({ start: e.target.value })} className="h-8 text-xs" />
        </Field>
        <Field label={t("aiAction.field.end")}>
          <Input type={inputType} value={value.end} onChange={(e) => set({ end: e.target.value })} className="h-8 text-xs" />
        </Field>
      </div>
      <label className="flex items-center gap-1.5 text-xs">
        <input type="checkbox" checked={value.all_day} onChange={(e) => toggleAllDay(e.target.checked)} />
        {t("aiAction.field.allDay")}
      </label>
      <Field label={t("aiAction.field.location")}>
        <Input value={value.location} onChange={(e) => set({ location: e.target.value })} className="h-8 text-sm" />
      </Field>
    </div>
  );
}

function listToText(v: string[]): string {
  return v.join(", ");
}
function textToList(v: string): string[] {
  return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

function Summary({ action }: { action: AiAction }) {
  const t = useT();
  switch (action.kind) {
    case "draft": {
      const p = action.payload as DraftPayload;
      return (
        <div className="space-y-1">
          <div className="text-xs"><span className="text-muted-foreground">{t("aiAction.field.to")} : </span>{listToText(p.to)}</div>
          {p.cc.length > 0 && <div className="text-xs"><span className="text-muted-foreground">Cc : </span>{listToText(p.cc)}</div>}
          <div className="font-medium">{p.subject}</div>
          <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-background p-2 text-xs">{p.body}</div>
        </div>
      );
    }
    case "event_create":
      return (
        <div className="space-y-1.5">
          {(action.payload as EventCreatePayload).events.map((e, i) => <EventLine key={i} f={e} />)}
        </div>
      );
    case "event_update":
      return (
        <div className="space-y-2">
          {(action.payload as EventUpdatePayload).changes.map((c) => (
            <div key={c.id} className="space-y-0.5">
              <EventLine f={c.before} muted />
              <EventLine f={c.after} />
            </div>
          ))}
        </div>
      );
    case "event_delete":
      return (
        <div className="space-y-1.5">
          {(action.payload as EventDeletePayload).events.map((e) => <EventLine key={e.id} f={e} />)}
        </div>
      );
    case "contact_create": {
      const p = action.payload as ContactPayload;
      return (
        <div className="text-sm">
          <div className="font-medium">{p.name || p.email}</div>
          <div className="text-xs text-muted-foreground">{[p.email, p.phone, p.company].filter(Boolean).join(" · ")}</div>
        </div>
      );
    }
    case "tracking_create": {
      const p = action.payload as TrackingPayload;
      return (
        <div className="space-y-1">
          <div className="font-medium">{p.title}</div>
          <ul className="space-y-0.5 text-xs">
            {p.emails.map((m) => (
              <li key={m.id} className="truncate">
                <span className="text-muted-foreground">{m.date} · {m.from} · </span>{m.subject}
              </li>
            ))}
          </ul>
        </div>
      );
    }
  }
  return <AppSummary action={action} />;
}

function Editor({ action, draft, setDraft }: { action: AiAction; draft: AiActionPayload; setDraft: (p: AiActionPayload) => void }) {
  const t = useT();
  switch (action.kind) {
    case "draft": {
      const p = draft as DraftPayload;
      return (
        <div className="space-y-1.5">
          <Field label={t("aiAction.field.to")}>
            <Input value={listToText(p.to)} onChange={(e) => setDraft({ ...p, to: textToList(e.target.value) })} className="h-8 text-sm" />
          </Field>
          <Field label="Cc">
            <Input value={listToText(p.cc)} onChange={(e) => setDraft({ ...p, cc: textToList(e.target.value) })} className="h-8 text-sm" />
          </Field>
          <Field label={t("aiAction.field.subject")}>
            <Input value={p.subject} onChange={(e) => setDraft({ ...p, subject: e.target.value })} className="h-8 text-sm" />
          </Field>
          <Field label={t("aiAction.field.body")}>
            <Textarea value={p.body} onChange={(e) => setDraft({ ...p, body: e.target.value })} rows={8} className="text-sm" />
          </Field>
        </div>
      );
    }
    case "event_create": {
      const p = draft as EventCreatePayload;
      return (
        <div className="space-y-1.5">
          {p.events.map((ev, i) => (
            <EventFieldsEditor key={i} value={ev} onChange={(v) => setDraft({ events: p.events.map((x, j) => (j === i ? v : x)) })} />
          ))}
        </div>
      );
    }
    case "event_update": {
      const p = draft as EventUpdatePayload;
      return (
        <div className="space-y-1.5">
          {p.changes.map((c, i) => (
            <EventFieldsEditor
              key={c.id}
              value={c.after}
              onChange={(v) => setDraft({ changes: p.changes.map((x, j) => (j === i ? { ...x, after: v } : x)) })}
            />
          ))}
        </div>
      );
    }
    case "event_delete": {
      const p = draft as EventDeletePayload;
      const all = (action.original ?? action.payload) as EventDeletePayload;
      const kept = new Set(p.events.map((e) => e.id));
      return (
        <div className="space-y-1">
          {all.events.map((e) => (
            <label key={e.id} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={kept.has(e.id)}
                onChange={(ev) =>
                  setDraft({ events: ev.target.checked ? all.events.filter((x) => kept.has(x.id) || x.id === e.id) : p.events.filter((x) => x.id !== e.id) })
                }
              />
              <EventLine f={e} />
            </label>
          ))}
        </div>
      );
    }
    case "contact_create": {
      const p = draft as ContactPayload;
      return (
        <div className="space-y-1.5">
          {(["name", "email", "phone", "company"] as const).map((k) => (
            <Field key={k} label={t(`aiAction.field.${k}`)}>
              <Input value={p[k]} onChange={(e) => setDraft({ ...p, [k]: e.target.value })} className="h-8 text-sm" />
            </Field>
          ))}
        </div>
      );
    }
    case "tracking_create": {
      const p = draft as TrackingPayload;
      const all = (action.original ?? action.payload) as TrackingPayload;
      const kept = new Set(p.emails.map((m) => m.id));
      return (
        <div className="space-y-1.5">
          <Field label={t("aiAction.field.title")}>
            <Input value={p.title} onChange={(e) => setDraft({ ...p, title: e.target.value })} className="h-8 text-sm" />
          </Field>
          {all.emails.map((m) => (
            <label key={m.id} className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={kept.has(m.id)}
                onChange={(ev) =>
                  setDraft({ ...p, emails: ev.target.checked ? all.emails.filter((x) => kept.has(x.id) || x.id === m.id) : p.emails.filter((x) => x.id !== m.id) })
                }
              />
              <span className="min-w-0 truncate"><span className="text-muted-foreground">{m.date} · {m.from} · </span>{m.subject}</span>
            </label>
          ))}
        </div>
      );
    }
  }
  return <AppEditor action={action} draft={draft} setDraft={setDraft} />;
}

export function AiActionCard({
  action,
  onAccept,
  onRefuse,
}: {
  action: AiAction;
  onAccept: (payload?: AiActionPayload) => void;
  onRefuse: () => void;
}) {
  const t = useT();
  // Carte a completer (mot de passe d'un compte) : ouverte d'emblee en saisie.
  const [editing, setEditing] = useState(() => action.status === "pending" && needsInput(action));
  const [draft, setDraft] = useState<AiActionPayload>(action.payload);
  const pending = action.status === "pending";

  return (
    <div
      data-ref="ai-action-card"
      data-kind={action.kind}
      data-status={action.status}
      className={cn(
        "w-full max-w-[90%] space-y-2 rounded-lg border bg-muted/50 p-2.5 text-sm",
        action.status === "done" && "border-blue-400/50",
        action.status === "error" && "border-destructive/50",
        action.status === "refused" && "opacity-60"
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-orange-600 dark:text-orange-400">
        {KIND_ICON[action.kind]}
        <span className="flex-1">{t(`aiAction.kind.${action.kind}`)}</span>
        {action.edited && <span className="text-[10px] font-normal text-muted-foreground">{t("aiAction.edited")}</span>}
      </div>

      {editing && pending ? <Editor action={action} draft={draft} setDraft={setDraft} /> : <Summary action={action} />}

      {pending && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            className="h-7"
            data-ref="ai-action-accept"
            onClick={() => {
              setEditing(false);
              onAccept(editing ? draft : undefined);
            }}
          >
            <Check className="size-3.5" />
            {t("aiAction.accept")}
          </Button>
          <Button size="sm" variant="outline" className="h-7" data-ref="ai-action-refuse" onClick={onRefuse}>
            <X className="size-3.5" />
            {t("aiAction.refuse")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            data-ref="ai-action-edit"
            onClick={() => {
              if (!editing) setDraft(action.payload);
              setEditing(!editing);
            }}
          >
            <Pencil className="size-3.5" />
            {editing ? t("aiAction.cancelEdit") : t("aiAction.edit")}
          </Button>
        </div>
      )}

      {action.status === "running" && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("aiAction.running")}
        </div>
      )}
      {action.status === "done" && (
        <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
          <Check className="size-3.5" />
          {action.resultLabel || t("aiAction.done")}
        </div>
      )}
      {action.status === "refused" && <div className="text-xs text-muted-foreground">{t("aiAction.refused")}</div>}
      {action.status === "error" && (
        <div className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{action.error || t("aiAction.failed")}</span>
        </div>
      )}
    </div>
  );
}
