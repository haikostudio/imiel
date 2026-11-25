"use client";

import { useIsMiel } from "@/lib/hooks/useSettings";
import { useState, useCallback, useRef, useEffect } from "react";
import { toast } from "sonner";
import { Search, RefreshCw, Users, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CollapsibleTop } from "@/components/ui/collapsible-top";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ContactList } from "@/components/contacts/ContactList";
import { ContactDetail } from "@/components/contacts/ContactDetail";
import { ThreadView } from "@/components/mail/ThreadView";
import { MobileThreadDrawer } from "@/components/mail/MobileThreadDrawer";
import { useContacts } from "@/lib/hooks/useContacts";
import { useContactThreads } from "@/lib/hooks/useContactThreads";
import { useMailStore } from "@/lib/stores/mail-store";
import { hashSetParams, useHashSelection } from "@/lib/hash-router";
import { useT } from "@/lib/i18n";
import type { Contact } from "@/lib/pocketbase";

const STORAGE_KEY = "imiel:contactsState";

function loadContactsState(): { searchQuery: string; selectedContactId: string | null } {
  if (typeof window === "undefined") return { searchQuery: "", selectedContactId: null };
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // ignore
  }
  return { searchQuery: "", selectedContactId: null };
}

function saveContactsState(searchQuery: string, selectedContactId: string | null) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ searchQuery, selectedContactId }));
  } catch {
    // ignore
  }
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [query]);

  return matches;
}

