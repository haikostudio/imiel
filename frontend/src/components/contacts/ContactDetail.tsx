"use client";

import { useState } from "react";
import { Mail, Pencil, Check, Trash2, X, MessageSquare, Paperclip, Star, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ContactAvatar } from "@/components/mail/ContactAvatar";
import { BottomActionBar, PrimaryAction } from "@/components/ui/kit";
import { formatRelativeDate } from "@/lib/utils/date";
import { stripReplacementChars } from "@/lib/utils/sanitize";
import { useMailStore } from "@/lib/stores/mail-store";
import { useT } from "@/lib/i18n";
import type { Contact } from "@/lib/pocketbase";
import type { Thread } from "@/lib/hooks/useThreads";
import { Skeleton } from "@/components/ui/skeleton";
import { ContactMemoryCard } from "./ContactMemoryCard";

interface ContactDetailProps {
  contact: Contact;
  threads: Thread[];
  threadsLoading: boolean;
  onUpdate: (id: string, data: { name?: string; phone?: string }) => Promise<Contact | null>;
  onDelete: (id: string) => Promise<void>;
}

export function ContactDetail({ contact, threads, threadsLoading, onUpdate, onDelete }: ContactDetailProps) {
  const t = useT();
  const openCompose = useMailStore((s) => s.openCompose);
  const selectMessage = useMailStore((s) => s.selectMessage);
  const selectedThreadId = useMailStore((s) => s.selectedThreadId);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(contact.name);
  const [editingPhone, setEditingPhone] = useState(false);
  const [editPhone, setEditPhone] = useState(contact.phone || "");

  function handleStartEdit() {
    setEditName(contact.name);
    setEditing(true);
  }

  async function handleSaveName() {
    if (editName.trim() !== contact.name) {
      await onUpdate(contact.id, { name: editName.trim() });
    }
    setEditing(false);
  }

  function handleCancelEdit() {
    setEditing(false);
    setEditName(contact.name);
  }

  async function handleSavePhone() {
    const value = editPhone.trim();
    if (value !== (contact.phone || "")) {
      await onUpdate(contact.id, { phone: value });
    }
    setEditingPhone(false);
  }

  function handleSendEmail() {
    openCompose("new", null, contact.email);
  }

  function handleSelectThread(thread: Thread) {
    selectMessage(thread.lastMessage.id, thread.id);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-6">
        <div>
          {/* Avatar + Name ("Envoyer un email" est epingle en bas, pleine
              largeur : pose en absolu en haut a droite, il chevauchait
              l'avatar sur telephone). */}
          <div className="flex flex-col items-center gap-4 pb-6">
            <ContactAvatar
              name={contact.name}
              email={contact.email}
              className="size-20"
              textClassName="text-2xl"
            />

            {editing ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveName();
                    if (e.key === "Escape") handleCancelEdit();
                  }}
                  className="h-8 w-48 text-center"
                  autoFocus
                />
                <Button variant="ghost" size="icon-sm" onClick={handleSaveName}>
                  <Check className="size-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={handleCancelEdit}>
                  <X className="size-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">
                  {contact.name || contact.email}
                </h2>
                <Button variant="ghost" size="icon-sm" onClick={handleStartEdit} title={t("contacts.editName")}>
                  <Pencil className="size-3.5" />
                </Button>
              </div>
            )}

            <p className="text-sm text-muted-foreground">{contact.email}</p>
          </div>
        </div>

        {/* Stats */}
        <div data-ref="contact-stats" className="space-y-4 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{t("contacts.messages")}</span>
            <span className="text-sm font-medium">{contact.message_count}</span>
          </div>
          {contact.last_contact_date && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t("contacts.lastContact")}</span>
              <span className="text-sm font-medium">
                {formatRelativeDate(contact.last_contact_date)}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Phone className="size-3.5" />
              {t("contacts.phone")}
            </span>
            {editingPhone ? (
              <div className="flex items-center gap-1">
                <Input
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSavePhone();
                    if (e.key === "Escape") {
                      setEditPhone(contact.phone || "");
                      setEditingPhone(false);
                    }
                  }}
                  inputMode="tel"
                  className="h-7 w-40 text-right"
                  autoFocus
                />
                <Button variant="ghost" size="icon-sm" onClick={handleSavePhone}>
                  <Check className="size-4" />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditPhone(contact.phone || "");
                  setEditingPhone(true);
                }}
                className="flex items-center gap-1.5 text-sm font-medium hover:underline"
                title={t("contacts.phoneHint")}
              >
                {contact.phone || <span className="text-muted-foreground">-</span>}
                <Pencil className="size-3 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>


        {/* Memoire "qui est qui" donnee a l'IA de reponse (corrigeable) */}
        <ContactMemoryCard
          key={contact.email}
          memoryKey={contact.email}
          name={contact.name}
          className="mt-6"
        />

        {/* Conversations */}
        <div className="mt-6">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <MessageSquare className="size-4" />
            {t("contacts.recentConversations")}
          </h3>

          {threadsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : threads.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t("contacts.noConversations")}
            </p>
          ) : (
            <div className="space-y-1">
              {threads.map((thread) => {
                const isSelected = selectedThreadId === thread.id;
                const displayName = thread.participantNames.map((p) => p.name).join(", ") || thread.lastMessage.from_address?.name || thread.lastMessage.from_address?.address || "";

                return (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => handleSelectThread(thread)}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left transition-colors",
                      "hover:bg-accent",
                      isSelected && "bg-accent",
                      !isSelected && thread.unreadCount > 0 && "bg-muted/40 ring-1 ring-border/50"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "truncate text-sm",
                          thread.unreadCount > 0 && "font-semibold"
                        )}
                      >
                        {stripReplacementChars(displayName)}
                      </span>
                      <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                        {thread.fullMessageCount}
                      </span>
                      <div className="ml-auto flex items-center gap-1.5 shrink-0">
                        {thread.hasAttachments && (
                          <Paperclip className="size-3 text-muted-foreground" />
                        )}
                        <Star className={cn("size-3.5", thread.isStarred ? "fill-starred text-starred" : "text-muted-foreground/40")} />
                        <span className={cn("text-xs text-muted-foreground", thread.unreadCount > 0 && "font-semibold")}>
                          {formatRelativeDate(thread.lastMessage.date)}
                        </span>
                      </div>
                    </div>
                    <span
                      className={cn(
                        "truncate text-sm",
                        thread.unreadCount > 0
                          ? "font-semibold text-foreground"
                          : "text-muted-foreground"
                      )}
                    >
                      {stripReplacementChars(thread.subject) || t("message.noSubject")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Delete action */}
        <div className="mt-6">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full text-destructive hover:text-destructive">
                <Trash2 className="mr-2 size-4" />
                {t("delete")}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("contacts.deleteConfirmTitle")}</DialogTitle>
                <DialogDescription>
                  {t("contacts.deleteConfirmDescription")}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">{t("cancel")}</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button variant="destructive" onClick={() => onDelete(contact.id)}>
                    {t("delete")}
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <BottomActionBar data-ref="contact-detail-actions">
        <PrimaryAction icon={Mail} onClick={handleSendEmail} data-ref="contact-send-email">
          {t("contacts.sendEmail")}
        </PrimaryAction>
      </BottomActionBar>
    </div>
  );
}
