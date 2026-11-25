import { beforeEach, describe, expect, it, vi } from "vitest";

// Base PocketBase simulee (groupes + evenements) et Google Agenda simule.
const db = vi.hoisted(() => ({
  groups: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  seq: 0,
}));
const g = vi.hoisted(() => ({
  calendars: [] as { id: string; summary: string; accessRole: string }[],
  events: [] as Record<string, unknown>[],
  calls: [] as string[],
  seq: 0,
}));

vi.mock("./pocketbase", () => {
  const byId = (list: Record<string, unknown>[], id: string) => list.find((r) => r.id === id);
  return {
    getAccount: vi.fn(async (id: string) => ({
      id,
      user: "u1",
      email: "chris@gmail.com",
      is_active: true,
      auth_type: "oauth2",
      oauth_provider: "google",
    })),
    getCalendarGroup: vi.fn(async (id: string) => {
      const r = byId(db.groups, id);
      if (!r) throw new Error("404");
      return { ...r };
    }),
    listCalendarGroupsForUser: vi.fn(async (u: string) => db.groups.filter((r) => r.user === u).map((r) => ({ ...r }))),
    updateCalendarGroup: vi.fn(async (id: string, data: Record<string, unknown>) => {
      const r = byId(db.groups, id)!;
      Object.assign(r, data);
      return { ...r };
    }),
    deleteCalendarGroup: vi.fn(async (id: string) => {
      db.groups = db.groups.filter((r) => r.id !== id);
      db.events = db.events.filter((e) => e.group !== id);
    }),
    getCalendarEvent: vi.fn(async (id: string) => {
      const r = byId(db.events, id);
      if (!r) throw new Error("404");
      return { ...r };
    }),
    createCalendarEvent: vi.fn(async (data: Record<string, unknown>) => {
      const rec = { id: `ev${++db.seq}`, google_event_id: "", copy_key: "", ...data };
      db.events.push(rec);
      return { ...rec };
    }),
    updateCalendarEvent: vi.fn(async (id: string, data: Record<string, unknown>) => {
      const r = byId(db.events, id)!;
      Object.assign(r, data);
      return { ...r };
    }),
    deleteCalendarEvent: vi.fn(async (id: string) => {
      db.events = db.events.filter((r) => r.id !== id);
    }),
    findCalendarEventByIcsUid: vi.fn(async (u: string, k: string) => db.events.find((e) => e.user === u && e.ics_uid === k) || null),
    listCalendarEventsByCopyKey: vi.fn(async (u: string, k: string) =>
      db.events.filter((e) => e.user === u && k && e.copy_key === k).map((e) => ({ ...e }))
    ),
    listUnpushedCalendarEvents: vi.fn(async (groupId: string) =>
      db.events.filter((e) => e.group === groupId && !e.google_event_id && !e.no_push && e.status !== "cancelled").map((e) => ({ ...e }))
    ),
    pbAdminFetch: vi.fn(async () => ({ items: [{ id: "acc", is_active: true, auth_type: "oauth2", oauth_provider: "google" }] })),
  };
});

