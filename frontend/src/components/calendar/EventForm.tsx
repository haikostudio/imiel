"use client";

import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Bell, Check, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import type { CalendarEvent, CalendarGroup } from "@/lib/pocketbase";
import type { EventInput } from "@/lib/hooks/useAgendaEvents";

const LOCALES: Record<string, string> = { fr: "fr-FR", en: "en-US", de: "de-DE", it: "it-IT" };

// Rappels par defaut (minutes avant le debut) quand l'utilisateur n'a rien
// defini : 9h / 3h / 30min. Aligne sur la logique worker (calendar-reminders).
const DEFAULT_REMINDER_MINUTES = [540, 180, 30];

type ReminderUnit = "minutes" | "hours" | "days";
interface ReminderRow {
  id: number;
  value: number;
  unit: ReminderUnit;
}
const UNIT_FACTOR: Record<ReminderUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** Minutes -> ligne (choisit la plus grande unite entiere). */
function minutesToRow(min: number, id: number): ReminderRow {
  if (min > 0 && min % 1440 === 0) return { id, value: min / 1440, unit: "days" };
  if (min > 0 && min % 60 === 0) return { id, value: min / 60, unit: "hours" };
  return { id, value: min, unit: "minutes" };
}

/** Agenda ou l'on peut ecrire : local, ou role Google proprietaire/redacteur. */
export function isWritableGroup(g: CalendarGroup): boolean {
  return !g.google_calendar_id || !g.access_role || g.access_role === "owner" || g.access_role === "writer";
}

interface EventFormProps {
  groups: CalendarGroup[];
  initial?: CalendarEvent | null;
  /** Agendas de toutes les copies de l'evenement edite (copies liees). */
  initialGroupIds?: string[];
  defaultStart?: Date | null;
  onSubmit: (input: EventInput) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel: () => void;
}

