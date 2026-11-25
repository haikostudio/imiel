"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowLeft, ArrowUp, BarChart3, Loader2, Minus, Pencil } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PeriodSelector,
  dateOf,
  periodBounds,
  readPeriod,
  writePeriod,
  type Period,
} from "@/components/ui/period-selector";
import { foldTag, invalidateKnownNewsletterTags } from "@/components/newsletters/NewsletterTags";
import { hashNavigate } from "@/lib/hash-router";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import pb from "@/lib/pocketbase";
import { useT } from "@/lib/i18n";
import { usePageBack, usePageTitle } from "@/lib/stores/page-title";
import { cn } from "@/lib/utils";

const PERIOD_KEY = "imiel:newsletters-stats:period";

interface TagStat {
  tag: string;
  count: number;
  prevCount: number;
  delta: number;
}

interface Stats {
  from: string;
  to: string;
  total: number;
  prevTotal: number;
  untagged: number;
  perDay: { date: string; count: number }[];
  tags: TagStat[];
  rising: TagStat[];
  series: { granularity: "day" | "week"; tags: string[]; points: Array<Record<string, number | string>> };
}

// Palette categorielle de reference (competence dataviz), validee en clair et
// en sombre pour 6 series adjacentes ; ordre FIXE, la couleur suit le sujet.
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];

function useIsDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setDark(el.classList.contains("dark"));
    read();
    const obs = new MutationObserver(read);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

const LOCALES: Record<string, string> = { fr: "fr-FR", en: "en-GB", de: "de-DE", it: "it-IT" };

function Trend({ s }: { s: TagStat }) {
  const t = useT();
  if (s.delta > 0)
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" title={t("nlStats.prev", { n: String(s.prevCount) })}>
        <ArrowUp className="size-3 text-emerald-600 dark:text-emerald-400" />+{s.delta}
      </span>
    );
  if (s.delta < 0)
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" title={t("nlStats.prev", { n: String(s.prevCount) })}>
        <ArrowDown className="size-3" />
        {s.delta}
      </span>
    );
  return (
    <span className="inline-flex items-center text-xs text-muted-foreground" title={t("nlStats.prev", { n: String(s.prevCount) })}>
      <Minus className="size-3" />
    </span>
  );
}

function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl bg-card p-4", className)}>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Page Statistiques des newsletters (#/newsletters/stats) : choix de periode
 * en haut, newsletters par jour, popularite et tendance de chaque sujet,
 * evolution des principaux sujets, renommage / fusion d'une etiquette.
 */
// Retour de l'entete unique du telephone (reference stable).
const backToNewsletters = () => hashNavigate("/newsletters");

