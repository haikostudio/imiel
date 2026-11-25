import { beforeEach, describe, expect, it, vi } from "vitest";

// Base PocketBase simulee : un tableau d'evenements en memoire.
const db = vi.hoisted(() => ({ events: [] as Record<string, unknown>[], seq: 0 }));
const pushed = vi.hoisted(() => [] as Record<string, unknown>[]);
const replies = vi.hoisted(() => [] as Record<string, unknown>[]);
const google = vi.hoisted(() => [] as unknown[]);
// Gestes vers Google Agenda des copies que NOUS y envoyons.
const gcal = vi.hoisted(() => ({ pushed: [] as string[], patched: [] as Record<string, unknown>[], deleted: [] as string[] }));

vi.mock("./pocketbase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pocketbase")>();
  return {
    ...actual,
    ensureEmailGroup: vi.fn(async () => ({ id: "grp-invit" })),
    getDefaultCalendarGroup: vi.fn(async () => ({ id: "grp-default" })),
    findCalendarEventByIcsUid: vi.fn(async (u: string, k: string) =>
      (db.events.find((e) => e.user === u && e.ics_uid === k) as never) || null
    ),
    createCalendarEvent: vi.fn(async (data: Record<string, unknown>) => {
      const rec = { id: `ev${++db.seq}`, attendees: [], ...data };
      db.events.push(rec);
      return rec;
    }),
    updateCalendarEvent: vi.fn(async (id: string, data: Record<string, unknown>) => {
      const rec = db.events.find((e) => e.id === id)!;
      Object.assign(rec, data);
      return rec;
    }),
    getCalendarEvent: vi.fn(async (id: string) => {
      const rec = db.events.find((e) => e.id === id);
      if (!rec) throw new Error("404");
      return rec;
    }),
    getCalendarGroup: vi.fn(async () => ({ id: "g-google", account: "acc-google" })),
    // "acc-gmail" = boite du compte Google relie (OAuth) ; les autres : boites IMAP.
    getAccount: vi.fn(async (id: string) => ({
      id,
      user: "u1",
      email: id === "acc-gmail" ? "chrisdupont@gmail.com" : "contact@studio.example.com",
      display_name: "Christophe",
      is_active: true,
      auth_type: id === "acc-gmail" ? "oauth2" : "password",
      oauth_provider: id === "acc-gmail" ? "google" : "",
    })),
    listOverlappingCalendarEvents: vi.fn(async () => [
      { id: "other", title: "Coiffeur", start: "2026-11-25T10:20:00.000Z", end: "2026-11-25T11:00:00.000Z" },
    ]),
  };
});
vi.mock("./push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./push")>();
  return {
    ...actual,
    sendInvitationNotification: vi.fn(async (_u: string, inv: Record<string, unknown>) => {
      pushed.push(inv);
    }),
  };
});
vi.mock("./smtp", () => ({
  sendCalendarReply: vi.fn(async (_acc: unknown, mail: Record<string, unknown>) => {
    replies.push(mail);
  }),
}));
vi.mock("./google-calendar", () => ({
  respondGoogleInvitation: vi.fn(async (...args: unknown[]) => {
    google.push(args);
    return { etag: "x" };
  }),
}));

vi.mock("./calendar-google", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./calendar-google")>();
  return {
    ...actual,
    pushEventQuietly: vi.fn(async (ev: Record<string, unknown>) => {
      gcal.pushed.push(String(ev.id));
      return ev;
    }),
    patchEventOnGoogle: vi.fn(async (ev: Record<string, unknown>) => {
      gcal.patched.push(ev);
      return "etag-2";
    }),
    deleteEventFromGoogle: vi.fn(async (ev: Record<string, unknown>) => {
      gcal.deleted.push(String(ev.google_event_id));
    }),
  };
});

import { parseIcsEvents, importIcsFromEmail } from "./ics";
import { buildReplyIcs, respondToInvitation, invitationKey } from "./invitations";

