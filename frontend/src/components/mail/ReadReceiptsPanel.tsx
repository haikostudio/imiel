"use client";

import { useMemo, type RefObject } from "react";
import { Eye, Inbox, Loader2, Send } from "lucide-react";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatFullDate } from "@/lib/utils/date";
import type { Message, ReadReceipt } from "@/lib/pocketbase";
import {
  labelForRecipientEmail,
  recipientLabel,
  uniqueRecipients,
} from "@/lib/utils/recipients";

interface ReadReceiptsPanelProps {
  /** Ouvert/ferme par le bouton CheckCheck de l'en-tete. */
  open: boolean;
  onClose: () => void;
  /** Tous les messages de la conversation (cross-folder, tries par date). */
  messages: Message[];
  /** Adresses de l'utilisateur (pour distinguer envoyes / recus). */
  userEmails: Set<string>;
  /** Evenements de suivi de lecture (hook useReadReceipts, messages envoyes). */
  receipts: ReadReceipt[];
  loading: boolean;
  /** Confinement desktop (panneau de lecture) ; undefined sur mobile. */
  containerRef?: RefObject<HTMLElement | null>;
}

interface TimelineEntry {
  key: string;
  kind: "sent" | "received" | "opened" | "reopened";
  date: string;
  /** Correspondant (destinataire pour un envoi, expediteur pour une reception). */
  who: string;
  /** Libelle client ("Gmail", "iPhone/iPad"...) pour les ouvertures. */
  client?: string;
}

interface MessageFlow {
  message: Message;
  isMine: boolean;
  entries: TimelineEntry[];
  openCount: number;
}

function isFromUser(msg: Message, userEmails: Set<string>): boolean {
  const from = msg.from_address?.address?.toLowerCase() || "";
  return msg.is_sent || (from !== "" && userEmails.has(from));
}

function correspondent(msg: Message, isMine: boolean, recipientCountLabel: (n: number) => string): string {
  if (isMine) {
    const all = uniqueRecipients([
      msg.to_addresses,
      msg.cc_addresses,
      msg.bcc_addresses,
    ]);
    if (all.length > 1) return recipientCountLabel(all.length);
    return recipientLabel(all[0]);
  }
  return msg.from_address?.name || msg.from_address?.address || "";
}

/**
 * Volet "Suivi de lecture" d'une conversation, ouvert par le bouton CheckCheck
 * de l'en-tete. Pour chaque message du fil : Envoye (pixel injecte a l'envoi
 * SMTP) -> Lu (1er chargement du pixel par le destinataire) -> Relu
 * (chargements suivants) ; les messages recus figurent comme "Recu" pour la
 * lecture chronologique complete du flux.
 */
