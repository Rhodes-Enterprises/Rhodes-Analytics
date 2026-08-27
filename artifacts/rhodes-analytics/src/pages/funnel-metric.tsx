import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  BarChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
} from "recharts";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetFunnelMetric,
  useGetOwtFilters,
  useGetSnowflakeStatus,
  getFunnelMetric,
  getGetFunnelMetricQueryKey,
  type GetFunnelMetricParams,
  type GetFunnelMetricMetric,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { useCommittedDateRange } from "@/hooks/use-committed-date";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  cn,
  downloadData,
  type CsvValue,
  type DownloadFormat,
  type DownloadInfo,
} from "@/lib/utils";
import {
  ALL,
  MONTH_NAMES,
  Breadcrumb,
  DownloadDataButton,
  FilterSelect,
  CrossYearRangeHint,
  InvertedRangeHint,
  LoneDateHint,
  LiveStatusBadge,
  RefreshDataButton,
  TargetToggle,
  appliedRangeInfo,
  filterDisplayValue,
  fmt,
  fmtPct,
  ptgColor,
  ptgBg,
  targetLabel,
  type TargetValue,
} from "@/components/dashboard-shared";

interface FunnelPageConfig {
  metric: GetFunnelMetricMetric;
  title: string;
  unit: string;
  color: string;
}

