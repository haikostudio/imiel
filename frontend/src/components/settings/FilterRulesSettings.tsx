"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFilterRules } from "@/lib/hooks/useFilterRules";
import { useT } from "@/lib/i18n";
import { t as tStatic } from "@/lib/i18n";
import type { FilterRule } from "@/lib/pocketbase";
import { filterRules } from "@/lib/pocketbase";

export default function FilterRulesSettings() {
  const t = useT();
  const { rules, loading, deleteRule, refresh } = useFilterRules();
  const [deleteTarget, setDeleteTarget] = useState<FilterRule | null>(null);

  const handleToggleActive = async (rule: FilterRule) => {
    try {
      await filterRules().update(rule.id, { is_active: !rule.is_active });
      refresh();
    } catch {
      // silent
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteRule(deleteTarget.id);
    setDeleteTarget(null);
    toast.success(tStatic("settings.ruleDeleted"));
  };

  if (loading) {
    return (
      <div data-ref="settings-filters" className="space-y-6">
        <h3 className="text-lg font-medium">{t("settings.filterRules")}</h3>
        <div className="flex items-center justify-center py-8">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div data-ref="settings-filters" className="space-y-6">
      <h3 className="text-lg font-medium">{t("settings.filterRules")}</h3>

      {rules.length === 0 ? (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            {t("settings.noFilterRules")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("settings.noFilterRulesDesc")}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {rule.name}
                  </span>
                  <Badge variant={rule.is_active ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
                    {rule.is_active
                      ? t("settings.filterRuleActive")
                      : t("settings.filterRuleInactive")}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-muted-foreground">
                    {t("settings.filterRuleCriteria", {
                      count: String(rule.criteria.length),
                    })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("settings.filterRuleActions", {
                      count: String(rule.actions.length),
                    })}
                  </span>
                  {rule.source_email && (
                    <span className="text-xs text-muted-foreground truncate">
                      {rule.source_email}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Switch
                  size="sm"
                  checked={rule.is_active}
                  onCheckedChange={() => handleToggleActive(rule)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(rule)}
                  className="size-8 p-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings.deleteRuleConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.deleteRuleConfirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
