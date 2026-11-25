import pb, { calendarEvents, type CalendarEvent } from "@/lib/pocketbase";

export type InvitationResponse = "accepted" | "declined" | "tentative";

/** Cle d'une invitation (meme regle que le worker : UID + occurrence). */
export function invitationKey(uid: string, recurrenceId?: string): string {
  return recurrenceId ? `${uid}#${recurrenceId}` : uid;
}

/** Evenement d'agenda importe pour cette invitation (null si pas encore la). */
export async function findInvitationEvent(uid: string, recurrenceId?: string): Promise<CalendarEvent | null> {
  if (!uid) return null;
  const key = invitationKey(uid, recurrenceId).replace(/"/g, '\\"');
  try {
    return await calendarEvents().getFirstListItem<CalendarEvent>(`ics_uid = "${key}"`, { requestKey: null });
  } catch {
    return null;
  }
}

/**
 * Repond a une invitation : la reponse part a l'organisateur (Google pour un
 * evenement Google, sinon mail iMIP). Session PocketBase obligatoire.
 */
export async function respondToInvitation(
  eventId: string,
  response: InvitationResponse
): Promise<{ sentVia: "google" | "email"; event: CalendarEvent }> {
  const res = await fetch(`/worker/calendar/invitations/${encodeURIComponent(eventId)}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: pb.authStore.token },
    body: JSON.stringify({ response }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; sentVia?: "google" | "email"; event?: CalendarEvent };
  if (!res.ok || !data.event) throw new Error(data.error || `HTTP ${res.status}`);
  return { sentVia: data.sentVia || "email", event: data.event };
}
