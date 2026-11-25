"use client";

import { useState } from "react";
import { toast } from "sonner";
import { BellRing, Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import { useAlertTopics } from "@/lib/hooks/useAlertTopics";
import { useT } from "@/lib/i18n";

/**
 * Tiroir "Alertes" de la page Newsletters : sujets surveilles par l'IA dans
 * chaque nouvelle newsletter (ajout, renommage, suppression).
 */
export function AlertTopicsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { topics, loading, addTopic, updateTopic, removeTopic } = useAlertTopics(open);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  async function handleAdd() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await addTopic(name, description);
      setName("");
      setDescription("");
      toast.success(t("newsletters.alertAdded"));
    } catch {
      toast.error(t("newsletters.sourceError"));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit() {
    if (!editId || !editName.trim()) return;
    const id = editId;
    setEditId(null);
    try {
      await updateTopic(id, editName, editDescription);
    } catch {
      toast.error(t("newsletters.sourceError"));
    }
  }

  async function handleRemove(id: string) {
    try {
      await removeTopic(id);
      toast.success(t("newsletters.alertRemoved"));
    } catch {
      toast.error(t("newsletters.sourceError"));
    }
  }

  return (
    <ResponsivePanel open={open} onOpenChange={onOpenChange} title={t("newsletters.alerts")}>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="px-1 pb-3 text-xs text-muted-foreground">{t("newsletters.alertsHint")}</p>

        <form
          className="mb-4 flex flex-col gap-2 rounded-lg border bg-card p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void handleAdd();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("newsletters.alertNamePlaceholder")}
            maxLength={120}
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("newsletters.alertDescriptionPlaceholder")}
            maxLength={500}
          />
          <Button type="submit" size="sm" className="gap-1.5 self-end" disabled={!name.trim() || saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {t("newsletters.alertAdd")}
          </Button>
        </form>

        {loading && topics.length === 0 ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : topics.length === 0 ? (
          <p className="px-1 py-3 text-sm text-muted-foreground">{t("newsletters.noAlerts")}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {topics.map((topic) =>
              editId === topic.id ? (
                <form
                  key={topic.id}
                  className="flex flex-col gap-2 rounded-lg border bg-card p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleSaveEdit();
                  }}
                >
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={120} autoFocus />
                  <Input
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder={t("newsletters.alertDescriptionPlaceholder")}
                    maxLength={500}
                  />
                  <div className="flex justify-end gap-1">
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditId(null)} aria-label={t("cancel")}>
                      <X className="size-4" />
                    </Button>
                    <Button type="submit" size="icon-sm" disabled={!editName.trim()} aria-label={t("newsletters.alertSave")}>
                      <Check className="size-4" />
                    </Button>
                  </div>
                </form>
              ) : (
                <div key={topic.id} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-sm">
                  <BellRing className="size-4 shrink-0 text-amber-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{topic.name}</p>
                    {topic.description && (
                      <p className="truncate text-xs text-muted-foreground">{topic.description}</p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground"
                    onClick={() => {
                      setEditId(topic.id);
                      setEditName(topic.name);
                      setEditDescription(topic.description || "");
                    }}
                    aria-label={t("newsletters.alertRename")}
                    title={t("newsletters.alertRename")}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleRemove(topic.id)}
                    aria-label={t("newsletters.alertDelete")}
                    title={t("newsletters.alertDelete")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )
            )}
          </div>
        )}
      </div>
    </ResponsivePanel>
  );
}