vi.mock("./google-calendar", () => {
  const ev = (cal: string, body: Record<string, unknown>) => {
    const rec = { id: `gev${++g.seq}`, etag: `e${g.seq}`, cal, ...body };
    g.events.push(rec);
    return rec;
  };
  return {
    insertCalendar: vi.fn(async (_a: unknown, summary: string) => {
      g.calls.push(`insertCalendar:${summary}`);
      const id = `${summary.toLowerCase()}@group.calendar.google.com`;
      g.calendars.push({ id, summary, accessRole: "owner" });
      return id;
    }),
    patchCalendarColor: vi.fn(async () => undefined),
    deleteCalendar: vi.fn(async (_a: unknown, id: string) => {
      g.calls.push(`deleteCalendar:${id}`);
    }),
    removeCalendarFromList: vi.fn(async (_a: unknown, id: string) => {
      g.calls.push(`removeFromList:${id}`);
    }),
    importEvent: vi.fn(async (_a: unknown, cal: string, uid: string, e: Record<string, unknown>) => {
      g.calls.push(`import:${cal}:${uid}`);
      const same = g.events.find((x) => x.cal === cal && x.iCalUID === uid);
      if (same) return { id: same.id, etag: same.etag };
      const r = ev(cal, { iCalUID: uid, title: e.title });
      return { id: r.id, etag: r.etag };
    }),
    findEventByImielId: vi.fn(async (_a: unknown, cal: string, imielId: string) =>
      g.events.find((x) => x.cal === cal && x.imielId === imielId) || null
    ),
    pushEvent: vi.fn(async (_a: unknown, cal: string, e: Record<string, unknown>) => {
      g.calls.push(`insert:${cal}:${e.id}`);
      const r = ev(cal, { imielId: e.id, title: e.title });
      return { id: r.id, etag: r.etag };
    }),
    patchEvent: vi.fn(async (_a: unknown, cal: string, gid: string, e: Record<string, unknown>) => {
      g.calls.push(`patch:${cal}:${gid}:${e.title}`);
      const r = g.events.find((x) => x.id === gid)!;
      r.title = e.title;
      r.etag = `${r.etag}+`;
      return { id: gid, etag: String(r.etag) };
    }),
    deleteGoogleEvent: vi.fn(async (_a: unknown, cal: string, gid: string) => {
      g.calls.push(`delete:${cal}:${gid}`);
      g.events = g.events.filter((x) => x.id !== gid);
    }),
    moveEvent: vi.fn(async (_a: unknown, from: string, gid: string, to: string) => {
      g.calls.push(`move:${from}->${to}:${gid}`);
      const r = g.events.find((x) => x.id === gid)!;
      r.cal = to;
      return { id: gid, etag: "moved" };
    }),
  };
});

import {
  createEventCopies,
  deleteEventCopies,
  deleteGroupEverywhere,
  ensureGoogleCalendarsForUser,
  propagateToSiblings,
  pushPendingEventsForAccount,
  updateEventCopies,
} from "./calendar-google";

const ACC = { id: "acc", user: "u1", email: "chris@gmail.com", is_active: true, auth_type: "oauth2", oauth_provider: "google" } as never;

function seedGroups() {
  db.groups = [
    { id: "gChris", user: "u1", name: "Chris", account: "acc", google_calendar_id: "chris@gmail.com", access_role: "owner", is_primary: true, is_default: true, color: "#3b82f6" },
    { id: "gPro", user: "u1", name: "Pro", account: "acc", google_calendar_id: "pro@group.calendar.google.com", access_role: "owner", color: "#ef4444" },
    { id: "gManon", user: "u1", name: "Manon", account: "acc", google_calendar_id: "manon@gmail.com", access_role: "reader", color: "#22c55e" },
    { id: "gPerso", user: "u1", name: "Perso", account: "", google_calendar_id: "", color: "#8b5cf6" },
  ];
}

const FIELDS = { title: "Kine", start: "2026-11-25T08:45:00.000Z", end: "2026-11-25T09:45:00.000Z", all_day: false };

beforeEach(() => {
  db.groups = [];
  db.events = [];
  db.seq = 0;
  g.calendars = [];
  g.events = [];
  g.calls = [];
  g.seq = 0;
  delete process.env.CALENDAR_GOOGLE_PUSH;
  seedGroups();
});

