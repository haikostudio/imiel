"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, CheckCircle2, AlertCircle, Loader2, Clock } from "lucide-react";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { syncAccount, type Account } from "@/lib/pocketbase";
import { useT } from "@/lib/i18n";
import { formatTimeAgo } from "@/lib/utils/date";
import { cn } from "@/lib/utils";

function SyncStatusBadge({ status }: { status: Account["sync_status"] }) {
  const t = useT();

  switch (status) {
    case "syncing":
      return (
        <Badge variant="outline" className="gap-1 text-warning border-warning">
          <Loader2 className="size-3 animate-spin" />
          {t("sync.syncing")}
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertCircle className="size-3" />
          {t("sync.error")}
        </Badge>
      );
    case "initial":
      return (
        <Badge variant="outline" className="gap-1 text-blue-500 border-blue-500">
          <Clock className="size-3" />
          {t("sync.initial")}
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="gap-1 text-green-600 border-green-600">
          <CheckCircle2 className="size-3" />
          {t("sync.idle")}
        </Badge>
      );
  }
}

function AccountSyncRow({ account }: { account: Account }) {
  const t = useT();
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      await syncAccount(account.id);
    } catch {
      // Erreur geree par le backend (sync_error)
    } finally {
      setSyncing(false);
    }
  }

  const isBusy = syncing || account.sync_status === "syncing";

  const title = account.label || account.email;
  const showEmail = Boolean(account.label) && account.label !== account.email;

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-2">
        {account.color && (
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: account.color }}
          />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {title}
        </span>
        <SyncStatusBadge status={syncing ? "syncing" : account.sync_status} />
        <Button
          variant="outline"
          size="sm"
          onClick={handleSync}
          disabled={isBusy}
          className="shrink-0"
          title={t("sync.syncNow")}
        >
          <RefreshCw className={cn("size-3.5", isBusy && "animate-spin")} />
          <span className="hidden sm:inline">{t("sync.syncNow")}</span>
        </Button>
      </div>

      <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
        {showEmail && <p className="truncate">{account.email}</p>}
        <p>
          {t("sync.lastSync")} :{" "}
          {account.last_synced_at
            ? formatTimeAgo(new Date(account.last_synced_at))
            : t("sync.never")}
          {" · "}
          {t("sync.interval").replace("{min}", String(account.check_interval))}
        </p>
      </div>

      {account.sync_error && account.sync_status === "error" && (
        <p className="text-xs text-destructive mt-1 truncate">
          {account.sync_error}
        </p>
      )}
    </div>
  );
}

export default function SyncSettings() {
  const t = useT();
  const { accounts } = useAccounts();
  const activeAccounts = accounts.filter((a) => a.is_active);

  return (
    <div data-ref="settings-sync" className="space-y-6">
      <h3 className="text-lg font-medium">{t("sync.title")}</h3>

      {activeAccounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("sync.noAccounts")}</p>
      ) : (
        <div className="space-y-3">
          {activeAccounts.map((account) => (
            <AccountSyncRow key={account.id} account={account} />
          ))}
        </div>
      )}
    </div>
  );
}
