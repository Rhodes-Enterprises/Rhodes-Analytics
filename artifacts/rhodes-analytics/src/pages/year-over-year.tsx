import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
} from "recharts";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetOwtYoy,
  useGetOwtFilters,
  useGetSnowflakeStatus,
  getOwtYoy,
  getGetOwtYoyQueryKey,
  type GetOwtYoyParams,
  type OwtYoy,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ALL,
  MONTH_NAMES,
  Breadcrumb,
  DownloadDataButton,
  FilterSelect,
  LiveStatusBadge,
  RefreshDataButton,
  fmt,
} from "@/components/dashboard-shared";
import { downloadCsv, type CsvValue } from "@/lib/utils";

const MEASURE_LABELS: Record<string, string> = {
  websiteUsers: "Website Users",
  leads: "Leads",
  tours: "Tours",
  grossSales: "Gross Sales",
};

export default function YearOverYearPage() {
  const [company, setCompany] = useState(ALL);
  const [development, setDevelopment] = useState(ALL);

  const filters = useGetOwtFilters();
  const yoyParams: GetOwtYoyParams = {
    ...(company !== ALL && { company }),
    ...(development !== ALL && { development }),
  };
  const yoy = useGetOwtYoy(yoyParams);
  const status = useGetSnowflakeStatus();

  // Force the API to bypass its stale-serve cache and wait for live
  // Snowflake data, then swap the fresh payload in under the same query key
  // so the numbers update in place.
  const queryClient = useQueryClient();
  const refreshNow = async () => {
    const live = await getOwtYoy({ ...yoyParams, refresh: true });
    queryClient.setQueryData(getGetOwtYoyQueryKey(yoyParams), live);
  };

  const developments = useMemo(() => {
    const list = filters.data?.developments ?? [];
    const scoped = company === ALL ? list : list.filter((d) => d.company === company);
    return [...new Set(scoped.map((d) => d.development))];
  }, [filters.data, company]);

  // "Oct 2025"-style label for when website tracking history begins.
  const gaStartLabel = useMemo(() => {
    const d = yoy.data?.gaHistoryStart;
    return d ? `${MONTH_NAMES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : null;
  }, [yoy.data?.gaHistoryStart]);

  const downloadMeasure = (m: OwtYoy["measures"][number]) => {
    const d = yoy.data;
    if (!d) return;
    const label = MEASURE_LABELS[m.measure] ?? m.measure;
    downloadCsv(
      `year-over-year-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      ["Month", String(d.year), String(d.priorYear), "Business Plan Goal"],
      m.points.map((p): CsvValue[] => [
        MONTH_NAMES[p.month - 1],
        p.currentYear,
        p.priorYear,
        p.goal,
      ]),
    );
  };

  return (
    <Layout>
      <div className="space-y-6">
        <Breadcrumb page="Year Over Year" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Year Over Year</h1>
            {yoy.data && (
              <p className="text-sm text-muted-foreground mt-1">
                {yoy.data.year} vs {yoy.data.priorYear} · monthly funnel metrics with business
                plan goal
              </p>
            )}
            <LiveStatusBadge
              status={status.data}
              checking={status.isLoading}
              lastRefreshed={yoy.dataUpdatedAt}
            />
          </div>
          <RefreshDataButton onRefresh={refreshNow} />
        </div>

        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
              <FilterSelect
                label="Division"
                value={company}
                onChange={(v) => {
                  setCompany(v);
                  setDevelopment(ALL);
                }}
                options={filters.data?.companies ?? []}
                testId="select-division"
              />
              <FilterSelect
                label="Development"
                value={development}
                onChange={setDevelopment}
                options={developments}
                testId="select-development"
              />
            </div>
          </CardContent>
        </Card>

        {yoy.isError && (
          <Alert variant="destructive">
            <AlertTitle>Failed to load dashboard data</AlertTitle>
            <AlertDescription>
              {(yoy.error as Error)?.message ?? "Snowflake query failed."}
            </AlertDescription>
          </Alert>
        )}

        {yoy.isLoading && (
          <div className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-80" />
            ))}
          </div>
        )}

        {yoy.data && (
          <div className="grid gap-4 lg:grid-cols-2">
            {yoy.data.measures.map((m) => {
              // Pre-tracking months arrive as null (never 0) so the chart
              // shows an honest gap; note below explains it.
              const noHistoryGap =
                m.measure === "websiteUsers" &&
                m.points.some((p) => p.currentYear === null || p.priorYear === null);
              return (
              <Card key={m.measure} data-testid={`chart-yoy-${m.measure}`}>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                  <CardTitle className="text-base">
                    {MEASURE_LABELS[m.measure] ?? m.measure}
                  </CardTitle>
                  <DownloadDataButton
                    slug={`yoy-${m.measure}`}
                    onDownload={() => downloadMeasure(m)}
                  />
                </CardHeader>
                <CardContent className="h-72">
                  <ResponsiveContainer>
                    <ComposedChart
                      data={m.points.map((p) => ({
                        ...p,
                        name: MONTH_NAMES[p.month - 1],
                      }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="name" fontSize={12} />
                      <YAxis fontSize={12} tickFormatter={(v) => fmt(v)} />
                      <RTooltip
                        formatter={(v) => (v == null ? "No data yet" : fmt(Number(v)))}
                      />
                      <Legend />
                      <Area
                        type="monotone"
                        dataKey="currentYear"
                        name={String(yoy.data.year)}
                        stroke="#3b82f6"
                        fill="#3b82f6"
                        fillOpacity={0.2}
                      />
                      <Area
                        type="monotone"
                        dataKey="priorYear"
                        name={String(yoy.data.priorYear)}
                        stroke="#94a3b8"
                        fill="#94a3b8"
                        fillOpacity={0.15}
                      />
                      <Line
                        type="monotone"
                        dataKey="goal"
                        name="Business Plan"
                        stroke="#ef4444"
                        strokeDasharray="5 3"
                        dot={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </CardContent>
                {noHistoryGap && (
                  <p
                    className="px-6 pb-4 text-xs text-muted-foreground"
                    data-testid="note-ga-history-gap"
                  >
                    {gaStartLabel
                      ? `Website tracking began ${gaStartLabel} — earlier months show as gaps (no data yet), not zeros.`
                      : "No website tracking data yet — months show as gaps until tracking data arrives."}
                  </p>
                )}
              </Card>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}
