import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatRelativeDate,
  formatTimeAgo,
  formatFullDate,
  formatShortDate,
} from "../date";

describe("formatRelativeDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T14:30:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("affiche 'Aujourd'hui HH:mm' pour une date du jour", () => {
    const result = formatRelativeDate("2025-06-15T10:32:00Z");
    expect(result).toContain("Aujourd'hui");
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it("affiche 'Hier HH:mm' pour une date d'hier", () => {
    const result = formatRelativeDate("2025-06-14T16:42:00Z");
    expect(result).toContain("Hier");
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it("affiche jour + mois pour une date cette annee", () => {
    const result = formatRelativeDate("2025-03-10T08:00:00Z");
    expect(result).toMatch(/\d+/);
    expect(result).toMatch(/mars/i);
  });

  it("affiche jour + mois + annee pour une annee precedente", () => {
    const result = formatRelativeDate("2024-02-23T12:00:00Z");
    expect(result).toContain("2024");
  });

  it("accepte un objet Date", () => {
    const date = new Date("2025-06-15T09:00:00Z");
    const result = formatRelativeDate(date);
    expect(result).toContain("Aujourd'hui");
  });
});

describe("formatTimeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T14:30:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retourne 'a l'instant' pour < 1 min", () => {
    const result = formatTimeAgo("2025-06-15T14:29:30Z");
    expect(result).toBe("à l'instant");
  });

  it("retourne 'il y a X min' pour < 60 min", () => {
    const result = formatTimeAgo("2025-06-15T14:00:00Z");
    expect(result).toBe("il y a 30 min");
  });

  it("retourne 'il y a Xh' pour < 24h", () => {
    const result = formatTimeAgo("2025-06-15T10:30:00Z");
    expect(result).toBe("il y a 4h");
  });

  it("retourne 'il y a Xj' pour < 7j", () => {
    const result = formatTimeAgo("2025-06-13T14:30:00Z");
    expect(result).toBe("il y a 2j");
  });

  it("utilise formatDistanceToNow pour > 7j", () => {
    const result = formatTimeAgo("2025-05-01T14:30:00Z");
    expect(result).toContain("il y a");
  });

  it("accepte un objet Date", () => {
    const date = new Date("2025-06-15T14:29:30Z");
    const result = formatTimeAgo(date);
    expect(result).toBe("à l'instant");
  });
});

describe("formatFullDate", () => {
  it("retourne la date complete en francais", () => {
    const result = formatFullDate("2025-02-23T14:32:00Z");
    expect(result).toContain("2025");
    // L'heure depend du fuseau horaire local, on verifie juste le format
    expect(result).toMatch(/\d{2}:\d{2}/);
    expect(result).toContain("février");
  });

  it("accepte un objet Date", () => {
    const date = new Date("2025-01-01T09:00:00Z");
    const result = formatFullDate(date);
    expect(result).toContain("2025");
  });
});

describe("formatShortDate", () => {
  it("retourne le format dd/MM", () => {
    const result = formatShortDate("2025-02-23T00:00:00Z");
    expect(result).toBe("23/02");
  });

  it("retourne le format dd/MM pour le 1er janvier", () => {
    const result = formatShortDate("2025-01-01T00:00:00Z");
    expect(result).toBe("01/01");
  });

  it("accepte un objet Date", () => {
    const date = new Date("2025-12-25T00:00:00Z");
    const result = formatShortDate(date);
    expect(result).toBe("25/12");
  });
});