export function EventForm({ groups, initial, initialGroupIds, defaultStart, onSubmit, onDelete, onCancel }: EventFormProps) {
  const t = useT();
  const language = useSettingsStore((s) => s.language);
  const locale = LOCALES[language] || "en-US";
  const localGroups = groups.length > 0 ? groups : [];

  const initialStart = initial ? new Date(initial.start) : defaultStart || new Date();
  // Fin affichee : pour un all-day, l'end stocke est exclusif -> on recule d'1j.
  const initialEndRaw = initial ? new Date(initial.end) : new Date(initialStart.getTime() + 3600_000);
  const initialAllDay = initial?.all_day ?? false;
  const initialEnd = initialAllDay ? new Date(initialEndRaw.getTime() - 86400_000) : initialEndRaw;

  const [title, setTitle] = useState(initial?.title ?? "");
  // Plusieurs agendas possibles (une copie par agenda). Nouvel evenement :
  // l'agenda par defaut coche d'office.
  const [groupIds, setGroupIds] = useState<string[]>(() => {
    if (initial) return initialGroupIds && initialGroupIds.length ? initialGroupIds : [initial.group];
    const def =
      localGroups.find((g) => g.is_default && isWritableGroup(g)) || localGroups.find((g) => isWritableGroup(g));
    return def ? [def.id] : [];
  });
  // Proposes : agendas ou l'on peut ecrire + ceux ou l'evenement est deja.
  const choosable = localGroups.filter((g) => isWritableGroup(g) || groupIds.includes(g.id));
  function toggleGroup(id: string) {
    setGroupIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  const [location, setLocation] = useState(initial?.location ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [allDay, setAllDay] = useState(initialAllDay);
  const [startDt, setStartDt] = useState(initialStart);
  const [endDt, setEndDt] = useState(initialEnd);
  const [saving, setSaving] = useState(false);

  // Alertes : on prefille avec les defauts (9h/3h/30min) quand l'event n'a
  // aucun rappel explicite, pour que l'utilisateur les voie et puisse les
  // ajuster/retirer. Liste vide a l'enregistrement => le worker renvoie aux defauts.
  const initialReminderMinutes =
    initial?.reminders && initial.reminders.length ? initial.reminders : DEFAULT_REMINDER_MINUTES;
  const [reminders, setReminders] = useState<ReminderRow[]>(
    initialReminderMinutes.map((m, i) => minutesToRow(m, i))
  );
  const reminderIdRef = useRef(initialReminderMinutes.length);

  function addReminder() {
    setReminders((prev) => [...prev, { id: reminderIdRef.current++, value: 10, unit: "minutes" }]);
  }
  function updateReminder(id: number, patch: Partial<ReminderRow>) {
    setReminders((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeReminder(id: number) {
    setReminders((prev) => prev.filter((r) => r.id !== id));
  }

  // Garde la fin >= debut quand on deplace le debut.
  function handleStartChange(next: Date) {
    setStartDt(next);
    if (endDt < next) setEndDt(new Date(next.getTime() + 3600_000));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || groupIds.length === 0) return;
    setSaving(true);

    let startIso: string;
    let endIso: string;
    if (allDay) {
      // Ancre a minuit UTC du jour choisi (independant du fuseau, cf. sync).
      const s = new Date(Date.UTC(startDt.getFullYear(), startDt.getMonth(), startDt.getDate()));
      startIso = s.toISOString();
      // end exclusif = jour de fin (inclusif) + 1 jour.
      const endExcl = new Date(Date.UTC(endDt.getFullYear(), endDt.getMonth(), endDt.getDate() + 1));
      endIso = endExcl.toISOString();
    } else {
      startIso = startDt.toISOString();
      endIso = endDt.toISOString();
      if (new Date(endIso) <= new Date(startIso)) {
        endIso = new Date(startDt.getTime() + 3600_000).toISOString();
      }
    }

    // Lignes -> minutes : uniques, > 0, triees du plus loin au plus proche.
    const reminderMinutes = Array.from(
      new Set(reminders.map((r) => r.value * UNIT_FACTOR[r.unit]).filter((m) => m > 0))
    ).sort((a, b) => b - a);

    await onSubmit({
      groups: groupIds,
      title: title.trim(),
      description,
      location,
      start: startIso,
      end: endIso,
      all_day: allDay,
      reminders: reminderMinutes,
    });
    setSaving(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex h-full min-h-0 flex-col">
      {/* Corps defilant */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="space-y-1.5">
          <Label htmlFor="ev-title">{t("calendar.eventTitle")}</Label>
          <Input
            id="ev-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("calendar.eventTitle")}
            autoFocus
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label>{t("calendar.group")}</Label>
          {/* Pastilles a cocher (pas de liste deroulante : rien ne passe sous le
              tiroir) ; chaque agenda coche recoit sa copie, chez Google aussi. */}
          <div className="flex flex-wrap gap-1.5" data-ref="event-form-groups" role="group">
            {choosable.map((g) => {
              const on = groupIds.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggleGroup(g.id)}
                  data-ref="event-form-group"
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-colors",
                    on ? "border-transparent text-white" : "bg-background text-foreground hover:bg-accent"
                  )}
                  style={on ? { backgroundColor: g.color || "#888" } : undefined}
                >
                  {on ? (
                    <Check className="size-3.5" />
                  ) : (
                    <span className="size-2.5 rounded-full" style={{ backgroundColor: g.color || "#888" }} />
                  )}
                  <span className="max-w-[12rem] truncate">{g.name}</span>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">{t("calendar.groupsHint")}</p>
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="ev-allday">{t("calendar.allDay")}</Label>
          <Switch id="ev-allday" checked={allDay} onCheckedChange={setAllDay} />
        </div>

        <div className="space-y-1.5">
          <Label>{t("calendar.start")}</Label>
          <DateTimePicker value={startDt} onChange={handleStartChange} withTime={!allDay} locale={locale} />
        </div>

        <div className="space-y-1.5">
          <Label>{t("calendar.end")}</Label>
          <DateTimePicker value={endDt} onChange={setEndDt} withTime={!allDay} locale={locale} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ev-loc">{t("calendar.location")}</Label>
          <Input id="ev-loc" value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ev-desc">{t("calendar.description")}</Label>
          <Textarea id="ev-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Bell className="size-4 text-muted-foreground" />
            <Label>{t("calendar.alert")}</Label>
          </div>
          {reminders.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("calendar.reminderNone")}</p>
          )}
          {reminders.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                value={r.value}
                onChange={(e) =>
                  updateReminder(r.id, { value: Math.max(0, parseInt(e.target.value, 10) || 0) })
                }
                className="w-20"
              />
              <Select
                value={r.unit}
                onValueChange={(u) => updateReminder(r.id, { unit: u as ReminderUnit })}
              >
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">{t("calendar.unit.minutes")}</SelectItem>
                  <SelectItem value="hours">{t("calendar.unit.hours")}</SelectItem>
                  <SelectItem value="days">{t("calendar.unit.days")}</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">{t("calendar.reminderBefore")}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-auto size-8 text-muted-foreground"
                onClick={() => removeReminder(r.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addReminder}>
            <Plus className="size-4" />
            {t("calendar.addReminder")}
          </Button>
        </div>
      </div>

      {/* Footer epingle (boutons) -- meme convention que la toolbar ReplyBox */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {onDelete ? (
          <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={onDelete}>
            <Trash2 className="size-4" />
            {t("calendar.delete")}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={saving || !title.trim() || groupIds.length === 0}>
            {t("save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
