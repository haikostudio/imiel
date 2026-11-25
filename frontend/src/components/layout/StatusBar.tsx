"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, RefreshCw, Download, CheckCircle2, AlertCircle, Loader2, Clock } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { useSyncStore } from "@/lib/hooks/useSync";
import { useIsMiel } from "@/lib/hooks/useSettings";
import { useMailStore } from "@/lib/stores/mail-store";
import { syncAccount, type Account } from "@/lib/pocketbase";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { formatTimeAgo } from "@/lib/utils/date";
import { BuildVersionTag } from "@/components/layout/BuildVersionTag";

function formatTimeSince(dateStr?: string): string {
  if (!dateStr) return "jamais";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "a l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours}h`;
  return `il y a ${Math.floor(hours / 24)}j`;
}

function useCountdown() {
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const isSyncing = useSyncStore((s) => s.isSyncing);
  const intervalSeconds = useSyncStore((s) => s.intervalSeconds);
  const [secondsLeft, setSecondsLeft] = useState(intervalSeconds);

  useEffect(() => {
    const refTime = lastSyncedAt ?? Date.now();

    function tick() {
      const elapsed = Math.floor((Date.now() - refTime) / 1000);
      const remaining = Math.max(0, intervalSeconds - elapsed);
      setSecondsLeft(remaining);
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastSyncedAt, intervalSeconds]);

  if (isSyncing) return null;
  return secondsLeft;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "imminent";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function SyncStatusIcon({ status, syncing }: { status: string; syncing: boolean }) {
  const effective = syncing ? "syncing" : status;
  switch (effective) {
    case "syncing":
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-warning" />;
    case "error":
      return <AlertCircle className="size-3.5 shrink-0 text-destructive" />;
    case "initial":
      return <Clock className="size-3.5 shrink-0 text-blue-500" />;
    default:
      return <CheckCircle2 className="size-3.5 shrink-0 text-green-600" />;
  }
}

function AccountSyncItem({ account, globalSyncing, onSynced }: { account: Account; globalSyncing: boolean; onSynced?: () => void }) {
  const t = useT();
  const [syncing, setSyncing] = useState(false);
  const wsStatus = useSyncStore((s) => s.accountSyncStatus[account.id]);

  async function handleSync() {
    setSyncing(true);
    try {
      await syncAccount(account.id);
      onSynced?.();
    } catch {
      // error handled by backend
    } finally {
      setSyncing(false);
    }
  }

  // Statut effectif : priorite au temps reel (WS), sinon le record PB
  const effectiveStatus = wsStatus?.status || account.sync_status;
  const effectiveError = wsStatus?.error || account.sync_error;
  const isBusy = syncing || globalSyncing || effectiveStatus === "syncing";

  return (
    <div className="flex items-center gap-2 py-1.5">
      <SyncStatusIcon status={effectiveStatus} syncing={isBusy} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {account.color && (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: account.color }}
            />
          )}
          <span className="text-xs font-medium truncate">
            {account.label || account.email}
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground truncate">
          {isBusy
            ? t("sync.syncing")
            : effectiveStatus === "error" && effectiveError
              ? effectiveError
              : account.last_synced_at
                ? formatTimeSince(account.last_synced_at)
                : t("sync.never")}
        </div>
      </div>
      <button
        onClick={handleSync}
        disabled={isBusy}
        className={cn(
          "inline-flex items-center justify-center rounded p-1 transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          "disabled:pointer-events-none disabled:opacity-50"
        )}
        title={t("sync.syncNow")}
      >
        <Download className="size-3" />
      </button>
    </div>
  );
}

