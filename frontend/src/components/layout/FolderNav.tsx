"use client";

import { useEffect, useRef, useState } from "react";
import {
  Inbox,
  Mail,
  Star,
  Send,
  FileText,
  Trash2,
  ShieldAlert,
  Archive,
  Folder,
  ChevronRight,
  Newspaper,
  PackageSearch,
  CircleDot,
  CalendarDays,
  Users,
  Home,
} from "lucide-react";
import { HashLink, useHashRouter } from "@/lib/hash-router";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useFolders } from "@/lib/hooks/useFolders";
import { useMailStore } from "@/lib/stores/mail-store";
import type { FolderType } from "@/lib/stores/mail-store";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import pb from "@/lib/pocketbase";
import { fetchTrackingAttentionCount } from "@/lib/hooks/useTracking";
import { bootMark } from "@/lib/boot-perf";

const FOLDER_ICONS: Record<FolderType, React.ComponentType<{ className?: string }>> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  trash: Trash2,
  spam: ShieldAlert,
  archive: Archive,
  custom: Folder,
  starred: Star,
  all_mail: Mail,
  unread: CircleDot,
  label: Folder,
};

function useFolderLabels(): Record<FolderType, string> {
  const t = useT();
  return {
    inbox: t("folder.inbox"),
    sent: t("folder.sent"),
    drafts: t("folder.drafts"),
    trash: t("folder.trash"),
    spam: t("folder.spam"),
    archive: t("folder.archive"),
    custom: t("folder.custom"),
    starred: t("folder.favorites"),
    all_mail: t("folder.allMail"),
    unread: t("folder.unread"),
    label: t("labels"),
  };
}

interface FolderItemProps {
  type: FolderType;
  label: string;
  href: string;
  unreadCount?: number;
  totalCount?: number;
  isActive: boolean;
  icon: React.ComponentType<{ className?: string }>;
  collapsed?: boolean;
  onNavigate?: () => void;
}

function FolderItem({ type, label, href, unreadCount, totalCount, isActive, icon: Icon, collapsed, onNavigate }: FolderItemProps) {
  const hasUnread = unreadCount != null && unreadCount > 0;
  const hasTotal = totalCount != null && totalCount > 0;

  const link = (
    <HashLink
      data-ref={`sidebar-nav-${type}`}
      href={href}
      onClick={onNavigate}
      data-active={isActive || undefined}
      className={cn(
        "flex items-center rounded-md text-sm transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        isActive && "bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-sidebar-accent-foreground font-medium",
        collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2"
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{label}</span>
          {(hasUnread || hasTotal) && (
            <span data-ref={`sidebar-nav-${type}-badge`} className="ml-auto text-[10px] tabular-nums text-muted-foreground">
              {hasUnread && (
                <span className="font-semibold text-foreground">{unreadCount}</span>
              )}
              {hasUnread && hasTotal && " / "}
              {!hasUnread && hasTotal && totalCount}
              {hasUnread && hasTotal && totalCount}
            </span>
          )}
        </>
      )}
    </HashLink>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

interface FolderGroupProps {
  folders: Array<{ id: string; name: string; unread_count: number }>;
  currentFolder: string;
  collapsed?: boolean;
  onNavigate?: (id: string) => void;
}

function FolderGroup({ folders, currentFolder, collapsed, onNavigate }: FolderGroupProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  if (folders.length === 0) return null;

  const hasActive = folders.some((f) => currentFolder === f.id);
  const totalUnread = folders.reduce((sum, f) => sum + f.unread_count, 0);
  const label = t("folder.folders");

  function handleMouseEnter() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(true);
  }

  function handleMouseLeave() {
    timeoutRef.current = setTimeout(() => setOpen(false), 150);
  }

  const triggerButton = (
    <button
      type="button"
      data-active={hasActive || undefined}
      className={cn(
        "flex w-full items-center rounded-md text-sm transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        hasActive && "bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-sidebar-accent-foreground font-medium",
        collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2"
      )}
    >
      <Folder className="size-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate text-left">{label}</span>
          {totalUnread > 0 && (
            <Badge variant="secondary" className="text-xs tabular-nums">
              {totalUnread}
            </Badge>
          )}
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        </>
      )}
    </button>
  );

  const popover = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {triggerButton}
        </div>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-auto min-w-48 p-1"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {folders.map((folder) => (
          <HashLink
            key={folder.id}
            href={`/mail/${folder.id}`}
            onClick={() => { setOpen(false); onNavigate?.(folder.id); }}
            className={cn(
              "flex items-center gap-3 rounded-sm px-3 py-2 text-sm transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
              currentFolder === folder.id && "bg-accent text-accent-foreground font-medium"
            )}
          >
            <Folder className="size-4 shrink-0" />
            <span className="flex-1 truncate">{folder.name}</span>
            {folder.unread_count > 0 && (
              <Badge variant="secondary" className="ml-auto text-xs tabular-nums">
                {folder.unread_count}
              </Badge>
            )}
          </HashLink>
        ))}
      </PopoverContent>
    </Popover>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div>{popover}</div>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return popover;
}

