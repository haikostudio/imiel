"use client";

import { useEffect, useState } from "react";
import {
  pushTokens,
  getCurrentUserId,
  users,
  type PushToken,
  type UserSettings,
} from "@/lib/pocketbase";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Bell, BellOff, Monitor, Smartphone, Trash2, Loader2, Sunrise } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { formatTimeAgo } from "@/lib/utils/date";

// device_name stocke l'user agent brut : on en derive un nom lisible
// ("iPhone · Safari", "Mac · Chrome"...) au lieu d'afficher "Mozilla/5.0 (...".
function parseDeviceName(ua: string): { label: string; isMobile: boolean } {
  if (!ua.startsWith("Mozilla/")) {
    return { label: ua.slice(0, 60), isMobile: false };
  }
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /CriOS\//.test(ua) || (/Chrome\//.test(ua) && !/Edg\//.test(ua))
        ? "Chrome"
        : /FxiOS\//.test(ua) || /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  const isMobile = /iPhone|iPad|Android|Mobile/.test(ua);
  return { label: [os, browser].filter(Boolean).join(" · "), isMobile };
}

export default function NotificationSettings() {
  const t = useT();
  const {
    permission,
    subscribe,
    unsubscribe,
    needsInstall,
    currentEndpoint,
    hasActiveSubscription,
  } = useNotifications();
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [dailyDigest, setDailyDigest] = useState(true);
  const [notifyImportance, setNotifyImportance] = useState<string>("important_secondary");
  const [devices, setDevices] = useState<PushToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);

  async function reloadDevices(userId: string) {
    try {
      const tokens = await pushTokens().getFullList<PushToken>({
        filter: `user = "${userId}"`,
        sort: "-created",
      });
      setDevices(tokens);
    } catch {
      // Liste indisponible, on n'ecrase pas l'etat actuel
    }
  }

  useEffect(() => {
    const userId = getCurrentUserId();
    if (!userId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        try {
          const settings = await users().getOne<UserSettings>(userId!);
          if (!cancelled && settings) {
            setSettingsId(settings.id);
            setNotificationsEnabled(settings.notifications_enabled);
            setSoundEnabled(settings.notification_sound);
            setDailyDigest(settings.daily_digest_disabled !== true);
            setNotifyImportance(settings.notify_importance || "important_secondary");
          }
        } catch {
          // Pas de settings
        }

        if (!cancelled) await reloadDevices(userId!);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggleSound(enabled: boolean) {
    setSoundEnabled(enabled);
    if (!settingsId) return;
    try {
      await users().update(settingsId, { notification_sound: enabled });
    } catch {
      setSoundEnabled(!enabled);
      toast.error(t("notifSettings.updateError"));
    }
  }

  async function handleNotifyImportance(value: string) {
    const prev = notifyImportance;
    setNotifyImportance(value);
    if (!settingsId) return;
    try {
      await users().update(settingsId, { notify_importance: value });
    } catch {
      setNotifyImportance(prev);
      toast.error(t("notifSettings.updateError"));
    }
  }

  async function handleToggleDailyDigest(enabled: boolean) {
    setDailyDigest(enabled);
    if (!settingsId) return;
    try {
      // Champ inverse : un bool PocketBase vaut false par defaut, donc
      // "pas coupe" = recapitulatif actif pour tous les comptes.
      await users().update(settingsId, { daily_digest_disabled: !enabled });
    } catch {
      setDailyDigest(!enabled);
      toast.error(t("notifSettings.updateError"));
    }
  }

  async function handleToggleNotifications(enabled: boolean) {
    const userId = getCurrentUserId();
    if (!userId) return;
    setBusy(true);
    setNotificationsEnabled(enabled);

    try {
      if (enabled) {
        await subscribe();
        if (settingsId) {
          await users().update(settingsId, { notifications_enabled: true });
        }
        toast.success(t("notifSettings.enabled"));
      } else {
        await unsubscribe();
        if (settingsId) {
          await users().update(settingsId, { notifications_enabled: false });
        }
        toast.success(t("notifSettings.disabled"));
      }
      await reloadDevices(userId);
    } catch (err) {
      setNotificationsEnabled(!enabled);
      const msg = err instanceof Error ? err.message : t("notifSettings.updateError");
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectDevice() {
    const userId = getCurrentUserId();
    if (!userId) return;
    setBusy(true);
    try {
      await subscribe();
      if (settingsId && !notificationsEnabled) {
        await users().update(settingsId, { notifications_enabled: true });
        setNotificationsEnabled(true);
      }
      await reloadDevices(userId);
      toast.success(t("notifSettings.enabled"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("notifSettings.updateError");
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnectDevice() {
    const userId = getCurrentUserId();
    if (!userId) return;
    setBusy(true);
    try {
      await unsubscribe();
      await reloadDevices(userId);
      toast.success(t("notifSettings.deviceDeleted"));
    } catch {
      toast.error(t("notifSettings.deleteError"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveDevice(tokenId: string, endpoint: string) {
    try {
      await pushTokens().delete(tokenId);
      setDevices((prev) => prev.filter((d) => d.id !== tokenId));
      if (endpoint && endpoint === currentEndpoint) {
        await unsubscribe();
      }
      toast.success(t("notifSettings.deviceDeleted"));
    } catch {
      toast.error(t("notifSettings.deleteError"));
    }
  }

  if (loading) {
    return (
      <div data-ref="settings-notifications-loading" className="flex h-64 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const canUsePush =
    permission !== "unsupported" && !needsInstall && permission !== "denied";

  return (
    <div data-ref="settings-notifications" className="space-y-8">
      <section data-ref="settings-notifications-toggle" className="space-y-4">
        <h3 className="text-lg font-medium">{t("notifications")}</h3>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {notificationsEnabled ? (
              <Bell className="size-5 text-primary" />
            ) : (
              <BellOff className="size-5 text-muted-foreground" />
            )}
            <Label htmlFor="notifications_enabled" className="font-normal">
              {t("notifSettings.enableNotifications")}
            </Label>
          </div>
          <Switch
            id="notifications_enabled"
            checked={notificationsEnabled}
            onCheckedChange={handleToggleNotifications}
            disabled={busy}
          />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="sound_enabled" className="font-normal">
            {t("notifSettings.notificationSound")}
          </Label>
          <Switch
            id="sound_enabled"
            checked={soundEnabled}
            onCheckedChange={handleToggleSound}
          />
        </div>

        <div className="space-y-2" data-ref="settings-notifications-importance">
          <Label className="font-normal">{t("notifSettings.importanceTitle")}</Label>
          <p className="text-sm text-muted-foreground">{t("notifSettings.importanceDescription")}</p>
          <RadioGroup value={notifyImportance} onValueChange={handleNotifyImportance} className="gap-2 pt-1">
            {(["important", "important_secondary", "all"] as const).map((v) => (
              <div key={v} className="flex items-center gap-2">
                <RadioGroupItem value={v} id={`notify-imp-${v}`} />
                <Label htmlFor={`notify-imp-${v}`} className="font-normal">
                  {t(`notifSettings.importance.${v}`)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>

        {needsInstall && (
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 space-y-1">
            <p className="text-sm font-medium">{t("notifSettings.iosInstallTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("notifSettings.iosInstallDescription")}</p>
          </div>
        )}

        {canUsePush && (
          hasActiveSubscription ? (
            <Button
              variant="outline"
              onClick={handleDisconnectDevice}
              disabled={busy}
              data-ref="settings-notifications-disconnect"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <BellOff className="size-4" />}
              {t("notifSettings.disconnectThisDevice")}
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={handleConnectDevice}
              disabled={busy}
              data-ref="settings-notifications-connect"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Bell className="size-4" />}
              {t("notifSettings.connectThisDevice")}
            </Button>
          )
        )}

        {permission === "denied" && (
          <p className="text-sm text-destructive">
            {t("notifSettings.blocked")}
          </p>
        )}

        {permission === "unsupported" && !needsInstall && (
          <p className="text-sm text-muted-foreground">
            {t("notifSettings.notSupported")}
          </p>
        )}
      </section>

      <Separator />

      <section data-ref="settings-notifications-daily-digest" className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <Sunrise className={dailyDigest ? "size-5 shrink-0 text-primary mt-0.5" : "size-5 shrink-0 text-muted-foreground mt-0.5"} />
            <div className="min-w-0 space-y-1">
              <Label htmlFor="daily_digest" className="font-normal">
                {t("notifSettings.dailyDigest")}
              </Label>
              <p className="text-sm text-muted-foreground">{t("notifSettings.dailyDigestDescription")}</p>
            </div>
          </div>
          <Switch id="daily_digest" checked={dailyDigest} onCheckedChange={handleToggleDailyDigest} />
        </div>
      </section>

      <Separator />

      <section data-ref="settings-notifications-devices" className="space-y-4">
        <h3 className="text-lg font-medium">{t("notifSettings.registeredDevices")}</h3>

        {devices.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("notifSettings.noRegisteredDevices")}
          </p>
        )}

        {devices.map((device) => {
          const isThisDevice = device.endpoint === currentEndpoint;
          const parsed = device.device_name
            ? parseDeviceName(device.device_name)
            : { label: "", isMobile: false };
          const DeviceIcon = parsed.isMobile ? Smartphone : Monitor;
          return (
            <Card key={device.id} className="py-2">
              <CardContent className="flex items-center justify-between gap-2 px-3">
                <div className="flex items-center gap-3 min-w-0">
                  <DeviceIcon className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {parsed.label || t("notifSettings.unknownDevice")}
                      {isThisDevice && (
                        <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                          {t("notifSettings.thisDevice")}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {device.is_active ? t("notifSettings.active") : t("notifSettings.inactive")}
                      {device.created
                        ? ` · ${formatTimeAgo(new Date(device.created))}`
                        : ""}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() => handleRemoveDevice(device.id, device.endpoint)}
                  data-ref="settings-notifications-device-remove"
                >
                  <Trash2 className="size-4" />
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </section>
    </div>
  );
}
