"use client";

import { useEffect, useState } from "react";
import { Pencil, MapPin, Mail, AlignLeft, Bell, Users, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { respondToInvitation, type InvitationResponse } from "@/lib/invitations-api";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import { eventDayRange } from "@/lib/utils/calendar";
import type { CalendarEvent, CalendarGroup } from "@/lib/pocketbase";
import type { EventInput } from "@/lib/hooks/useAgendaEvents";
import { EventForm } from "./EventForm";

const LOCALES: Record<string, string> = { fr: "fr-FR", en: "en-US", de: "de-DE", it: "it-IT" };

// Rappels par defaut quand l'event n'a aucune alerte (cf. worker + EventForm).
const DEFAULT_REMINDER_MINUTES = [540, 180, 30];

/** "30 minutes" / "3 heures" / "1 jours" selon l'offset (minutes), pour l'affichage. */
function reminderLabel(min: number, t: (k: string) => string): string {
  if (min > 0 && min % 1440 === 0) return `${min / 1440} ${t("calendar.unit.days")}`;
  if (min > 0 && min % 60 === 0) return `${min / 60} ${t("calendar.unit.hours")}`;
  return `${min} ${t("calendar.unit.minutes")}`;
}

interface EventDrawerProps {
  event: CalendarEvent | null;
  groups: CalendarGroup[];
  /** Agendas de toutes les copies de l'evenement (copies liees). */
  copyGroupIds?: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: (id: string, input: Partial<EventInput>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function formatRange(event: CalendarEvent, locale: string): string {
  const date = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" });
  const dateY = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false });

  const start = new Date(event.start);
  if (event.all_day) {
    const { startDay, endDay } = eventDayRange(event);
    if (+startDay === +endDay) return dateY.format(startDay);
    return `${date.format(startDay)} – ${dateY.format(endDay)}`;
  }
  const end = new Date(event.end);
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) return `${dateY.format(start)} · ${time.format(start)} – ${time.format(end)}`;
  return `${date.format(start)} ${time.format(start)} – ${date.format(end)} ${time.format(end)}`;
}

