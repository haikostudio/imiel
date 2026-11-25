import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  buildFtsMatch,
  ftsPhrase,
  hasSearchCriterion,
  isSimpleQuery,
  normalizeSearchDate,
  parseSearchQuery,
  splitSearchTerms,
} from "./search-query";

// Jeu de cas COMMUN, joue a l'identique par le frontend (meme analyseur).
const CASES = JSON.parse(
  readFileSync(join(__dirname, "search-query.cases.json"), "utf8")
) as Array<{ q: string; expect: Record<string, unknown> }>;

describe("parseSearchQuery (jeu de cas commun)", () => {
  for (const c of CASES) {
    it(c.q, () => {
      const p = parseSearchQuery(c.q) as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(c.expect)) expect(p[k]).toEqual(v);
    });
  }
});

describe("parseSearchQuery", () => {
  it("garde un mot contenant ':' qui n'est pas un operateur", () => {
    expect(parseSearchQuery("inovi:").freeText).toBe("inovi:");
  });

  it("accepte une valeur entre guillemets", () => {
    expect(parseSearchQuery('subject:"compte rendu"').subject).toEqual(["compte rendu"]);
  });

  it("une requete faite de filtres seuls a un critere", () => {
    expect(hasSearchCriterion(parseSearchQuery("is:unread"))).toBe(true);
    expect(hasSearchCriterion(parseSearchQuery('""'))).toBe(false);
  });
});

describe("normalizeSearchDate", () => {
  it("accepte les formats francais et rejette les dates inexistantes", () => {
    expect(normalizeSearchDate("1/2/2025")).toBe("2025-02-01");
    expect(normalizeSearchDate("2025-04-31")).toBeNull();
    expect(normalizeSearchDate("2023-02-29")).toBeNull();
    expect(normalizeSearchDate("2025-1-1x")).toBeNull();
  });
});

describe("splitSearchTerms", () => {
  it("garde tous les mots saisis, meme les plus courants", () => {
    expect(splitSearchTerms("contact document projet")).toEqual(["contact", "document", "projet"]);
  });

  it("ecarte les termes sans lettre ni chiffre et les doublons", () => {
    expect(splitSearchTerms("@ - inovi INOVI")).toEqual(["inovi"]);
  });

  it("ecarte un terme d'une lettre sauf s'il est seul", () => {
    expect(splitSearchTerms("a inovi")).toEqual(["inovi"]);
    expect(splitSearchTerms("a")).toEqual(["a"]);
  });
});

describe("buildFtsMatch", () => {
  it("fait de chaque mot un debut de mot, tous requis", () => {
    expect(buildFtsMatch({ terms: ["inovi", "labo"] })).toBe('"inovi"* AND "labo"*');
  });

  it("mot entier quand prefix=false (chat IA, suivi)", () => {
    expect(buildFtsMatch({ terms: ["atelier60"], prefix: false })).toBe('"atelier60"');
  });

  it("neutralise la syntaxe FTS5 saisie par l'utilisateur", () => {
    expect(ftsPhrase('in"ovi', true)).toBe('"in ovi"*');
    expect(buildFtsMatch({ terms: ["AND", "(inovi", "-x1", "a*b"] })).toBe(
      '"AND"* AND "(inovi"* AND "-x1"* AND "a*b"*'
    );
  });

  it("restreint from:/to:/subject: a leur colonne", () => {
    expect(buildFtsMatch({ terms: [], from: "jean dupont", subject: "facture" })).toBe(
      'sender : "jean"* AND sender : "dupont"* AND subject : "facture"*'
    );
    expect(buildFtsMatch({ terms: ["devis"], to: "bob@x.fr" })).toBe(
      '"devis"* AND recipients : "bob@x.fr"*'
    );
  });

  it("plusieurs from: = l'un OU l'autre, plusieurs subject: = tous", () => {
    expect(buildFtsMatch({ terms: [], from: ["alice", "bob dupont"] })).toBe(
      '((sender : "alice"*) OR (sender : "bob"* AND sender : "dupont"*))'
    );
    expect(buildFtsMatch({ terms: [], subject: ["devis", "mars"] })).toBe(
      'subject : "devis"* AND subject : "mars"*'
    );
  });

  it("rend une expression vide quand il n'y a rien a chercher", () => {
    expect(buildFtsMatch({ terms: [] })).toBe("");
    expect(buildFtsMatch({ terms: ["@"] })).toBe("");
  });
});

describe("isSimpleQuery", () => {
  it("mot-cle, nom ou adresse = simple ; question = pertinence", () => {
    expect(isSimpleQuery("inovi")).toBe(true);
    expect(isSimpleQuery("facture edf mars")).toBe(true);
    expect(isSimpleQuery("quel est le dernier mail de Boris ?")).toBe(false);
    expect(isSimpleQuery("resume moi les echanges avec le notaire")).toBe(false);
  });
});
