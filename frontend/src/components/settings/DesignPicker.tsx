"use client";

import { Check } from "lucide-react";
import {
  DESIGN_BACKGROUNDS,
  setDesign,
  useSettingsStore,
  type Design,
  type DesignBackground,
} from "@/lib/hooks/useSettings";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const DESIGNS: Design[] = ["miel", "minimal"];

/**
 * Reglages > General > Apparence : choix du STYLE (Miel | Minimaliste) en
 * controle segmente, puis du FOND de l'apparence Miel en 4 vignettes 16:10.
 * Applique tout de suite (data-design sur <html>, sans recharger) et
 * enregistre sur le compte (users.design / users.design_background) : le
 * choix suit l'utilisateur sur tous ses appareils.
 */
export function DesignPicker({ isDark }: { isDark: boolean }) {
  const t = useT();
  const design = useSettingsStore((s) => s.design);
  const background = useSettingsStore((s) => s.designBackground);

  return (
    <div className="space-y-6" data-ref="settings-design">
      <div className="space-y-2">
        <div className="text-sm font-medium">{t("settings.design")}</div>
        <div
          role="radiogroup"
          aria-label={t("settings.design")}
          className="inline-flex gap-1 rounded-[14px] bg-muted p-1"
          data-ref="settings-design-style"
        >
          {DESIGNS.map((d) => {
            const active = design === d;
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => void setDesign(d)}
                className={cn(
                  "inline-flex h-[34px] items-center rounded-[10px] px-4 text-sm transition-colors",
                  active
                    ? "bg-background font-semibold text-foreground shadow-sm"
                    : "font-medium text-muted-foreground hover:text-foreground"
                )}
              >
                {t(`settings.design.${d}`)}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.design.hint")}</p>
      </div>

      {design === "miel" && (
        <div className="space-y-2">
          <div className="text-sm font-medium">{t("settings.background")}</div>
          <div
            role="radiogroup"
            aria-label={t("settings.background")}
            className="grid max-w-[720px] grid-cols-2 gap-3.5 sm:grid-cols-4"
            data-ref="settings-design-background"
          >
            {DESIGN_BACKGROUNDS.map((bg: DesignBackground) => {
              const active = background === bg;
              return (
                <button
                  key={bg}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => void setDesign("miel", bg)}
                  className="flex flex-col gap-2 text-left"
                  data-ref={`settings-design-bg-${bg}`}
                >
                  <span
                    className={cn(
                      "relative block aspect-[16/10] w-full rounded-[14px] bg-cover bg-center",
                      active ? "miel-tile-active" : "miel-tile"
                    )}
                    style={{ backgroundImage: `url(/backgrounds/${bg}-${isDark ? "sombre" : "clair"}.svg)` }}
                  >
                    {/* Apercu d'un bloc pose sur le fond */}
                    <span className="absolute inset-x-[14%] inset-y-[16%] rounded-lg bg-card/75 shadow-sm" aria-hidden />
                    {active && (
                      <span className="miel-tile-check absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-full">
                        <Check className="size-3" strokeWidth={3} />
                      </span>
                    )}
                  </span>
                  <span className={cn("text-[13px]", active ? "font-semibold" : "font-medium")}>
                    {t(`settings.background.${bg}`)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
