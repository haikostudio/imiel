"use client";

import { useMemo, useState } from "react";
import { Eye, Inbox, Send } from "lucide-react";
import { RemoveScroll } from "react-remove-scroll";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatFullDate } from "@/lib/utils/date";
import type { Message, ReadReceipt } from "@/lib/pocketbase";
import { labelForRecipientEmail, uniqueRecipients } from "@/lib/utils/recipients";

interface ViewsEntry {
  key: string;
  kind: "sent" | "received" | "opened" | "reopened";
  date: string;
  who: string;
  client?: string;
}

/** Le bouton vit dans la rangee du message, qui porte le clic droit
 * (ordinateur) : on l'arrete ici. L'appui long (telephone) ignore lui-meme le
 * bouton et le menu (MessageAccordion) - MEM-5171. */
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * Vues d'un message ENVOYE, sous sa bulle (choix utilisateur 2026-10-18) :
 * nombre d'ouvertures de CE message (relectures comprises, jamais un total de
 * conversation) ; un clic ouvre le detail : envoi, reception (scan de la
 * messagerie a l'arrivee, quand il existe) puis chaque ouverture, par personne.
 */
export function MessageViews({
  message,
  receipts,
  onOpenChange,
}: {
  message: Message;
  /** Evenements de CE message (deja remappes vers la copie affichee). */
  receipts: ReadReceipt[];
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const { entries, opens } = useMemo(() => {
    const recipients = uniqueRecipients([message.to_addresses, message.cc_addresses, message.bcc_addresses]);
    const sorted = [...receipts].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const sent = sorted.find((r) => r.kind === "sent");
    const list: ViewsEntry[] = [{ key: "sent", kind: "sent", date: sent?.date || message.date, who: "" }];
    const byRecipient = new Map<string, number>();
    let count = 0;
    for (const r of sorted) {
      const email = (r.recipient || "").trim().toLowerCase();
      const who = email ? labelForRecipientEmail(recipients, email) : "";
      if (r.kind === "received") {
        list.push({ key: r.id, kind: "received", date: r.date, who, client: r.client });
      } else if (r.kind === "opened") {
        count++;
        const n = (byRecipient.get(email) || 0) + 1;
        byRecipient.set(email, n);
        list.push({ key: r.id, kind: n === 1 ? "opened" : "reopened", date: r.date, who, client: r.client });
      }
    }
    return { entries: list, opens: count };
  }, [message, receipts]);

  const label =
    opens === 0
      ? t("readReceipts.noViews")
      : opens === 1
        ? t("readReceipts.view")
        : t("readReceipts.views", { count: String(opens) });

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        onOpenChange?.(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-ref="thread-message-views"
          data-views={opens}
          onContextMenu={stop}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.8125rem] transition-colors hover:bg-muted",
            opens > 0 ? "text-foreground" : "text-muted-foreground"
          )}
          aria-label={`${t("readReceipts.title")} : ${label}`}
        >
          <Eye className="size-3.5 shrink-0" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="z-[100] w-80 max-w-[calc(100vw-1.5rem)] p-0"
        data-ref="thread-message-views-menu"
        // PAS de stopPropagation au toucher ici : le verrou de defilement
        // ecoute touchstart au niveau du document (sinon le menu ne defile plus
        // au doigt dans le tiroir de conversation). La rangee du message ignore
        // les touchers venus du portail (MessageAccordion).
        onContextMenu={stop}
      >
        <RemoveScroll removeScrollBar={false} allowPinchZoom>
          <ol className="flex max-h-[min(60vh,24rem)] flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-3 text-sm">
            {entries.map((e) => (
              <li key={e.key} data-ref={`thread-message-views-${e.kind}`}>
                <div className="flex min-w-0 items-center gap-2">
                  {e.kind === "sent" && <Send className="size-3.5 shrink-0 text-muted-foreground" />}
                  {e.kind === "received" && <Inbox className="size-3.5 shrink-0 text-muted-foreground" />}
                  {(e.kind === "opened" || e.kind === "reopened") && <Eye className="size-3.5 shrink-0" />}
                  <span className="shrink-0 font-medium">
                    {e.kind === "sent" && t("readReceipts.sent")}
                    {e.kind === "received" && t("readReceipts.received")}
                    {e.kind === "opened" && t("readReceipts.opened")}
                    {e.kind === "reopened" && t("readReceipts.reopened")}
                  </span>
                  {e.who && <span className="min-w-0 truncate text-xs text-muted-foreground">&middot; {e.who}</span>}
                  {e.client && <span className="shrink-0 text-xs text-muted-foreground">&middot; {e.client}</span>}
                </div>
                <div className="mt-0.5 pl-5.5 text-xs text-muted-foreground">{formatFullDate(e.date)}</div>
              </li>
            ))}
            {opens === 0 && (
              <li className="flex items-center gap-2 text-xs text-muted-foreground italic">
                <Eye className="size-3.5 shrink-0 opacity-50" />
                {t("readReceipts.noOpens")}
              </li>
            )}
          </ol>
        </RemoveScroll>
      </PopoverContent>
    </Popover>
  );
}
