"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n";
import { useMailStore } from "@/lib/stores/mail-store";
import { useFilterRules, applyRuleRetroactively } from "@/lib/hooks/useFilterRules";
import { blockSender } from "@/lib/hooks/useSettings";
import type {
  CriterionField,
  CriterionOperator,
  FilterCriterion,
  FilterAction,
  FilterActionType,
} from "@/lib/pocketbase";

const FIELDS: CriterionField[] = [
  "from_address",
  "from_domain",
  "to_address",
  "subject",
  "body",
  "has_attachments",
];

const OPERATORS_BY_FIELD: Record<CriterionField, CriterionOperator[]> = {
  from_address: ["equals", "contains", "starts_with", "ends_with"],
  from_domain: ["equals", "contains"],
  to_address: ["equals", "contains"],
  subject: ["contains", "equals", "starts_with", "ends_with", "not_contains"],
  body: ["contains", "not_contains"],
  has_attachments: ["is_true", "is_false"],
};

const ACTION_TYPES: FilterActionType[] = [
  "move_to_spam",
  "move_to_trash",
  "archive",
  "mark_as_read",
  "add_label",
  "block_sender",
];

function defaultCriterion(email?: string): FilterCriterion {
  return {
    field: "from_address",
    operator: "equals",
    value: email || "",
  };
}

