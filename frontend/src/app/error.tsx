"use client";

import { useEffect, useState } from "react";

const RECOVERY_KEY = "imiel:rootErrorRecovery";

export default function RootError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    console.error("[RootError]", error);

    const lastRecovery = sessionStorage.getItem(RECOVERY_KEY);
    const now = Date.now();

    if (!lastRecovery || now - Number(lastRecovery) > 60_000) {
      sessionStorage.setItem(RECOVERY_KEY, String(now));
      setRecovering(true);
      // Clear all client storage
      try { localStorage.clear(); } catch {}
      try {
        document.cookie.split(";").forEach((c) => {
          document.cookie = c.trim().split("=")[0] + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
        });
      } catch {}
      try {
        indexedDB.databases?.()?.then((dbs) => {
          dbs.forEach((db) => { if (db.name) indexedDB.deleteDatabase(db.name); });
        });
      } catch {}
      caches.keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .then(() => {
          window.location.replace("/");
          window.location.reload();
        });
    }
  }, [error]);

  if (recovering) {
    return (
      <div style={{ display: "flex", height: "100dvh", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "#888", fontSize: "14px" }}>Recuperation en cours...</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100dvh", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "16px" }}>
      <p style={{ color: "#888", fontSize: "14px" }}>Une erreur est survenue.</p>
      <button
        type="button"
        onClick={() => {
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
            indexedDB.databases?.()?.then((dbs) => {
              dbs.forEach((db) => { if (db.name) indexedDB.deleteDatabase(db.name); });
            });
          } catch {}
          // Clear Cache API + unregister SW
          caches.keys()
            .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
            .then(() => {
              navigator.serviceWorker?.getRegistrations().then((regs) => {
                Promise.all(regs.map((r) => r.unregister())).then(() => {
                  window.location.replace("/");
                  window.location.reload();
                });
              });
            });
        }}
        style={{ padding: "8px 16px", border: "1px solid #ccc", borderRadius: "6px", cursor: "pointer", fontSize: "14px" }}
      >
        Vider le cache et recharger
      </button>
    </div>
  );
}