/**
 * Charge les compteurs sidebar depuis le serveur et les ecrit dans le store.
 * Le store est aussi mis a jour optimistement par les actions (markAsRead, etc.)
 */
function useSidebarCountsSync(): void {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const foldersRefreshKey = useMailStore((s) => s.foldersRefreshKey);

  // Refetch compteurs depuis le serveur
  useEffect(() => {
    if (!activeAccountId) return;
    let cancelled = false;

    async function fetchCounts() {
      const t0 = performance.now();
      bootMark("sidebar-counts:fetch-start", { account: activeAccountId });
      try {
        const params = activeAccountId !== "all" ? `?account_id=${activeAccountId}` : "";
        const data = await pb.send<{
          inboxUnread: number;
          inboxTotal: number;
          starred: number;
          unread: number;
          sent: number;
          drafts: number;
          trash: number;
          allMail: number;
          allMailUnread30?: number;
          spam: number;
        }>(`/api/mail/sidebar-counts${params}`, { method: "GET" });
        bootMark("sidebar-counts:fetch-done", { dur_ms: Math.round(performance.now() - t0) });
        if (!cancelled) {
          useMailStore.getState().setSidebarCounts(data);
        }
      } catch {
        bootMark("sidebar-counts:fetch-error", { dur_ms: Math.round(performance.now() - t0) });
      }
    }

    fetchCounts();
    return () => { cancelled = true; };
  }, [activeAccountId, foldersRefreshKey]);

  // Polling sidebar removed — real-time updates via WebSocket channel (ws-channel.ts)
}

/**
 * Onglet Newsletters : flux de syntheses IA. Hors arborescence /mail/, donc
 * actif sur pathname === "/newsletters". Badge = posts non lus.
 */
function NewsletterNavItem({
  isActive,
  collapsed,
  onNavigate,
}: {
  isActive: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const t = useT();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function fetchCount() {
      try {
        const res = await pb.collection("newsletter_posts").getList(1, 1, {
          filter: "is_read=false",
          fields: "id",
          requestKey: "newsletter-unread",
        });
        if (!cancelled) setUnread(res.totalItems);
      } catch {
        /* collection absente / non authentifie : badge masque */
      }
    }
    fetchCount();
    return () => {
      cancelled = true;
    };
    // Re-fetch a chaque navigation (les posts vus passent en lu cote page).
  }, [isActive]);

  const label = t("folder.newsletters");
  const link = (
    <HashLink
      data-ref="sidebar-nav-newsletters"
      href="/newsletters"
      onClick={onNavigate}
      data-active={isActive || undefined}
      className={cn(
        "flex items-center rounded-md text-sm transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        isActive && "bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-sidebar-accent-foreground font-medium",
        collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2"
      )}
    >
      <Newspaper className="size-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{label}</span>
          {unread > 0 && (
            <span data-ref="sidebar-nav-newsletters-badge" className="ml-auto text-[10px] tabular-nums">
              <span className="font-semibold text-foreground">{unread}</span>
            </span>
          )}
        </>
      )}
    </HashLink>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return link;
}

