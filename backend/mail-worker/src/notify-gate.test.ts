import { beforeEach, describe, expect, it, vi } from "vitest";

// Garde anti double notification branchee dans maybeNotifyNewMail : une copie
// tardive n'ecrit ni activite ni push ; une copie unique notifie comme avant.
const state = vi.hoisted(() => ({ laterCopy: false, notify: "" }));
const { copyCheck, push, activity } = vi.hoisted(() => ({
  copyCheck: vi.fn(async (..._args: unknown[]) => state.laterCopy),
  push: vi.fn(async (..._args: unknown[]) => undefined),
  activity: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("./pocketbase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pocketbase")>();
  return {
    ...actual,
    isLaterCopyOfMailOnOtherAccount: copyCheck,
    getUserNotificationsEnabled: vi.fn(async () => true),
    getImportanceContext: vi.fn(async () => ({ rules: [], examples: [], notify: state.notify })),
  };
});
vi.mock("./push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./push")>();
  return { ...actual, sendNewEmailNotification: push };
});
vi.mock("./activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./activity")>();
  return { ...actual, logNewMailActivity: activity };
});
vi.mock("./labels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./labels")>();
  return { ...actual, hasAnySecondaryLabel: vi.fn(async () => false) };
});

import { maybeNotifyNewMail } from "./imap";

describe("maybeNotifyNewMail - copies sur plusieurs comptes", () => {
  beforeEach(() => {
    state.laterCopy = false;
    state.notify = "";
    copyCheck.mockClear();
    push.mockClear();
    activity.mockClear();
  });

  it("copie tardive : ni push ni activite", async () => {
    state.laterCopy = true;
    await maybeNotifyNewMail("u1", "PayPal", "Recu", "gmail", "rec2", [], "t1", "a@b.c", "<x@y>");
    expect(copyCheck).toHaveBeenCalledWith("u1", "rec2", "<x@y>");
    expect(push).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  });

  it("premiere copie : push + activite", async () => {
    await maybeNotifyNewMail("u1", "PayPal", "Recu", "salut", "rec1", [], "t1", "a@b.c", "<x@y>");
    expect(push).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenCalledTimes(1);
  });
});

describe("maybeNotifyNewMail - niveau d'importance", () => {
  beforeEach(() => {
    state.laterCopy = false;
    state.notify = "";
    push.mockClear();
    activity.mockClear();
  });

  it("peu utile : activite gardee, aucun push (reglage par defaut)", async () => {
    await maybeNotifyNewMail("u1", "Promo", "Soldes", "salut", "m1", [], "t1", "p@shop.fr", "<a@b>", "low");
    expect(activity).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("important et secondaire sonnent par defaut", async () => {
    await maybeNotifyNewMail("u1", "Client", "Devis", "salut", "m2", [], "t2", "c@client.fr", "<c@d>", "important");
    await maybeNotifyNewMail("u1", "TestFlight", "Build", "salut", "m3", [], "t3", "t@apple.com", "<e@f>", "secondary");
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("reglage 'important' : le secondaire se tait", async () => {
    state.notify = "important";
    await maybeNotifyNewMail("u1", "TestFlight", "Build", "salut", "m4", [], "t4", "t@apple.com", "<g@h>", "secondary");
    expect(push).not.toHaveBeenCalled();
  });
});
