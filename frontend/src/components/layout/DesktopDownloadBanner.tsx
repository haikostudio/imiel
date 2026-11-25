"use client";

import { useEffect, useState } from "react";
import { Download, X, Monitor } from "lucide-react";
import { hashNavigate } from "@/lib/hash-router";
import { useT } from "@/lib/i18n";
import {
  detectOs,
  isDesktopApp,
  osLabel,
  fetchLatestRelease,
  downloadUrl,
  type DetectedOs,
} from "@/lib/desktop";

const DISMISS_KEY = "imiel:desktopBannerDismissed";

/**
 * Banniere globale (haut de l'app) qui propose de telecharger l'application de
 * bureau. Masquee si : on tourne deja dans l'app de bureau, l'utilisateur l'a
 * fermee, aucune Release n'est disponible, ou OS non desktop (mobile).
 */
export function DesktopDownloadBanner() {
  const t = useT();
  const [show, setShow] = useState(false);
  const [os, setOs] = useState<DetectedOs>("unknown");

  useEffect(() => {
    if (isDesktopApp()) return;
    if (localStorage.getItem(DISMISS_KEY) === "1") return;
    const detected = detectOs();
    if (detected === "unknown") return;
    let alive = true;
    fetchLatestRelease().then((rel) => {
      if (!alive) return;
      const list = rel.available ? rel.assets?.[detected] : undefined;
      if (rel.available && list && list.length > 0) {
        setOs(detected);
        setShow(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!show || os === "unknown") return null;

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    setShow(false);
  }

  return (
    <div
      data-ref="desktop-download-banner"
      className="flex w-full items-center gap-3 border-b border-border bg-muted px-4 py-2 text-sm text-foreground"
    >
      <Monitor className="size-4 shrink-0" />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{t("desktop.bannerTitle")}</span>
        <span className="hidden sm:inline">
          {" "}
          {t("desktop.bannerSubtitle", { os: osLabel(os) })}
        </span>
      </p>
      <a
        href={downloadUrl(os)}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        <Download className="size-3.5" />
        {t("desktop.bannerDownload", { os: osLabel(os) })}
      </a>
      <button
        type="button"
        onClick={() => {
          dismiss();
          hashNavigate("/settings?tab=desktop");
        }}
        className="hidden shrink-0 text-xs underline underline-offset-2 opacity-90 hover:opacity-100 md:inline"
      >
        {t("desktop.bannerOther")}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("desktop.bannerDismiss")}
        className="shrink-0 rounded p-1 opacity-80 hover:opacity-100"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