export function EventDrawer({ event, groups, copyGroupIds, open, onOpenChange, onUpdate, onDelete }: EventDrawerProps) {
  const t = useT();
  const language = useSettingsStore((s) => s.language);
  const locale = LOCALES[language] || "en-US";
  const [editing, setEditing] = useState(false);
  // Reponse a une invitation : etat local tant que la liste (temps reel) ne
  // s'est pas rafraichie.
  const [invitationStatus, setInvitationStatus] = useState(event?.invitation_status || "");
  const [answering, setAnswering] = useState<InvitationResponse | null>(null);

  // Repasse en mode lecture a chaque changement d'event / ouverture.
  useEffect(() => {
    setEditing(false);
    setInvitationStatus(event?.invitation_status || "");
  }, [event?.id, event?.invitation_status, open]);

  async function answer(response: InvitationResponse) {
    if (!event) return;
    setAnswering(response);
    try {
      const out = await respondToInvitation(event.id, response);
      setInvitationStatus(out.event.invitation_status || response);
      if (response === "declined") onOpenChange(false);
    } catch {
      toast.error(t("invitation.error"));
    } finally {
      setAnswering(null);
    }
  }

  const group = event ? groups.find((g) => g.id === event.group) : null;
  const color = group?.color || "#888";
  // Tous les agendas de l'evenement (une copie par agenda), le sien d'abord.
  const allGroupIds = event ? Array.from(new Set([event.group, ...(copyGroupIds || [])])) : [];
  const eventGroups = allGroupIds
    .map((id) => groups.find((g) => g.id === id))
    .filter((g): g is CalendarGroup => !!g);

  return (
    <ResponsivePanel
      open={open}
      onOpenChange={onOpenChange}
      title={event?.title || t("calendar.untitled")}
      accentColor={color}
      // Lecture : tiroir a la hauteur du CONTENU (h-auto). Edition : plus haut
      // pour le formulaire. Empile au-dessus du tiroir "liste du jour" (z-[60])
      // pour ne pas le fermer.
      mobileHeightClass={editing ? "h-[calc(var(--app-height,100dvh)*0.9)] max-sm:sheet-h-full" : "h-auto"}
      contentClassName="z-[60]"
      overlayClassName="z-[60]"
      headerActions={
        event && !editing ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setEditing(true)}
            title={t("calendar.editEvent")}
          >
            <Pencil className="size-4" />
          </Button>
        ) : null
      }
    >
      {!event ? null : editing ? (
        <EventForm
          groups={groups}
          initial={event}
          initialGroupIds={allGroupIds}
          onSubmit={async (input) => {
            await onUpdate(event.id, input);
            onOpenChange(false);
          }}
          onDelete={async () => {
            await onDelete(event.id);
            onOpenChange(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="flex flex-col gap-4 overflow-y-auto p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              {eventGroups.map((g) => (
                <Badge key={g.id} variant="outline" className="gap-1.5" data-ref="event-group-badge">
                  <span className="size-2 rounded-full" style={{ backgroundColor: g.color || "#888" }} />
                  {g.name}
                </Badge>
              ))}
              {event.source === "email" && (
                <Badge variant="secondary" className="gap-1">
                  <Mail className="size-3" />
                  {t("calendar.fromEmail")}
                </Badge>
              )}
            </div>

            <div className="font-medium">{formatRange(event, locale)}</div>

            {!!invitationStatus && (
              <div
                className="flex flex-col gap-2 rounded-xl border border-dashed p-3"
                style={{ borderColor: color }}
                data-ref="event-invitation"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {t("invitation.organizer")} : {event.organizer_name || event.organizer_email}
                  </span>
                  <span className="font-semibold">
                    {invitationStatus === "accepted"
                      ? t("invitation.accepted")
                      : invitationStatus === "declined"
                        ? t("invitation.declined")
                        : invitationStatus === "tentative"
                          ? t("invitation.tentative")
                          : t("invitation.toAnswer")}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {([
                    ["accepted", "invitation.accept"],
                    ["declined", "invitation.decline"],
                    ["tentative", "invitation.maybe"],
                  ] as const).map(([value, key]) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={invitationStatus === value ? "default" : "outline"}
                      className="rounded-full"
                      disabled={!!answering}
                      onClick={() => void answer(value)}
                      data-ref={`event-invitation-${value}`}
                    >
                      {answering === value ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : invitationStatus === value ? (
                        <Check className="size-3.5" />
                      ) : null}
                      {t(key)}
                    </Button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t("invitation.willSend", { organizer: event.organizer_name || event.organizer_email || "" })}
                </p>
              </div>
            )}

            {event.location && (
              <div className="flex items-start gap-2 text-muted-foreground">
                <MapPin className="mt-0.5 size-4 shrink-0" />
                <span>{event.location}</span>
              </div>
            )}

            {event.description && (
              <div className="flex items-start gap-2 text-muted-foreground">
                <AlignLeft className="mt-0.5 size-4 shrink-0" />
                <p className="whitespace-pre-wrap">{event.description}</p>
              </div>
            )}

            {event.attendees && event.attendees.length > 0 && (
              <div className="flex items-start gap-2 text-muted-foreground">
                <Users className="mt-0.5 size-4 shrink-0" />
                <div className="flex flex-col gap-0.5">
                  {event.attendees.map((a, i) => (
                    <span key={i}>{a.name || a.email}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-start gap-2 text-muted-foreground">
              <Bell className="mt-0.5 size-4 shrink-0" />
              <span>
                {(event.reminders && event.reminders.length
                  ? event.reminders
                  : DEFAULT_REMINDER_MINUTES
                )
                  .map((m) => reminderLabel(m, t))
                  .join(", ")}{" "}
                {t("calendar.reminderBefore")}
              </span>
            </div>
          </div>
        )}
    </ResponsivePanel>
  );
}
