"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Bell } from "lucide-react";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { getCurrentUserId, users, type UserSettings } from "@/lib/pocketbase";
import { useT } from "@/lib/i18n";
import { toast } from "sonner";

const DISMISS_KEY = "imiel:pushPromptDismissedAt";
const REPROMPT_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

function wasRecentlyDismissed(): boolean {
  if (typeof window === "undefined") return false;
  const raw = window.localStorage.getItem(DISMISS_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < REPROMPT_AFTER_MS;
}

export function PushPromptDialog() {
  const t = useT();
  const { permission, subscribe, needsInstall, hasActiveSubscription } =
    useNotifications();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (permission === "unsupported" || permission === "denied") return;
    if (wasRecentlyDismissed()) return;
    // En dev, le SW est desenregistre au demarrage (layout.tsx) : afficher
    // le prompt n'a aucun sens, subscribe() echouera de toute facon.
    if (process.env.NODE_ENV === "development") return;

    const userId = getCurrentUserId();
    if (!userId) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const settings = await users().getOne<UserSettings>(userId);
        if (cancelled) return;
        // Prompt si pas d'abonnement actif sur cet appareil,
        // meme si notifications_enabled = true (etat zombi possible
        // suite a un subscribe rate sur une autre session).
        if (settings?.notifications_enabled && hasActiveSubscription) return;
        setOpen(true);
      } catch {
        // Erreur silencieuse — ne pas bloquer l'app
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [permission, hasActiveSubscription]);

  const handleEnable = async () => {
    setBusy(true);
    try {
      await subscribe();
      const userId = getCurrentUserId();
      if (userId) {
        try {
          await users().update(userId, { notifications_enabled: true });
        } catch {
          // Souscription faite, le toggle peut etre active depuis settings
        }
      }
      toast.success(t("notifSettings.enabled"));
      setOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("notifSettings.updateError");
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleLater = () => {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : handleLater())}>
      <DialogContent data-ref="push-prompt-dialog" className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Bell className="size-6 text-primary" />
          </div>
          <DialogTitle className="text-center">
            {needsInstall
              ? t("notifPrompt.iosTitle")
              : t("notifPrompt.title")}
          </DialogTitle>
          <DialogDescription className="text-center">
            {needsInstall
              ? t("notifPrompt.iosDescription")
              : t("notifPrompt.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-center sm:gap-2">
          <Button variant="ghost" onClick={handleLater} disabled={busy}>
            {t("notifPrompt.later")}
          </Button>
          {!needsInstall && (
            <Button onClick={handleEnable} disabled={busy}>
              <Bell className="size-4" />
              {t("notifPrompt.enable")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
