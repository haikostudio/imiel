"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";
import { useSettingsStore, blockSender, unblockSender } from "@/lib/hooks/useSettings";
import { useT } from "@/lib/i18n";

export default function BlockedSettings() {
  const t = useT();
  const blockedSenders = useSettingsStore((s) => s.blockedSenders);
  const [email, setEmail] = useState("");

  async function handleAdd() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) return;
    await blockSender(trimmed);
    setEmail("");
  }

  return (
    <div data-ref="settings-blocked" className="space-y-6">
      <h3 className="text-lg font-medium">{t("settings.blockedSenders")}</h3>

      <div className="flex items-center gap-2">
        <Input
          type="email"
          placeholder={t("settings.addBlockedPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          className="max-w-sm"
        />
        <Button size="sm" onClick={handleAdd} disabled={!email.trim()}>
          {t("settings.block")}
        </Button>
      </div>

      {blockedSenders.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("settings.noBlockedSenders")}
        </p>
      ) : (
        <div className="space-y-2">
          {blockedSenders.map((addr) => (
            <div
              key={addr}
              className="flex items-center justify-between gap-2 rounded-md border py-1 pl-3 pr-1"
            >
              <span className="min-w-0 flex-1 truncate text-sm" title={addr}>
                {addr}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => unblockSender(addr)}
              >
                <X className="size-3.5" />
                <span className="hidden sm:inline">{t("settings.unblock")}</span>
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
