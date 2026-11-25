"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BarChart3 } from "lucide-react";
import type { ActivityDataPoint } from "@/lib/hooks/useDashboard";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface ActivityChartProps {
  data: ActivityDataPoint[];
}

export default function ActivityChart({ data }: ActivityChartProps) {
  return (
    <Card data-ref="dashboard-activity">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="size-5 text-primary" />
          <CardTitle className="text-base">Activite</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p data-ref="dashboard-activity-empty" className="py-12 text-center text-sm text-muted-foreground">
            Aucune donnee disponible
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data} barCategoryGap="20%">
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--color-border)"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 12 }}
                stroke="var(--color-muted-foreground)"
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontSize: 12 }}
                stroke="var(--color-muted-foreground)"
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-popover)",
                  borderColor: "var(--color-border)",
                  borderRadius: "8px",
                  color: "var(--color-popover-foreground)",
                  fontSize: "12px",
                }}
                labelStyle={{
                  color: "var(--color-popover-foreground)",
                  fontWeight: 600,
                }}
              />
              <Legend
                iconType="circle"
                wrapperStyle={{ fontSize: "12px" }}
              />
              <Bar
                dataKey="received"
                name="Recus"
                fill="#3B82F6"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="sent"
                name="Envoyes"
                fill="#10B981"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