export default function ContactsPage() {
  const t = useT();
  const isMobile = useMediaQuery("(max-width: 767px)");
  // Miel ordinateur : le texte d'aide nomme la page (« Rechercher dans les contacts »).
  const mielDesktop = useIsMiel() && !isMobile;
  const { contacts, loading, refresh, backfill, deleteContact, updateContact } = useContacts();
  const initialState = useRef(loadContactsState());
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  // La fiche contact ouverte vit dans l'ADRESSE (`#/contacts?k=<contact>`) :
  // recharger la page ou revenir en arriere retombe sur le meme contact.
  const { value: urlContactId, open: openContactUrl, close: closeContactUrl } =
    useHashSelection("k");
  const [searchQuery, setSearchQuery] = useState(initialState.current.searchQuery);
  const [syncing, setSyncing] = useState(false);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);

  const selectMessage = useMailStore((s) => s.selectMessage);
  const selectedThreadId = useMailStore((s) => s.selectedThreadId);

  const { threads: contactThreads, loading: contactThreadsLoading, getThread: getContactThread } =
    useContactThreads(selectedContact?.email ?? null);

  // La fiche affichee suit l'ADRESSE : ouverture, retour arriere et
  // rechargement passent tous par ce seul endroit. Au tout premier chargement
  // sans contact dans l'adresse, on restaure le dernier contact consulte et on
  // l'ecrit dans l'adresse SANS empiler d'entree (ce n'est pas une navigation).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (loading || contacts.length === 0) return;

    if (urlContactId) {
      if (selectedContact?.id === urlContactId) return;
      const found = contacts.find((c) => c.id === urlContactId);
      if (found) setSelectedContact(found);
      return;
    }

    if (!restoredRef.current) {
      restoredRef.current = true;
      const savedId = initialState.current.selectedContactId;
      const found = savedId ? contacts.find((c) => c.id === savedId) : null;
      if (found) {
        setSelectedContact(found);
        hashSetParams({ k: found.id }, { replace: true });
      }
      return;
    }

    if (selectedContact) setSelectedContact(null);
  }, [loading, contacts, urlContactId, selectedContact]);

  // Persister l'etat a chaque changement
  useEffect(() => {
    saveContactsState(searchQuery, selectedContact?.id ?? null);
  }, [searchQuery, selectedContact?.id]);

  const handleSelect = useCallback((contact: Contact) => {
    setSelectedContact(contact);
    openContactUrl(contact.id);
    selectMessage(null);
  }, [selectMessage, openContactUrl]);

  const handleDelete = useCallback(async (id: string) => {
    await deleteContact(id);
    toast.success(t("contacts.deleted"));
    if (selectedContact?.id === id) {
      setSelectedContact(null);
      closeContactUrl();
      selectMessage(null);
    }
  }, [deleteContact, selectedContact?.id, selectMessage, closeContactUrl, t]);

  const handleUpdate = useCallback(async (id: string, data: { name?: string; phone?: string }) => {
    const updated = await updateContact(id, data);
    if (updated) {
      toast.success(t("contacts.updated"));
    } else {
      toast.error(t("message.actionFailed"));
    }
    if (updated && selectedContact?.id === id) {
      setSelectedContact(updated);
    }
    return updated;
  }, [updateContact, selectedContact?.id, t]);

  const handleClosePreview = useCallback(() => {
    selectMessage(null);
  }, [selectMessage]);

  async function handleBackfill() {
    setSyncDialogOpen(false);
    setSyncing(true);
    await backfill();
    setSyncing(false);
    toast.success(t("contacts.syncDone"));
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      </div>
    );
  }

  if (contacts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <Users className="size-12 text-muted-foreground/50" />
        <h2 className="text-lg font-semibold">{t("contacts.noContacts")}</h2>
        <p className="text-sm text-muted-foreground text-center max-w-md">
          {t("contacts.noContactsDesc")}
        </p>
        <Button onClick={() => setSyncDialogOpen(true)} disabled={syncing}>
          <RefreshCw className={`mr-2 size-4 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? t("contacts.syncing") : t("contacts.syncContacts")}
        </Button>
        <SyncConfirmDialog
          open={syncDialogOpen}
          onOpenChange={setSyncDialogOpen}
          onConfirm={handleBackfill}
          t={t}
        />
      </div>
    );
  }

  // Liste des contacts (barre de recherche + liste), partagee mobile/desktop.
  const listPanel = (
    <div data-ref="contacts-list-panel" className="flex h-full flex-col">
      {/* Search bar + sync button (telephone : repliee quand on descend dans
          la liste, revient des qu'on remonte) */}
      <CollapsibleTop forceVisible={!!selectedContact} data-ref="contacts-list-top">
      <div data-ref="contacts-search" className="flex items-center gap-2 border-b px-[10px] py-2 md:px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={mielDesktop ? t("searchIn.contacts") : t("contacts.searchPlaceholder")}
          className="h-8 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="text-muted-foreground hover:text-foreground text-xs"
          >
            &times;
          </button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setSyncDialogOpen(true)}
          disabled={syncing}
          title={t("contacts.syncContacts")}
        >
          <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
        </Button>
      </div>
      </CollapsibleTop>

      {/* Contact list */}
      <div className="flex-1 overflow-hidden">
        <ContactList
          contacts={contacts}
          selectedId={selectedContact?.id ?? null}
          onSelect={handleSelect}
          searchQuery={searchQuery}
          onRefresh={refresh}
        />
      </div>
    </div>
  );

  // Mobile : liste plein ecran + fiche detail en bottom sheet
  // (la conversation s'ouvre dans le tiroir commun, par-dessus la fiche).
  if (isMobile) {
    return (
      <div className="h-full">
        {listPanel}

        <Drawer
          open={!!selectedContact}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedContact(null);
              closeContactUrl();
              selectMessage(null);
            }
          }}
          repositionInputs={false}
          noBodyStyles
          handleOnly
        >
          {/* Tiroir commun du telephone : arret sous la barre d'etat, en-tete
              poignee + titre centre (sans croix), glisse par la prise seulement. */}
          <DrawerContent
            hideGrip
            data-ref="contact-detail-sheet"
            className="drawer-scroll-native top-[var(--app-top)] mt-0 flex flex-col gap-0 overflow-hidden p-0"
          >
            <DrawerSheetHeader
              title={t("contacts.sheetTitle")}
            />

            <div className="relative flex min-h-0 flex-1 flex-col">
              {selectedContact && (
                <ContactDetail
                  key={selectedContact.id}
                  contact={selectedContact}
                  threads={contactThreads}
                  threadsLoading={contactThreadsLoading}
                  onUpdate={handleUpdate}
                  onDelete={handleDelete}
                />
              )}
            </div>
          </DrawerContent>
        </Drawer>

        {/* Conversation : tiroir commun du telephone (poignee, arret sous la
            barre du haut), empile par-dessus la fiche du contact. */}
        <MobileThreadDrawer
          open={!!selectedThreadId}
          onClose={() => selectMessage(null)}
          threadId={selectedThreadId}
          threads={contactThreads}
          loading={contactThreadsLoading}
          getThread={getContactThread}
        />

        <SyncConfirmDialog
          open={syncDialogOpen}
          onOpenChange={setSyncDialogOpen}
          onConfirm={handleBackfill}
          t={t}
        />
      </div>
    );
  }

  // Desktop : panneaux redimensionnables, meme gabarit que la page des mails
  // (two-block-page) : en Miel, liste, fiche et conversation en blocs separes.
  return (
    <>
      <ResizablePanelGroup data-ref="two-block-page" orientation="horizontal" className="h-full">
        {/* Left: Contact list */}
        <ResizablePanel defaultSize={selectedThreadId ? "20%" : "35%"} minSize="15%" maxSize="50%">
          <div data-ref="two-block-list" className="h-full border-r">{listPanel}</div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Center: Contact detail */}
        <ResizablePanel defaultSize={selectedThreadId ? "35%" : "65%"} minSize="25%">
          <div data-ref="two-block-read" className="h-full">
          {selectedContact ? (
            <ContactDetail
              key={selectedContact.id}
              contact={selectedContact}
              threads={contactThreads}
              threadsLoading={contactThreadsLoading}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">
                {t("contacts.noSelection")}
              </p>
            </div>
          )}
          </div>
        </ResizablePanel>

        {/* Right: Thread view */}
        {selectedThreadId && (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize="45%" minSize="30%">
              <div data-ref="two-block-read" className="flex h-full flex-col border-l">
                <div className="flex items-center justify-end border-b px-2 py-1">
                  <Button variant="ghost" size="icon-sm" onClick={handleClosePreview}>
                    <X className="size-4" />
                  </Button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <ThreadView
                    threads={contactThreads}
                    loading={contactThreadsLoading}
                    getThread={getContactThread}
                  />
                </div>
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      <SyncConfirmDialog
        open={syncDialogOpen}
        onOpenChange={setSyncDialogOpen}
        onConfirm={handleBackfill}
        t={t}
      />
    </>
  );
}

function SyncConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  t: (key: string) => string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("contacts.syncConfirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("contacts.syncConfirmDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("cancel")}</Button>
          </DialogClose>
          <Button onClick={onConfirm}>
            <RefreshCw className="mr-2 size-4" />
            {t("contacts.syncContacts")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