const GOOGLE_INVITE = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
DTSTART:20261125T100000Z
DTEND:20261125T110000Z
DTSTAMP:20261124T090000Z
ORGANIZER;CN=Benoit Weber:mailto:benoit@ecole-example.com
UID:abc123@google.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Benoit
 Weber;X-NUM-GUESTS=0:mailto:benoit@ecole-example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=
 TRUE;CN=contact@studio.example.com;X-NUM-GUESTS=0:mailto:contact@studio.example.com
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Point hebergement
END:VEVENT
END:VCALENDAR`;

const OUTLOOK_INVITE = `BEGIN:VCALENDAR
METHOD:REQUEST
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VTIMEZONE
TZID:W. Europe Standard Time
BEGIN:STANDARD
DTSTART:16010101T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
ORGANIZER;CN="Dupont; Marie":mailto:Marie.Dupont@contoso.com
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Christophe:mailto:chrisdupont@gmail.com
DESCRIPTION;LANGUAGE=fr-FR:Rejoindre la reunion Microsoft Teams
UID:040000008200E00074C5B7101A82E00800000000
RECURRENCE-ID;TZID=W. Europe Standard Time:20261126T140000
SUMMARY;LANGUAGE=fr-FR:Revue Teams
DTSTART;TZID=W. Europe Standard Time:20261126T140000
DTEND;TZID=W. Europe Standard Time:20261126T150000
SEQUENCE:2
LOCATION;LANGUAGE=fr-FR:Reunion Microsoft Teams
END:VEVENT
END:VCALENDAR`;

const APPLE_INVITE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//iPhone 18.0//EN
METHOD:REQUEST
BEGIN:VEVENT
UID:6B29FC40-CA47-1067-B31D-00DD010662DA
DTSTART;VALUE=DATE:20261201
DTEND;VALUE=DATE:20261202
SUMMARY:Anniversaire Annie
ORGANIZER;CN="Annie":mailto:annie@icloud.com
ATTENDEE;CN="Christophe";PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:contact@studio.example.com
SEQUENCE:0
END:VEVENT
END:VCALENDAR`;

const att = (ics: string) => [{ filename: "invite.ics", contentType: "text/calendar; method=REQUEST", size: ics.length, content: Buffer.from(ics), contentId: "", isInline: false }];

describe("parseIcsEvents - invitations", () => {
  it("Google : METHOD, organisateur, invites et PARTSTAT (lignes repliees)", () => {
    const [ev] = parseIcsEvents(GOOGLE_INVITE);
    expect(ev.method).toBe("REQUEST");
    expect(ev.organizer).toEqual({ email: "benoit@ecole-example.com", name: "Benoit Weber" });
    expect(ev.attendees.map((a) => [a.email, a.partstat])).toEqual([
      ["benoit@ecole-example.com", "ACCEPTED"],
      ["contact@studio.example.com", "NEEDS-ACTION"],
    ]);
    expect(ev.sequence).toBe(0);
  });
  it("Outlook/Teams : CN entre guillemets avec ';', fuseau Windows, RECURRENCE-ID, SEQUENCE", () => {
    const [ev] = parseIcsEvents(OUTLOOK_INVITE);
    expect(ev.organizer?.name).toBe("Dupont; Marie");
    expect(ev.organizer?.email).toBe("marie.dupont@contoso.com");
    expect(ev.start).toBe("2026-11-26T13:00:00.000Z");
    expect(ev.recurrenceId).toBe("20261126T140000");
    expect(ev.sequence).toBe(2);
    expect(invitationKey(ev)).toBe("040000008200E00074C5B7101A82E00800000000#20261126T140000");
  });
  it("Apple : journee entiere", () => {
    const [ev] = parseIcsEvents(APPLE_INVITE);
    expect(ev.allDay).toBe(true);
    expect(ev.attendees[0].email).toBe("contact@studio.example.com");
  });
});

function resetGcal() {
  gcal.pushed.length = 0;
  gcal.patched.length = 0;
  gcal.deleted.length = 0;
}

