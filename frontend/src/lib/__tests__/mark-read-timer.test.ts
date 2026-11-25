import { describe, it, expect, vi, afterEach } from "vitest";
import {
  scheduleMarkRead,
  cancelPendingMarkRead,
  flushPendingMarkRead,
  flushMarkReadOnContentClick,
  hasPendingMarkRead,
} from "../mark-read-timer";

afterEach(() => {
  cancelPendingMarkRead();
  vi.useRealTimers();
});

describe("flushPendingMarkRead", () => {
  it("execute tout de suite le marquage en attente, une seule fois", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    scheduleMarkRead("thread:a", 5, run);
    flushPendingMarkRead();
    expect(run).toHaveBeenCalledTimes(1);
    expect(hasPendingMarkRead()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ne fait rien sans marquage en attente", () => {
    const run = vi.fn();
    scheduleMarkRead("thread:a", 5, run);
    cancelPendingMarkRead();
    flushPendingMarkRead();
    expect(run).not.toHaveBeenCalled();
  });

  it("un clic sur un bouton ne passe pas en lu, un clic sur le texte oui", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    scheduleMarkRead("thread:a", 5, run);
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.appendChild(icon);
    flushMarkReadOnContentClick({ target: icon });
    expect(run).not.toHaveBeenCalled();
    const text = document.createElement("p");
    flushMarkReadOnContentClick({ target: text });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