describe("copies liees (un evenement dans plusieurs agendas)", () => {
  it("creation dans deux agendas Google : deux copies, une par agenda, meme copy_key", async () => {
    const copies = await createEventCopies("u1", ["gChris", "gPro"], FIELDS);
    expect(copies).toHaveLength(2);
    expect(copies[0].copy_key).toBeTruthy();
    expect(copies[0].copy_key).toBe(copies[1].copy_key);
    expect(g.events.map((e) => e.cal).sort()).toEqual(["chris@gmail.com", "pro@group.calendar.google.com"]);
    expect(db.events.every((e) => e.google_event_id && e.google_pushed)).toBe(true);
  });

  it("un seul agenda : pas de copy_key", async () => {
    const [ev] = await createEventCopies("u1", ["gChris"], FIELDS);
    expect(ev.copy_key).toBe("");
  });

  it("agenda d'un autre utilisateur : refuse", async () => {
    db.groups.push({ id: "gX", user: "u2", name: "X" });
    await expect(createEventCopies("u1", ["gX"], FIELDS)).rejects.toMatchObject({ status: 403 });
  });

  it("modifier depuis iMiel : toutes les copies et leurs copies Google suivent", async () => {
    const [a] = await createEventCopies("u1", ["gChris", "gPro"], FIELDS);
    await updateEventCopies("u1", String(a.id), { title: "Kine (deplace)" });
    expect(db.events.map((e) => e.title)).toEqual(["Kine (deplace)", "Kine (deplace)"]);
    expect(g.events.map((e) => e.title)).toEqual(["Kine (deplace)", "Kine (deplace)"]);
  });

  it("ajouter puis retirer un agenda : copie creee puis supprimee chez Google", async () => {
    const [a] = await createEventCopies("u1", ["gChris"], FIELDS);
    await updateEventCopies("u1", String(a.id), {}, ["gChris", "gPro"]);
    expect(db.events).toHaveLength(2);
    expect(db.events[0].copy_key).toBeTruthy();
    expect(db.events[0].copy_key).toBe(db.events[1].copy_key);
    await updateEventCopies("u1", String(a.id), {}, ["gChris"]);
    expect(db.events).toHaveLength(1);
    expect(g.events).toHaveLength(1);
    expect(g.calls.some((c) => c.startsWith("delete:pro@"))).toBe(true);
  });

  it("changer d'agenda Google (meme compte) : deplacement, pas de suppression", async () => {
    const [a] = await createEventCopies("u1", ["gChris"], FIELDS);
    await updateEventCopies("u1", String(a.id), {}, ["gPro"]);
    expect(g.calls.filter((c) => c.startsWith("move:"))).toHaveLength(1);
    expect(g.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    expect(db.events[0]).toMatchObject({ group: "gPro", google_calendar_id: "pro@group.calendar.google.com" });
  });

  it("aucun agenda coche : refuse (400)", async () => {
    const [a] = await createEventCopies("u1", ["gChris"], FIELDS);
    await expect(updateEventCopies("u1", String(a.id), {}, [])).rejects.toMatchObject({ status: 400 });
  });

  it("supprimer dans iMiel : toutes les copies, partout", async () => {
    const [a] = await createEventCopies("u1", ["gChris", "gPro"], FIELDS);
    const n = await deleteEventCopies("u1", String(a.id));
    expect(n).toBe(2);
    expect(db.events).toHaveLength(0);
    expect(g.events).toHaveLength(0);
  });

  it("modification faite dans Google sur une copie : reportee UNE fois sur l'autre, sans boucle", async () => {
    const [a] = await createEventCopies("u1", ["gChris", "gPro"], FIELDS);
    const before = { ...db.events.find((e) => e.id === a.id)! } as never;
    const after = { ...(before as Record<string, unknown>), title: "Kine 10h" } as never;
    Object.assign(db.events.find((e) => e.id === a.id)!, { title: "Kine 10h" });
    expect(await propagateToSiblings(before, after)).toBe(1);
    expect(db.events.map((e) => e.title)).toEqual(["Kine 10h", "Kine 10h"]);
    const patches = g.calls.filter((c) => c.startsWith("patch:")).length;
    // Retour de la synchro de l'autre agenda : contenu deja identique -> rien.
    const sib = db.events.find((e) => e.id !== a.id)! as never;
    expect(await propagateToSiblings(sib, sib)).toBe(0);
    expect(g.calls.filter((c) => c.startsWith("patch:")).length).toBe(patches);
  });
});

describe("rattrapage : tous les agendas chez Google, rejouable", () => {
  it("agenda propre a iMiel cree chez Google, puis adopte (pas recree) au passage suivant", async () => {
    const added = await ensureGoogleCalendarsForUser(ACC, []);
    expect(added.map((c) => c.summary)).toEqual(["Perso"]);
    expect(db.groups.find((x) => x.id === "gPerso")).toMatchObject({ account: "acc", access_role: "owner" });
    // Coupure simulee : le groupe a perdu son lien, l'agenda existe chez Google.
    Object.assign(db.groups.find((x) => x.id === "gPerso")!, { google_calendar_id: "" });
    await ensureGoogleCalendarsForUser(ACC, g.calendars as never);
    expect(g.calls.filter((c) => c.startsWith("insertCalendar:"))).toHaveLength(1);
  });

  it("evenements envoyes une seule fois, meme rejoue ; lecture seule et no_push ignores", async () => {
    await ensureGoogleCalendarsForUser(ACC, []);
    db.events.push(
      { id: "l1", user: "u1", group: "gPerso", title: "Local", start: FIELDS.start, end: FIELDS.end, google_event_id: "", status: "confirmed" },
      { id: "m1", user: "u1", group: "gChris", title: "Doctolib", start: FIELDS.start, end: FIELDS.end, google_event_id: "", ics_uid: "doc-123", status: "confirmed" },
      { id: "n1", user: "u1", group: "gChris", title: "Invit Gmail", start: FIELDS.start, end: FIELDS.end, google_event_id: "", no_push: true, status: "tentative" },
      { id: "r1", user: "u1", group: "gManon", title: "Manon", start: FIELDS.start, end: FIELDS.end, google_event_id: "", status: "confirmed" }
    );
    expect(await pushPendingEventsForAccount(ACC)).toBe(2);
    expect(g.calls).toContain("import:chris@gmail.com:doc-123");
    // Coupure apres l'envoi, avant l'ecriture locale : la cle privee evite le doublon.
    Object.assign(db.events.find((e) => e.id === "l1")!, { google_event_id: "" });
    await pushPendingEventsForAccount(ACC);
    expect(g.events.filter((e) => e.imielId === "l1")).toHaveLength(1);
    expect(g.events.some((e) => e.title === "Invit Gmail" || e.title === "Manon")).toBe(false);
  });

  it("coupe-circuit CALENDAR_GOOGLE_PUSH=off : rien n'est envoye", async () => {
    process.env.CALENDAR_GOOGLE_PUSH = "off";
    expect(await ensureGoogleCalendarsForUser(ACC, [])).toEqual([]);
    db.events.push({ id: "l1", user: "u1", group: "gChris", title: "x", start: FIELDS.start, end: FIELDS.end, google_event_id: "", status: "confirmed" });
    expect(await pushPendingEventsForAccount(ACC)).toBe(0);
    expect(g.calls).toEqual([]);
  });
});

describe("suppression d'un agenda", () => {
  it("agenda principal : refuse", async () => {
    await expect(deleteGroupEverywhere("u1", "gChris")).rejects.toMatchObject({ status: 400 });
  });
  it("agenda du compte : supprime chez Google", async () => {
    expect(await deleteGroupEverywhere("u1", "gPro")).toEqual({ effect: "google_deleted" });
    expect(g.calls).toContain("deleteCalendar:pro@group.calendar.google.com");
  });
  it("agenda partage : seulement retire de la liste", async () => {
    expect(await deleteGroupEverywhere("u1", "gManon")).toEqual({ effect: "unsubscribed" });
    expect(g.calls).toContain("removeFromList:manon@gmail.com");
    expect(g.calls.some((c) => c.startsWith("deleteCalendar"))).toBe(false);
  });
  it("agenda local : supprime dans iMiel seulement", async () => {
    expect(await deleteGroupEverywhere("u1", "gPerso")).toEqual({ effect: "local" });
    expect(g.calls).toEqual([]);
  });
});
