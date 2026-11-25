"use client";

import { useHashRouter } from "@/lib/hash-router";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Plus,
  Pencil,
  Trash2,
  Mail,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { formatTimeAgo } from "@/lib/utils/date";
import { getInitials } from "@/lib/utils/avatar";
import { useState } from "react";
import { toast } from "sonner";
import type { Account } from "@/lib/pocketbase";
import { getCurrentUserId } from "@/lib/pocketbase";
import { getOAuthRedirectOrigin } from "@/lib/oauth-origin";
import { useT } from "@/lib/i18n";

function SyncStatusIndicator({ account }: { account: Account }) {
  const t = useT();
  switch (account.sync_status) {
    case "syncing":
      return (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <RefreshCw className="size-3 animate-spin" />
          {t("account.syncing")}
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1 text-destructive">
          <AlertCircle className="size-3" />
          {t("error")}
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-green-600">
          <CheckCircle2 className="size-3" />
          {t("account.connected")}
        </span>
      );
  }
}

export default function AccountsPage() {
  const t = useT();
  const { navigate } = useHashRouter();
  const { accounts, loading, deleteAccount } = useAccounts();
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteAccount(deleteTarget.id);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-9 w-40" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div data-ref="settings-accounts" className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 data-ref="settings-accounts-title" className="min-w-0 truncate text-lg font-semibold sm:text-xl">{t("settings.emailAccounts")}</h2>
        <Button size="sm" className="shrink-0" onClick={() => navigate("/settings/accounts/new")} data-ref="settings-accounts-add">
          <Plus className="size-4" />
          {t("account.addAccount")}
        </Button>
      </div>

      {accounts.length === 0 && (
        <Card>
          <CardContent data-ref="settings-accounts-empty" className="flex flex-col items-center justify-center py-12 text-center">
            <Mail className="mb-4 size-12 text-muted-foreground" />
            <p className="text-lg font-medium">{t("account.noAccountConfigured")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("account.addFirstAccount")}
            </p>
          </CardContent>
        </Card>
      )}

      {accounts?.map((account) => {
        if (!account?.id) return null;
        const label = account.label ?? account.email ?? "";
        const email = account.email ?? "";
        return (
        <Card key={account.id} data-ref="settings-accounts-card" className="py-3">
          <CardContent className="px-3 sm:px-4">
            <div className="flex items-start gap-3">
              <div
                className="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
                style={{ backgroundColor: account.color || "#94a3b8" }}
              >
                {getInitials(label)}
              </div>

              <div className="min-w-0 flex-1">
                <CardTitle className="truncate text-sm leading-5">
                  {label}
                </CardTitle>
                <p className="truncate text-sm text-muted-foreground">
                  {email}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="font-medium">
                    {account.protocol?.toUpperCase() || "IMAP"}
                  </span>
                  <span aria-hidden>·</span>
                  <SyncStatusIndicator account={account} />
                  {account.last_synced_at ? (
                    <>
                      <span aria-hidden>·</span>
                      <span>{formatTimeAgo(new Date(account.last_synced_at))}</span>
                    </>
                  ) : null}
                </div>

                {account.sync_error && (
                  <p className="mt-1 truncate text-xs text-destructive">
                    {account.sync_error.includes("reconnect") || account.sync_error.includes("revoked")
                      ? t("account.oauthExpired")
                      : account.sync_error}
                  </p>
                )}
                {account.auth_type === "oauth2" && account.sync_status === "error" &&
                  account.sync_error?.includes("revoked") && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 text-destructive border-destructive"
                    onClick={async () => {
                      const userId = getCurrentUserId();
                      if (!userId) return;
                      try {
                        const res = await fetch(`/worker/oauth/google/url?userId=${userId}&origin=${encodeURIComponent(getOAuthRedirectOrigin())}`);
                        const data = await res.json();
                        if (data.url) {
                          window.location.href = data.url;
                        }
                      } catch {
                        toast.error(t("account.oauthError"));
                      }
                    }}
                  >
                    <RefreshCw className="size-3.5" />
                    {t("account.oauthReconnect")}
                  </Button>
                )}
              </div>

              <div className="-mr-1 -mt-0.5 flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  title={t("edit")}
                  onClick={() =>
                    navigate(`/settings/accounts/${account.id}`)
                  }
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:text-destructive"
                  title={t("delete")}
                  onClick={() => setDeleteTarget(account)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
        );
      })}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent data-ref="settings-accounts-delete-dialog">
          <DialogHeader>
            <DialogTitle>{t("account.deleteAccount")}</DialogTitle>
            <DialogDescription>
              {t("account.deleteConfirm", { email: deleteTarget?.email ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
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