/**
 * Onglet Suivi : fiches de suivi (commandes, livraisons, rendez-vous...). Hors
 * arborescence /mail/, actif sur pathname === "/suivi". Badge = nombre de suivis
 * a suivre (active/waiting, non archives).
 */
function TrackingNavItem({
  isActive,
  collapsed,
  onNavigate,
}: {
  isActive: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const t = useT();
  const [attention, setAttention] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchTrackingAttentionCount().then((n) => {
      if (!cancelled) setAttention(n);
    });
    return () => {
      cancelled = true;
    };
    // Re-fetch a chaque navigation (statuts mis a jour cote page).
  }, [isActive]);

  const label = t("folder.suivi");
  const link = (
    <HashLink
      data-ref="sidebar-nav-suivi"
      href="/suivi"
      onClick={onNavigate}
      data-active={isActive || undefined}
      className={cn(
        "flex items-center rounded-md text-sm transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        isActive && "bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-sidebar-accent-foreground font-medium",
        collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2"
      )}
    >
      <PackageSearch className="size-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{label}</span>
          {attention > 0 && (
            <span data-ref="sidebar-nav-suivi-badge" className="ml-auto text-[10px] tabular-nums">
              <span className="font-semibold text-foreground">{attention}</span>
            </span>
          )}
        </>
      )}
    </HashLink>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return link;
}

/**
 * Onglet de navigation simple (sans compteur) : Agenda, Contacts. Regroupes avec
 * Newsletters/Suivi sous les dossiers mail, separes par un trait.
 */
