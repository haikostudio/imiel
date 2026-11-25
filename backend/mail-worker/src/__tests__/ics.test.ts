import { describe, it, expect } from "vitest";
import { parseIcsEvents } from "../ics";

// VTIMEZONE Microsoft "W. Europe Standard Time" (= Europe/Paris/Zurich/Berlin).
const MS_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:W. Europe Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16010101T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

function ics(vevent: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "VERSION:2.0",
    ...MS_VTIMEZONE,
    "BEGIN:VEVENT",
    ...vevent,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

describe("parseIcsEvents - resolution TZID (VTIMEZONE embarque)", () => {
  it("convertit une heure d'ete (DST, +02:00) en UTC", () => {
    // 1 juillet -> heure d'ete -> 11:00 CEST = 09:00 UTC
    const [ev] = parseIcsEvents(
      ics([
        "UID:evt-summer",
        "SUMMARY:Discussion Signa",
        "DTSTART;TZID=W. Europe Standard Time:20260701T110000",
        "DTEND;TZID=W. Europe Standard Time:20260701T120000",
      ])
    );
    expect(ev.start).toBe("2026-07-01T09:00:00.000Z");
    expect(ev.end).toBe("2026-07-01T10:00:00.000Z");
    expect(ev.allDay).toBe(false);
  });

  it("convertit une heure d'hiver (STANDARD, +01:00) en UTC", () => {
    // 15 janvier -> heure d'hiver -> 11:00 CET = 10:00 UTC
    const [ev] = parseIcsEvents(
      ics([
        "UID:evt-winter",
        "SUMMARY:Reunion hiver",
        "DTSTART;TZID=W. Europe Standard Time:20260115T110000",
        "DTEND;TZID=W. Europe Standard Time:20260115T120000",
      ])
    );
    expect(ev.start).toBe("2026-01-15T10:00:00.000Z");
    expect(ev.end).toBe("2026-01-15T11:00:00.000Z");
  });

  it("respecte un horodatage explicitement UTC (suffixe Z)", () => {
    const [ev] = parseIcsEvents(
      ics([
        "UID:evt-utc",
        "SUMMARY:UTC event",
        "DTSTART:20260701T090000Z",
        "DTEND:20260701T100000Z",
      ])
    );
    expect(ev.start).toBe("2026-07-01T09:00:00.000Z");
    expect(ev.end).toBe("2026-07-01T10:00:00.000Z");
  });

  it("resout un TZID IANA via Intl quand aucun VTIMEZONE n'est embarque", () => {
    const raw = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:evt-iana",
      "SUMMARY:Paris event",
      "DTSTART;TZID=Europe/Paris:20260701T110000",
      "DTEND;TZID=Europe/Paris:20260701T120000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [ev] = parseIcsEvents(raw);
    expect(ev.start).toBe("2026-07-01T09:00:00.000Z");
  });

  it("gere les evenements toute la journee (VALUE=DATE)", () => {
    const [ev] = parseIcsEvents(
      ics([
        "UID:evt-allday",
        "SUMMARY:All day",
        "DTSTART;VALUE=DATE:20260701",
        "DTEND;VALUE=DATE:20260702",
      ])
    );
    expect(ev.allDay).toBe(true);
    expect(ev.start).toBe("2026-07-01T00:00:00.000Z");
  });
});
