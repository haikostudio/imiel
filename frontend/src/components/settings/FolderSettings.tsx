"use client";

import { useState } from "react";
import { Folder, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { folders, messages, type Folder as FolderType } from "@/lib/pocketbase";
import { useT, t as tStatic } from "@/lib/i18n";
import { useFoldersAll } from "@/lib/hooks/useFolders";

export default function FolderSettings() {
  const t = useT();
  const { accounts } = useAccounts();
  const { folders: allFolders, loading } = useFoldersAll();
  const customFolders = allFolders.filter((f) => f.type === "custom");

  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [creating, setCreating] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<FolderType | null>(null);

  const [editTarget, setEditTarget] = useState<FolderType | null>(null);
  const [editName, setEditName] = useState("");

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || !accountId) return;

    setCreating(true);
    try {
      await folders().create({
        name: trimmed,
        path: trimmed,
        account: accountId,
        type: "custom",
        sort_order: 100,
        unread_count: 0,
        total_count: 0,
      });
      setName("");
      toast.success(tStatic("settings.folderCreated"));
    } catch {
      toast.error(tStatic("settings.folderCreateError"));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      // Trouver le dossier inbox du meme compte pour y deplacer les messages
      const inboxFolder = allFolders.find(
        (f) => f.account === deleteTarget.account && f.type === "inbox"
      );
      if (inboxFolder) {
        // Deplacer tous les messages du dossier vers inbox
        const msgs = await messages().getFullList({
          filter: `folder = "${deleteTarget.id}"`,
          fields: "id",
        });
        for (const msg of msgs) {
          await messages().update(msg.id, { folder: inboxFolder.id });
        }
      }
      await folders().delete(deleteTarget.id);
      toast.success(tStatic("settings.folderDeleted"));
    } catch {
      toast.error(tStatic("settings.folderDeleteError"));
    } finally {
      setDeleteTarget(null);
    }
  }

  async function handleRename() {
    if (!editTarget) return;
    const trimmed = editName.trim();
    if (!trimmed || trimmed === editTarget.name) {
      setEditTarget(null);
      return;
    }
    try {
      await folders().update(editTarget.id, { name: trimmed, path: trimmed });
      toast.success(tStatic("settings.folderRenamed"));
    } catch {
      toast.error(tStatic("settings.folderRenameError"));
    } finally {
      setEditTarget(null);
    }
  }

  function getAccountLabel(id: string) {
    const account = accounts.find((a) => a.id === id);
    return account?.label || account?.email || id;
  }

  if (loading) {
    return (
      <div data-ref="settings-folders" className="space-y-6">
        <h3 className="text-lg font-medium">{t("settings.folders")}</h3>
        <div className="flex items-center justify-center py-8">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div data-ref="settings-folders" className="space-y-6">
      <h3 className="text-lg font-medium">{t("settings.folders")}</h3>

      {/* Formulaire de creation */}
      {accounts.length > 0 && (
        <div className="flex items-end gap-2">
          <div className="flex-1 max-w-xs space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              {t("settings.folderName")}
            </label>
            <Input
              placeholder={t("settings.folderNamePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
          </div>
          <div className="w-48 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              {t("settings.folderAccount")}
            </label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder={t("settings.folderAccount")} />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.label || account.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!name.trim() || !accountId || creating}
          >
            <Plus className="size-4 mr-1" />
            {t("settings.addFolder")}
          </Button>
        </div>
      )}

      {/* Liste des dossiers */}
      {customFolders.length === 0 ? (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            {t("settings.noFolders")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("settings.noFoldersDesc")}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {customFolders.map((folder) => (
            <div
              key={folder.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium truncate block">
                    {folder.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {getAccountLabel(folder.account)}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditTarget(folder);
                    setEditName(folder.name);
                  }}
                  className="size-8 p-0 text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(folder)}
                  className="size-8 p-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Dialog suppression */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings.deleteFolderConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.deleteFolderConfirmDescription", {
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
            <DialogTitle>{t("edit")}</DialogTitle>
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
