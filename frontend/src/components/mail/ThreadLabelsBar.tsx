"use client";

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useLabels } from "@/lib/hooks/useLabels";
import { useThreadLabels } from "@/lib/hooks/useThreadLabels";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface ThreadLabelsBarProps {
  threadId: string;
  className?: string;
  /** "bar" : bande autonome avec libelle ; "inline" : pastilles + "+" compact,
   * posees dans la ligne d'infos de l'en-tete du fil. */
  variant?: "bar" | "inline";
}

export function ThreadLabelsBar({ threadId, className, variant = "bar" }: ThreadLabelsBarProps) {
  const inline = variant === "inline";
  const t = useT();
  const { list: allLabels, byId } = useLabels();
  const { labelIds, addLabel, removeLabel } = useThreadLabels(threadId);
  const [open, setOpen] = useState(false);

  const items = useMemo(() => {
    const out: { id: string; name: string; color: string }[] = [];
    for (const id of labelIds) {
      const lbl = byId.get(id);
      if (lbl) out.push({ id: lbl.id, name: lbl.name, color: lbl.color || "#6b7280" });
    }
    return out;
  }, [labelIds, byId]);

  const available = useMemo(
    () => allLabels.filter((l) => !labelIds.includes(l.id)),
    [allLabels, labelIds]
  );

  async function handleRemove(id: string) {
    try {
      await removeLabel(id);
      toast.success(t("thread.labelRemoved"));
    } catch {
      toast.error(t("thread.labelsRemoveError"));
    }
  }

  async function handleAdd(id: string) {
    setOpen(false);
    try {
      await addLabel(id);
      toast.success(t("thread.labelAdded"));
    } catch {
      toast.error(t("thread.labelsAddError"));
    }
  }

  return (
    <div
      data-ref="thread-labels-bar"
      className={cn(
        "flex flex-wrap items-center gap-1.5",
        inline ? "min-w-0" : "px-4 py-2",
        className
      )}
    >
      {!inline && (
        <span className="text-muted-foreground mr-1 text-[11px] font-medium uppercase tracking-wide">
          {t("thread.labels")}
        </span>
      )}

      {!inline && items.length === 0 && (
        <span className="text-muted-foreground text-xs italic">
          {t("thread.labelsEmpty")}
        </span>
      )}

      {items.map((lbl) => (
        <span
          key={lbl.id}
          className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-[0.8125rem] leading-tight text-foreground"
        >
          {lbl.name}
          <button
            type="button"
            onClick={() => handleRemove(lbl.id)}
            className="text-muted-foreground hover:text-foreground rounded-sm transition-colors"
            title={t("thread.labelsRemoveTitle")}
            aria-label={t("thread.labelsRemoveTitle")}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {inline ? (
            <button
              type="button"
              data-ref="thread-labels-add"
              className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-7 items-center justify-center rounded-lg border border-dashed transition-colors"
              title={t("thread.labelsAdd")}
              aria-label={t("thread.labelsAdd")}
            >
              <Plus className="size-3" />
            </button>
          ) : (
            <button
              type="button"
              data-ref="thread-labels-add"
              className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center gap-1 rounded-lg border border-dashed px-2 py-1 text-[0.8125rem] leading-tight transition-colors"
              title={t("thread.labelsAdd")}
            >
              <Plus className="size-3" />
              {t("thread.labelsAdd")}
            </button>
          )}
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            <CommandInput placeholder={t("thread.labelsSearch")} />
            <CommandList>
              <CommandEmpty>{t("thread.labelsNoMatch")}</CommandEmpty>
              {available.map((lbl) => (
                <CommandItem
                  key={lbl.id}
                  value={lbl.name}
                  onSelect={() => handleAdd(lbl.id)}
                  className="flex items-center gap-2"
                >
                  <span
                    className="size-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: lbl.color || "#6b7280" }}
                  />
                  <span className="truncate">{lbl.name}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