export default function NewsletterStatsPage() {
  const t = useT();
  usePageTitle(t("nlStats.title"));
  usePageBack(backToNewsletters);
  const language = useSettingsStore((s) => s.language) || "fr";
  const dark = useIsDark();
  const [period, setPeriod] = useState<Period>(() => readPeriod(PERIOD_KEY));
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [renaming, setRenaming] = useState<TagStat | null>(null);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const bounds = periodBounds(period);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/worker/newsletters/stats?from=${bounds.from}&to=${bounds.to}`, {
        headers: { Authorization: pb.authStore.token },
      });
      if (!res.ok) throw new Error(String(res.status));
      setStats((await res.json()) as Stats);
    } catch {
      toast.error(t("nlStats.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [bounds.from, bounds.to, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const fmtDay = useMemo(() => {
    const f = new Intl.DateTimeFormat(LOCALES[language] || "fr-FR", { day: "numeric", month: "short" });
    return (d: string) => f.format(dateOf(d));
  }, [language]);

  const palette = dark ? SERIES_DARK : SERIES_LIGHT;
  const maxCount = stats?.tags[0]?.count || 1;

  // Fusion : le nouveau nom est-il celui d'une AUTRE etiquette deja employee ?
  const mergeTarget = useMemo(() => {
    if (!renaming || !stats) return null;
    const f = foldTag(newName);
    if (!f || f === foldTag(renaming.tag)) return null;
    return stats.tags.find((s) => foldTag(s.tag) === f)?.tag ?? null;
  }, [newName, renaming, stats]);

  async function submitRename() {
    if (!renaming || !newName.trim() || foldTag(newName) === foldTag(renaming.tag) && newName.trim() === renaming.tag) {
      setRenaming(null);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/worker/newsletters/tags/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: pb.authStore.token },
        body: JSON.stringify({ from: renaming.tag, to: newName.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { updated?: number; merged?: boolean; to?: string };
      if (!res.ok) throw new Error();
      toast.success(
        data.merged
          ? t("nlStats.merged", { from: renaming.tag, to: data.to || newName.trim(), n: String(data.updated ?? 0) })
          : t("nlStats.renamed", { from: renaming.tag, to: data.to || newName.trim(), n: String(data.updated ?? 0) })
      );
      invalidateKnownNewsletterTags();
      setRenaming(null);
      void load();
    } catch {
      toast.error(t("nlStats.renameFailed"));
    } finally {
      setSaving(false);
    }
  }

  const delta = stats ? stats.total - stats.prevTotal : 0;

  return (
    <div data-ref="newsletter-stats-page" data-veil="" className="flex h-full flex-col bg-muted">
      {/* Telephone : l'entete unique porte la fleche de retour et le titre
          (usePageBack / usePageTitle) ; cette bande ne reste que sur ordinateur. */}
      <header className="hidden items-center gap-2 border-b bg-background px-4 py-3 md:flex">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => hashNavigate("/newsletters")}
          aria-label={t("nlStats.back")}
          title={t("nlStats.back")}
        >
          <ArrowLeft className="size-5" />
        </Button>
        <BarChart3 className="size-5 shrink-0" />
        <h1 className="truncate text-lg font-semibold">{t("nlStats.title")}</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-4 p-4">
          <PeriodSelector
            period={period}
            onChange={(p) => {
              setPeriod(p);
              writePeriod(PERIOD_KEY, p);
            }}
          />

          {loading && !stats ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : !stats ? null : (
            <div className={cn("space-y-4 transition-opacity", loading && "opacity-60")}>
              {/* Chiffres de tete */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl bg-card p-4">
                  <p className="text-xs text-muted-foreground">{t("nlStats.total")}</p>
                  <p data-ref="nl-stats-total" className="mt-1 text-2xl font-semibold tabular-nums">{stats.total}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {delta > 0 ? `+${delta}` : delta} {t("nlStats.vsPrev")}
                  </p>
                </div>
                <div className="rounded-xl bg-card p-4">
                  <p className="text-xs text-muted-foreground">{t("nlStats.topics")}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{stats.tags.length}</p>
                </div>
                <div className="rounded-xl bg-card p-4">
                  <p className="text-xs text-muted-foreground">{t("nlStats.perDayAvg")}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">
                    {(stats.total / Math.max(1, stats.perDay.length)).toFixed(1)}
                  </p>
                </div>
              </div>

              {stats.total === 0 ? (
                <p className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground">{t("nlStats.empty")}</p>
              ) : (
                <>
                  <Panel title={t("nlStats.perDay")}>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={stats.perDay} barCategoryGap={2}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                        <XAxis
                          dataKey="date"
                          tickFormatter={fmtDay}
                          tick={{ fontSize: 11 }}
                          stroke="var(--color-muted-foreground)"
                          tickLine={false}
                          axisLine={false}
                          minTickGap={24}
                        />
                        <YAxis
                          allowDecimals={false}
                          tick={{ fontSize: 11 }}
                          stroke="var(--color-muted-foreground)"
                          tickLine={false}
                          axisLine={false}
                          width={28}
                        />
                        <Tooltip
                          cursor={{ fill: "var(--color-accent)" }}
                          labelFormatter={(d) => fmtDay(String(d))}
                          formatter={(v) => [String(v), t("nlStats.newsletters")]}
                          contentStyle={{
                            background: "var(--color-popover)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        />
                        <Bar dataKey="count" fill={palette[0]} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>

                  {stats.rising.length > 0 && (
                    <Panel title={t("nlStats.rising")}>
                      <div className="flex flex-wrap gap-2">
                        {stats.rising.map((s) => (
                          <span key={s.tag} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
                            {s.tag}
                            <Trend s={s} />
                          </span>
                        ))}
                      </div>
                    </Panel>
                  )}

                  <Panel title={t("nlStats.ranking")}>
                    {stats.tags.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("nlStats.noTags")}</p>
                    ) : (
                      <ul data-ref="nl-stats-ranking" className="space-y-1.5">
                        {stats.tags.slice(0, 30).map((s) => (
                          <li key={s.tag} className="group flex items-center gap-3 text-sm">
                            <span className="w-36 min-w-0 shrink-0 truncate font-medium sm:w-48" title={s.tag}>
                              {s.tag}
                            </span>
                            <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                              <span
                                className="absolute inset-y-0 left-0 rounded-full bg-primary/70"
                                style={{ width: `${Math.max(4, (s.count / maxCount) * 100)}%` }}
                              />
                            </span>
                            <span className="w-8 shrink-0 text-right tabular-nums">{s.count}</span>
                            <span className="w-10 shrink-0">
                              <Trend s={s} />
                            </span>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-7 shrink-0 text-muted-foreground"
                              data-ref="nl-stats-rename"
                              onClick={() => {
                                setRenaming(s);
                                setNewName(s.tag);
                              }}
                              aria-label={t("nlStats.renameTag", { tag: s.tag })}
                              title={t("nlStats.renameTag", { tag: s.tag })}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {stats.untagged > 0 && (
                      <p className="mt-3 text-xs text-muted-foreground">
                        {t("nlStats.untagged", { n: String(stats.untagged) })}
                      </p>
                    )}
                  </Panel>

                  {stats.series.tags.length > 0 && (
                    <Panel
                      title={
                        stats.series.granularity === "week" ? t("nlStats.evolutionWeek") : t("nlStats.evolutionDay")
                      }
                    >
                      <ResponsiveContainer width="100%" height={260}>
                        <LineChart data={stats.series.points}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                          <XAxis
                            dataKey="date"
                            tickFormatter={(d) => fmtDay(String(d))}
                            tick={{ fontSize: 11 }}
                            stroke="var(--color-muted-foreground)"
                            tickLine={false}
                            axisLine={false}
                            minTickGap={24}
                          />
                          <YAxis
                            allowDecimals={false}
                            tick={{ fontSize: 11 }}
                            stroke="var(--color-muted-foreground)"
                            tickLine={false}
                            axisLine={false}
                            width={28}
                          />
                          <Tooltip
                            labelFormatter={(d) => fmtDay(String(d))}
                            contentStyle={{
                              background: "var(--color-popover)",
                              border: "1px solid var(--color-border)",
                              borderRadius: 8,
                              fontSize: 12,
                            }}
                          />
                          <Legend wrapperStyle={{ fontSize: 12 }} />
                          {stats.series.tags.map((tag, i) => (
                            <Line
                              key={tag}
                              type="monotone"
                              dataKey={tag}
                              stroke={palette[i % palette.length]}
                              strokeWidth={2}
                              dot={false}
                              activeDot={{ r: 4 }}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </Panel>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("nlStats.renameTitle", { tag: renaming?.tag ?? "" })}</DialogTitle>
            <DialogDescription>{t("nlStats.renameIntro")}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitRename();
            }}
          >
            <Input value={newName} maxLength={40} autoFocus onChange={(e) => setNewName(e.target.value)} />
          </form>
          {mergeTarget && (
            <p data-ref="nl-stats-merge-warning" className="rounded-md bg-amber-500/10 p-2 text-sm text-amber-800 dark:text-amber-300">
              {t("nlStats.mergeWarning", { from: renaming?.tag ?? "", to: mergeTarget })}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void submitRename()} disabled={saving || !newName.trim()} data-ref="nl-stats-rename-submit">
              {saving && <Loader2 className="size-4 animate-spin" />}
              {mergeTarget ? t("nlStats.merge") : t("nlStats.rename")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