export function FilterRuleDialog() {
  const t = useT();
  const filterRuleOpen = useMailStore((s) => s.filterRuleOpen);
  const filterRuleMessage = useMailStore((s) => s.filterRuleMessage);
  const closeFilterRule = useMailStore((s) => s.closeFilterRule);
  const { createRule } = useFilterRules();

  const [criteria, setCriteria] = useState<FilterCriterion[]>([defaultCriterion()]);
  const [matchMode, setMatchMode] = useState<"all" | "any">("all");
  const [activeActions, setActiveActions] = useState<Record<FilterActionType, boolean>>({
    move_to_spam: true,
    move_to_trash: false,
    archive: false,
    mark_as_read: false,
    add_label: false,
    block_sender: false,
  });
  const [applyRetroactive, setApplyRetroactive] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset state when message changes
  useEffect(() => {
    if (filterRuleMessage) {
      const email = filterRuleMessage.from_address?.address || "";
      setCriteria([defaultCriterion(email)]);
      setMatchMode("all");
      setActiveActions({
        move_to_spam: true,
        move_to_trash: false,
        archive: false,
        mark_as_read: false,
        add_label: false,
        block_sender: false,
      });
      setApplyRetroactive(false);
    }
  }, [filterRuleMessage]);

  const updateCriterion = useCallback(
    (index: number, updates: Partial<FilterCriterion>) => {
      setCriteria((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], ...updates };
        return next;
      });
    },
    []
  );

  const handleFieldChange = useCallback(
    (index: number, field: CriterionField) => {
      const operators = OPERATORS_BY_FIELD[field];
      setCriteria((prev) => {
        const next = [...prev];
        next[index] = {
          field,
          operator: operators[0],
          value: field === "has_attachments" ? "" : next[index].value,
        };
        return next;
      });
    },
    []
  );

  const addCriterion = useCallback(() => {
    setCriteria((prev) => [...prev, defaultCriterion()]);
  }, []);

  const removeCriterion = useCallback((index: number) => {
    setCriteria((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const toggleAction = useCallback((type: FilterActionType) => {
    setActiveActions((prev) => ({ ...prev, [type]: !prev[type] }));
  }, []);

  const handleSave = async () => {
    // Validation
    const hasEmptyValue = criteria.some(
      (c) => c.field !== "has_attachments" && !c.value.trim()
    );
    if (hasEmptyValue) return;

    const hasAction = Object.values(activeActions).some(Boolean);
    if (!hasAction) return;

    setSaving(true);

    const ruleActions: FilterAction[] = [];
    for (const [type, active] of Object.entries(activeActions)) {
      if (active) {
        ruleActions.push({ type: type as FilterActionType });
      }
    }

    const senderEmail = filterRuleMessage?.from_address?.address || "";
    const firstValue = criteria[0]?.value || senderEmail;
    const name = `${t("message.filterSimilar")} - ${firstValue}`;

    const rule = await createRule({
      name,
      criteria,
      actions: ruleActions,
      match_mode: matchMode,
      source_email: senderEmail,
    });

    if (rule) {
      // Block sender if action selected
      if (activeActions.block_sender && senderEmail) {
        await blockSender(senderEmail);
      }

      // Apply retroactively
      if (applyRetroactive) {
        const count = await applyRuleRetroactively(criteria, ruleActions, matchMode);
        if (count > 0) {
          toast.success(t("filterRule.retroactiveApplied", { count: String(count) }));
        }
      }

      toast.success(t("filterRule.created"));
    }

    setSaving(false);
    closeFilterRule();
  };

  const senderName =
    filterRuleMessage?.from_address?.name ||
    filterRuleMessage?.from_address?.address ||
    "";

  return (
    <Dialog open={filterRuleOpen} onOpenChange={(open) => !open && closeFilterRule()}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("filterRule.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {senderName
              ? `${t("filterRule.dialogDescription")} — ${senderName}`
              : t("filterRule.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        {/* Criteria section */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">{t("filterRule.criteria")}</h4>
            {criteria.length > 1 && (
              <Select value={matchMode} onValueChange={(v) => setMatchMode(v as "all" | "any")}>
                <SelectTrigger size="sm" className="w-auto text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("filterRule.matchAll")}</SelectItem>
                  <SelectItem value="any">{t("filterRule.matchAny")}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            {criteria.map((criterion, index) => (
              <CriterionRow
                key={index}
                criterion={criterion}
                onFieldChange={(field) => handleFieldChange(index, field)}
                onOperatorChange={(op) => updateCriterion(index, { operator: op })}
                onValueChange={(value) => updateCriterion(index, { value })}
                onRemove={() => removeCriterion(index)}
                canRemove={criteria.length > 1}
                t={t}
              />
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={addCriterion}
            className="w-full"
          >
            <Plus className="mr-1 size-3" />
            {t("filterRule.addCriterion")}
          </Button>
        </div>

        <Separator />

        {/* Actions section */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium">{t("filterRule.actions")}</h4>
          <div className="space-y-2">
            {ACTION_TYPES.map((type) => (
              <div key={type} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-sm">{t(`filterRule.action.${type}`)}</span>
                <Switch
                  size="sm"
                  checked={activeActions[type]}
                  onCheckedChange={() => toggleAction(type)}
                />
              </div>
            ))}
          </div>
        </div>

        <Separator />

        {/* Retroactive */}
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div className="space-y-0.5">
            <span className="text-sm">{t("filterRule.applyRetroactive")}</span>
            <p className="text-xs text-muted-foreground">
              {t("filterRule.applyRetroactiveDesc")}
            </p>
          </div>
          <Switch
            size="sm"
            checked={applyRetroactive}
            onCheckedChange={setApplyRetroactive}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closeFilterRule} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t("filterRule.saving") : t("filterRule.createRule")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Criterion Row ---

interface CriterionRowProps {
  criterion: FilterCriterion;
  onFieldChange: (field: CriterionField) => void;
  onOperatorChange: (op: CriterionOperator) => void;
  onValueChange: (value: string) => void;
  onRemove: () => void;
  canRemove: boolean;
  t: (key: string, params?: Record<string, string>) => string;
}

function CriterionRow({
  criterion,
  onFieldChange,
  onOperatorChange,
  onValueChange,
  onRemove,
  canRemove,
  t,
}: CriterionRowProps) {
  const operators = OPERATORS_BY_FIELD[criterion.field];
  const showValue = criterion.field !== "has_attachments";

  return (
    <div className="flex items-center gap-2">
      {/* Field */}
      <Select value={criterion.field} onValueChange={(v) => onFieldChange(v as CriterionField)}>
        <SelectTrigger size="sm" className="w-[140px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FIELDS.map((f) => (
            <SelectItem key={f} value={f}>
              {t(`filterRule.field.${f}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Operator */}
      <Select value={criterion.operator} onValueChange={(v) => onOperatorChange(v as CriterionOperator)}>
        <SelectTrigger size="sm" className="w-[120px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op} value={op}>
              {t(`filterRule.operator.${op}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Value */}
      {showValue && (
        <Input
          value={criterion.value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={t("filterRule.valuePlaceholder")}
          className="h-8 flex-1 text-xs"
        />
      )}

      {/* Remove */}
      {canRemove && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="size-8 shrink-0 p-0"
        >
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}
