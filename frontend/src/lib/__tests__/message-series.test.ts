import { describe, expect, it } from "vitest";
import { computeSeriesContinuations, type SeriesEntry } from "@/lib/utils/message-series";

const msg = (id: string, sender: string, date: string, open = true): SeriesEntry => ({
  kind: "message",
  id,
  sender,
  date,
  open,
});

describe("computeSeriesContinuations", () => {
  it("regroupe les messages qui se suivent d'une meme adresse le meme jour", () => {
    const result = computeSeriesContinuations([
      msg("c", "anne@exemple.fr", "2026-10-16T15:00:00"),
      msg("b", "ANNE@exemple.fr", "2026-10-16T11:00:00"),
      msg("a", "anne@exemple.fr", "2026-10-16T09:00:00"),
    ]);
    expect([...result]).toEqual(["b", "a"]);
  });

  it("coupe la serie au changement d'adresse, meme entre deux adresses de l'utilisateur", () => {
    const result = computeSeriesContinuations([
      msg("c", "hello@immo-example.app", "2026-10-16T15:00:00"),
      msg("b", "hey@sante-example.app", "2026-10-16T14:00:00"),
      msg("a", "hey@sante-example.app", "2026-10-16T13:00:00"),
    ]);
    expect([...result]).toEqual(["a"]);
  });

  it("coupe la serie au changement de jour", () => {
    const result = computeSeriesContinuations([
      msg("b", "anne@exemple.fr", "2026-10-16T09:00:00"),
      msg("a", "anne@exemple.fr", "2026-10-15T18:00:00"),
    ]);
    expect(result.size).toBe(0);
  });

  it("coupe la serie a un brouillon ou a l'indicateur de messages replies", () => {
    const result = computeSeriesContinuations([
      msg("c", "anne@exemple.fr", "2026-10-16T15:00:00"),
      { kind: "break" },
      msg("b", "anne@exemple.fr", "2026-10-16T11:00:00"),
      msg("a", "anne@exemple.fr", "2026-10-16T09:00:00"),
    ]);
    expect([...result]).toEqual(["a"]);
  });

  it("un message replie garde son avatar mais peut ouvrir une serie", () => {
    const result = computeSeriesContinuations([
      msg("c", "anne@exemple.fr", "2026-10-16T15:00:00"),
      msg("b", "anne@exemple.fr", "2026-10-16T11:00:00", false),
      msg("a", "anne@exemple.fr", "2026-10-16T09:00:00"),
    ]);
    expect([...result]).toEqual(["a"]);
  });

  it("ignore les adresses ou dates absentes", () => {
    const result = computeSeriesContinuations([
      msg("b", "", "2026-10-16T15:00:00"),
      msg("a", "", "2026-10-16T11:00:00"),
      msg("y", "anne@exemple.fr", "pas une date"),
      msg("x", "anne@exemple.fr", "pas une date"),
    ]);
    expect(result.size).toBe(0);
  });
});
