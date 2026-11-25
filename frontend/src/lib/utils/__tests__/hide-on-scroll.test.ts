import { describe, expect, it } from "vitest";
import {
  clampScrollPosition,
  initialHideOnScrollState,
  stepHideOnScroll,
  type HideOnScrollState,
} from "../hide-on-scroll";

function run(positions: number[], gesture = true, start: HideOnScrollState = initialHideOnScrollState) {
  let s = start;
  let now = 1000;
  for (const p of positions) {
    s = stepHideOnScroll(s, p, now, { gesture });
    now += 300; // au-dela du gel entre deux pas
  }
  return s;
}

describe("stepHideOnScroll", () => {
  it("reste affiche pres du haut", () => {
    expect(run([10, 30, 60]).hidden).toBe(false);
  });

  it("se replie sur une descente lente par petits pas", () => {
    const steps = Array.from({ length: 40 }, (_, i) => 60 + i * 4);
    expect(run(steps).hidden).toBe(true);
  });

  it("un retour de 5 px ne change rien, 20 px reaffichent", () => {
    const hidden = run([100, 200, 300]);
    expect(hidden.hidden).toBe(true);
    expect(run([295], true, hidden).hidden).toBe(true);
    expect(run([296, 292, 288, 284, 280], true, hidden).hidden).toBe(false);
  });

  it("hors geste, recale la reference sans basculer", () => {
    const s = run([100, 400], false);
    expect(s.hidden).toBe(false);
    expect(s.ref).toBe(400);
  });

  it("gele la decision juste apres une bascule (recul du au repli)", () => {
    let s = stepHideOnScroll(initialHideOnScrollState, 100, 0, { gesture: true });
    s = stepHideOnScroll(s, 200, 10, { gesture: true });
    expect(s.hidden).toBe(true);
    // La zone grandit, la position recule de 120 px en bas de liste : ignore.
    s = stepHideOnScroll(s, 80, 50, { gesture: true });
    expect(s.hidden).toBe(true);
    expect(s.ref).toBe(80);
  });

  it("revient toujours en haut, meme gele", () => {
    let s = stepHideOnScroll(initialHideOnScrollState, 100, 0, { gesture: true });
    s = stepHideOnScroll(s, 200, 10, { gesture: true });
    s = stepHideOnScroll(s, 0, 20, { gesture: false });
    expect(s.hidden).toBe(false);
  });
});

describe("clampScrollPosition", () => {
  it("ignore le rebond elastique", () => {
    expect(clampScrollPosition(-30, 2000, 800)).toBe(0);
    expect(clampScrollPosition(1300, 2000, 800)).toBe(1200);
  });
});
