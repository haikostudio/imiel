import { describe, it, expect } from "vitest";
import { cn } from "../utils";

describe("cn", () => {
  it("combine des classes simples", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("gere les valeurs conditionnelles", () => {
    expect(cn("foo", false && "bar", "baz")).toBe("foo baz");
  });

  it("fusionne les classes Tailwind conflictuelles", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("gere undefined et null", () => {
    expect(cn("foo", undefined, null, "bar")).toBe("foo bar");
  });

  it("retourne une chaine vide sans arguments", () => {
    expect(cn()).toBe("");
  });

  it("gere les tableaux", () => {
    expect(cn(["foo", "bar"])).toBe("foo bar");
  });
});