function FunnelMetricPage({ metric, title, unit, color }: FunnelPageConfig) {
  const [target, setTarget] = useState<TargetValue>("goal");
  const [company, setCompany] = useState(ALL);
  const [development, setDevelopment] = useState(ALL);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // Only complete, plausible dates reach the API; while a date is half-typed,
  // the end date is before the start date, the range crosses calendar years
  // (the API rejects mixed-year ranges — goals are set per year), or a lone
  // date would invert against this page's default range (the current
  // quarter), the previously applied range stays in effect (no 400 flashes or
  // misleading all-zero metrics mid-edit).
  const {
    startDate: appliedStartDate,
    endDate: appliedEndDate,
    invertedRange,
    crossYearRange,
    loneDateConflict,
  } = useCommittedDateRange(startDate, endDate, { defaultRange: "quarter" });

  const params: GetFunnelMetricParams = {
    metric,
    target,
    ...(company !== ALL && { company }),
    ...(development !== ALL && { development }),
    ...(appliedStartDate && { startDate: appliedStartDate }),
    ...(appliedEndDate && { endDate: appliedEndDate }),
  };

  const filters = useGetOwtFilters();
  const dash = useGetFunnelMetric(params);
  const status = useGetSnowflakeStatus();

  // Force the API to bypass its stale-serve cache and wait for live
  // Snowflake data, then swap the fresh payload in under the same query key
  // so the numbers update in place.
  const queryClient = useQueryClient();
  const refreshNow = async () => {
    const live = await getFunnelMetric({ ...params, refresh: true });
    queryClient.setQueryData(getGetFunnelMetricQueryKey(params), live);
  };

  const developments = useMemo(() => {
    const list = filters.data?.developments ?? [];
    const scoped = company === ALL ? list : list.filter((d) => d.company === company);
    return [...new Set(scoped.map((d) => d.development))];
  }, [filters.data, company]);

  const setYtd = () => {
    const year = new Date().getFullYear();
    setStartDate(`${year}-01-01`);
    setEndDate(`${year}-12-31`);
  };

  const metricSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  // Provenance for the Excel Info sheet: this page's filters as displayed,
  // with the server-resolved applied range (not the raw inputs, which may be
  // blank while the backend fills in the default quarter).
  const downloadInfo: DownloadInfo = {
    page: title,
    filters: [
      { label: "Target", value: targetLabel(target) },
      { label: "Division", value: filterDisplayValue(company) },
      { label: "Development", value: filterDisplayValue(development) },
      ...(dash.data ? appliedRangeInfo(dash.data.appliedRange) : []),
    ],
    dataAsOf: dash.data?.dataAsOf,
  };
  const downloadMonthly = (format: DownloadFormat) => {
    const d = dash.data;
    if (!d) return;
    return downloadData(
      format,
      `${metricSlug}-monthly-vs-goal`,
      ["Month", "Online", "Onsite", "Monthly Goal"],
      d.monthly.map((m): CsvValue[] => [MONTH_NAMES[m.month - 1], m.online, m.onsite, m.goal]),
      undefined,
      downloadInfo,
    );
  };
  const downloadSources = (format: DownloadFormat) => {
    const d = dash.data;
    if (!d) return;
    return downloadData(
      format,
      `${metricSlug}-by-lead-source`,
      ["Lead Source", unit],
      d.sources.map((s): CsvValue[] => [s.name, s.count]),
      undefined,
      downloadInfo,
    );
  };

  return (
    <Layout>
      <div className="space-y-6">
        <Breadcrumb page={title} />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
            {dash.data && (
              <p className="text-sm text-muted-foreground mt-1">
                {dash.data.appliedRange.startDate} → {dash.data.appliedRange.endDate} ·
                progress through {dash.data.appliedRange.toDate}
              </p>
            )}
            <LiveStatusBadge
              status={status.data}
              checking={status.isLoading}
              lastRefreshed={dash.dataUpdatedAt}
              dataAsOf={dash.data?.dataAsOf}
              refreshing={dash.data?.refreshing}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RefreshDataButton onRefresh={refreshNow} />
            <TargetToggle target={target} onChange={setTarget} />
          </div>
        </div>

        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 items-end">
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
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Start</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  data-testid="input-start-date"
                  className="w-full h-9 rounded-md border bg-background px-2 text-sm"
                />
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">End</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  data-testid="input-end-date"
                  className="w-full h-9 rounded-md border bg-background px-2 text-sm"
                />
              </div>
            </div>
            <InvertedRangeHint show={invertedRange} />
            <CrossYearRangeHint show={crossYearRange} />
            <LoneDateHint conflict={loneDateConflict} />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={setYtd} data-testid="button-ytd">
                Current Year
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCompany(ALL);
                  setDevelopment(ALL);
                  setStartDate("");
                  setEndDate("");
                }}
                data-testid="button-clear-filters"
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Clear filters
              </Button>
            </div>
          </CardContent>
        </Card>

        {dash.isError && (
          <Alert variant="destructive">
            <AlertTitle>Failed to load dashboard data</AlertTitle>
            <AlertDescription>
              {(dash.error as Error)?.message ?? "Snowflake query failed."}
            </AlertDescription>
          </Alert>
        )}

        {dash.isLoading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        )}

        {dash.data && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <KpiCell
                title={`Total ${unit}`}
                value={dash.data.kpis.total}
                goal={dash.data.kpis.toDateGoal}
                ptgPercent={dash.data.kpis.ptgPercent}
                testId="kpi-total"
              />
              <KpiCell
                title={`Online ${unit}`}
                value={dash.data.kpis.online}
                goal={dash.data.kpis.onlineToDateGoal}
                ptgPercent={dash.data.kpis.onlinePtgPercent}
                testId="kpi-online"
              />
              <KpiCell
                title={`Onsite ${unit}`}
                value={dash.data.kpis.onsite}
                goal={dash.data.kpis.onsiteToDateGoal}
                ptgPercent={dash.data.kpis.onsitePtgPercent}
                testId="kpi-onsite"
              />
              <Card data-testid="kpi-full-span-goal">
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground">Full-Span Goal</p>
                  <p className="text-2xl font-bold mt-1">{fmt(dash.data.kpis.fullSpanGoal)}</p>
                </CardContent>
              </Card>
              <Card data-testid="kpi-td-goal">
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground">To-Date Goal</p>
                  <p className="text-2xl font-bold mt-1">{fmt(dash.data.kpis.toDateGoal)}</p>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                  <CardTitle className="text-base">Monthly {unit} vs Goal</CardTitle>
                  <DownloadDataButton slug="monthly-vs-goal" onDownload={downloadMonthly} />
                </CardHeader>
                <CardContent className="h-72">
                  <ResponsiveContainer>
                    <ComposedChart
                      data={dash.data.monthly.map((m) => ({
                        ...m,
                        name: MONTH_NAMES[m.month - 1],
                      }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="name" fontSize={12} />
                      <YAxis fontSize={12} tickFormatter={(v) => fmt(v)} />
                      <RTooltip formatter={(v: number) => fmt(v)} />
                      <Legend />
                      <Bar dataKey="online" name="Online" stackId="a" fill={color} radius={[0, 0, 0, 0]} />
                      <Bar dataKey="onsite" name="Onsite" stackId="a" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                      <Line
                        type="monotone"
                        dataKey="goal"
                        name="Monthly Goal"
                        stroke="#ef4444"
                        strokeDasharray="5 3"
                        dot={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                  <CardTitle className="text-base">{unit} by Lead Source</CardTitle>
                  <DownloadDataButton slug="by-lead-source" onDownload={downloadSources} />
                </CardHeader>
                <CardContent className="h-72">
                  <ResponsiveContainer>
                    <BarChart data={dash.data.sources} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis type="number" fontSize={12} tickFormatter={(v) => fmt(v)} />
                      <YAxis type="category" dataKey="name" width={140} fontSize={11} />
                      <RTooltip formatter={(v: number) => fmt(v)} />
                      <Bar dataKey="count" name={unit} fill={color} radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>

            <BreakdownTable
              title="Division Summary"
              rows={dash.data.divisions}
              unit={unit}
              testId="table-divisions"
              downloadSlug="division-summary"
              downloadFilename={`${metricSlug}-division-summary`}
              downloadInfo={downloadInfo}
            />
            <BreakdownTable
              title="Development Summary"
              rows={dash.data.developments.map((d) => ({
                ...d,
                division: `${d.development} · ${d.division}`,
              }))}
              unit={unit}
              firstColumn="Development"
              testId="table-developments"
              downloadSlug="development-summary"
              downloadFilename={`${metricSlug}-development-summary`}
              downloadInfo={downloadInfo}
            />
          </>
        )}
      </div>
    </Layout>
  );
}

function KpiCell({
  title,
  value,
  goal,
  ptgPercent,
  testId,
}: {
  title: string;
  value: number;
  goal: number;
  ptgPercent: number | null;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground">{title}</p>
        <p className="text-2xl font-bold mt-1">{fmt(value)}</p>
        {goal > 0 && (
          <p className={cn("text-xs mt-1 font-medium", ptgColor(ptgPercent))}>
            {fmtPct(ptgPercent)} vs TD goal {fmt(goal)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function BreakdownTable({
  title,
  rows,
  unit,
  firstColumn = "Division",
  testId,
  downloadSlug,
  downloadFilename,
  downloadInfo,
}: {
  title: string;
  rows: {
    division: string;
    total: number;
    online: number;
    onsite: number;
    toDateGoal: number;
    ptgPercent: number | null;
  }[];
  unit: string;
  firstColumn?: string;
  testId: string;
  downloadSlug: string;
  downloadFilename: string;
  downloadInfo: DownloadInfo;
}) {
  const downloadTable = (format: DownloadFormat) =>
    downloadData(
      format,
      downloadFilename,
      [firstColumn, `Total ${unit}`, "Online", "Onsite", "TD Goal", "PTG %"],
      rows.map((r): CsvValue[] => [
        r.division,
        r.total,
        r.online,
        r.onsite,
        r.toDateGoal,
        r.ptgPercent,
      ]),
      undefined,
      downloadInfo,
    );
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <DownloadDataButton slug={downloadSlug} onDownload={downloadTable} />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm" data-testid={testId}>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-4">{firstColumn}</th>
              <th className="py-2 pr-4 text-right">Total {unit}</th>
              <th className="py-2 pr-4 text-right">Online</th>
              <th className="py-2 pr-4 text-right">Onsite</th>
              <th className="py-2 pr-4 text-right">TD Goal</th>
              <th className="py-2 text-right">PTG</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.division} className="border-b last:border-0">
                <td className="py-1.5 pr-4 font-medium">{r.division}</td>
                <td className="py-1.5 pr-4 text-right">{fmt(r.total)}</td>
                <td className="py-1.5 pr-4 text-right">{fmt(r.online)}</td>
                <td className="py-1.5 pr-4 text-right">{fmt(r.onsite)}</td>
                <td className="py-1.5 pr-4 text-right">{fmt(r.toDateGoal)}</td>
                <td className="py-1.5 text-right">
                  <span
                    className={cn(
                      "inline-block rounded px-1.5 py-0.5 font-medium",
                      ptgColor(r.ptgPercent),
                      ptgBg(r.ptgPercent),
                    )}
                  >
                    {fmtPct(r.ptgPercent)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export function LeadsPage() {
  return <FunnelMetricPage metric="leads" title="Leads" unit="Leads" color="#3b82f6" />;
}

export function ToursPage() {
  return <FunnelMetricPage metric="tours" title="Tours" unit="Tours" color="#8b5cf6" />;
}

export function GrossSalesPage() {
  return (
    <FunnelMetricPage metric="gross-sales" title="Gross Sales" unit="Sales" color="#10b981" />
  );
}
