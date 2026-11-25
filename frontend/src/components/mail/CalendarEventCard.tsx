"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Check, ExternalLink, Loader2, MapPin, Text, User, Users, Video } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { CalendarEvent as CalendarEventRecord } from "@/lib/pocketbase";
import {
  findInvitationEvent,
  respondToInvitation,
  type InvitationResponse,
} from "@/lib/invitations-api";
import { format, isSameDay, isToday, isYesterday } from "date-fns";
import { fr } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import type { CalendarEvent } from "@/lib/utils/ics-parser";

const MAX_VISIBLE_ATTENDEES = 3;

function formatEventDate(
  dtstart: Date,
  dtend: Date | null,
  allDay: boolean,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const dayPrefix = isToday(dtstart)
    ? "Aujourd'hui"
    : isYesterday(dtstart)
      ? "Hier"
      : format(dtstart, "EEEE d MMMM yyyy", { locale: fr });

  if (allDay) return `${dayPrefix} — ${t("calendar.allDay")}`;

  const startTime = format(dtstart, "HH:mm", { locale: fr });

  if (!dtend) return `${dayPrefix}, ${startTime}`;

  const endTime = format(dtend, "HH:mm", { locale: fr });

  if (isSameDay(dtstart, dtend)) {
    return `${dayPrefix}, ${startTime} – ${endTime}`;
  }

  const endDay = format(dtend, "EEEE d MMMM yyyy", { locale: fr });
  return `${dayPrefix}, ${startTime} – ${endDay}, ${endTime}`;
}

interface CalendarEventCardProps {
  event: CalendarEvent;
}

const PLATFORM_LABELS: Record<string, string> = {
  teams: "Microsoft Teams",
  meet: "Google Meet",
  zoom: "Zoom",
  webex: "Webex",
};

const RESPONSES: { value: InvitationResponse; key: string }[] = [
  { value: "accepted", key: "invitation.accept" },
  { value: "declined", key: "invitation.decline" },
  { value: "tentative", key: "invitation.maybe" },
];

