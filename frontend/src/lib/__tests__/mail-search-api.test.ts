import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/pocketbase", () => ({
  getCurrentUserId: () => "u1",
}));

import { fetchMailSearchPage } from "../mail-search-api";

const okResponse = {
  items: [],
  page: 1,
  perPage: 50,
  totalItems: 0,
  totalPages: 0,
  counts: {},
  mode: "keyword",
  indexing: { ready: true, done: 0, total: 0 },
};

function mockFetch(status = 200, body: unknown = okResponse) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const sentBody = (fn: ReturnType<typeof vi.fn>) => JSON.parse(fn.mock.calls[0][1].body);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("fetchMailSearchPage", () => {
  it("envoie la requete telle quelle, sans perimetre pour la palette", async () => {
    const fn = mockFetch();
    await fetchMailSearchPage({ query: "from:alice inovi", page: 1, perPage: 200, accountId: "all" });
    expect(fn.mock.calls[0][0]).toBe("/worker/search/mail");
    expect(sentBody(fn)).toEqual({ userId: "u1", query: "from:alice inovi", page: 1, perPage: 200 });
  });

  it("transmet le perimetre du dossier et les filtres rapides", async () => {
    const fn = mockFetch();
    await fetchMailSearchPage({
      query: "inovi",
      page: 2,
      perPage: 50,
      accountId: "acc1",
      scope: {
        folderIds: ["f1", "f2"],
        excludeSecondary: true,
        isDraft: false,
        filter: { unread: true, priority: "all", fromText: " labo " },
      },
    });
    expect(sentBody(fn)).toEqual({
      userId: "u1",
      accountId: "acc1",
      query: "inovi",
      page: 2,
      perPage: 50,
      scope: {
        folderIds: ["f1", "f2"],
        excludeSecondary: true,
        isDraft: false,
        unread: true,
        fromText: "labo",
      },
    });
  });

  it("une vue virtuelle prime sur les dossiers, un dossier seul devient une liste", async () => {
    let fn = mockFetch();
    await fetchMailSearchPage({
      query: "x",
      page: 1,
      perPage: 50,
      scope: { view: "all_mail", folderIds: ["f1"], isDraft: false },
    });
    expect(sentBody(fn).scope).toEqual({ view: "all_mail", isDraft: false });

    fn = mockFetch();
    await fetchMailSearchPage({ query: "x", page: 1, perPage: 50, scope: { folderId: "f9" } });
    expect(sentBody(fn).scope).toEqual({ folderIds: ["f9"] });
  });

  it("leve une erreur quand l'index du worker est indisponible (repli appelant)", async () => {
    mockFetch(503, { error: "search index unavailable" });
    await expect(fetchMailSearchPage({ query: "x", page: 1, perPage: 50 })).rejects.toThrow("503");
  });
});
