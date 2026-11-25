"use client";

import { useState } from "react";
import { Check, Plus, Trash2, Eye, EyeOff, Settings2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ACCOUNT_COLORS, getNextAvailableColor } from "@/lib/utils/account-colors";
import { useT } from "@/lib/i18n";
import { hashNavigate } from "@/lib/hash-router";
import { calendarEvents, type CalendarGroup } from "@/lib/pocketbase";

interface GroupManagerContentProps {
  groups: CalendarGroup[];
  onCreate: (data: { name: string; color: string }) => Promise<void>;
  onUpdate: (id: string, data: { color?: string; is_visible?: boolean }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToggle: (id: string) => Promise<void>;
  /** Appele avant d'ouvrir les reglages (fermer le menu ou le tiroir). */
  onOpenSettings?: () => void;
}

interface GroupManagerProps extends GroupManagerContentProps {
  trigger: React.ReactNode;
}

/**
 * Contenu de gestion des groupes (liste + visibilite + couleur + creation).
 * Reutilise tel quel dans le Popover (desktop) et le tiroir Options (mobile).
 */
/** Ce que fait la suppression d'un agenda, dit avant de confirmer. */
function deleteEffectKey(g: CalendarGroup): string {
  if (!g.google_calendar_id) return "calendar.deleteGroupLocal";
  return g.access_role === "owner" ? "calendar.deleteGroupGoogle" : "calendar.deleteGroupShared";
}

export function GroupManagerContent({ groups, onCreate, onUpdate, onDelete, onToggle, onOpenSettings }: GroupManagerContentProps) {
  const t = useT();
  const [newName, setNewName] = useState("");
  // Confirmation de suppression : agenda vise + nombre d'evenements (lu a l'ouverture).
  const [pendingDelete, setPendingDelete] = useState<CalendarGroup | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);

  async function askDelete(group: CalendarGroup) {
    setPendingDelete(group);
    setPendingCount(null);
    try {
      const res = await calendarEvents().getList(1, 1, { filter: `group = "${group.id}"`, fields: "id" });
      setPendingCount(res.totalItems);
    } catch {
      setPendingCount(0);
    }
  }
  const [newColor, setNewColor] = useState(() => getNextAvailableColor(groups.map((g) => g.color)));

  async function handleCreate() {
    if (!newName.trim()) return;
    await onCreate({ name: newName.trim(), color: newColor });
    setNewName("");
    setNewColor(getNextAvailableColor([...groups.map((g) => g.color), newColor]));
  }

  return (
    <>
      <div className="px-1 py-1 text-xs font-medium text-muted-foreground">{t("calendar.groups")}</div>
      <div className="max-h-64 space-y-0.5 overflow-y-auto">
        {groups.map((group) => {
          return (
            <div key={group.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent">
              <button
                type="button"
                onClick={() => onToggle(group.id)}
                className="text-muted-foreground hover:text-foreground"
                title={group.is_visible ? t("calendar.allDay") : ""}
              >
                {group.is_visible ? <Eye className="size-4" /> : <EyeOff className="size-4 opacity-50" />}
              </button>

              <ColorPicker
                value={group.color}
                onChange={(color) => onUpdate(group.id, { color })}
              />

              <span className="flex-1 truncate text-sm">{group.name}</span>

              {group.is_primary ? (
                <span className="size-3.5" title={t("calendar.primaryNotDeletable")} />
              ) : (
                <button
                  type="button"
                  onClick={() => askDelete(group)}
                  className="text-muted-foreground hover:text-destructive"
                  title={t("calendar.delete")}
                  data-ref="calendar-group-delete"
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2 border-t pt-2">
        <div className="flex items-center gap-2">
          <ColorPicker value={newColor} onChange={setNewColor} />
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCreate();
              }
            }}
            placeholder={t("calendar.groupName")}
            className="h-8"
          />
          <Button size="icon-sm" onClick={handleCreate} disabled={!newName.trim()}>
            <Plus className="size-4" />
          </Button>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full"
          data-ref="calendar-manage-groups"
          onClick={() => {
            onOpenSettings?.();
            hashNavigate("/settings?tab=calendar");
          }}
        >
          <Settings2 className="size-4" />
          {t("calendar.manageGroups")}
        </Button>
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent className="z-[80]" overlayClassName="z-[80]" data-ref="calendar-group-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("calendar.deleteGroupTitle")} {pendingDelete ? `« ${pendingDelete.name} »` : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCount === null
                ? "..."
                : t("calendar.deleteGroupEvents", { count: String(pendingCount) })}{" "}
              {pendingDelete ? t(deleteEffectKey(pendingDelete)) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pendingCount === null}
              onClick={async () => {
                const g = pendingDelete;
                setPendingDelete(null);
                if (g) await onDelete(g.id);
              }}
            >
              {t("calendar.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** La confirmation de suppression vit hors du menu : ne pas refermer le menu (et la demonter) en y cliquant. */
function insideConfirm(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[data-slot^="alert-dialog"]');
}

export function GroupManager({ trigger, ...content }: GroupManagerProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 p-2"
        onInteractOutside={(e) => insideConfirm(e.target) && e.preventDefault()}
        onFocusOutside={(e) => insideConfirm(e.target) && e.preventDefault()}
      >
        <GroupManagerContent {...content} onOpenSettings={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="size-4 shrink-0 rounded-full ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          style={{ backgroundColor: value || "#888" }}
        />
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
                value === c.value && "ring-2 ring-ring ring-offset-1 ring-offset-background"
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
