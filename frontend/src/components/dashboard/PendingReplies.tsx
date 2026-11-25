"use client";

import { useHashRouter } from "@/lib/hash-router";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowUpRight, Clock } from "lucide-react";
import type { Message } from "@/lib/pocketbase";
import { formatTimeAgo } from "@/lib/utils/date";
import { useT } from "@/lib/i18n";

interface PendingRepliesProps {
  messages: Message[];
}

export default function PendingReplies({ messages }: PendingRepliesProps) {
  const t = useT();
  const { navigate } = useHashRouter();
  const displayed = messages.slice(0, 8);

  return (
    <Card data-ref="dashboard-pending">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Clock className="size-5 text-blue-500" />
          <CardTitle className="text-base">
            {t("dashboard.pendingReply")}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {displayed.length === 0 && (
          <p data-ref="dashboard-pending-empty" className="py-8 text-center text-sm text-muted-foreground">
            {t("dashboard.noPendingMessages")}
          </p>
        )}

        {displayed.map((msg) => (
          <button
            key={msg.id}
            className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
            data-ref="dashboard-pending-item"
            onClick={() =>
              navigate(`/mail/sent?message=${msg.id}`)
            }
          >
            <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">
                  {msg.subject || t("message.noSubject")}
                </p>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatTimeAgo(msg.date)}
                </span>
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {t("dashboard.toPrefix")}{msg.to_addresses?.[0]?.name || msg.to_addresses?.[0]?.address || ""}
              </p>
            </div>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}
