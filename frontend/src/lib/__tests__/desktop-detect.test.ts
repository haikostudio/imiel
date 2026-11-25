import { afterEach, describe, expect, it } from "vitest";
import { detectOs, isDesktopApp, isNativeShell } from "@/lib/desktop";

// User agents reels : Safari/Chrome sur Mac et Windows, et la vue web de
// l'application iPhone iMiel lancee sur un Mac Apple Silicon (elle annonce
// "Macintosh" + le suffixe iMielApp/ de capacitor.config.json).
const UA = {
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  iphoneAppOnMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) iMielApp/1",
  iphoneApp:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 iMielApp/1",
};

function setNavigator(ua: string, platform: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
}

type W = Record<string, unknown>;
afterEach(() => {
  delete (window as unknown as W).Capacitor;
  delete (window as unknown as W).__IMIEL_DESKTOP__;
});

describe("proposition de l'app de bureau", () => {
  it("navigateur ordinaire sur Mac : propose la version Mac", () => {
    setNavigator(UA.safariMac, "MacIntel");
    expect(isNativeShell()).toBe(false);
    expect(detectOs()).toBe("mac");
  });

  it("navigateur ordinaire sur Windows : propose la version Windows", () => {
    setNavigator(UA.chromeWin, "Win32");
    expect(detectOs()).toBe("windows");
  });

  it("app iPhone lancee sur un Mac (user agent iMielApp/) : rien a proposer", () => {
    setNavigator(UA.iphoneAppOnMac, "MacIntel");
    expect(isNativeShell()).toBe(true);
    expect(detectOs()).toBe("unknown");
  });

  it("app iPhone reconnue par window.Capacitor meme sans le suffixe", () => {
    setNavigator(UA.safariMac, "MacIntel");
    (window as unknown as W).Capacitor = { isNativePlatform: () => true };
    expect(detectOs()).toBe("unknown");
  });

  it("app iPhone sur iPhone : rien a proposer", () => {
    setNavigator(UA.iphoneApp, "iPhone");
    expect(detectOs()).toBe("unknown");
  });

  it("app de bureau (Tauri) : rien a proposer", () => {
    setNavigator(UA.safariMac, "MacIntel");
    (window as unknown as W).__IMIEL_DESKTOP__ = true;
    expect(isDesktopApp()).toBe(true);
    expect(detectOs()).toBe("unknown");
  });
});
