"use client";

import { useState } from "react";
import { useDashboard } from "@/lib/hooks/useDashboard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import KpiCards from "@/components/dashboard/KpiCards";
import UnrepliedList from "@/components/dashboard/UnrepliedList";
import PendingReplies from "@/components/dashboard/PendingReplies";
import ActivityChart from "@/components/dashboard/ActivityChart";
import TopContacts from "@/components/dashboard/TopContacts";
import { Chip } from "@/components/ui/kit";
import { useT } from "@/lib/i18n";

type Period = "7" | "30" | "90";

export default function DashboardPage() {
  const t = useT();
  const [period, setPeriod] = useState<Period>("7");
  const { stats, needsReply, waitingReply, activityData, topContacts, loading } =
    useDashboard();

  if (loading) {
    return (
      <div data-ref="dashboard-page-loading" className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-80 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div data-ref="dashboard-page" className="space-y-4 px-3 pt-1 pb-6 md:space-y-6 md:p-6">
      {/* Le titre vit dans la barre du haut ; ici la periode en pastilles. */}
      <div className="flex items-center justify-end">
        <h1 data-ref="dashboard-title" className="sr-only">{t("dashboard.title")}</h1>
        <div data-ref="dashboard-period-selector" className="flex items-center gap-2">
          {([["7", "dashboard.7d"], ["30", "dashboard.30d"], ["90", "dashboard.90d"]] as const).map(([value, key]) => (
            <Chip key={value} active={period === value} onClick={() => setPeriod(value as Period)}>
              {t(key)}
            </Chip>
          ))}
        </div>
      </div>

      <KpiCards stats={stats} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <UnrepliedList messages={needsReply} />
          <PendingReplies messages={waitingReply} />
        </div>
        <div className="space-y-6">
          <ActivityChart data={activityData} />
          <TopContacts contacts={topContacts} />
        </div>
      </div>
    </div>
  );
}
