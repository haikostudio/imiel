"use client";

import { useHashRouter } from "@/lib/hash-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { accounts, type Account } from "@/lib/pocketbase";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Trash2, Save, History, Loader2, Paperclip, Pause, Play } from "lucide-react";
import AccountForm from "@/components/settings/AccountForm";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";

export default function EditAccountPage() {
  const t = useT();
  const { params, navigate, replace } = useHashRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  interface HistoryStatus {
    running: boolean;
    paused?: boolean;
    total: number;
    done: number;
    inserted: number;
    phase: string;
    error: string | null;
  }
  const [history, setHistory] = useState<HistoryStatus | null>(null);
  const historyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchHistory = useCallback(async (accountId: string) => {
    try {
      const res = await fetch(
        `/worker/history-backfill/status/${encodeURIComponent(accountId)}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as HistoryStatus;
      setHistory(data);
      if (!data.running && historyPollRef.current) {
        clearInterval(historyPollRef.current);
        historyPollRef.current = null;
      }
    } catch {
      // worker peut etre indisponible
    }
  }, []);

  useEffect(() => {
    if (account?.id) fetchHistory(account.id);
    return () => {
      if (historyPollRef.current) clearInterval(historyPollRef.current);
    };
  }, [account?.id, fetchHistory]);

  async function handleHistoryBackfill() {
    if (!account) return;
    try {
      const res = await fetch(
        `/worker/history-backfill/${encodeURIComponent(account.id)}`,
        { method: "POST" }
      );
      if (!res.ok) return;
      if (!historyPollRef.current) {
        historyPollRef.current = setInterval(
          () => fetchHistory(account.id),
          3000
        );
      }
      fetchHistory(account.id);
    } catch {
      // ignore
    }
  }

  async function handleHistoryPause() {
    if (!account) return;
    try {
      await fetch(
        `/worker/history-backfill/pause/${encodeURIComponent(account.id)}`,
        { method: "POST" }
      );
      fetchHistory(account.id);
    } catch {
      // ignore
    }
  }

  const { accounts: allAccounts } = useAccounts();
  const isNew = params.id === "new";
  const usedColors = allAccounts
    .filter((a) => a.id !== params.id)
    .map((a) => a.color)
    .filter(Boolean);

  useEffect(() => {
    if (isNew) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const result = await accounts().getOne<Account>(params.id!);
        if (!cancelled) setAccount(result);
      } catch {
        if (!cancelled) replace("/settings?tab=accounts");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [params.id, isNew, replace]);

  const [repairing, setRepairing] = useState(false);

  async function handleRepairAttachments() {
    if (!account) return;
    setRepairing(true);
    try {
      const res = await fetch(
        `/worker/repair-attachments/${encodeURIComponent(account.id)}`,
        { method: "POST" }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(
          t("editAccount.repairFailed", {
            error: (err as { error?: string }).error || res.statusText,
          })
        );
        return;
      }
      const data = (await res.json()) as {
        repaired: number;
        failed: number;
        noSource: number;
        total?: number;
      };
      if ((data.total ?? 0) === 0) {
        toast.success(t("editAccount.repairNone"));
      } else {
        toast.success(
          t("editAccount.repairSuccess", {
            repaired: String(data.repaired),
            noSource: String(data.noSource),
            failed: String(data.failed),
          })
        );
      }
    } catch (err) {
      toast.error(
        t("editAccount.repairFailed", {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    } finally {
      setRepairing(false);
    }
  }

  async function handleDelete() {
    if (!account) return;
    setDeleting(true);
    try {
      await accounts().delete(account.id);
      replace("/settings?tab=accounts");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div>
        <div className="border-b px-4 py-2">
          <Skeleton className="h-8 w-64" />
        </div>
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Skeleton className="h-[600px] w-full rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div data-ref="settings-account-edit" className="flex h-full flex-col">
      <div className="relative flex h-12 shrink-0 items-center justify-center border-b bg-background px-12">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/settings?tab=accounts")}
          data-ref="settings-account-edit-back"
          className="absolute left-2.5 gap-1.5 text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("back")}
        </Button>
        <h1 data-ref="settings-account-edit-title" className="text-xs font-medium text-muted-foreground">
          {isNew ? t("editAccount.titleAdd") : t("editAccount.titleEdit")}
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6">
        <AccountForm
          account={account ?? undefined}
          usedColors={usedColors}
          onSuccess={() => navigate("/settings?tab=accounts")}
          formId="account-form"
        />

        {!isNew && account && (
          <>
            <Separator className="my-8" />
            <div className="rounded-lg border p-6">
              <h3 className="text-lg font-medium">{t("editAccount.historyTitle")}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("editAccount.historyDescription")}
              </p>

              <div className="mt-4 flex items-center gap-2 flex-wrap">
                <Button
                  onClick={handleHistoryBackfill}
                  disabled={history?.running ?? false}
                  data-ref="settings-account-history-backfill"
                >
                  {history?.running ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : history?.paused ? (
                    <Play className="size-4" />
                  ) : (
                    <History className="size-4" />
                  )}
                  {history?.running
                    ? t("editAccount.historyRunning")
                    : history?.paused
                      ? t("editAccount.historyResume")
                      : t("editAccount.historyTitle")}
                </Button>
                {history?.running && (
                  <Button variant="outline" onClick={handleHistoryPause}>
                    <Pause className="size-4" />
                    {t("pause")}
                  </Button>
                )}
                {history?.paused && !history?.running && (
                  <span className="text-sm text-muted-foreground">{t("paused")}</span>
                )}
              </div>

              {history && (history.running || history.done > 0) && (
                <p className="mt-3 text-sm">
                  {history.phase === "sent"
                    ? t("editAccount.historyPhaseSent")
                    : history.phase === "done"
                      ? t("editAccount.historyPhaseDone")
                      : history.phase === "preparing"
                        ? t("editAccount.historyPhasePreparing")
                        : t("editAccount.historyPhaseInbox")}
                  {" : "}
                  {history.phase === "preparing"
                    ? t("editAccount.historyPreparingDetail", {
                        done: history.done.toLocaleString(),
                        total: history.total.toLocaleString(),
                      })
                    : (
                      <>
                        {t("editAccount.historyProgress", {
                          done: String(history.done),
                          total: String(history.total),
                        })}
                        {" — "}
                        {t("editAccount.historyImported", { count: String(history.inserted) })}
                      </>
                    )}
                </p>
              )}

              {history?.error && (
                <p className="mt-3 text-sm text-destructive">
                  {history.error}
                </p>
              )}
            </div>

            <Separator className="my-8" />
            <div className="rounded-lg border p-6">
              <h3 className="text-lg font-medium">{t("editAccount.repairTitle")}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("editAccount.repairDescription")}
              </p>
              <Button
                className="mt-4"
                variant="outline"
                onClick={handleRepairAttachments}
                disabled={repairing}
                data-ref="settings-account-repair-attachments"
              >
                {repairing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Paperclip className="size-4" />
                )}
                {repairing ? t("editAccount.repairRunning") : t("editAccount.repairTitle")}
              </Button>
            </div>

            <Separator className="my-8" />
            <div className="rounded-lg border border-destructive/30 p-6">
              <h3 className="text-lg font-medium text-destructive">{t("editAccount.dangerTitle")}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("editAccount.dangerDescription")}
              </p>
              <Button
                variant="destructive"
                className="mt-4"
                onClick={() => setDeleteOpen(true)}
                data-ref="settings-account-edit-delete"
              >
                <Trash2 className="size-4" />
                {t("editAccount.dangerButton")}
              </Button>
            </div>
          </>
        )}
        </div>
      </div>

      <div className="border-t bg-background px-4 py-2">
        <Button
          type="submit"
          size="sm"
          form="account-form"
          data-ref="settings-account-form-submit"
        >
          <Save className="size-4" />
          {t("save")}
        </Button>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("account.deleteAccount")}</DialogTitle>
            <DialogDescription>
              {t("editAccount.deleteDialogDescription", { email: account?.email ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? t("account.deleting") : t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
