"use client";

import { useState } from "react";
import { Check, Eye, EyeOff, Pencil, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { type Label } from "@/lib/pocketbase";
import { useLabels } from "@/lib/hooks/useLabels";
import { ACCOUNT_COLORS } from "@/lib/utils/account-colors";
import { useT, t as tStatic } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export default function LabelsSettings() {
  const t = useT();
  const { list, removeLabel, renameLabel, setLabelColor, toggleSecondary } = useLabels();
  const labels = [...list].sort((a, b) => a.name.localeCompare(b.name));

  const [deleteTarget, setDeleteTarget] = useState<Label | null>(null);
  const [editTarget, setEditTarget] = useState<Label | null>(null);
  const [editName, setEditName] = useState("");

  // Toutes les mutations sont OPTIMISTES (le cache useLabels se met a jour et
  // re-rend instantanement, puis PB en arriere-plan avec rollback si echec).
  // On ferme donc la modale immediatement au lieu d'attendre le reseau, sinon
  // sur mobile/4G le bouton semble "ne rien faire" pendant plusieurs secondes.
  function handleDelete() {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    removeLabel(target.id)
      .then(() => toast.success(tStatic("settings.labelDeleted")))
      .catch(() => toast.error(tStatic("settings.labelDeleteError")));
  }

  function handleRename() {
    const target = editTarget;
    const trimmed = editName.trim();
    setEditTarget(null);
    if (!target || !trimmed || trimmed === target.name) return;
    renameLabel(target.id, trimmed)
      .then(() => toast.success(tStatic("settings.labelRenamed")))
      .catch(() => toast.error(tStatic("settings.labelRenameError")));
  }

  function handleColor(label: Label, color: string) {
    if (color === label.color) return;
    setLabelColor(label.id, color).catch(() =>
      toast.error(tStatic("settings.labelColorError"))
    );
  }

  return (
    <div data-ref="settings-labels" className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-lg font-medium">{t("settings.labels")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("settings.labelsDesc")}
        </p>
      </div>

      {labels.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noLabel")}</p>
      ) : (
        <div className="space-y-2">
          {labels.map((label) => {
            const color = label.color || "#6b7280";
            const isSecondary = !!label.is_secondary;
            return (
              <div
                key={label.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                data-ref="settings-label-item"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <LabelColorPicker
                    value={color}
                    onChange={(c) => handleColor(label, c)}
                  />
                  <span className="block flex-1 truncate text-sm font-medium">
                    {label.name}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleSecondary(label.id).catch(() => {})}
                        className="size-8 p-0 text-muted-foreground hover:text-foreground"
                      >
                        {isSecondary ? (
                          <EyeOff className="size-3.5" />
                        ) : (
                          <Eye className="size-3.5" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {isSecondary
                        ? t("label.includeInInbox")
                        : t("label.hideFromInbox")}
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditTarget(label);
                      setEditName(label.name);
                    }}
                    className="size-8 p-0 text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteTarget(label)}
                    className="size-8 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Dialog suppression */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings.deleteLabelConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.deleteLabelConfirmDescription", {
                name: deleteTarget?.name ?? "",
              })}
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

      {/* Dialog renommage */}
      <Dialog
        open={!!editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings.renameLabel")}</DialogTitle>
          </DialogHeader>
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleRename()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              {t("cancel")}
            </Button>
            <Button onClick={handleRename} disabled={!editName.trim()}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LabelColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex size-5 shrink-0 items-center justify-center rounded-full ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          style={{ backgroundColor: value || "#6b7280" }}
          aria-label={tStatic("settings.labelColor")}
        >
          <Tag className="size-2.5 text-white" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="grid grid-cols-5 gap-1.5">
          {ACCOUNT_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => onChange(c.value)}
              className={cn(
                "flex size-6 items-center justify-center rounded-full",
                value === c.value &&
                  "ring-2 ring-ring ring-offset-1 ring-offset-background"
              )}
              style={{ backgroundColor: c.value }}
              title={c.label}
            >
              {value === c.value && <Check className="size-3 text-white" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