export function ReadReceiptsPanel({
  open,
  onClose,
  messages,
  userEmails,
  receipts,
  loading,
  containerRef,
}: ReadReceiptsPanelProps) {
  const t = useT();
  const container = containerRef?.current ?? null;
  const contained = container != null;

  const flows = useMemo<MessageFlow[]>(() => {
    const byMessage = new Map<string, ReadReceipt[]>();
    for (const r of receipts) {
      const list = byMessage.get(r.message) || [];
      list.push(r);
      byMessage.set(r.message, list);
    }

    const sorted = [...messages].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    return sorted.map((msg) => {
      const isMine = isFromUser(msg, userEmails);
      const who = correspondent(msg, isMine, (n) =>
        t("message.recipientCount", { count: String(n) })
      );
      const recipients = uniqueRecipients([
        msg.to_addresses,
        msg.cc_addresses,
        msg.bcc_addresses,
      ]);
      const msgReceipts = (byMessage.get(msg.id) || []).sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      );
      const entries: TimelineEntry[] = [];

      if (isMine) {
        const sentReceipt = msgReceipts.find((r) => r.kind === "sent");
        entries.push({
          key: `${msg.id}-sent`,
          kind: "sent",
          date: sentReceipt?.date || msg.date,
          who,
        });
        const opensByRecipient = new Map<string, number>();
        let opens = 0;
        for (const r of msgReceipts) {
          // Reception : passage de controle de la messagerie a l'arrivee
          // (migration 072). Jamais compte comme une ouverture.
          if (r.kind === "received") {
            const email = (r.recipient || "").trim().toLowerCase();
            entries.push({
              key: r.id,
              kind: "received",
              date: r.date,
              who: email ? labelForRecipientEmail(recipients, email) : "",
              client: r.client,
            });
            continue;
          }
          if (r.kind !== "opened") continue;
          opens++;
          const email = (r.recipient || "").trim().toLowerCase();
          const n = (opensByRecipient.get(email) || 0) + 1;
          opensByRecipient.set(email, n);
          entries.push({
            key: r.id,
            kind: n === 1 ? "opened" : "reopened",
            date: r.date,
            who: email ? labelForRecipientEmail(recipients, email) : "",
            client: r.client,
          });
        }
        return { message: msg, isMine, entries, openCount: opens };
      }

      entries.push({
        key: `${msg.id}-received`,
        kind: "received",
        date: msg.date,
        who,
      });
      return { message: msg, isMine, entries, openCount: 0 };
    });
  }, [messages, receipts, userEmails, t]);

  const hasAny = flows.length > 0;

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      repositionInputs={false}
      noBodyStyles
      container={container}
    >
      <DrawerContent
        className="flex sheet-max-h flex-col data-[contained=true]:max-h-[calc(var(--app-height,100dvh)*0.85)]"
        container={container}
        contained={contained}
        overlayClassName={contained ? "bg-black/30 backdrop-blur-none" : undefined}
        data-ref="read-receipts-drawer"
        hideGrip
      >
        <DrawerSheetHeader
          title={t("readReceipts.title")}
          className="border-b"
          actions={
            loading ? (
              <span className="inline-flex size-9 items-center justify-center">
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
              </span>
            ) : undefined
          }
        />

        {/* Corps defilant */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm">
          {!hasAny ? (
            <p className="text-muted-foreground">{t("readReceipts.empty")}</p>
          ) : (
            <div className="flex flex-col gap-5">
              {flows.map(({ message: msg, isMine, entries, openCount }) => (
                <div key={msg.id} data-ref="read-receipts-message">
                  {/* En-tete du message : direction + correspondant */}
                  <div className="mb-2 flex items-center gap-2">
                    {isMine ? (
                      <Send className="size-3.5 shrink-0 text-foreground" />
                    ) : (
                      <Inbox className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {isMine ? t("readReceipts.to") : t("readReceipts.from")}{" "}
                      {correspondent(msg, isMine, (n) =>
                        t("message.recipientCount", { count: String(n) })
                      )}
                    </span>
                    {isMine && openCount > 1 && (
                      <span className="text-muted-foreground shrink-0 text-[11px]">
                        {t("readReceipts.openCount", { count: String(openCount) })}
                      </span>
                    )}
                  </div>

                  {/* Timeline verticale des evenements */}
                  <ol className="border-border/70 ml-1.5 flex flex-col gap-3 border-l pl-4">
                    {entries.map((e) => (
                      <li key={e.key} className="relative">
                        <span
                          className={cn(
                            "absolute -left-[21.5px] top-1 size-2.5 rounded-full border-2 border-background",
                            e.kind === "sent" && "bg-muted-foreground/50",
                            e.kind === "received" && "bg-muted-foreground/50",
                            e.kind === "opened" && "bg-foreground",
                            e.kind === "reopened" && "bg-foreground/50"
                          )}
                          aria-hidden
                        />
                        <div className="flex items-center gap-2">
                          {e.kind === "sent" && <Send className="text-muted-foreground size-3.5 shrink-0" />}
                          {e.kind === "received" && <Inbox className="text-muted-foreground size-3.5 shrink-0" />}
                          {(e.kind === "opened" || e.kind === "reopened") && (
                            <Eye className="size-3.5 shrink-0 text-foreground" />
                          )}
                          <span className={cn("font-medium", (e.kind === "opened" || e.kind === "reopened") && "text-foreground")}>
                            {e.kind === "sent" && t("readReceipts.sent")}
                            {e.kind === "received" && t("readReceipts.received")}
                            {e.kind === "opened" && t("readReceipts.opened")}
                            {e.kind === "reopened" && t("readReceipts.reopened")}
                          </span>
                          {e.client && (
                            <span className="text-muted-foreground text-xs">
                              &middot; {e.client}
                            </span>
                          )}
                          {e.kind !== "sent" && e.who && (
                            <span className="text-muted-foreground min-w-0 truncate text-xs">
                              &middot; {e.who}
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground mt-0.5 text-xs">
                          {formatFullDate(e.date)}
                        </div>
                      </li>
                    ))}
                    {/* Message envoye sans ouverture : etat d'attente */}
                    {isMine && openCount === 0 && (
                      <li className="relative">
                        <span
                          className="border-background bg-muted absolute -left-[21.5px] top-1 size-2.5 rounded-full border-2"
                          aria-hidden
                        />
                        <div className="text-muted-foreground flex items-center gap-2 text-xs italic">
                          <Eye className="size-3.5 shrink-0 opacity-50" />
                          {t("readReceipts.noOpens")}
                        </div>
                      </li>
                    )}
                  </ol>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Note honnete sur les limites du pixel */}
        <div className="text-muted-foreground shrink-0 border-t px-4 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-[11px] leading-relaxed">
          {t("readReceipts.hint")}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
