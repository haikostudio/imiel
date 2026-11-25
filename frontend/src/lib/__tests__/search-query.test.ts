/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import {
  EMPTY_CHIPS,
  buildPocketBaseSearchFilter,
  composeSearchQuery,
  parseSearchQuery,
  splitChipsFromQuery,
} from "../search-query";
// Analyseur partage avec le worker (sous-projet voisin) : meme bloc de code,
// meme jeu de cas. Lecture par Vite (?raw), aucune lecture disque.
import CASES_JSON from "../../../../backend/mail-worker/src/search-query.cases.json";
import WORKER_SRC from "../../../../backend/mail-worker/src/search-query.ts?raw";
import FRONT_SRC from "../search-query.ts?raw";

const CASES = CASES_JSON as Array<{ q: string; expect: Record<string, unknown> }>;

function sharedBlock(s: string): string {
  const a = s.indexOf("// --- BEGIN SHARED PARSER");
  const b = s.indexOf("// --- END SHARED PARSER ---");
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return s.slice(a, b);
}

describe("analyseur de recherche partage avec le worker", () => {
  it("le bloc est identique des deux cotes", () => {
    const front = sharedBlock(FRONT_SRC);
    const worker = sharedBlock(WORKER_SRC);
    expect(front).toBe(worker);
  });

  for (const c of CASES) {
    it(c.q, () => {
      const p = parseSearchQuery(c.q) as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(c.expect)) expect(p[k]).toEqual(v);
    });
  }
});

describe("pastilles <-> requete", () => {
  it("les pastilles deviennent des operateurs valides", () => {
    const q = composeSearchQuery(
      { ...EMPTY_CHIPS, unread: true, attachment: true, from: "Paul Dupont", after: "2025-03-01" },
      "  devis "
    );
    expect(q).toBe('is:unread has:attachment from:"Paul Dupont" after:2025-03-01 devis');
    expect(parseSearchQuery(q).errors).toEqual([]);
    expect(parseSearchQuery(q).from).toEqual(["Paul Dupont"]);
  });

  it("une recherche recente (ancien format texte) se redecoupe", () => {
    const { chips, text } = splitChipsFromQuery("facture is:starred from:edf.fr to:moi after:01/02/2025");
    expect(chips).toEqual({ ...EMPTY_CHIPS, starred: true, from: "edf.fr", after: "2025-02-01" });
    expect(text).toBe("facture to:moi");
    expect(splitChipsFromQuery("reunion budget")).toEqual({ chips: EMPTY_CHIPS, text: "reunion budget" });
  });

  it("une operation en erreur reste dans le texte", () => {
    expect(splitChipsFromQuery("after:2025-02-30").text).toBe("after:2025-02-30");
  });
});

describe("repli PocketBase", () => {
  it("dates au format espace, from multiples en OU", () => {
    const f = buildPocketBaseSearchFilter(parseSearchQuery("from:a from:b before:2025-01-31"), null);
    expect(f).toBe('(from_address ~ "a" || from_address ~ "b") && date <= "2025-01-31 23:59:59.999Z"');
  });

  it("une requete en erreur ne ramene rien", () => {
    expect(buildPocketBaseSearchFilter(parseSearchQuery("has:pdf"), "acc")).toBe(
      'id = "__invalid_search__"'
    );
  });
});
