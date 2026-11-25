"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type AccountScan,
  useSpamScanStore,
} from "@/lib/stores/spam-scan-store";
import { useT } from "@/lib/i18n";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  Loader2,
  Minus,
  ShieldCheck,
  X,
} from "lucide-react";

export function SpamScanProgress() {
  const t = useT();
  const open = useSpamScanStore((s) => s.open);
  const running = useSpamScanStore((s) => s.running);
  const accounts = useSpamScanStore((s) => s.accounts);
  const globalError = useSpamScanStore((s) => s.globalError);
  const close = useSpamScanStore((s) => s.close);

  // Agregats globaux derives des comptes (source de verite : par compte).
  const totals = useMemo(() => {
    let total = 0;
    let processed = 0;
    let recovered = 0;
    for (const a of accounts) {
      total += a.total;
      processed += a.processed;
      recovered += a.recovered;
    }
    return { total, processed, recovered };
  }, [accounts]);

  // Premiere section "en cours" ouverte par defaut ; suit l'avancement.
  const [openSections, setOpenSections] = useState<string[]>([]);

  useEffect(() => {
    if (!open) {
      setOpenSections([]);
      return;
    }
    // Selection initiale : premier compte en cours, sinon premier tout court.
    setOpenSections((prev) => {
      if (prev.length > 0) return prev;
      const firstRunning = accounts.find((a) => a.status === "running");
      const fallback = accounts[0];
      const initial = firstRunning?.accountId ?? fallback?.accountId;
      return initial ? [initial] : [];
    });
  }, [open, accounts]);

  if (!open) return null;

  const pct =
    totals.total > 0 ? Math.round((totals.processed / totals.total) * 100) : 0;
  const allDone = !running && !globalError;
  const isMultiAccount = accounts.length > 1;

  return (
    <div
      data-ref="spam-scan-progress"
      className="bg-popover text-popover-foreground fixed bottom-4 right-4 z-[90] flex max-h-[70vh] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border shadow-xl"
    >
      {/* En-tete global */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {running ? (
          <Loader2 className="text-primary size-4 shrink-0 animate-spin" />
        ) : globalError ? (
          <AlertTriangle className="text-destructive size-4 shrink-0" />
        ) : (
          <ShieldCheck className="size-4 shrink-0 text-emerald-500" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{t("spamScan.title")}</p>
          <p className="text-muted-foreground truncate text-xs">
            {totals.total > 0
              ? t("spamScan.progress", {
                  done: String(totals.processed),
                  total: String(totals.total),
                })
              : t("spamScan.starting")}
            {" · "}
            <span className="tabular-nums">{pct}%</span>
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          className="hover:bg-muted rounded p-1"
          aria-label={t("spamScan.close")}
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Barre globale */}
      <div className="px-3 py-2">
        <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              globalError
                ? "bg-destructive"
                : allDone
                  ? "bg-emerald-500"
                  : "bg-primary"
            )}
            style={{
              width: `${totals.total > 0 ? pct : running ? 15 : 0}%`,
            }}
          />
        </div>
      </div>

      {/* Accordeon par compte (ou liste simple si 1 compte) */}
      <ScrollArea className="min-h-0 flex-1">
        {isMultiAccount ? (
          <Accordion
            type="multiple"
            value={openSections}
            onValueChange={setOpenSections}
            className="px-1 pb-1"
          >
            {accounts.map((acc) => (
              <AccountSection key={acc.accountId} account={acc} />
            ))}
          </Accordion>
        ) : accounts[0] ? (
          <div className="px-3 pb-2">
            <AccountBody account={accounts[0]} />
          </div>
        ) : null}
      </ScrollArea>

      {/* Pied : resume global */}
      {allDone ? (
        <div className="flex items-center gap-2 border-t px-3 py-2 text-xs">
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
          <span>
            {t("spamScan.doneSummary", { count: String(totals.recovered) })}
          </span>
        </div>
      ) : null}
      {globalError ? (
        <div className="text-destructive flex items-center gap-2 border-t px-3 py-2 text-xs">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="truncate">
            {t("spamScan.error", { error: globalError })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function AccountSection({ account }: { account: AccountScan }) {
  const t = useT();
  const pct =
    account.total > 0
      ? Math.round((account.processed / account.total) * 100)
      : 0;

  return (
    <AccordionItem
      value={account.accountId}
      className="border-b last:border-b-0"
    >
      <AccordionTrigger className="px-2 py-2 hover:no-underline">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <StatusIcon status={account.status} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {account.accountEmail}
            </p>
            <p className="text-muted-foreground truncate text-[11px]">
              {summaryLine(account, t)}
            </p>
          </div>
          {account.total > 0 && account.status !== "pending" ? (
            <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
              {pct}%
            </span>
          ) : null}
        </div>
      </AccordionTrigger>
      <AccordionContent className="px-2 pb-2">
        <AccountBody account={account} />
      </AccordionContent>
    </AccordionItem>
  );
}

function AccountBody({ account }: { account: AccountScan }) {
  const t = useT();
  const pct =
    account.total > 0
      ? Math.round((account.processed / account.total) * 100)
      : 0;

  const barColor =
    account.status === "error"
      ? "bg-destructive"
      : account.status === "done"
        ? "bg-emerald-500"
        : "bg-primary";

  return (
    <div className="flex flex-col gap-2">
      <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
        <div
          className={cn("h-full rounded-full transition-all duration-300", barColor)}
          style={{
            width: `${
              account.total > 0
                ? pct
                : account.status === "running"
                  ? 15
                  : 0
            }%`,
          }}
        />
      </div>

      {account.status === "error" && account.error ? (
        <p className="text-destructive flex items-start gap-1.5 text-[11px]">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="break-words">{account.error}</span>
        </p>
      ) : null}

      <ul className="flex flex-col">
        {account.items.map((it) => (
          <li key={it.id} className="flex items-start gap-2 rounded px-1 py-1">
            {it.status === "recovered" ? (
              <Inbox className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
            ) : (
              <Minus className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "truncate text-xs",
                  it.status === "kept" && "text-muted-foreground"
                )}
              >
                {it.subject || t("spamScan.noSubject")}
              </p>
              <p className="text-muted-foreground truncate text-[11px]">
                {it.from} ·{" "}
                {it.status === "recovered"
                  ? t("spamScan.recovered")
                  : t("spamScan.kept")}
              </p>
            </div>
          </li>
        ))}
        {account.items.length === 0 &&
        (account.status === "done" || account.status === "error") ? (
          <li className="text-muted-foreground px-1 py-2 text-center text-[11px]">
            {t("spamScan.empty")}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function StatusIcon({ status }: { status: AccountScan["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" />;
    case "done":
      return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />;
    case "error":
      return <AlertTriangle className="text-destructive size-3.5 shrink-0" />;
    case "pending":
    default:
      return <Clock className="text-muted-foreground size-3.5 shrink-0" />;
  }
}

function summaryLine(
  account: AccountScan,
  t: (key: string, vars?: Record<string, string>) => string
): string {
  if (account.status === "pending") return t("spamScan.starting");
  if (account.status === "error")
    return t("spamScan.error", { error: account.error ?? "" });
  if (account.status === "done")
    return t("spamScan.doneSummary", { count: String(account.recovered) });
  // running
  if (account.total > 0) {
    return t("spamScan.progress", {
      done: String(account.processed),
      total: String(account.total),
    });
  }
  return t("spamScan.starting");
}