function PageNavItem({
  href,
  label,
  icon: Icon,
  dataRef,
  isActive,
  collapsed,
  onNavigate,
  badge = 0,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  dataRef: string;
  isActive: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
  /** Nombre a signaler sur l'entree (0 = rien). Replie, il devient une pastille. */
  badge?: number;
}) {
  const link = (
    <HashLink
      data-ref={dataRef}
      href={href}
      onClick={onNavigate}
      data-active={isActive || undefined}
      className={cn(
        "relative flex items-center rounded-md text-sm transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        isActive && "bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-sidebar-accent-foreground font-medium",
        collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2"
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
      {badge > 0 &&
        (collapsed ? (
          <span
            data-ref={`${dataRef}-badge`}
            className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground"
          >
            {badge}
          </span>
        ) : (
          <span
            data-ref={`${dataRef}-badge`}
            className="ml-auto flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground"
          >
            {badge}
          </span>
        ))}
    </HashLink>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return link;
}

export function FolderNav({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { pathname } = useHashRouter();
  const { folders } = useFolders();
  const t = useT();
  const folderLabels = useFolderLabels();
  useSidebarCountsSync();
  const c = useMailStore((s) => s.sidebarCounts);
  const setActiveFolder = useMailStore((s) => s.setActiveFolder);

  // Determiner le dossier actif depuis l'URL (vide hors des routes mail,
  // sinon "all" mettrait "Tous les messages" en surbrillance sur /intro, etc.)
  const currentFolder = pathname.startsWith("/mail/")
    ? pathname.split("/mail/")[1]?.split("/")[0] || "all"
    : "";

  // Force la synchronisation du store au clic, meme si l'URL hash ne change pas
  // (sinon clic label -> clic inbox laisse activeFolder="label" car hashchange
  // ne se declenche pas pour une navigation identique).
  function handleNavigate(type: FolderType, folderId?: string) {
    let ids: string[] = [];
    if (folderId) {
      ids = [folderId];
    } else if (type !== "starred" && type !== "all_mail" && type !== "unread") {
      ids = folders.filter((f) => f.type === type).map((f) => f.id);
    }
    setActiveFolder(ids, type);
    onNavigate?.();
  }

  return (
    <nav data-ref="sidebar-nav" className="flex flex-col gap-1 px-2">
      <PageNavItem
        href="/intro"
        label={t("intro.title")}
        icon={Home}
        dataRef="sidebar-nav-intro"
        isActive={pathname === "/intro"}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />
      <Separator className={cn("my-1", collapsed ? "mx-auto w-6" : "")} />
      <FolderItem
        type="all_mail"
        label={folderLabels.all_mail}
        href="/mail/all"
        unreadCount={c.allMailUnread30}
        totalCount={c.allMail}
        isActive={currentFolder === "all"}
        icon={Mail}
        collapsed={collapsed}
        onNavigate={() => handleNavigate("all_mail")}
      />
      <FolderItem
        type="inbox"
        label={folderLabels.inbox}
        href="/mail/inbox"
        unreadCount={c.inboxUnread}
        totalCount={c.inboxTotal}
        isActive={currentFolder === "inbox"}
        icon={Inbox}
        collapsed={collapsed}
        onNavigate={() => handleNavigate("inbox")}
      />
      <FolderItem
        type="unread"
        label={folderLabels.unread}
        href="/mail/unread"
        unreadCount={c.unread}
        isActive={currentFolder === "unread"}
        icon={CircleDot}
        collapsed={collapsed}
        onNavigate={() => handleNavigate("unread")}
      />
      <FolderItem
        type="starred"
        label={folderLabels.starred}
        href="/mail/starred"
        totalCount={c.starred}
        isActive={currentFolder === "starred"}
        icon={Star}
        collapsed={collapsed}
        onNavigate={() => handleNavigate("starred")}
      />
      <FolderItem
        type="sent"
        label={folderLabels.sent}
        href="/mail/sent"
        totalCount={c.sent}
        isActive={currentFolder === "sent"}
        icon={Send}
        collapsed={collapsed}
        onNavigate={() => handleNavigate("sent")}
      />
      <FolderItem
        type="drafts"
        label={folderLabels.drafts}
        href="/mail/drafts"
        totalCount={c.drafts}
        isActive={currentFolder === "drafts"}
        icon={FileText}
        collapsed={collapsed}
        onNavigate={() => handleNavigate("drafts")}
      />
      <FolderItem
        type="trash"
        label={folderLabels.trash}
        href="/mail/trash"
        totalCount={c.trash}
        isActive={currentFolder === "trash"}
        icon={Trash2}
        collapsed={collapsed}
        onNavigate={() => handleNavigate("trash")}
      />

      <FolderItem
        type="spam"
        label={folderLabels.spam}
        href="/mail/spam"
        totalCount={c.spam}
        isActive={currentFolder === "spam"}
        icon={ShieldAlert}
        collapsed={collapsed}
        onNavigate={() => handleNavigate("spam")}
      />

      {/* Dossiers personnalises regroupes */}
      <FolderGroup
        folders={folders.filter((f) => f.type === "custom")}
        currentFolder={currentFolder}
        collapsed={collapsed}
        onNavigate={(id) => handleNavigate("custom", id)}
      />

      {/* Groupe applicatif : Agenda, Contacts, puis Newsletters + Suivi */}
      <Separator className={cn("my-1", collapsed ? "mx-auto w-6" : "")} />
      <PageNavItem
        href="/calendar"
        label={t("calendar")}
        icon={CalendarDays}
        dataRef="sidebar-nav-calendar"
        isActive={pathname === "/calendar"}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />
      <PageNavItem
        href="/contacts"
        label={t("contacts")}
        icon={Users}
        dataRef="sidebar-nav-contacts"
        isActive={pathname === "/contacts"}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />

      {/* Newsletters + Suivi regroupes sous Contacts */}
      <NewsletterNavItem
        isActive={pathname === "/newsletters" || pathname === "/newsletters/stats"}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />
      <TrackingNavItem
        isActive={pathname === "/suivi"}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />
    </nav>
  );
}
