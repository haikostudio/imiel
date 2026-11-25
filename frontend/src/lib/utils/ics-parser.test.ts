import { describe, it, expect } from "vitest";
import { parseIcsContent } from "./ics-parser";

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

describe("parseIcsContent - TZID resolution", () => {
  it("resolves DST wall-clock (+02:00) to the right UTC instant", () => {
    const ev = parseIcsContent(
      ics([
        "UID:evt-summer",
        "SUMMARY:Discussion Signa",
        "DTSTART;TZID=W. Europe Standard Time:20260701T110000",
        "DTEND;TZID=W. Europe Standard Time:20260701T120000",
      ])
    );
    // 11:00 CEST = 09:00 UTC
    expect(ev?.dtstart?.toISOString()).toBe("2026-07-01T09:00:00.000Z");
    expect(ev?.dtend?.toISOString()).toBe("2026-07-01T10:00:00.000Z");
  });

  it("resolves winter wall-clock (+01:00) to the right UTC instant", () => {
    const ev = parseIcsContent(
      ics([
        "UID:evt-winter",
        "SUMMARY:Hiver",
        "DTSTART;TZID=W. Europe Standard Time:20260115T110000",
      ])
    );
    // 11:00 CET = 10:00 UTC
    expect(ev?.dtstart?.toISOString()).toBe("2026-01-15T10:00:00.000Z");
  });

  it("honours explicit UTC (Z suffix)", () => {
    const ev = parseIcsContent(
      ics(["UID:evt-utc", "SUMMARY:UTC", "DTSTART:20260701T090000Z"])
    );
    expect(ev?.dtstart?.toISOString()).toBe("2026-07-01T09:00:00.000Z");
  });
});
