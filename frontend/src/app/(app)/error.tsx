"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useT } from "@/lib/i18n";

const RECOVERY_KEY = "imiel:errorRecovery";

async function clearAllStorage(): Promise<boolean> {
  try {
    // Clear localStorage and sessionStorage
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
    // Clear cookies
    try {
      document.cookie.split(";").forEach((c) => {
        document.cookie = c.trim().split("=")[0] + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
      });
    } catch {}
    // Clear IndexedDB
    try {
      const dbs = await indexedDB.databases?.();
      if (dbs) {
        dbs.forEach((db) => { if (db.name) indexedDB.deleteDatabase(db.name); });
      }
    } catch {}
    // Ask SW to clear its caches
    const reg = await navigator.serviceWorker?.ready;
    if (reg?.active) {
      reg.active.postMessage({ type: "CLEAR_CACHE" });
    }
    // Also clear from main thread
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    return true;
  } catch {
    return false;
  }
}

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
  const [recovering, setRecovering] = useState(false);

  // Auto-recovery: clear caches and reload once on first crash
  useEffect(() => {
    console.error("[AppError]", error);

    const lastRecovery = sessionStorage.getItem(RECOVERY_KEY);
    const now = Date.now();

    // Auto-recover max once per 60s to avoid infinite reload loop
    if (!lastRecovery || now - Number(lastRecovery) > 60_000) {
      sessionStorage.setItem(RECOVERY_KEY, String(now));
      setRecovering(true);
      clearAllStorage().then(() => {
        window.location.replace("/");
        window.location.reload();
      });
    }
  }, [error]);

  if (recovering) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="size-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Recuperation en cours...</p>
        </div>
      </div>
    );
  }

  async function handleManualRecovery() {
    setRecovering(true);
    await clearAllStorage();
    // Unregister SW entirely for a clean slate
    const regs = await navigator.serviceWorker?.getRegistrations();
    if (regs) {
      await Promise.all(regs.map((r) => r.unregister()));
    }
    window.location.replace("/");
    window.location.reload();
  }

  return (
    <div className="flex h-dvh items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center">
        <AlertTriangle className="size-10 text-destructive" />
        <h2 className="text-lg font-semibold">{t("error.title")}</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {t("error.description")}
        </p>
        <div className="flex gap-2">
          <Button onClick={reset} variant="outline">
            {t("error.retry")}
          </Button>
          <Button onClick={handleManualRecovery} variant="default">
            <RefreshCw className="mr-2 size-4" />
            Vider le cache et recharger
          </Button>
        </div>
      </div>
    </div>
  );
}