export function CalendarEventCard({ event }: CalendarEventCardProps) {
  const t = useT();
  // Etat RELU depuis l'agenda (pas un etat local) : la reponse vaut pour le
  // mail, la notification et le widget de l'iPhone.
  const [record, setRecord] = useState<CalendarEventRecord | null>(null);
  const [busy, setBusy] = useState<InvitationResponse | null>(null);

  useEffect(() => {
    let alive = true;
    void findInvitationEvent(event.uid, event.recurrenceId).then((r) => {
      if (alive) setRecord(r);
    });
    return () => {
      alive = false;
    };
  }, [event.uid, event.recurrenceId]);

  const invitationStatus = record?.invitation_status || "";
  const canAnswer = !!event.organizer || !!invitationStatus;
  const organizerLabel =
    record?.organizer_name || event.organizer?.name || record?.organizer_email || event.organizer?.email || "";

  async function answer(response: InvitationResponse) {
    let target = record;
    if (!target) {
      target = await findInvitationEvent(event.uid, event.recurrenceId);
      setRecord(target);
    }
    if (!target) {
      toast.message(t("invitation.notImported"));
      return;
    }
    setBusy(response);
    try {
      const out = await respondToInvitation(target.id, response);
      setRecord({ ...target, ...out.event });
    } catch {
      toast.error(t("invitation.error"));
    } finally {
      setBusy(null);
    }
  }

  const isCancelled = event.status === "CANCELLED" || record?.status === "cancelled" && !invitationStatus;
  const visibleAttendees = event.attendees.slice(0, MAX_VISIBLE_ATTENDEES);
  const hiddenCount = event.attendees.length - MAX_VISIBLE_ATTENDEES;

  return (
    <div className="mb-2 rounded-2xl border border-border bg-card px-4 py-3">
      {/* Header */}
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <CalendarDays className="size-4 shrink-0 text-foreground" />
        <span>{t("calendar.invitation")}</span>
        {canAnswer && !isCancelled && (
          <span
            data-ref="invitation-state"
            className={cn(
              "ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold",
              invitationStatus === "accepted"
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : invitationStatus === "declined"
                  ? "bg-muted text-muted-foreground"
                  : "border border-dashed border-amber-500/70 text-amber-700 dark:text-amber-300"
            )}
          >
            {invitationStatus === "accepted"
              ? t("invitation.accepted")
              : invitationStatus === "declined"
                ? t("invitation.declined")
                : invitationStatus === "tentative"
                  ? t("invitation.tentative")
                  : t("invitation.toAnswer")}
          </span>
        )}
        {isCancelled && (
          <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
            {t("calendar.cancelled")}
          </Badge>
        )}
      </div>

      {/* Title */}
      {event.summary && (
        <div className={`flex items-start gap-2 text-xs font-bold ${isCancelled ? "line-through text-muted-foreground" : "text-foreground"}`}>
          <Text className="mt-0.5 size-3.5 shrink-0" />
          <span>{event.summary}</span>
        </div>
      )}

      {/* Date/Time */}
      {event.dtstart && (
        <div className="mt-1.5 flex items-start gap-2 text-xs text-foreground">
          <CalendarDays className="mt-0.5 size-3.5 shrink-0" />
          <span>{formatEventDate(event.dtstart, event.dtend, event.allDay, t)}</span>
        </div>
      )}

      {/* Location */}
      {event.location && (
        <div className="mt-2 flex items-start gap-2 text-xs text-foreground">
          <MapPin className="mt-0.5 size-3.5 shrink-0" />
          <span>{event.location}</span>
        </div>
      )}

      {/* Organizer */}
      {event.organizer && (
        <div className="mt-1.5 flex items-start gap-2 text-xs text-foreground">
          <User className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {event.organizer.name}
            {event.organizer.email && event.organizer.name !== event.organizer.email && (
              <span className="ml-1 text-muted-foreground">({event.organizer.email})</span>
            )}
          </span>
        </div>
      )}

      {/* Attendees */}
      {event.attendees.length > 0 && (
        <div className="mt-1.5 flex items-start gap-2 text-xs text-foreground">
          <Users className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {visibleAttendees.map((a) => a.name).join(", ")}
            {hiddenCount > 0 && (
              <span> {t("calendar.andOthers", { count: String(hiddenCount) })}</span>
            )}
          </span>
        </div>
      )}

      {/* Actions */}
      {!isCancelled && (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div className="mt-3 flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {canAnswer &&
            RESPONSES.map((r) => {
              const active = invitationStatus === r.value;
              return (
                <Button
                  key={r.value}
                  variant={active ? "default" : "outline"}
                  size="xs"
                  disabled={!!busy}
                  onClick={() => void answer(r.value)}
                  className="rounded-full"
                  data-ref={`invitation-${r.value}`}
                  aria-pressed={active}
                >
                  {busy === r.value ? <Loader2 className="size-3 animate-spin" /> : active ? <Check className="size-3" /> : null}
                  {t(r.key)}
                </Button>
              );
            })}

          {event.meetingUrl && (
            <Button
              variant="outline"
              size="xs"
              className="ml-auto rounded-full"
              asChild
            >
              <a
                href={event.meetingUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Video className="size-3" />
                {event.meetingPlatform
                  ? PLATFORM_LABELS[event.meetingPlatform]
                  : t("calendar.joinMeeting")}
                <ExternalLink className="size-2.5" />
              </a>
            </Button>
          )}
        </div>
      )}
      {canAnswer && !isCancelled && organizerLabel && (
        <p className="mt-2 text-[11px] text-muted-foreground" data-ref="invitation-note">
          {invitationStatus === "accepted"
            ? t("invitation.doneAccepted", { organizer: organizerLabel })
            : invitationStatus === "declined"
              ? t("invitation.doneDeclined", { organizer: organizerLabel })
              : invitationStatus === "tentative"
                ? t("invitation.doneTentative", { organizer: organizerLabel })
                : t("invitation.willSend", { organizer: organizerLabel })}
        </p>
      )}
    </div>
  );
}