describe("importIcsFromEmail - cycle d'une invitation", () => {
  beforeEach(() => {
    db.events.length = 0;
    pushed.length = 0;
    replies.length = 0;
    google.length = 0;
    resetGcal();
  });

  const ctx = { accountId: "acc1", accountEmail: "contact@studio.example.com", messageId: "m1", threadId: "t1", notify: true };

  it("une invitation arrive A REPONDRE (jamais confirmee d'office) + notification avec conflit", async () => {
    await importIcsFromEmail("u1", att(GOOGLE_INVITE) as never, ctx);
    expect(db.events).toHaveLength(1);
    expect(db.events[0]).toMatchObject({
      invitation_status: "needs_action",
      status: "tentative",
      organizer_email: "benoit@ecole-example.com",
      attendee_email: "contact@studio.example.com",
      account: "acc1",
      message: "m1",
    });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ kind: "new", title: "Point hebergement" });
    expect(String(pushed[0].conflict)).toMatch(/^Chevauche \d\d:\d\d Coiffeur$/);
  });

  it("meme invitation recue deux fois (copie) : un seul evenement, une seule notification", async () => {
    await importIcsFromEmail("u1", att(GOOGLE_INVITE) as never, ctx);
    await importIcsFromEmail("u1", att(GOOGLE_INVITE) as never, { ...ctx, accountId: "acc2", messageId: "m2" });
    expect(db.events).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });

  it("SEQUENCE superieure : mise a jour ; CANCEL : annulee", async () => {
    await importIcsFromEmail("u1", att(GOOGLE_INVITE) as never, ctx);
    const moved = GOOGLE_INVITE.replace("SEQUENCE:0", "SEQUENCE:1").replace("DTSTART:20261125T100000Z", "DTSTART:20261125T103000Z");
    await importIcsFromEmail("u1", att(moved) as never, ctx);
    expect(db.events[0].ics_sequence).toBe(1);
    expect(db.events[0].start).toBe("2026-11-25T10:30:00.000Z");
    const cancel = GOOGLE_INVITE.replace("METHOD:REQUEST", "METHOD:CANCEL").replace("SEQUENCE:0", "SEQUENCE:2");
    await importIcsFromEmail("u1", att(cancel) as never, ctx);
    expect(db.events[0].status).toBe("cancelled");
    expect(pushed.map((p) => p.kind)).toEqual(["new", "updated", "cancelled"]);
  });

  it("invitation recue hors Gmail : agenda par defaut, envoyee chez Google des reception", async () => {
    await importIcsFromEmail("u1", att(GOOGLE_INVITE) as never, ctx);
    expect(db.events[0]).toMatchObject({ group: "grp-default", no_push: false, status: "tentative" });
    expect(gcal.pushed).toEqual([db.events[0].id]);
  });

  it("invitation recue sur la boite Gmail reliee : jamais envoyee (Google l'ajoute lui-meme)", async () => {
    await importIcsFromEmail("u1", att(GOOGLE_INVITE) as never, { ...ctx, accountId: "acc-gmail" });
    expect(db.events[0]).toMatchObject({ group: "grp-default", no_push: true });
    expect(gcal.pushed).toHaveLength(0);
  });

  it("CANCEL d'une invitation deja envoyee chez Google : la copie Google est retiree", async () => {
    await importIcsFromEmail("u1", att(GOOGLE_INVITE) as never, ctx);
    Object.assign(db.events[0], { google_pushed: true, google_event_id: "gpush", google_calendar_id: "primary" });
    const cancel = GOOGLE_INVITE.replace("METHOD:REQUEST", "METHOD:CANCEL").replace("SEQUENCE:0", "SEQUENCE:1");
    await importIcsFromEmail("u1", att(cancel) as never, ctx);
    expect(gcal.deleted).toEqual(["gpush"]);
    expect(db.events[0]).toMatchObject({ status: "cancelled", google_event_id: "", google_pushed: false });
  });

  it("un .ics sans organisateur (reservation) : agenda par defaut, envoye chez Google", async () => {
    const booking = APPLE_INVITE.replace(/ORGANIZER.*\n/, "").replace(/ATTENDEE.*\n/, "").replace("METHOD:REQUEST", "METHOD:PUBLISH");
    await importIcsFromEmail("u1", att(booking) as never, ctx);
    expect(db.events[0]).toMatchObject({ status: "confirmed", group: "grp-default" });
    expect(gcal.pushed).toEqual([db.events[0].id]);
  });

  it("un .ics sans organisateur (reservation) reste importe tel quel", async () => {
    const booking = APPLE_INVITE.replace(/ORGANIZER.*\n/, "").replace(/ATTENDEE.*\n/, "").replace("METHOD:REQUEST", "METHOD:PUBLISH");
    await importIcsFromEmail("u1", att(booking) as never, ctx);
    expect(db.events[0]).toMatchObject({ status: "confirmed" });
    expect(db.events[0].invitation_status).toBeUndefined();
    expect(pushed).toHaveLength(0);
  });
});

