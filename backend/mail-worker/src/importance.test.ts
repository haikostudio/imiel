import { describe, expect, it } from "vitest";
import {
  decideImportance,
  heuristicImportance,
  importanceAllowsNotification,
  matchImportanceRule,
  parseImportance,
} from "./importance";
import { parseResult } from "./categorizer";
import { noReasoning, backgroundModel, DEFAULT_BACKGROUND_MODEL } from "./ai-models";

describe("parseImportance / parseResult", () => {
  it("lit le JSON de production (categories + niveau)", () => {
    const r = parseResult('{"categories":["Travail","Facture"],"importance":"important"}');
    expect(r).toEqual({ categories: ["Travail", "Facture"], importance: "important" });
  });
  it("tolere le bloc de code et les synonymes", () => {
    expect(parseResult('```json\n{"categories":["Promotion"],"importance":"LOW"}\n```')?.importance).toBe("low");
    expect(parseImportance('{"importance":"secondaire"}')).toBe("secondary");
    expect(parseImportance('{"importance":"high"}')).toBe("important");
  });
  it("niveau absent ou inconnu => null, categories gardees", () => {
    expect(parseResult('{"categories":["Travail"]}')).toEqual({ categories: ["Travail"], importance: null });
    expect(parseImportance('{"importance":"bof"}')).toBeNull();
  });
  it("JSON casse : repli par expression reguliere", () => {
    const r = parseResult('{"categories": ["Newsletter"], "importance": "low"');
    expect(r?.categories).toEqual(["Newsletter"]);
    expect(r?.importance).toBe("low");
  });
});

describe("heuristicImportance (repli sans IA)", () => {
  it("expediteur a qui on a deja ecrit => important", () => {
    expect(heuristicImportance({ fromAddress: "benoit@client.com", sentToCount: 3 })).toBe("important");
  });
  it("rendez-vous et factures => important", () => {
    expect(heuristicImportance({ fromAddress: "no-reply@doctolib.fr", subject: "Votre rendez-vous demain", sentToCount: 0 })).toBe("important");
    expect(heuristicImportance({ fromAddress: "noreply@ebill.ch", subject: "Nouvelle facture", sentToCount: 0 })).toBe("important");
  });
  it("envoi de masse (desabonnement) ou newsletter => low", () => {
    expect(heuristicImportance({ fromAddress: "newsletter@ia-newsletter.example.com", sentToCount: 0 })).toBe("low");
    expect(heuristicImportance({ fromAddress: "x@shop.fr", sentToCount: 0, listUnsubscribe: true })).toBe("low");
  });
  it("notifications pro automatiques => secondary", () => {
    expect(heuristicImportance({ fromAddress: "testflight_no_reply@email.apple.com", sentToCount: 0 })).toBe("secondary");
    expect(heuristicImportance({ fromAddress: "noreply@github.com", sentToCount: 0 })).toBe("secondary");
    expect(heuristicImportance({ fromAddress: "nobody@mozilla.org", sentToCount: 0 })).toBe("secondary");
  });
  it("le recap envoye par l'utilisateur lui-meme => important", () => {
    expect(heuristicImportance({ fromAddress: "contact@studio.example.com", sentToCount: 0, fromSelf: true })).toBe("important");
  });
});

describe("decideImportance (ordre de decision)", () => {
  const rules = [
    { match_type: "domain" as const, match_value: "apple.com", importance: "low" as const },
    { match_type: "email" as const, match_value: "testflight_no_reply@email.apple.com", importance: "important" as const },
  ];
  it("la regle expediteur prime sur l'IA, l'adresse exacte sur le domaine", () => {
    expect(decideImportance({ rules, fromAddress: "testflight_no_reply@email.apple.com", sentToCount: 0, ai: "low" })).toEqual({ importance: "important", source: "rule" });
    expect(decideImportance({ rules, fromAddress: "no_reply@email.apple.com", sentToCount: 0, ai: "secondary" })).toEqual({ importance: "low", source: "rule" });
  });
  it("jamais low pour un correspondant a qui on a ecrit", () => {
    expect(decideImportance({ rules: [], fromAddress: "a@b.c", sentToCount: 2, ai: "low" })).toEqual({ importance: "secondary", source: "ai" });
  });
  it("IA absente => repli heuristique", () => {
    expect(decideImportance({ rules: [], fromAddress: "newsletter@x.io", sentToCount: 0, ai: null })).toEqual({ importance: "low", source: "heuristic" });
  });
  it("matchImportanceRule accepte les sous-domaines", () => {
    expect(matchImportanceRule(rules, "News@InsideApple.Apple.com")?.importance).toBe("low");
    expect(matchImportanceRule(rules, "x@notapple.com")).toBeNull();
  });
});

describe("importanceAllowsNotification", () => {
  it("defaut : importants et secondaires sonnent, peu utiles non", () => {
    expect(importanceAllowsNotification("important", "")).toBe(true);
    expect(importanceAllowsNotification("secondary", null)).toBe(true);
    expect(importanceAllowsNotification("low", undefined)).toBe(false);
  });
  it("reglage important seulement / tout", () => {
    expect(importanceAllowsNotification("secondary", "important")).toBe(false);
    expect(importanceAllowsNotification("low", "all")).toBe(true);
  });
  it("niveau inconnu : on ne tait jamais par erreur", () => {
    expect(importanceAllowsNotification(null, "important")).toBe(true);
  });
});

describe("ai-models", () => {
  it("variable dediee > OPENROUTER_MODEL_BACKGROUND > defaut ; jamais OPENROUTER_MODEL", () => {
    const saved = { ...process.env };
    process.env.OPENROUTER_MODEL = "chat/model";
    delete process.env.OPENROUTER_MODEL_BACKGROUND;
    delete process.env.OPENROUTER_MODEL_TRACKING;
    expect(backgroundModel("OPENROUTER_MODEL_TRACKING")).toBe(DEFAULT_BACKGROUND_MODEL);
    process.env.OPENROUTER_MODEL_BACKGROUND = "bg/model";
    expect(backgroundModel("OPENROUTER_MODEL_TRACKING")).toBe("bg/model");
    process.env.OPENROUTER_MODEL_TRACKING = "dedie/model";
    expect(backgroundModel("OPENROUTER_MODEL_TRACKING")).toBe("dedie/model");
    process.env = saved;
  });
  it("coupe le raisonnement des modeles qui en ont un", () => {
    expect(noReasoning("tencent/hy4-flash")).toEqual({ reasoning: { enabled: false } });
    expect(noReasoning("deepseek/deepseek-chat-v3-0324")).toEqual({});
  });
});
