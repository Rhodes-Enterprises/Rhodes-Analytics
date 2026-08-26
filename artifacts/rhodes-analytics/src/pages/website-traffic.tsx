import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
} from "recharts";
import {
  useGetWebsiteTraffic,
  useGetOwtFilters,
  useGetSnowflakeStatus,
  type GetWebsiteTrafficParams,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { useCommittedDate } from "@/hooks/use-committed-date";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import {
  ALL,
  MONTH_NAMES,
  Breadcrumb,
  FilterSelect,
  LiveStatusBadge,
  TargetToggle,
  fmt,
  fmtPct,
  ptgColor,
  type TargetValue,
} from "@/components/dashboard-shared";

export default function WebsiteTrafficPage() {
  const [target, setTarget] = useState<TargetValue>("goal");
  const [company, setCompany] = useState(ALL);
  const [development, setDevelopment] = useState(ALL);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // Only complete, plausible dates reach the API; while a date is half-typed
  // the previously applied range stays in effect (no 400 flashes mid-edit).
  const appliedStartDate = useCommittedDate(startDate);
  const appliedEndDate = useCommittedDate(endDate);

  const params: GetWebsiteTrafficParams = {
    target,
    ...(company !== ALL && { company }),
    ...(development !== ALL && { development }),
    ...(appliedStartDate && { startDate: appliedStartDate }),
    ...(appliedEndDate && { endDate: appliedEndDate }),
  };

  const filters = useGetOwtFilters();
  const dash = useGetWebsiteTraffic(params);
  const status = useGetSnowflakeStatus();

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

  return (
    <Layout>
      <div className="space-y-6">
        <Breadcrumb page="Website Traffic" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Website Traffic</h1>
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
            />
          </div>
          <TargetToggle target={target} onChange={setTarget} />
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
              <Kpi
                title="Total Users"
                value={fmt(dash.data.kpis.totalUsers)}
                sub={
                  dash.data.kpis.toDateGoal > 0 ? (
                    <span className={cn("font-medium", ptgColor(dash.data.kpis.ptgPercent))}>
                      {fmtPct(dash.data.kpis.ptgPercent)} vs TD goal{" "}
                      {fmt(dash.data.kpis.toDateGoal)}
                    </span>
                  ) : null
                }
                testId="kpi-total-users"
              />
              <Kpi
                title="New Users"
                value={fmt(dash.data.kpis.newUsers)}
                testId="kpi-new-users"
              />
              <Kpi title="Sessions" value={fmt(dash.data.kpis.sessions)} testId="kpi-sessions" />
              <Kpi
                title="Engaged Sessions"
                value={fmt(dash.data.kpis.engagedSessions)}
                sub={<span>{dash.data.kpis.engagementRate.toFixed(1)}% engagement rate</span>}
                testId="kpi-engaged-sessions"
              />
              <Kpi
                title="Page Views"
                value={fmt(dash.data.kpis.pageViews)}
                testId="kpi-page-views"
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Monthly Users & Sessions</CardTitle>
                </CardHeader>
                <CardContent className="h-72">
                  <ResponsiveContainer>
                    <AreaChart
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
                      <Area
                        type="monotone"
                        dataKey="users"
                        name="Users"
                        stroke="#3b82f6"
                        fill="#3b82f6"
                        fillOpacity={0.2}
                      />
                      <Area
                        type="monotone"
                        dataKey="newUsers"
                        name="New Users"
                        stroke="#10b981"
                        fill="#10b981"
                        fillOpacity={0.15}
                      />
                      <Area
                        type="monotone"
                        dataKey="sessions"
                        name="Sessions"
                        stroke="#8b5cf6"
                        fill="#8b5cf6"
                        fillOpacity={0.1}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Users by Channel</CardTitle>
                </CardHeader>
                <CardContent className="h-72">
                  <ResponsiveContainer>
                    <BarChart data={dash.data.channels} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis type="number" fontSize={12} tickFormatter={(v) => fmt(v)} />
                      <YAxis type="category" dataKey="name" width={120} fontSize={12} />
                      <RTooltip formatter={(v: number) => fmt(v)} />
                      <Bar dataKey="users" name="Users" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Users by Device</CardTitle>
                </CardHeader>
                <CardContent className="h-64">
                  <ResponsiveContainer>
                    <BarChart data={dash.data.devices}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="name" fontSize={12} />
                      <YAxis fontSize={12} tickFormatter={(v) => fmt(v)} />
                      <RTooltip formatter={(v: number) => fmt(v)} />
                      <Bar dataKey="users" name="Users" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">Traffic by Development</CardTitle>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-developments">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-4">Development</th>
                        <th className="py-2 pr-4">Division</th>
                        <th className="py-2 pr-4 text-right">Users</th>
                        <th className="py-2 pr-4 text-right">New Users</th>
                        <th className="py-2 text-right">Sessions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dash.data.developments.map((d) => (
                        <tr key={`${d.division}-${d.development}`} className="border-b last:border-0">
                          <td className="py-1.5 pr-4 font-medium">{d.development}</td>
                          <td className="py-1.5 pr-4 text-muted-foreground">{d.division}</td>
                          <td className="py-1.5 pr-4 text-right">{fmt(d.users)}</td>
                          <td className="py-1.5 pr-4 text-right">{fmt(d.newUsers)}</td>
                          <td className="py-1.5 text-right">{fmt(d.sessions)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

function Kpi({
  title,
  value,
  sub,
  testId,
}: {
  title: string;
  value: string;
  sub?: React.ReactNode;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground">{title}</p>
        <p className="text-2xl font-bold mt-1">{value}</p>
        {sub && <p className="text-xs mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}
