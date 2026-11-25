import { useState, useEffect } from "react";
import { attachments as attachmentsCollection, getFileUrl } from "@/lib/pocketbase";
import { parseIcsContent, type CalendarEvent } from "@/lib/utils/ics-parser";
import type { Message, Attachment } from "@/lib/pocketbase";

export function useCalendarEvents(message: Message): {
  events: CalendarEvent[];
  loading: boolean;
} {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!message.has_attachments) {
      setEvents([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        // Query the attachments collection for calendar files
        const records = await attachmentsCollection().getFullList<Attachment>({
          filter: `message="${message.id}" && (content_type~"calendar" || filename~".ics")`,
        });

        if (cancelled || records.length === 0) {
          if (!cancelled) {
            setEvents([]);
            setLoading(false);
          }
          return;
        }

        // Fetch and parse each ICS file
        const results = await Promise.allSettled(
          records.map(async (record) => {
            const url = getFileUrl(record, record.file);
            const response = await fetch(url);
            const text = await response.text();
            return parseIcsContent(text);
          })
        );

        if (cancelled) return;

        const parsed: CalendarEvent[] = [];
        for (const result of results) {
          if (result.status === "fulfilled" && result.value) {
            parsed.push(result.value);
          }
        }
        setEvents(parsed);
      } catch {
        if (!cancelled) setEvents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [message.id, message.has_attachments]);

  return { events, loading };
}
