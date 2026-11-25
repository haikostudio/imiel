"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { hashNavigate } from "@/lib/hash-router";
import { useT } from "@/lib/i18n";
import type { Account } from "@/lib/pocketbase";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Bandeau d'alerte global, affiche en haut de l'app quand un compte a cesse
 * de se synchroniser (sync_status=error ou compte desactive avec une erreur,
 * typiquement un token OAuth2 expire/revoque). Volontairement non masquable :
 * il reste tant que le probleme n'est pas corrige (reconnexion du compte).
 * Un clic ouvre une modale qui explique le probleme en detail.
 */
function isBroken(a: Account): boolean {
  return a.sync_status === "error" || (!a.is_active && !!a.sync_error);
}

function isAuthError(a: Account): boolean {
  const err = (a.sync_error || "").toLowerCase();
  return (
    err.includes("token") ||
    err.includes("oauth") ||
    err.includes("revoked") ||
    err.includes("grant")
  );
}

function reasonKey(a: Account): string {
  return isAuthError(a) ? "accountError.reasonAuth" : "accountError.reasonGeneric";
}

export function AccountErrorBanner() {
  const t = useT();
  const { accounts } = useAccounts();
  const [open, setOpen] = useState(false);
  const broken = accounts.filter(isBroken);
  if (broken.length === 0) return null;

  const first = broken[0];
  const summary =
    broken.length === 1
      ? t("accountError.single", { email: first.email, reason: t(reasonKey(first)) })
      : t("accountError.multiple", { count: String(broken.length) });

  function reconnect(account: Account) {
    setOpen(false);
    hashNavigate(`/settings/accounts/${account.id}`);
  }

  return (
    <>
      <button
        type="button"
        data-ref="account-error-banner"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3 bg-destructive px-4 py-2.5 text-left text-sm font-medium text-white shadow-md hover:bg-destructive/90"
      >
        <AlertTriangle className="size-5 shrink-0" />
        <p className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{t("accountError.title")} : </span>
          <span>{summary}</span>
        </p>
        <span className="shrink-0 rounded-md bg-white/20 px-3 py-1 text-xs font-semibold text-white">
          {t("accountError.reconnect")}
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-5" />
              {t("accountError.detailsTitle")}
            </DialogTitle>
            <DialogDescription>{t("accountError.detailsIntro")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            {broken.map((a) => (
              <div key={a.id} className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    {t("accountError.accountLabel")}
                  </p>
                  <p className="font-semibold">{a.email}</p>
                </div>

                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    {t("accountError.whatHappened")}
                  </p>
                  <p>{isAuthError(a) ? t("accountError.authExplain") : t("accountError.genericExplain")}</p>
                </div>

                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    {t("accountError.howToFix")}
                  </p>
                  <p>{t("accountError.fixStep")}</p>
                </div>

                {a.sync_error ? (
                  <div>
                    <p className="text-xs font-medium uppercase text-muted-foreground">
                      {t("accountError.technical")}
                    </p>
                    <p className="break-words font-mono text-xs text-muted-foreground">{a.sync_error}</p>
                  </div>
                ) : null}

                {a.last_synced_at ? (
                  <p className="text-xs text-muted-foreground">
                    {t("accountError.lastSync")} : {new Date(a.last_synced_at).toLocaleString()}
                  </p>
                ) : null}

                <Button variant="destructive" size="sm" onClick={() => reconnect(a)}>
                  {t("accountError.reconnect")}
                </Button>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("accountError.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
