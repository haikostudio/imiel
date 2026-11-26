"use client";

// Bandeau « Nouvelle version disponible » de l'app d'ordinateur. La mise a
// jour est PROPOSEE : rien ne s'installe sans le clic « Installer ». La
// signature du paquet est verifiee par l'app (desktop/src-tauri/src/maj.rs) :
// une version falsifiee est refusee avant toute installation.
import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { isDesktopApp } from "@/lib/desktop";

type MiseAJour = { version: string; notes?: string | null; date?: string | null };
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const SIX_HEURES = 6 * 60 * 60 * 1000;
const CLE_REPORT = "imiel:majReportee";

function invokeTauri(): Invoke | null {
  if (typeof window === "undefined" || !isDesktopApp()) return null;
  const w = window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } };
  return w.__TAURI__?.core?.invoke ?? null;
}

export function DesktopUpdateBanner() {
  const t = useT();
  const [maj, setMaj] = useState<MiseAJour | null>(null);
  const [notes, setNotes] = useState(false);
  const [etat, setEtat] = useState<"repos" | "installation" | "erreur">("repos");
  const [erreur, setErreur] = useState("");

  const verifier = useCallback(async () => {
    const invoke = invokeTauri();
    if (!invoke) return;
    try {
      const r = (await invoke("verifier_mise_a_jour")) as MiseAJour | null;
      if (r && sessionStorage.getItem(CLE_REPORT) !== r.version) setMaj(r);
    } catch {
      // Nuage injoignable ou ancienne app sans la commande : rien a proposer.
    }
  }, []);

  useEffect(() => {
    void verifier();
    const id = setInterval(() => void verifier(), SIX_HEURES);
    return () => clearInterval(id);
  }, [verifier]);

  if (!maj) return null;

  const installer = async () => {
    const invoke = invokeTauri();
    if (!invoke) return;
    setEtat("installation");
    try {
      await invoke("installer_mise_a_jour"); // l'app redemarre d'elle-meme
    } catch (e) {
      setEtat("erreur");
      setErreur(String(e));
    }
  };

  return (
    <div data-ref="desktop-update-banner" className="border-b bg-accent px-4 py-2 text-sm text-accent-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Download className="size-4 shrink-0" />
        <span className="font-medium">{t("update.available").replace("{version}", maj.version)}</span>
        {maj.notes && (
          <button type="button" className="underline underline-offset-2" onClick={() => setNotes((v) => !v)} data-ref="desktop-update-notes-toggle">
            {t("update.whatsNew")}
          </button>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={installer} disabled={etat === "installation"} data-ref="desktop-update-install">
            {etat === "installation" && <Loader2 className="size-4 animate-spin" />}
            {etat === "installation" ? t("update.installing") : t("update.install")}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("update.later")}
            title={t("update.later")}
            onClick={() => {
              sessionStorage.setItem(CLE_REPORT, maj.version);
              setMaj(null);
            }}
          >
            <X className="size-4" />
          </Button>
        </span>
      </div>
      {notes && maj.notes && <p className="mt-2 whitespace-pre-line text-muted-foreground" data-ref="desktop-update-notes">{maj.notes}</p>}
      {etat === "erreur" && <p className="mt-1 font-medium text-destructive">{t("update.failed").replace("{message}", erreur)}</p>}
    </div>
  );
}