describe("respondToInvitation", () => {
  beforeEach(() => {
    db.events.length = 0;
    replies.length = 0;
    google.length = 0;
    resetGcal();
  });

  it("invitation par mail : REPLY iMIP depuis l'adresse invitee, evenement confirme", async () => {
    await importIcsFromEmail("u1", att(OUTLOOK_INVITE) as never, { accountId: "acc1", accountEmail: "chrisdupont@gmail.com", messageId: "m1" });
    const id = String(db.events[0].id);
    const out = await respondToInvitation("u1", id, "accepted");
    expect(out.sentVia).toBe("email");
    expect(google).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ from: "chrisdupont@gmail.com", to: "marie.dupont@contoso.com" });
    const ics = String(replies[0].ics);
    expect(ics).toContain("METHOD:REPLY");
    expect(ics).toContain("UID:040000008200E00074C5B7101A82E00800000000\r\n");
    expect(ics).toContain("RECURRENCE-ID;TZID=W. Europe Standard Time:20261126T140000");
    expect(ics).toContain("SEQUENCE:2");
    expect(ics).toMatch(/ATTENDEE;PARTSTAT=ACCEPTED;CN="Christophe":mailto:chrisdupont@gmail.com/);
    expect(db.events[0]).toMatchObject({ invitation_status: "accepted", status: "confirmed" });
  });

  it("evenement Google : reponse par Google seulement (pas de mail en double)", async () => {
    db.events.push({ id: "g1", user: "u1", group: "g-google", google_event_id: "gid", google_calendar_id: "primary", invitation_status: "needs_action", organizer_email: "b@x.com", title: "T" });
    const out = await respondToInvitation("u1", "g1", "declined");
    expect(out.sentVia).toBe("google");
    expect(google).toHaveLength(1);
    expect(replies).toHaveLength(0);
    expect(db.events[0]).toMatchObject({ invitation_status: "declined", status: "cancelled" });
  });

  it("copie envoyee PAR NOUS chez Google : reponse en iMIP a l'organisateur, jamais par Google", async () => {
    await importIcsFromEmail("u1", att(OUTLOOK_INVITE) as never, { accountId: "acc1", accountEmail: "chrisdupont@gmail.com", messageId: "m1" });
    Object.assign(db.events[0], { google_pushed: true, google_event_id: "gpush", google_calendar_id: "cal-chris", group: "g-google" });
    const out = await respondToInvitation("u1", String(db.events[0].id), "accepted");
    expect(out.sentVia).toBe("email");
    expect(google).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ to: "marie.dupont@contoso.com" });
    // La copie Google passe de "a confirmer" a confirmee.
    expect(gcal.patched).toHaveLength(1);
    expect(gcal.patched[0]).toMatchObject({ status: "confirmed", google_event_id: "gpush" });
    expect(db.events[0]).toMatchObject({ status: "confirmed", etag: "etag-2" });
  });

  it("copie envoyee par nous puis REFUSEE : effacee de Google, reponse iMIP", async () => {
    await importIcsFromEmail("u1", att(OUTLOOK_INVITE) as never, { accountId: "acc1", accountEmail: "chrisdupont@gmail.com", messageId: "m1" });
    Object.assign(db.events[0], { google_pushed: true, google_event_id: "gpush", google_calendar_id: "cal-chris", group: "g-google" });
    await respondToInvitation("u1", String(db.events[0].id), "declined");
    expect(replies).toHaveLength(1);
    expect(google).toHaveLength(0);
    expect(gcal.deleted).toEqual(["gpush"]);
    expect(db.events[0]).toMatchObject({ status: "cancelled", invitation_status: "declined", google_event_id: "" });
  });

  it("evenement d'un autre utilisateur : refuse (403)", async () => {
    db.events.push({ id: "x1", user: "u2", invitation_status: "needs_action", organizer_email: "b@x.com" });
    await expect(respondToInvitation("u1", "x1", "accepted")).rejects.toMatchObject({ status: 403 });
  });
});

describe("buildReplyIcs", () => {
  it("journee entiere : VALUE=DATE", () => {
    const ics = buildReplyIcs(
      { ics_uid: "u", ics_recurrence_id: "", ics_sequence: 0, start: "2026-12-01T00:00:00.000Z", end: "2026-12-02T00:00:00.000Z", all_day: true, title: "A, b", organizer_email: "o@x.com", organizer_name: "O", attendee_email: "me@x.com" },
      "tentative",
      "",
      new Date("2026-11-24T10:00:00Z")
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20261201");
    expect(ics).toContain("SUMMARY:A\\, b");
    expect(ics).toContain("ATTENDEE;PARTSTAT=TENTATIVE:mailto:me@x.com");
    expect(ics).toContain("DTSTAMP:20261124T100000Z");
  });
});
