"use client";

import { useState, useEffect } from "react";
import AuthenticatedLayout from "@/components/layout/AuthenticatedLayout";
import { HashRouter } from "@/components/layout/HashRouter";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Rediriger les URLs path-based vers les hash equivalentes
    // Ex: /mail/inbox -> /#/mail/inbox
    if (!window.location.hash && window.location.pathname !== "/") {
      window.location.replace("/#" + window.location.pathname + window.location.search);
      return;
    }
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div data-ref="app-loading" className="flex h-dvh items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Chargement...</p>
        </div>
      </div>
    );
  }

  return (
    <AuthenticatedLayout>
      <HashRouter />
    </AuthenticatedLayout>
  );
}
