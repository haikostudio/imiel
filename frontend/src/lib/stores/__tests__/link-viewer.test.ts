import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOutsideApp, useLinkViewer } from "@/lib/stores/link-viewer";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";

let hrefSet: string[] = [];
let visibility: DocumentVisibilityState = "visible";

function setUa(ua: string) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  hrefSet = [];
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
  // jsdom ne navigue pas : on espionne l'affectation de location.href.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      set href(v: string) {
        hrefSet.push(v);
      },
      get href() {
        return "https://imiel.example.com/#/mail/inbox";
      },
    },
  });
  useLinkViewer.getState().close();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("openOutsideApp", () => {
  it("iPhone : ouvre Safari par x-safari-https, sans repli si l'app passe en arriere-plan", () => {
    setUa(IPHONE_UA);
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    openOutsideApp("https://immo-newsletter.example.com/news");
    expect(hrefSet).toEqual(["x-safari-https://immo-newsletter.example.com/news"]);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1000);
    expect(open).not.toHaveBeenCalled();
    expect(useLinkViewer.getState().url).toBeNull();
  });

  it("iPhone : schema ignore (page restee visible) -> repli window.open", () => {
    setUa(IPHONE_UA);
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    openOutsideApp("https://exemple.com/a");
    vi.advanceTimersByTime(1000);
    expect(open).toHaveBeenCalledWith("https://exemple.com/a", "_blank");
    expect(useLinkViewer.getState().url).toBeNull();
  });

  it("ouverture refusee partout -> tiroir avec bouton (kind external)", () => {
    setUa(IPHONE_UA);
    vi.spyOn(window, "open").mockReturnValue(null);
    openOutsideApp("https://exemple.com/a");
    vi.advanceTimersByTime(1000);
    expect(useLinkViewer.getState()).toMatchObject({ url: "https://exemple.com/a", kind: "external" });
  });

  it("Android : navigateur systeme tout de suite, pas de schema Safari", () => {
    setUa(ANDROID_UA);
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    openOutsideApp("https://exemple.com/a");
    expect(hrefSet).toEqual([]);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
