"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, PackageSearch, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { trackingItems, type TrackingItem } from "@/lib/pocketbase";
import { useTrackedThreads } from "@/lib/stores/tracked-threads";
import { getInitials, getAvatarColor } from "@/lib/utils/avatar";
import { formatRelativeDate } from "@/lib/utils/date";
import { useT, t as tStatic } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface AddToTrackingDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Mails a rattacher a la fiche choisie (un seul depuis le clic droit, plusieurs
   * depuis la selection par cases a cocher). Le worker resout le thread de chacun. */
  messageIds: string[];
}

const isClosedItem = (it: TrackingItem) =>
  it.status === "done" || it.status === "cancelled";

/** Favicon du marchand (meme rendu que la liste Suivi : chip logo sur fond blanc,
 * repli propre sur l'initiale coloree via le proxy /api/favicon). */
export function FicheAvatar({ item }: { item: Pick<TrackingItem, "sender_domain" | "merchant" | "title"> }) {
  const seed = item.sender_domain || item.merchant || item.title;
  const label = item.merchant || item.sender_domain || item.title;
  return (
    <Avatar size="default" className="mt-0.5 rounded-md border">
      {item.sender_domain && (
        <AvatarImage
          src={`/api/favicon?domain=${encodeURIComponent(item.sender_domain)}`}
          alt=""
          className="rounded-md bg-white object-contain p-1"
        />
      )}
      <AvatarFallback
        className="rounded-md text-xs font-medium text-white"
        style={{ backgroundColor: getAvatarColor(seed) }}
      >
        {getInitials(label)}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * Tiroir de rattachement d'un/plusieurs mails a un suivi EXISTANT. Champ de
 * recherche en haut (filtre titre/marchand/domaine/type), liste des fiches non
 * archivees dessous (ouvertes en tete). Un clic sur une fiche envoie la selection
 * au worker (POST /tracking/attach, 1 seule re-synthese) puis ferme le tiroir.
 */
export function AddToTrackingDrawer({ open, onOpenChange, messageIds }: AddToTrackingDrawerProps) {
  const t = useT();
  const [items, setItems] = useState<TrackingItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [attachingId, setAttachingId] = useState<string | null>(null);
  const refreshTracked = useTrackedThreads((s) => s.refresh);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setAttachingId(null);
    let cancelled = false;
    setLoading(true);
    trackingItems()
      .getFullList<TrackingItem>({
        filter: "archived = false",
        sort: "-last_message_date",
        requestKey: "attach-tracking-list",
      })
      .then((res) => {
        if (!cancelled) setItems(res);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...items].sort((a, b) => Number(isClosedItem(a)) - Number(isClosedItem(b)));
    if (!q) return sorted;
    return sorted.filter((it) =>
      [it.title, it.merchant, it.sender_domain, it.type, it.status_label]
        .filter(Boolean)
        .some((f) => f.toLowerCase().includes(q))
    );
  }, [items, query]);

  const handleAttach = async (item: TrackingItem) => {
    if (attachingId || messageIds.length === 0) return;
    setAttachingId(item.id);
    try {
      const r = await fetch("/worker/tracking/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, messageIds }),
      });
      if (!r.ok) throw new Error(String(r.status));
      toast.success(tStatic("tracking.addedToExisting"));
      void refreshTracked();
      onOpenChange(false);
    } catch {
      toast.error(tStatic("tracking.addToExistingError"));
      setAttachingId(null);
    }
  };

  return (
    <ResponsivePanel
      open={open}
      onOpenChange={onOpenChange}
      title={t("tracking.addToExistingTitle")}
      accentColor="#f59e0b"
    >
      <div className="shrink-0 border-b p-3">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("tracking.searchPlaceholder")}
            className="pl-9"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {loading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-sm">
            <PackageSearch className="size-6 opacity-50" />
            {items.length === 0 ? t("tracking.empty") : t("tracking.noMatch")}
          </div>
        ) : (
          filtered.map((item) => {
            const closed = isClosedItem(item);
            const subtitle = [item.merchant || item.sender_domain, item.type]
              .filter(Boolean)
              .join(" · ");
            return (
              <button
                key={item.id}
                type="button"
                disabled={!!attachingId}
                onClick={() => handleAttach(item)}
                className="hover:bg-muted flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors disabled:opacity-60"
              >
                <FicheAvatar item={item} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    {closed && (
                      <span className="text-muted-foreground bg-muted shrink-0 rounded px-1.5 py-0.5 text-[10px]">
                        {t("tracking.statusDone")}
                      </span>
                    )}
                  </div>
                  {subtitle && (
                    <div className="text-muted-foreground truncate text-xs">{subtitle}</div>
                  )}
                </div>
                {attachingId === item.id ? (
                  <Loader2 className="text-muted-foreground mt-1 size-4 shrink-0 animate-spin" />
                ) : (
                  item.last_message_date && (
                    <span
                      className={cn(
                        "text-muted-foreground mt-0.5 shrink-0 text-[11px]",
                        closed && "opacity-70"
                      )}
                    >
                      {formatRelativeDate(item.last_message_date)}
                    </span>
                  )
                )}
              </button>
            );
          })
        )}
      </div>
    </ResponsivePanel>
  );
}
