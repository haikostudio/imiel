"use client";

import { useCallback, useEffect, useState } from "react";
import {
  filterRules,
  messages,
  getCurrentUserId,
  type FilterRule,
  type FilterCriterion,
  type FilterAction,
} from "@/lib/pocketbase";

export function useFilterRules() {
  const [rules, setRules] = useState<FilterRule[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) return;
    try {
      const result = await filterRules().getList(1, 200, {
        filter: `user = "${userId}"`,
        sort: "-created",
      });
      setRules(result.items);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createRule = useCallback(
    async (data: {
      name: string;
      criteria: FilterCriterion[];
      actions: FilterAction[];
      match_mode: "all" | "any";
      source_email?: string;
    }): Promise<FilterRule | null> => {
      const userId = getCurrentUserId();
      if (!userId) return null;
      try {
        const rule = await filterRules().create({
          user: userId,
          name: data.name,
          criteria: data.criteria,
          actions: data.actions,
          is_active: true,
          match_mode: data.match_mode,
          source_email: data.source_email || "",
        });
        setRules((prev) => [rule, ...prev]);
        return rule;
      } catch {
        return null;
      }
    },
    []
  );

  const deleteRule = useCallback(async (id: string) => {
    try {
      await filterRules().delete(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch {
      // silent
    }
  }, []);

  return { rules, loading, refresh, createRule, deleteRule };
}

// --- Application retroactive ---

function buildPocketBaseFilter(
  criteria: FilterCriterion[],
  matchMode: "all" | "any"
): string {
  const parts: string[] = [];

  for (const c of criteria) {
    switch (c.field) {
      case "from_address":
        if (c.operator === "equals")
          parts.push(`from_address.address = "${c.value}"`);
        else if (c.operator === "contains")
          parts.push(`from_address.address ~ "${c.value}"`);
        break;
      case "from_domain":
        if (c.operator === "equals")
          parts.push(`from_address.address ~ "@${c.value}"`);
        else if (c.operator === "contains")
          parts.push(`from_address.address ~ "${c.value}"`);
        break;
      case "subject":
        if (c.operator === "equals") parts.push(`subject = "${c.value}"`);
        else if (c.operator === "contains")
          parts.push(`subject ~ "${c.value}"`);
        else if (c.operator === "not_contains")
          parts.push(`subject !~ "${c.value}"`);
        break;
      case "has_attachments":
        parts.push(
          `has_attachments = ${c.operator === "is_true" ? "true" : "false"}`
        );
        break;
      default:
        break;
    }
  }

  if (parts.length === 0) return "";
  const joiner = matchMode === "all" ? " && " : " || ";
  return parts.join(joiner);
}

export async function applyRuleRetroactively(
  criteria: FilterCriterion[],
  actions: FilterAction[],
  matchMode: "all" | "any"
): Promise<number> {
  const pbFilter = buildPocketBaseFilter(criteria, matchMode);
  if (!pbFilter) return 0;

  let count = 0;
  let page = 1;

  while (true) {
    const result = await messages().getList(page, 100, { filter: pbFilter });
    if (result.items.length === 0) break;

    for (const msg of result.items) {
      const updates: Record<string, unknown> = {};
      for (const action of actions) {
        switch (action.type) {
          case "mark_as_read":
            updates.is_read = true;
            break;
          case "add_label":
            if (action.labelId) {
              const current = msg.labels || [];
              if (!current.includes(action.labelId)) {
                updates.labels = [...current, action.labelId];
              }
            }
            break;
        }
      }
      if (Object.keys(updates).length > 0) {
        try {
          await messages().update(msg.id, updates);
          count++;
        } catch {
          // skip individual failures
        }
      }
    }

    if (result.items.length < 100) break;
    page++;
  }

  return count;
}
