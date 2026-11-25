"use client";

import { useEffect } from "react";
import { CalendarClock, CalendarPlus, Loader2, Sparkles, X } from "lucide-react";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import {
  useCalendarSuggestions,
  useSuggestionsDrawer,
} from "@/lib/hooks/useCalendarSuggestions";
import type { CalendarSuggestion } from "@/lib/pocketbase";

const LOCALE_BY_LANG: Record<string, string> = {
  fr: "fr-FR",
  en: "en-US",
  de: "de-DE",
  it: "it-IT",
};

function formatWhen(s: CalendarSuggestion, locale: string): string {
  const d = new Date(s.start);
  if (isNaN(d.getTime())) return "";
  if (s.all_day) {
    return d.toLocaleDateString(locale, {
      weekday: "short",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
  return d.toLocaleString(locale, {
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Drawer des propositions d'echeances detectees dans le suivi. Une carte par
 * date a venir (livraison, RDV, echeance...) avec deux boutons : Ajouter a
 * l'agenda / Refuser. Aucun ajout automatique : l'utilisateur tranche. Monte
 * globalement (AuthenticatedLayout), pilote par useSuggestionsDrawer.
 */
export function CalendarSuggestionsDrawer() {
  const t = useT();
  const language = useSettingsStore((s) => s.language);
  const locale = LOCALE_BY_LANG[language] || "fr-FR";
  const open = useSuggestionsDrawer((s) => s.open);
  const setOpen = useSuggestionsDrawer((s) => s.setOpen);
  const autoRun = useSuggestionsDrawer((s) => s.autoRun);
  const setAutoRun = useSuggestionsDrawer((s) => s.setAutoRun);
  const { pending, loading, accept, refuse, runAnalysis, analyzing, analyzeProgress } =
    useCalendarSuggestions();

  // La page Suivi demande une analyse via `autoRun` -> le drawer (seul
  // proprietaire des donnees) la lance a l'ouverture, puis consomme le flag.
  useEffect(() => {
    if (open && autoRun && !analyzing) {
      setAutoRun(false);
      void runAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoRun]);

  // Ouverture auto UNIQUEMENT sur tap de la notif -> URL `#/suivi?dates=1`.
  // Sinon le drawer ne s'ouvre plus tout seul : l'entree se fait via la barre
  // affichee en haut des conversations (SuggestionsBanner), moins intrusive
  // qu'un drawer surgissant a chaque session.
  useEffect(() => {
    if (loading || pending.length === 0) return;
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    if (/[?&]dates=1\b/.test(hash)) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, pending.length]);

  return (
    <ResponsivePanel
      open={open}
      onOpenChange={setOpen}
      title={t("suggestions.title")}
      accentColor="#f59e0b"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {analyzing && (
          <div className="mb-2 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span>
              {t("suggestions.analyzing")}
              {analyzeProgress && analyzeProgress.total > 0
                ? ` (${analyzeProgress.done}/${analyzeProgress.total})`
                : "..."}
            </span>
          </div>
        )}
        {loading && pending.length === 0 && !analyzing ? (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            {t("loading")}
          </div>
        ) : pending.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
            <CalendarClock className="size-8 opacity-40" />
            <p>{t("suggestions.empty")}</p>
            {!analyzing && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => runAnalysis()}>
                <Sparkles className="size-4" />
                {t("suggestions.analyze")}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="px-1 pb-1 text-xs text-muted-foreground">
              {t("suggestions.intro")}
            </p>
            {pending.map((s) => (
              <div
                key={s.id}
                className="flex flex-col gap-2 rounded-lg border bg-card p-3 shadow-sm"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="line-clamp-3 text-sm font-medium">{s.title}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CalendarClock className="size-3.5 shrink-0" />
                    {formatWhen(s, locale)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="flex-1 gap-1.5"
                    onClick={() => accept(s.id)}
                  >
                    <CalendarPlus className="size-4" />
                    {t("suggestions.add")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 gap-1.5"
                    onClick={() => refuse(s.id)}
                  >
                    <X className="size-4" />
                    {t("suggestions.refuse")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </ResponsivePanel>
  );
}
