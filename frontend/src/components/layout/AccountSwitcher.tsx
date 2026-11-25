"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Mail, Settings } from "lucide-react";
import { hashNavigate, hashSetParams } from "@/lib/hash-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { useActiveAccount } from "@/lib/hooks/useActiveAccount";
import { folders as foldersCollection, type Folder } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

interface AccountStats {
  unread: number;
  total: number;
}

function useAccountStats(accountIds: string[]): Map<string, AccountStats> {
  const [stats, setStats] = useState<Map<string, AccountStats>>(new Map());
  const foldersRefreshKey = useMailStore((s) => s.foldersRefreshKey);

  useEffect(() => {
    if (accountIds.length === 0) return;

    let cancelled = false;

    async function fetchStats() {
      try {
        const allFolders = await foldersCollection().getFullList<Folder>({
          sort: "sort_order",
        });
        if (cancelled) return;

        const map = new Map<string, AccountStats>();
        for (const folder of allFolders) {
          const current = map.get(folder.account) ?? { unread: 0, total: 0 };
          current.unread += folder.unread_count;
          current.total += folder.total_count;
          map.set(folder.account, current);
        }
        setStats(map);
      } catch {
        // ignore
      }
    }

    fetchStats();

    // Real-time updates via WebSocket channel → invalidateFolders → foldersRefreshKey

    return () => {
      cancelled = true;
    };
  }, [accountIds.join(","), foldersRefreshKey]);

  return stats;
}

export function AccountSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { accounts } = useAccounts();
  const { activeAccountId, activeAccount, setActiveAccount } =
    useActiveAccount();
  const t = useT();
  const accountStats = useAccountStats(accounts.map((a) => a.id));

  /**
   * Choisir une boite l'inscrit dans l'ADRESSE (`?a=<compte>`, retire pour
   * "Tous les comptes") : recharger la page ou rouvrir le lien retombe sur la
   * meme boite. On REMPLACE l'entree d'historique (changer de boite filtre
   * l'ecran courant, ce n'est pas un nouvel ecran) pour que le bouton
   * "precedent" continue de designer l'ecran precedent.
   */
  function selectAccount(id: string | "all") {
    setActiveAccount(id);
    hashSetParams({ a: id === "all" ? null : id }, { replace: true });
  }

  const displayLabel =
    activeAccountId === "all"
      ? t("account.allAccounts")
      : activeAccount?.email ?? t("account.noAccount");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={collapsed ? "icon" : "default"}
          className={cn(
            collapsed ? "w-full px-0" : "w-full justify-start gap-2 px-3 py-2 h-auto"
          )}
          data-ref="sidebar-account-switcher"
        >
          <Mail className="size-4 shrink-0" />
          {!collapsed && (
            <>
              <span data-ref="sidebar-account-switcher-label" className="truncate text-sm font-medium">{displayLabel}</span>
              <ChevronDown className="ml-auto size-4 shrink-0 opacity-50" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[320px]" data-ref="sidebar-account-menu">
        <DropdownMenuItem
          onClick={() => selectAccount("all")}
          className={cn(
            "gap-2",
            activeAccountId === "all" && "bg-foreground text-background hover:bg-foreground hover:text-background"
          )}
          data-ref="sidebar-account-menu-all"
        >
          <Mail className="size-4" />
          <span className="flex-1">{t("account.allAccounts")}</span>
          {(() => {
            let totalUnread = 0;
            let totalAll = 0;
            accountStats.forEach((s) => { totalUnread += s.unread; totalAll += s.total; });
            const isActive = activeAccountId === "all";
            return totalAll > 0 ? (
              <span className={cn("text-xs tabular-nums", isActive ? "text-background/60" : "text-muted-foreground")}>
                {totalUnread > 0 && <span className={cn("font-medium", isActive ? "text-background" : "text-foreground")}>{totalUnread}</span>}
                {totalUnread > 0 && " / "}
                {totalAll}
              </span>
            ) : null;
          })()}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {accounts.map((account) => {
          const stat = accountStats.get(account.id);
          const isActive = activeAccountId === account.id;
          return (
            <DropdownMenuItem
              key={account.id}
              onClick={() => selectAccount(account.id)}
              className={cn(
                "gap-2",
                isActive && "bg-foreground text-background hover:bg-foreground hover:text-background"
              )}
            >
              <span
                className="size-2 rounded-full shrink-0"
                style={{ backgroundColor: account.color || "#94a3b8" }}
              />
              <span className="flex-1 truncate">{account.email}</span>
              {stat && stat.total > 0 && (
                <span className={cn("text-xs tabular-nums", isActive ? "text-background/60" : "text-muted-foreground")}>
                  {stat.unread > 0 && <span className={cn("font-medium", isActive ? "text-background" : "text-foreground")}>{stat.unread}</span>}
                  {stat.unread > 0 && " / "}
                  {stat.total}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}

        {accounts.length > 0 && <DropdownMenuSeparator />}

        <DropdownMenuItem
          onSelect={() => hashNavigate("/settings?tab=accounts")}
          className={cn("gap-2")}
          data-ref="sidebar-account-menu-manage"
        >
          <Settings className="size-4" />
          <span>{t("account.manageAccounts")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
