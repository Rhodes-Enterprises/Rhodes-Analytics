import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronRight, RefreshCw, Database } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  AreaChart,
  Area,
  Legend,
  LabelList,
  Cell,
} from "recharts";
import {
  useGetOwtDashboard,
  useGetOwtFilters,
  useGetOwtYoy,
  useGetSnowflakeStatus,
  type OwtDashboard,
  type OwtRatioRow,
  type OwtYoy,
  type GetOwtDashboardParams,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { useCommittedDate } from "@/hooks/use-committed-date";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ---------- formatting ----------

const nf = new Intl.NumberFormat("en-US");
function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return "–";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return "–";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** PTG traffic-light: on-track, slipping, at-risk */
function ptgColor(ptg: number | null | undefined): string {
  if (ptg == null) return "text-muted-foreground";
  if (ptg >= -2) return "text-emerald-600 dark:text-emerald-400";
  if (ptg >= -15) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}
function ptgBg(ptg: number | null | undefined): string {
  if (ptg == null) return "";
  if (ptg >= -2) return "bg-emerald-500/10";
  if (ptg >= -15) return "bg-amber-500/10";
  return "bg-red-500/10";
}

const TARGETS = [
  { value: "proforma", label: "Proforma" },
  { value: "business_plan", label: "Business Plan" },
  { value: "goal", label: "Goal" },
  { value: "waterfall", label: "Waterfall" },
] as const;

const ALL = "__all__";

// ---------- page ----------

export default function OverviewWithTargetsPage() {
  const [target, setTarget] =
    useState<(typeof TARGETS)[number]["value"]>("goal");
  const [company, setCompany] = useState<string>(ALL);
  const [development, setDevelopment] = useState<string>(ALL);
  const [cohortQuarter, setCohortQuarter] = useState<string>(ALL);
  const [leadSource, setLeadSource] = useState<string>(ALL);
  const [contactChannel, setContactChannel] = useState<string>(ALL);
  const [dealChannel, setDealChannel] = useState<string>(ALL);
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  // Only complete, plausible dates reach the API; while a date is half-typed
  // the previously applied range stays in effect (no 400 flashes mid-edit).
  const appliedStartDate = useCommittedDate(startDate);
  const appliedEndDate = useCommittedDate(endDate);

  const params: GetOwtDashboardParams = {
    target,
    ...(company !== ALL && { company }),
    ...(development !== ALL && { development }),
    ...(cohortQuarter !== ALL && { cohortQuarter }),
    ...(leadSource !== ALL && { leadSource }),
    ...(contactChannel !== ALL && { contactChannel }),
    ...(dealChannel !== ALL && { dealChannel }),
    ...(appliedStartDate && { startDate: appliedStartDate }),
    ...(appliedEndDate && { endDate: appliedEndDate }),
  };

  const filters = useGetOwtFilters();
  const dash = useGetOwtDashboard(params);
  const yoy = useGetOwtYoy({
    ...(company !== ALL && { company }),
    ...(development !== ALL && { development }),
  });
  const status = useGetSnowflakeStatus();

  const setYtd = () => {
    const year = new Date().getFullYear();
    setStartDate(`${year}-01-01`);
    setEndDate(`${year}-12-31`);
  };
  const resetRange = () => {
    setStartDate("");
    setEndDate("");
  };

  const developments = useMemo(() => {
    const list = filters.data?.developments ?? [];
    const scoped =
      company === ALL ? list : list.filter((d) => d.company === company);
    return [...new Set(scoped.map((d) => d.development))];
  }, [filters.data, company]);

  return (
    <Layout>
      <div className="space-y-6">
        <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link
            href="/workspaces/marketing"
            className="hover:text-foreground transition-colors"
          >
            Marketing Dashboards
          </Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground font-medium">
            Overview with Targets
          </span>
        </nav>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Overview with Targets
            </h1>
            {dash.data && (
              <p className="text-sm text-muted-foreground mt-1">
                {dash.data.appliedRange.startDate} →{" "}
                {dash.data.appliedRange.endDate} · progress through{" "}
                {dash.data.appliedRange.toDate}
              </p>
            )}
            <LiveStatusBadge
              status={status.data}
              checking={status.isLoading}
              lastRefreshed={dash.dataUpdatedAt}
            />
          </div>
          {/* Target selector */}
          <div className="flex rounded-lg border p-0.5 bg-muted/40">
            {TARGETS.map((t) => (
              <button
                key={t.value}
                onClick={() => setTarget(t.value)}
                data-testid={`button-target-${t.value}`}
                className={cn(
                  "px-3 py-1.5 text-sm rounded-md transition-colors",
                  target === t.value
                    ? "bg-background shadow font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Filter bar */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 gap-2 items-end">
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
              <FilterSelect
                label="Cohort Quarter"
                value={cohortQuarter}
                onChange={setCohortQuarter}
                options={filters.data?.cohortQuarters ?? []}
                testId="select-cohort"
              />
              <FilterSelect
                label="Lead Source"
                value={leadSource}
                onChange={setLeadSource}
                options={filters.data?.leadSources ?? []}
                testId="select-lead-source"
              />
              <FilterSelect
                label="Contact Channel"
                value={contactChannel}
                onChange={setContactChannel}
                options={filters.data?.channels ?? []}
                testId="select-contact-channel"
              />
              <FilterSelect
                label="Deal Channel"
                value={dealChannel}
                onChange={setDealChannel}
                options={filters.data?.channels ?? []}
                testId="select-deal-channel"
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
              <Button size="sm" variant="ghost" onClick={resetRange} data-testid="button-quarter">
                Current Quarter (default)
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCompany(ALL);
                  setDevelopment(ALL);
                  setCohortQuarter(ALL);
                  setLeadSource(ALL);
                  setContactChannel(ALL);
                  setDealChannel(ALL);
                  resetRange();
                }}
                data-testid="button-clear-filters"
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Clear filters
              </Button>
              <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                <LegendDot className="bg-emerald-500" label="On track" />
                <LegendDot className="bg-amber-500" label="Slipping (2–15% behind)" />
                <LegendDot className="bg-red-500" label="At risk (>15% behind)" />
              </div>
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

        {dash.isLoading && <DashboardSkeleton />}

        {dash.data && (
          <>
            <KpiRow data={dash.data} />
            <TrafficMatrix data={dash.data} />
            <DivisionTable data={dash.data} />
            <DevelopmentTable data={dash.data} />
            <RatioSection ratios={dash.data.ratios} />
          </>
        )}

        {/* YOY chart */}
        <YoySection
          yoy={yoy.data}
          loading={yoy.isLoading}
          error={yoy.isError ? ((yoy.error as Error)?.message ?? "Snowflake query failed.") : null}
        />
      </div>
    </Layout>
  );
}

// ---------- pieces ----------

function LiveStatusBadge({
  status,
  checking,
  lastRefreshed,
}: {
  status: { connected: boolean; database?: string; error?: string } | undefined;
  checking: boolean;
  lastRefreshed: number;
}) {
  const time =
    lastRefreshed > 0
      ? new Date(lastRefreshed).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })
      : null;
  return (
    <div
      className="mt-1.5 flex items-center gap-1.5 text-xs"
      data-testid="badge-data-source"
    >
      {checking && !status ? (
        <span className="text-muted-foreground">Checking data source…</span>
      ) : status?.connected ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <span className="font-medium text-emerald-700 dark:text-emerald-400">
            Live · Snowflake
          </span>
          <Database className="h-3 w-3 text-muted-foreground" />
          {time && (
            <span className="text-muted-foreground">
              refreshed {time}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="h-2 w-2 rounded-full bg-red-500" />
          <span className="font-medium text-red-600 dark:text-red-400">
            Snowflake connection unavailable
          </span>
        </>
      )}
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", className)} />
      {label}
    </span>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  testId: string;
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9" data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function KpiRow({ data }: { data: OwtDashboard }) {
  const { kpis } = data;
  const items = [
    { label: "Sales Goal", value: fmt(kpis.salesGoal) },
    { label: "Sales TD Goal", value: fmt(kpis.salesTdGoal) },
    { label: "Gross Sales", value: fmt(kpis.grossSales) },
    {
      label: "PTG Variance",
      value: fmt(kpis.ptgVariance, 1),
      color: ptgColor(kpis.ptgPercent),
    },
    {
      label: "PTG Percent",
      value: fmtPct(kpis.ptgPercent, 2),
      color: ptgColor(kpis.ptgPercent),
      bg: ptgBg(kpis.ptgPercent),
    },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {items.map((it) => (
        <Card key={it.label} className={cn(it.bg)}>
          <CardContent className="pt-4 pb-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {it.label}
            </div>
            <div
              className={cn("text-2xl font-bold mt-1 tabular-nums", it.color)}
              data-testid={`kpi-${it.label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {it.value}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function MatrixRow({
  label,
  cell,
  sub,
}: {
  label: string;
  cell: {
    fullSpanGoal: number;
    toDateGoal: number;
    actual: number;
    ptgPercent: number | null;
  };
  sub?: string;
}) {
  return (
    <tr className="border-b last:border-0">
      <td className="py-2 pr-4 font-medium whitespace-nowrap">
        {label}
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </td>
      <td className="py-2 px-3 text-right tabular-nums">{fmt(cell.fullSpanGoal)}</td>
      <td className="py-2 px-3 text-right tabular-nums">{fmt(cell.toDateGoal)}</td>
      <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmt(cell.actual)}</td>
      <td className={cn("py-2 pl-3 text-right tabular-nums font-semibold", ptgColor(cell.ptgPercent))}>
        {fmtPct(cell.ptgPercent)}
      </td>
    </tr>
  );
}

function TrafficMatrix({ data }: { data: OwtDashboard }) {
  const m = data.trafficMatrix;
  const section = (title: string) => (
    <tr className="bg-muted/50">
      <td colSpan={5} className="py-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </td>
    </tr>
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Traffic Goals — Actual vs Target</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="table-traffic-matrix">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="py-2 pr-4 text-left font-medium">Measure</th>
              <th className="py-2 px-3 text-right font-medium">Full Span Goal</th>
              <th className="py-2 px-3 text-right font-medium">To Date Goal</th>
              <th className="py-2 px-3 text-right font-medium">Actual</th>
              <th className="py-2 pl-3 text-right font-medium">PTG %</th>
            </tr>
          </thead>
          <tbody>
            {section("Online")}
            <MatrixRow
              label="Website Users"
              cell={m.online.websiteUsers}
              sub={`New users: ${nf.format(m.newWebsiteUsers)}`}
            />
            <MatrixRow label="Online Leads" cell={m.online.leads} />
            <MatrixRow label="Online Tours" cell={m.online.tours} />
            <MatrixRow label="Online Sales" cell={m.online.sales} />
            {section("Onsite")}
            <MatrixRow label="Onsite Leads" cell={m.onsite.leads} />
            <MatrixRow label="Onsite Tours" cell={m.onsite.tours} />
            <MatrixRow label="Onsite Sales" cell={m.onsite.sales} />
            {section("Total")}
            <MatrixRow label="Total Leads" cell={m.total.leads} />
            <MatrixRow label="Total Tours" cell={m.total.tours} />
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function DivisionTable({ data }: { data: OwtDashboard }) {
  return (
    <SummaryTable
      title="Division Summary"
      labelHeader="Division"
      testId="table-divisions"
      rows={data.divisions.map((r) => ({ ...r, label: r.division, key: r.division }))}
      userTotals={{
        newUsers: data.trafficMatrix.newWebsiteUsers,
        totalUsers: data.trafficMatrix.online.websiteUsers.actual,
      }}
    />
  );
}

function DevelopmentTable({ data }: { data: OwtDashboard }) {
  return (
    <SummaryTable
      title="Development Summary"
      labelHeader="Development"
      testId="table-developments"
      rows={data.developments.map((r) => ({
        ...r,
        label: r.development,
        key: `${r.division}|${r.development}`,
      }))}
      userTotals={{
        newUsers: data.trafficMatrix.newWebsiteUsers,
        totalUsers: data.trafficMatrix.online.websiteUsers.actual,
      }}
    />
  );
}

type SummaryRow = OwtDashboard["divisions"][number] & { label: string; key: string };

function SummaryTable({
  title,
  labelHeader,
  testId,
  rows,
  userTotals,
}: {
  title: string;
  labelHeader: string;
  testId: string;
  rows: SummaryRow[];
  /** Distinct user counts for the footer — summing per-row distinct counts would double-count. */
  userTotals: { newUsers: number; totalUsers: number };
}) {
  const totals = useMemo(() => {
    const sum = (pick: (r: (typeof rows)[number]) => number) =>
      rows.reduce((t, r) => t + pick(r), 0);
    return {
      newUsers: userTotals.newUsers,
      totalUsers: userTotals.totalUsers,
      leads: sum((r) => r.leads),
      tours: sum((r) => r.tours),
      sales: sum((r) => r.sales),
    };
  }, [rows, userTotals]);

  const PtgCell = ({ v }: { v: number | null }) => (
    <td className={cn("py-1.5 px-2 text-right tabular-nums", ptgColor(v))}>
      {fmtPct(v, 0)}
    </td>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm" data-testid={testId}>
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="py-2 pr-3 text-left font-medium">{labelHeader}</th>
              <th className="py-2 px-2 text-right font-medium">New Users</th>
              <th className="py-2 px-2 text-right font-medium">Total Users</th>
              <th className="py-2 px-2 text-right font-medium">Leads</th>
              <th className="py-2 px-2 text-right font-medium">Tours</th>
              <th className="py-2 px-2 text-right font-medium">Sales</th>
              <th className="py-2 px-2 text-right font-medium">Sales PTG</th>
              <th className="py-2 px-2 text-right font-medium">Tours PTG</th>
              <th className="py-2 px-2 text-right font-medium">Leads PTG</th>
              <th className="py-2 px-2 text-right font-medium">Traffic PTG</th>
              <th className="py-2 px-2 text-right font-medium">Onl. Leads PTG</th>
              <th className="py-2 px-2 text-right font-medium">Onl. Tours PTG</th>
              <th className="py-2 px-2 text-right font-medium">Onl. Sales PTG</th>
              <th className="py-2 px-2 text-right font-medium">Ons. Leads PTG</th>
              <th className="py-2 px-2 text-right font-medium">Ons. Tours PTG</th>
              <th className="py-2 px-2 text-right font-medium">Ons. Sales PTG</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b last:border-0">
                <td className="py-1.5 pr-3 font-medium whitespace-nowrap">
                  {r.label.replace("Esperanza Homes ", "").replace(", LLC", "")}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(r.newWebsiteUsers)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(r.totalWebsiteUsers)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">
                  {fmt(r.leads)}{" "}
                  <span className="text-muted-foreground">({r.leadsPctOfTotal.toFixed(0)}%)</span>
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums">
                  {fmt(r.tours)}{" "}
                  <span className="text-muted-foreground">({r.toursPctOfTotal.toFixed(0)}%)</span>
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums">
                  {fmt(r.sales)}{" "}
                  <span className="text-muted-foreground">({r.salesPctOfTotal.toFixed(0)}%)</span>
                </td>
                <PtgCell v={r.salesPtg} />
                <PtgCell v={r.toursPtg} />
                <PtgCell v={r.leadsPtg} />
                <PtgCell v={r.onlineTrafficPtg} />
                <PtgCell v={r.onlineLeadsPtg} />
                <PtgCell v={r.onlineToursPtg} />
                <PtgCell v={r.onlineSalesPtg} />
                <PtgCell v={r.onsiteLeadsPtg} />
                <PtgCell v={r.onsiteToursPtg} />
                <PtgCell v={r.onsiteSalesPtg} />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t font-semibold">
              <td className="py-2 pr-3">Total</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.newUsers)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.totalUsers)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.leads)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.tours)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.sales)}</td>
              <td colSpan={10} />
            </tr>
          </tfoot>
        </table>
      </CardContent>
    </Card>
  );
}

function RatioChart({
  title,
  rows,
}: {
  title: string;
  rows: OwtRatioRow[];
}) {
  const data = rows.map((r) => ({
    name: r.name
      .replace(/^(Total|Online|Onsite)\s/, "")
      .replace(" to ", " → "),
    Goal: r.goal != null ? +(r.goal * 100).toFixed(1) : 0,
    Actual: +(r.actual * 100).toFixed(1),
    behind: r.ptgPercent != null && r.ptgPercent < 0,
  }));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={rows.length * 64 + 40}>
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 36 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" unit="%" tick={{ fontSize: 11 }} />
            <YAxis
              type="category"
              dataKey="name"
              width={140}
              tick={{ fontSize: 11 }}
            />
            <RTooltip formatter={(v: number) => `${v}%`} />
            <Bar dataKey="Goal" fill="hsl(215 16% 62%)" barSize={10} radius={2}>
              <LabelList dataKey="Goal" position="right" formatter={(v: number) => `${v}%`} style={{ fontSize: 10 }} />
            </Bar>
            <Bar dataKey="Actual" barSize={10} radius={2}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.behind ? "#dc2626" : "#457537"} />
              ))}
              <LabelList dataKey="Actual" position="right" formatter={(v: number) => `${v}%`} style={{ fontSize: 10 }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function RatioSection({ ratios }: { ratios: OwtRatioRow[] }) {
  const groups = {
    total: ratios.filter((r) => r.group === "total"),
    online: ratios.filter((r) => r.group === "online"),
    onsite: ratios.filter((r) => r.group === "onsite"),
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Ratio Goals</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-ratios">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-2 pr-4 text-left font-medium">Conversion Ratio</th>
                <th className="py-2 px-3 text-right font-medium">Goal</th>
                <th className="py-2 px-3 text-right font-medium">Actual</th>
                <th className="py-2 pl-3 text-right font-medium">PTG %</th>
              </tr>
            </thead>
            <tbody>
              {ratios.map((r) => (
                <tr key={r.name} className="border-b last:border-0">
                  <td className="py-1.5 pr-4">{r.name}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">
                    {r.goal != null ? `${(r.goal * 100).toFixed(1)}%` : "–"}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-semibold">
                    {(r.actual * 100).toFixed(1)}%
                  </td>
                  {/* Source Qlik sheet uses a simple two-color flag for ratios:
                      red below goal, green at/above (no amber tier). */}
                  <td
                    className={cn(
                      "py-1.5 pl-3 text-right tabular-nums font-semibold",
                      r.ptgPercent == null
                        ? "text-muted-foreground"
                        : r.ptgPercent < 0
                          ? "text-red-600"
                          : "text-[#457537]",
                    )}
                  >
                    {fmtPct(r.ptgPercent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <RatioChart title="Total Ratios" rows={groups.total} />
        <RatioChart title="Online Ratios" rows={groups.online} />
        <RatioChart title="Onsite Ratios" rows={groups.onsite} />
      </div>
    </div>
  );
}

const YOY_MEASURES = [
  { key: "websiteUsers", label: "Website Users" },
  { key: "leads", label: "Leads" },
  { key: "tours", label: "Tours" },
  { key: "grossSales", label: "Gross Sales" },
];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function YoySection({
  yoy,
  loading,
  error,
}: {
  yoy: OwtYoy | undefined;
  loading: boolean;
  error: string | null;
}) {
  const [measure, setMeasure] = useState("websiteUsers");
  const series = yoy?.measures.find((m) => m.measure === measure);
  const data =
    series?.points.map((p) => ({
      month: MONTHS[p.month - 1],
      [`${yoy?.year}`]: p.currentYear,
      [`${yoy?.priorYear}`]: p.priorYear,
      Goal: p.goal,
    })) ?? [];

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Year over Year</CardTitle>
        <div className="flex rounded-lg border p-0.5 bg-muted/40">
          {YOY_MEASURES.map((m) => (
            <button
              key={m.key}
              onClick={() => setMeasure(m.key)}
              data-testid={`button-yoy-${m.key}`}
              className={cn(
                "px-2.5 py-1 text-xs rounded-md transition-colors",
                measure === m.key
                  ? "bg-background shadow font-semibold"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="destructive" data-testid="alert-yoy-error">
            <AlertTitle>Failed to load year-over-year data</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : loading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={data} margin={{ left: 8, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => nf.format(v)} width={64} />
              <RTooltip formatter={(v: number) => nf.format(v)} />
              <Legend />
              <Area
                type="monotone"
                dataKey={`${yoy?.priorYear ?? "prior"}`}
                stroke="hsl(215 16% 62%)"
                fill="hsl(215 16% 62% / 0.25)"
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey={`${yoy?.year ?? "current"}`}
                stroke="#005473"
                fill="#0054731f"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="Goal"
                stroke="#A69211"
                fill="transparent"
                strokeDasharray="5 4"
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
