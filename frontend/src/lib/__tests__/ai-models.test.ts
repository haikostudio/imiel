import { describe, expect, it } from "vitest";
import {
  AI_MODELS,
  DEFAULT_AI_COMPOSE_MODEL,
  costLevel,
  costLevelLabel,
  estimateReplyCents,
  formatCents,
  isAiComposeModel,
  pricedCatalog,
} from "../ai-models";

describe("catalogue des modeles du menu IA", () => {
  it("dix modeles, ids uniques, Claude Haiku 5.5 par defaut", () => {
    expect(AI_MODELS).toHaveLength(10);
    expect(new Set(AI_MODELS.map((m) => m.id)).size).toBe(10);
    expect(isAiComposeModel(DEFAULT_AI_COMPOSE_MODEL)).toBe(true);
    expect(DEFAULT_AI_COMPOSE_MODEL).toBe("anthropic/claude-haiku-5.5");
  });

  it("refuse un id hors catalogue", () => {
    expect(isAiComposeModel("openai/gpt-4o")).toBe(false);
    expect(isAiComposeModel(undefined)).toBe(false);
    expect(isAiComposeModel(42)).toBe(false);
  });

  it("cout d'une reponse : 25 000 jetons en entree + 2 000 en sortie", () => {
    expect(estimateReplyCents({ input: 0.1, output: 0.5 })).toBeCloseTo(0.35, 5);
    expect(estimateReplyCents({ input: 4, output: 20 })).toBeCloseTo(14, 5);
  });

  it("niveaux € < 1 c, €€ < 5 c, €€€ < 10 c, €€€€ au-dela", () => {
    expect(costLevel(0.35)).toBe(1);
    expect(costLevel(2.9)).toBe(2);
    expect(costLevel(7)).toBe(3);
    expect(costLevel(14)).toBe(4);
    expect(costLevelLabel(3)).toBe("€€€");
  });

  it("liste triee du moins cher au plus cher, Opus en dernier", () => {
    const list = pricedCatalog();
    for (let i = 1; i < list.length; i++) expect(list[i].cents).toBeGreaterThanOrEqual(list[i - 1].cents);
    expect(list[0].id).toBe("anthropic/claude-haiku-5.5");
    expect(list[list.length - 1].id).toBe("anthropic/claude-opus-5.5");
    expect(list.map((m) => m.level)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4]);
  });

  it("affiche ≈ 0,4 c sous le centime et un entier au-dela", () => {
    expect(formatCents(0.35, "fr")).toBe("≈ 0,4 c");
    expect(formatCents(14, "fr")).toBe("≈ 14 c");
    expect(formatCents(0.01, "fr")).toBe("≈ 0,1 c");
  });
});
