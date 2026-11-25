"use client";

import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Mail,
  MessageSquareWarning,
  Send,
  Clock,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import type { DashboardStats } from "@/lib/hooks/useDashboard";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

interface KpiCardsProps {
  stats: DashboardStats;
}

interface KpiItem {
  label: string;
  value: string;
  icon: React.ElementType;
  iconClassName: string;
  trend?: number;
}

function formatHours(hours: number): string {
  if (hours < 1) return "< 1h";
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}j`;
}

export default function KpiCards({ stats }: KpiCardsProps) {
  const t = useT();
  const items: KpiItem[] = [
    {
      label: t("dashboard.unread"),
      value: String(stats.unreadCount),
      icon: Mail,
      iconClassName: "text-foreground bg-muted",
      trend: stats.unreadCount > 10 ? 1 : stats.unreadCount > 0 ? 0 : -1,
    },
    {
      label: t("dashboard.unanswered"),
      value: String(stats.unansweredCount),
      icon: MessageSquareWarning,
      iconClassName: "text-foreground bg-muted",
    },
    {
      label: t("dashboard.sentLast7d"),
      value: String(stats.sentCount7d),
      icon: Send,
      iconClassName: "text-foreground bg-muted",
    },
    {
      label: t("dashboard.responseTime"),
      value: formatHours(stats.avgResponseTimeHours),
      icon: Clock,
      iconClassName: "text-foreground bg-muted",
    },
  ];

  return (
    <div data-ref="dashboard-kpi" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label} data-ref={`dashboard-kpi-${item.label.toLowerCase().replace(/[^a-z0-9]/g, "-")}`}>
          <CardContent className="flex items-center gap-4 py-4">
            <div
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-full",
                item.iconClassName
              )}
            >
              <item.icon className="size-5" />
            </div>
            <div className="min-w-0">
              <p data-ref="dashboard-kpi-value" className="text-2xl font-bold leading-none">{item.value}</p>
              <p data-ref="dashboard-kpi-label" className="mt-1 text-sm text-muted-foreground">
                {item.label}
              </p>
            </div>
            {item.trend !== undefined && item.trend !== 0 && (
              <div className="ml-auto">
                {item.trend > 0 ? (
                  <TrendingUp className="size-4 text-destructive" />
                ) : (
                  <TrendingDown className="size-4 text-success" />
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
