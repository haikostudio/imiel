"use client";

import { useHashRouter } from "@/lib/hash-router";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageSquareWarning, ChevronRight } from "lucide-react";
import type { Message } from "@/lib/pocketbase";
import { formatTimeAgo } from "@/lib/utils/date";
import { differenceInHours } from "date-fns";
import { cn } from "@/lib/utils";
import { stripReplacementChars } from "@/lib/utils/sanitize";
import { useT } from "@/lib/i18n";

interface UnrepliedListProps {
  messages: Message[];
}

function getUrgencyColor(date: string): string {
  const hours = differenceInHours(new Date(), new Date(date));
  if (hours < 4) return "bg-green-500";
  if (hours < 24) return "bg-orange-500";
  return "bg-red-500";
}

export default function UnrepliedList({ messages }: UnrepliedListProps) {
  const t = useT();
  const { navigate } = useHashRouter();
  const displayed = messages.slice(0, 8);

  return (
    <Card data-ref="dashboard-unreplied">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquareWarning className="size-5" />
            <CardTitle className="text-base">
              {t("dashboard.needsReply")}
            </CardTitle>
          </div>
          {messages.length > 8 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/mail/inbox?filter=unreplied")}
              data-ref="dashboard-unreplied-see-all"
            >
              {t("dashboard.viewAll")}
              <ChevronRight className="size-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {displayed.length === 0 && (
          <p data-ref="dashboard-unreplied-empty" className="py-8 text-center text-sm text-muted-foreground">
            {t("dashboard.noMessagesNeedReply")}
          </p>
        )}

        {displayed.map((msg) => (
          <button
            key={msg.id}
            className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
            data-ref="dashboard-unreplied-item"
            onClick={() => navigate(`/mail/inbox?message=${msg.id}`)}
          >
            <div
              className={cn(
                "size-2 shrink-0 rounded-full",
                getUrgencyColor(msg.date)
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">
                  {stripReplacementChars(msg.from_address?.name || msg.from_address?.address || "")}
                </p>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatTimeAgo(msg.date)}
                </span>
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {stripReplacementChars(msg.subject) || t("message.noSubject")}
              </p>
            </div>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}
