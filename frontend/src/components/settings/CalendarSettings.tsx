"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, RefreshCw, CheckCircle2, Link2, AlertCircle, Mail, Trash2, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { isWritableGroup } from "@/components/calendar/EventForm";
import type { CalendarGroup } from "@/lib/pocketbase";
import pb, { getCurrentUserId } from "@/lib/pocketbase";
import { getOAuthRedirectOrigin } from "@/lib/oauth-origin";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { useCalendarGroups } from "@/lib/hooks/useCalendarGroups";
import { useCalendarStats } from "@/lib/hooks/useCalendarStats";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export default function CalendarSettings() {
  const t = useT();
  const { accounts } = useAccounts();
  const { groups, refresh: refreshGroups, deleteGroup, setDefaultGroup } = useCalendarGroups();
  const groupIds = useMemo(() => groups.map((g) => g.id), [groups]);
  const { stats, refresh: refreshStats } = useCalendarStats(groupIds);

  const [connecting, setConnecting] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CalendarGroup | null>(null);
  const writableGroups = useMemo(() => groups.filter(isWritableGroup), [groups]);
  const defaultGroup = groups.find((g) => g.is_default);

  const googleAccounts = useMemo(() => accounts.filter((a) => a.auth_type === "oauth2"), [accounts]);

  async function handleConnect() {
    const userId = getCurrentUserId();
    if (!userId) {
      toast.error(t("account.oauthError"));
      return;
    }
    setConnecting(true);
    try {
      const res = await fetch(`/worker/oauth/google/url?userId=${userId}&origin=${encodeURIComponent(getOAuthRedirectOrigin())}`);
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast.error(data.error || t("account.oauthError"));
      }
    } catch {
      toast.error(t("account.oauthError"));
    } finally {
      setConnecting(false);
    }
  }

  const handleSync = useCallback(
    async (accountId: string) => {
      setSyncingId(accountId);
      try {
        // fetch RELATIF -> rewrite /worker/* de l'app (pas pb.send qui cible PocketBase).
        const httpRes = await fetch(`/worker/calendar/sync/${accountId}`, {
          method: "POST",
          headers: { Authorization: pb.authStore.token },
        });
        const res = (await httpRes.json().catch(() => ({}))) as {
          success?: boolean;
          needsReconnect?: boolean;
          error?: string;
          calendars?: number;
          events?: number;
        };
        if (res?.needsReconnect) {
          toast.error(t("calendar.reconnectHint"));
        } else if (res?.error) {
          toast.error(res.error);
        } else {
          toast.success(t("calendar.settings.synced"));
        }
        await Promise.all([refreshGroups(), refreshStats()]);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSyncingId(null);
      }
    },
    [refreshGroups, refreshStats, t]
  );

  const googleGroups = groups.filter((g) => g.google_calendar_id);
  const localGroups = groups.filter((g) => !g.google_calendar_id);

  return (
    <div data-ref="settings-calendar" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-lg font-medium">{t("calendar.settings.title")}</h3>
        <Button onClick={handleConnect} disabled={connecting} size="sm" className="shrink-0">
          <Link2 className="size-4" />
          {t("calendar.connectGoogle")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("calendar.settings.description")}</p>

      {/* Statistiques */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t("calendar.settings.totalEvents")} value={stats.total} />
        <StatCard label={t("calendar.settings.googleEvents")} value={stats.google} />
        <StatCard label={t("calendar.settings.emailEvents")} value={stats.email} />
        <StatCard label={t("calendar.settings.localEvents")} value={stats.local} />
      </div>

      {/* Synchronisation par compte Google */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t("calendar.settings.sync")}</h4>
        {googleAccounts.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            <AlertCircle className="size-4 shrink-0" />
            {t("calendar.settings.noGoogle")}
          </div>
        ) : (
          googleAccounts.map((account) => (
            <div key={account.id} className="flex items-center gap-2 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{account.label || account.email}</div>
                <div className="truncate text-xs text-muted-foreground">{account.email}</div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSync(account.id)}
                disabled={syncingId === account.id}
                className="shrink-0"
                title={t("calendar.sync")}
              >
                <RefreshCw className={cn("size-3.5", syncingId === account.id && "animate-spin")} />
                <span className="hidden sm:inline">
                  {syncingId === account.id ? t("calendar.syncing") : t("calendar.sync")}
                </span>
              </Button>
            </div>
          ))
        )}
      </div>

      {/* Agenda par defaut : rendez-vous lus dans les mails + coche d'office */}
      {writableGroups.length > 0 && (
        <div className="space-y-2" data-ref="calendar-default-group">
          <h4 className="text-sm font-medium">{t("calendar.defaultGroup")}</h4>
          <Select value={defaultGroup?.id ?? ""} onValueChange={(id) => void setDefaultGroup(id)}>
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue placeholder={t("calendar.defaultGroup")} />
            </SelectTrigger>
            <SelectContent>
              {writableGroups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  <span className="flex items-center gap-2">
                    <span className="size-3 rounded-full" style={{ backgroundColor: g.color || "#888" }} />
                    {g.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("calendar.defaultGroupHint")}</p>
        </div>
      )}

      {/* Agendas */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium">
          {t("calendar.settings.calendars")}{" "}
          <span className="text-muted-foreground">({googleGroups.length})</span>
        </h4>
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("calendar.noEvents")}</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {[...googleGroups, ...localGroups].map((group) => {
              const isGoogle = !!group.google_calendar_id;
              const synced = isGoogle && !!group.sync_token;
              const count = stats.byGroup[group.id] ?? 0;
              return (
                <div key={group.id} className="flex items-center gap-2.5 px-3 py-2">
                  <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: group.color || "#888" }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-sm">
                      {group.name}
                      {group.is_default && <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" aria-label={t("calendar.defaultBadge")} />}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {count} {t("calendar.settings.events")}
                    </div>
                  </div>

                  {isGoogle ? (
                    synced ? (
                      <Badge variant="outline" className="shrink-0 gap-1 border-green-600 text-green-600">
                        <CheckCircle2 className="size-3" />
                        {t("calendar.settings.synced")}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="shrink-0 gap-1 text-muted-foreground">
                        {t("calendar.settings.notSynced")}
                      </Badge>
                    )
                  ) : group.name === "Invitations" ? (
                    <Badge variant="outline" className="shrink-0 gap-1">
                      <Mail className="size-3" />
                      {t("calendar.fromEmail")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0 gap-1">
                      <CalendarDays className="size-3" />
                      {t("calendar.settings.local")}
                    </Badge>
                  )}
                  {group.is_primary ? (
                    <span className="size-8 shrink-0" title={t("calendar.primaryNotDeletable")} />
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      title={t("calendar.delete")}
                      data-ref="settings-calendar-delete"
                      onClick={() => setPendingDelete(group)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent className="z-[80]" overlayClassName="z-[80]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("calendar.deleteGroupTitle")} {pendingDelete ? `« ${pendingDelete.name} »` : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("calendar.deleteGroupEvents", { count: String(pendingDelete ? stats.byGroup[pendingDelete.id] ?? 0 : 0) })}{" "}
              {pendingDelete
                ? t(
                    !pendingDelete.google_calendar_id
                      ? "calendar.deleteGroupLocal"
                      : pendingDelete.access_role === "owner"
                        ? "calendar.deleteGroupGoogle"
                        : "calendar.deleteGroupShared"
                  )
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const g = pendingDelete;
                setPendingDelete(null);
                if (g && (await deleteGroup(g.id))) await refreshStats();
              }}
            >
              {t("calendar.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="text-xl font-semibold">{value}</div>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
