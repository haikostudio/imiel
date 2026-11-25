import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";

process.env.AI_BUDGET_STATE_PATH = path.join(os.tmpdir(), `ai-budget-test-${process.pid}.json`);
process.env.AI_DAILY_BUDGET_USD = "1";

import {
  __resetForTests,
  aiFetch,
  getBudgetStatus,
  nextParisMidnight,
  parisDay,
  recordSpend,
  runAsManual,
  setLimitUsd,
} from "./ai-budget";

function okResponse(cost: number) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { cost, total_tokens: 10 } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("ai-budget", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    __resetForTests({ day: parisDay(), totalUsd: 0, limitUsd: null, bySource: {} });
    fetchMock = vi.fn(async () => okResponse(0.3));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("demande le cout a OpenRouter et additionne la depense par source", async () => {
    const res = await aiFetch("categorize", { method: "POST", body: JSON.stringify({ model: "m" }) });
    expect(res.ok).toBe(true);
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.usage).toEqual({ include: true });
    const st = getBudgetStatus();
    expect(st.spentUsd).toBeCloseTo(0.3);
    expect(st.bySource.categorize.calls).toBe(1);
  });

  it("refuse les appels automatiques une fois le plafond atteint, sans appeler le fournisseur", async () => {
    recordSpend("tracking-pick", 1.02);
    const res = await aiFetch("categorize", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getBudgetStatus().exceeded).toBe(true);
    expect(getBudgetStatus().bySource.categorize.blocked).toBe(1);
  });

  it("laisse passer une action demandee a la main", async () => {
    recordSpend("tracking-pick", 5);
    const res = await runAsManual(() => aiFetch("tracking-extract", { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("le plafond se regle, et null revient au defaut", () => {
    recordSpend("x", 0.5);
    setLimitUsd(0.1);
    expect(getBudgetStatus().exceeded).toBe(true);
    setLimitUsd(null);
    expect(getBudgetStatus().limitUsd).toBe(1);
    expect(getBudgetStatus().exceeded).toBe(false);
  });

  it("la depense repart a zero un autre jour", () => {
    __resetForTests({ day: "2000-01-01", totalUsd: 9, limitUsd: 2, bySource: {} });
    const st = getBudgetStatus();
    expect(st.spentUsd).toBe(0);
    expect(st.limitUsd).toBe(2);
  });

  it("calcule le prochain minuit de Paris", () => {
    const now = new Date("2026-09-16T20:30:00Z"); // 22h30 a Paris (UTC+2)
    expect(nextParisMidnight(now).toISOString()).toBe("2026-09-16T22:00:00.000Z");
  });
});