export function StatusBar() {
  const t = useT();
  const { accounts, refreshAccounts } = useAccounts();
  const storeSyncing = useSyncStore((s) => s.isSyncing);
  const accountSyncStatus = useSyncStore((s) => s.accountSyncStatus);
  const wasSyncingRef = useRef(false);

  // Refresh accounts when global sync finishes
  useEffect(() => {
    if (wasSyncingRef.current && !storeSyncing) {
      refreshAccounts();
    }
    wasSyncingRef.current = storeSyncing;
  }, [storeSyncing, refreshAccounts]);

  // Refresh accounts when one of the user's accounts completes a sync (idle/error)
  const prevStatusRef = useRef(accountSyncStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const changed = accounts.some((a) => {
      const s = accountSyncStatus[a.id];
      return s && s.status !== prev[a.id]?.status && (s.status === "idle" || s.status === "error");
    });
    prevStatusRef.current = accountSyncStatus;
    if (changed) refreshAccounts();
  }, [accountSyncStatus, accounts, refreshAccounts]);

  const wsAnySyncing = accounts.some((a) => accountSyncStatus[a.id]?.status === "syncing");
  const isSyncing = storeSyncing || wsAnySyncing || accounts.some((a) => a.sync_status === "syncing");
  const storeSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const secondsLeft = useCountdown();
  const hasComposeOpen = useMailStore((s) => s.composeInstances.length > 0);
  const draftSaving = useMailStore((s) => s.draftSaving);
  const draftLastSaved = useMailStore((s) => s.draftLastSaved);

  const activeAccounts = accounts.filter((a) => a.is_active);
  const isMiel = useIsMiel();

  // Calculer le dernier sync (le plus recent entre la base et le store frontend)
  const dbSync = accounts.reduce<string | undefined>((latest, acc) => {
    if (!acc.last_synced_at) return latest;
    if (!latest) return acc.last_synced_at;
    return new Date(acc.last_synced_at) > new Date(latest) ? acc.last_synced_at : latest;
  }, undefined);
  const dbSyncMs = dbSync ? new Date(dbSync).getTime() : 0;
  const lastSync = storeSyncedAt && storeSyncedAt > dbSyncMs
    ? new Date(storeSyncedAt).toISOString()
    : dbSync;

  const hasError = accounts.some(
    (a) => a.sync_status === "error" || accountSyncStatus[a.id]?.status === "error"
  );

  const syncStatusColor = isSyncing
    ? "bg-warning"
    : hasError
      ? "bg-danger"
      : "bg-success";

  const syncLabel = `Sync ${formatTimeSince(lastSync)}`;
  // Apparence Miel : plus de barre d'etat (carte « Pages au meme gabarit ») :
  // la recherche est en tete de chaque page et la mention de synchronisation
  // n'est plus affichee (decision utilisateur). Le composant reste MONTE pour
  // ses effets (comptes rafraichis a la fin d'une releve) ; il ne rend rien.
  if (isMiel) return null;

  return (
    <footer data-ref="status-bar" className="hidden md:flex h-7 shrink-0 items-center gap-4 border-t bg-muted/50 px-3 text-xs text-muted-foreground">
      <div
        data-ref="status-bar-sync"
        className="flex items-center gap-1.5"
      >
        <span
          data-ref="status-bar-sync-dot"
          className={cn("size-1.5 rounded-full", syncStatusColor)}
        />
        <span data-ref="status-bar-sync-label">{syncLabel}</span>
      </div>

      <span className="text-border">|</span>

      <span>
        {accounts.length} compte{accounts.length !== 1 ? "s" : ""}
      </span>

      <span className="text-border">|</span>

      <Popover>
        <PopoverTrigger asChild>
          <button
            data-ref="status-bar-countdown"
            className="flex items-center gap-1.5 rounded px-1 -mx-1 transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <span>
              {isSyncing
                ? "Synchronisation..."
                : secondsLeft !== null
                  ? `Prochain check : ${formatCountdown(secondsLeft)}`
                  : "Prochain check : --"}
            </span>
            <RefreshCw className="size-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-72 p-2">
          <div className="space-y-0.5">
            <div className="mb-1">
              <span className="text-xs font-semibold">{t("sync.title")}</span>
            </div>
            {activeAccounts.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">{t("sync.noAccounts")}</p>
            ) : (
              <div className="divide-y">
                {activeAccounts.map((account) => (
                  <AccountSyncItem key={account.id} account={account} globalSyncing={storeSyncing} onSynced={refreshAccounts} />
                ))}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {hasComposeOpen && (draftSaving || draftLastSaved) && (
        <>
          <span className="text-border">|</span>
          <div className="flex items-center gap-1.5">
            <FileText className="size-3" />
            <span>
              {draftSaving
                ? t("compose.autoSaving")
                : draftLastSaved
                  ? `${t("compose.draftSaved")}${formatTimeAgo(draftLastSaved)}`
                  : null}
            </span>
          </div>
        </>
      )}

      {/* Version build : ml-auto pour pousser tout a droite */}
      <BuildVersionTag variant="inline" className="ml-auto" />
    </footer>
  );
}
