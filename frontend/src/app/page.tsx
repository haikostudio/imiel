"use client";

import { useState, useEffect } from "react";
import AuthenticatedLayout from "@/components/layout/AuthenticatedLayout";
import { HashRouter } from "@/components/layout/HashRouter";

export default function Home() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Gerer le redirect OAuth
    const params = new URLSearchParams(window.location.search);
    if (params.get("oauth_redirect") === "settings") {
      const oauthParams = new URLSearchParams();
      oauthParams.set("tab", "accounts");
      if (params.get("oauth_success")) oauthParams.set("oauth_success", "true");
      if (params.get("oauth_error")) oauthParams.set("oauth_error", params.get("oauth_error")!);
      history.replaceState(null, "", `/#/settings?${oauthParams.toString()}`);
    }

    // Si pas de hash, rediriger vers la page d'introduction (accueil)
    if (!window.location.hash || window.location.hash === "#" || window.location.hash === "#/") {
      history.replaceState(null, "", "/#/intro");
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
