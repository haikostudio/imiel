"use client";

import { useEffect, useState } from "react";
import { Download, Monitor, Apple, Loader2, CheckCircle2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import {
  fetchLatestRelease,
  downloadUrl,
  detectOs,
  isDesktopApp,
  formatBytes,
  type LatestReleaseInfo,
  type DesktopPlatform,
} from "@/lib/desktop";

const PLATFORMS: {
  id: DesktopPlatform;
  label: string;
  icon: typeof Monitor;
}[] = [
  { id: "windows", label: "Windows", icon: Monitor },
  { id: "mac", label: "macOS", icon: Apple },
  { id: "linux", label: "Linux", icon: Monitor },
];

export default function DesktopSettings() {
  const t = useT();
  const [rel, setRel] = useState<LatestReleaseInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const myOs = detectOs();
  const inApp = isDesktopApp();

  useEffect(() => {
    fetchLatestRelease()
      .then(setRel)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div data-ref="settings-desktop" className="space-y-8">
      <div>
        <h3 className="text-lg font-medium">{t("settings.desktop")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("desktop.intro")}
        </p>
      </div>

      {inApp && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          <CheckCircle2 className="size-4 shrink-0 text-primary" />
          <span>{t("desktop.alreadyInApp")}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("loading")}
        </div>
      ) : !rel?.available ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          {t("desktop.notAvailable")}
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {PLATFORMS.map(({ id, label, icon: Icon }) => {
              const assets = rel.assets?.[id] ?? [];
              const has = assets.length > 0;
              const primary = assets[0];
              const isMine = id === myOs;
              return (
                <div
                  key={id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Icon className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {label}
                        {isMine && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                            {t("desktop.yourSystem")}
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {has
                          ? `${primary.kind.toUpperCase()}${
                              primary.size
                                ? ` · ${formatBytes(primary.size)}`
                                : ""
                            }`
                          : t("desktop.platformUnavailable")}
                      </p>
                    </div>
                  </div>
                  <Button
                    asChild={has}
                    size="sm"
                    variant={isMine ? "default" : "outline"}
                    disabled={!has}
                  >
                    {has ? (
                      <a href={downloadUrl(id)} download>
                        <Download className="size-4" />
                        {t("desktop.download")}
                      </a>
                    ) : (
                      <span>
                        <Download className="size-4" />
                        {t("desktop.download")}
                      </span>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>

          <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            <p className="flex items-center gap-1.5 font-medium">
              <ShieldAlert className="size-3.5 shrink-0 text-amber-500" />
              {t("desktop.securityTitle")}
            </p>
            <p className="text-muted-foreground">{t("desktop.securityIntro")}</p>
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
              <li>{t("desktop.securityMac")}</li>
              <li>{t("desktop.securityWindows")}</li>
            </ul>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("desktop.version", {
              version: rel.version ?? "",
            })}
          </p>
        </>
      )}
    </div>
  );
}
