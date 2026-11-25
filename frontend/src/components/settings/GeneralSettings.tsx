"use client";

import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  users,
  getCurrentUserId,
  type UserSettings,
} from "@/lib/pocketbase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Save, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { notifySettingsUpdated, applyUiScale, applyTheme, useSettingsStore, type UiScale, DEFAULT_AUTO_MARK_READ_SECONDS } from "@/lib/hooks/useSettings";
import { useT } from "@/lib/i18n";
import { DesignPicker } from "@/components/settings/DesignPicker";

interface FormData {
  theme: "light" | "dark" | "system";
  density: "compact" | "comfortable" | "spacious";
  ui_scale: UiScale;
  preview_lines: string;
  reading_pane: "right" | "bottom" | "off";
  conversation_view: boolean;
  mark_read_delay: string;
  reply_all_default: boolean;
  auto_save_interval: string;
  language: string;
}

const LANGUAGES = [
  { value: "fr", label: "Francais" },
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
];

interface GeneralSettingsProps {
  actionsContainer?: RefObject<HTMLDivElement | null>;
}

export default function GeneralSettings({ actionsContainer }: GeneralSettingsProps) {
  const t = useT();

  const THEMES = [
    { value: "light", label: t("settings.theme.light") },
    { value: "dark", label: t("settings.theme.dark") },
    { value: "system", label: t("settings.theme.system") },
  ];

  const DENSITIES = [
    { value: "compact", label: t("settings.density.compact") },
    { value: "comfortable", label: t("settings.density.comfortable") },
    { value: "spacious", label: t("settings.density.spacious") },
  ];

  const UI_SCALES = [
    { value: "small", label: t("settings.uiScale.small") },
    { value: "medium", label: t("settings.uiScale.medium") },
    { value: "large", label: t("settings.uiScale.large") },
  ];

  const PREVIEW_LINES = [
    { value: "0", label: t("settings.0Lines") },
    { value: "1", label: t("settings.1Line") },
    { value: "2", label: t("settings.nLines", { n: "2" }) },
    { value: "3", label: t("settings.nLines", { n: "3" }) },
    { value: "4", label: t("settings.nLines", { n: "4" }) },
    { value: "5", label: t("settings.nLines", { n: "5" }) },
  ];

  const READING_PANES = [
    { value: "bottom", label: t("settings.readingPane.bottom") },
    { value: "right", label: t("settings.readingPane.right") },
    { value: "off", label: t("settings.readingPane.off") },
  ];

  const [form, setForm] = useState<FormData>({
    theme: "system",
    density: "comfortable",
    ui_scale: "small",
    preview_lines: "2",
    reading_pane: "right",
    conversation_view: true,
    mark_read_delay: String(DEFAULT_AUTO_MARK_READ_SECONDS),
    reply_all_default: false,
    auto_save_interval: "10",
    language: "fr",
  });
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const userId = getCurrentUserId();
    if (!userId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const result = await users().getOne<UserSettings>(userId!);
        if (!cancelled && result) {
          setSettingsId(result.id);
          const localScale = typeof window !== "undefined" ? localStorage.getItem("imiel:uiScale") : null;
          const uiScale: UiScale = (result.ui_scale as UiScale) ?? (localScale === "medium" || localScale === "large" ? localScale : "small");
          setForm((prev) => ({
            ...prev,
            theme: result.theme ?? prev.theme,
            density: result.density ?? prev.density,
            ui_scale: uiScale,
            reading_pane: result.reading_pane ?? prev.reading_pane,
            language: result.language ?? prev.language,
            conversation_view: result.conversation_view ?? prev.conversation_view,
            preview_lines: String(result.preview_lines ?? prev.preview_lines),
            mark_read_delay: String(result.auto_mark_read_seconds ?? prev.mark_read_delay),
            reply_all_default: result.default_reply_all ?? prev.reply_all_default,
            auto_save_interval: String(result.auto_save_interval ?? prev.auto_save_interval),
          }));
        }
      } catch {
        // Pas de settings existants
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function updateField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    const userId = getCurrentUserId();
    if (!userId) return;

    setSaving(true);
    try {
      const data: Record<string, unknown> = {
        theme: form.theme,
        density: form.density,
        ui_scale: form.ui_scale,
        reading_pane: form.reading_pane,
        language: form.language,
        preview_lines: Number(form.preview_lines),
        conversation_view: form.conversation_view,
        auto_mark_read_seconds: Number(form.mark_read_delay),
        default_reply_all: form.reply_all_default,
        auto_save_interval: Number(form.auto_save_interval),
      };

      try {
        await users().update(userId!, data);
      } catch {
        // Si le champ ui_scale n'existe pas encore en prod (migration non appliquee),
        // retenter sans ce champ pour ne pas bloquer la sauvegarde du reste.
        delete data.ui_scale;
        await users().update(userId!, data);
      }

      try { localStorage.setItem("imiel:uiScale", form.ui_scale); } catch {}
      applyUiScale(form.ui_scale);
      notifySettingsUpdated();
      toast.success(t("settings.saved"));
    } catch {
      toast.error(t("settings.saveError"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div data-ref="settings-general-loading" className="flex h-64 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div data-ref="settings-general" className="space-y-8">
      {/* Apparence */}
      <section data-ref="settings-general-appearance" className="space-y-4">
        <h3 className="text-lg font-medium">{t("settings.appearance")}</h3>

        {/* Style (Miel | Minimaliste) et fond : appliques et enregistres tout de suite. */}
        <DesignPicker
          isDark={
            form.theme === "dark" ||
            (form.theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches)
          }
        />

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t("settings.theme")}</Label>
            <Select
              value={form.theme}
              onValueChange={(v) => {
                const theme = v as FormData["theme"];
                updateField("theme", theme);
                applyTheme(theme);
                try { localStorage.setItem("theme", theme); } catch {}
                useSettingsStore.getState().load({ theme });
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEMES.map((th) => (
                  <SelectItem key={th.value} value={th.value}>
                    {th.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("settings.density")}</Label>
            <Select
              value={form.density}
              onValueChange={(v) => updateField("density", v as FormData["density"])}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DENSITIES.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label>{t("settings.uiScale")}</Label>
          <Select
            value={form.ui_scale}
            onValueChange={(v) => {
              const scale = v as UiScale;
              updateField("ui_scale", scale);
              applyUiScale(scale);
              try { localStorage.setItem("imiel:uiScale", scale); } catch {}
            }}
          >
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_SCALES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("settings.uiScale.hint")}</p>
        </div>

        <div className="space-y-2">
          <Label>{t("settings.previewLines")}</Label>
          <Select
            value={form.preview_lines}
            onValueChange={(v) => updateField("preview_lines", v)}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PREVIEW_LINES.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      <Separator />

      {/* Lecture */}
      <section data-ref="settings-general-reading" className="space-y-4">
        <h3 className="text-lg font-medium">{t("settings.reading")}</h3>

        <div className="space-y-2">
          <Label>{t("settings.readingPane")}</Label>
          <Select
            value={form.reading_pane}
            onValueChange={(v) => updateField("reading_pane", v as FormData["reading_pane"])}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {READING_PANES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="conversation_view" className="font-normal">
            {t("settings.conversationView")}
          </Label>
          <Switch
            id="conversation_view"
            checked={form.conversation_view}
            onCheckedChange={(v) => updateField("conversation_view", v)}
          />
        </div>

        <div className="flex items-center gap-4">
          <Label htmlFor="mark_read_delay" className="shrink-0 font-normal">
            {t("settings.markReadAfter")}
          </Label>
          <Input
            id="mark_read_delay"
            type="number"
            min={0}
            max={30}
            className="w-20"
            value={form.mark_read_delay}
            onChange={(e) => updateField("mark_read_delay", e.target.value)}
          />
          <span className="text-sm text-muted-foreground">{t("seconds")}</span>
        </div>
      </section>

      <Separator />

      {/* Reponses */}
      <section data-ref="settings-general-replies" className="space-y-4">
        <h3 className="text-lg font-medium">{t("settings.replies")}</h3>

        <div className="flex items-center justify-between">
          <Label htmlFor="reply_all_default" className="font-normal">
            {t("settings.replyAllDefault")}
          </Label>
          <Switch
            id="reply_all_default"
            checked={form.reply_all_default}
            onCheckedChange={(v) => updateField("reply_all_default", v)}
          />
        </div>

        <div className="flex items-center gap-4">
          <Label htmlFor="auto_save_interval" className="shrink-0 font-normal">
            {t("settings.autoSave")}
          </Label>
          <Input
            id="auto_save_interval"
            type="number"
            min={5}
            max={120}
            className="w-20"
            value={form.auto_save_interval}
            onChange={(e) => updateField("auto_save_interval", e.target.value)}
          />
          <span className="text-sm text-muted-foreground">{t("seconds")}</span>
        </div>
      </section>

      <Separator />

      {/* Langue */}
      <section data-ref="settings-general-language" className="space-y-4">
        <h3 className="text-lg font-medium">{t("settings.language")}</h3>

        <div className="space-y-2">
          <Select
            value={form.language}
            onValueChange={(v) => {
              updateField("language", v);
              useSettingsStore.getState().load({ language: v });
            }}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      {actionsContainer?.current && createPortal(
        <Button size="sm" onClick={handleSave} disabled={saving} data-ref="settings-general-save">
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          {t("save")}
        </Button>,
        actionsContainer.current
      )}
    </div>
  );
}
