import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronRight, RefreshCw, Database, ExternalLink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
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
  getOwtDashboard,
  getGetOwtDashboardQueryKey,
  getOwtYoy,
  getGetOwtYoyQueryKey,
  type OwtDashboard,
  type OwtRatioRow,
  type OwtYoy,
  type GetOwtDashboardParams,
  type GetOwtYoyParams,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { useCommittedDateRange } from "@/hooks/use-committed-date";
import {
  CrossYearRangeHint,
  DownloadDataButton,
  InvertedRangeHint,
  LiveStatusBadge,
  LoneDateHint,
  RefreshDataButton,
} from "@/components/dashboard-shared";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, downloadCsv, type CsvValue } from "@/lib/utils";

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
  const yoyParams: GetOwtYoyParams = {
    ...(company !== ALL && { company }),
    ...(development !== ALL && { development }),
  };
  const yoy = useGetOwtYoy(yoyParams);
  const status = useGetSnowflakeStatus();

  // Force the API to bypass its stale-serve cache and wait for live
  // Snowflake data for both queries this page renders, then swap the fresh
  // payloads in under the same query keys so the numbers update in place.
  const queryClient = useQueryClient();
  const refreshNow = async () => {
    const [liveDash, liveYoy] = await Promise.all([
      getOwtDashboard({ ...params, refresh: true }),
      getOwtYoy({ ...yoyParams, refresh: true }),
    ]);
    queryClient.setQueryData(getGetOwtDashboardQueryKey(params), liveDash);
    queryClient.setQueryData(getGetOwtYoyQueryKey(yoyParams), liveYoy);
  };

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
              <p
                className="text-sm text-muted-foreground mt-1"
                data-testid="text-applied-range"
              >
                {dash.data.appliedRange.startDate} →{" "}
                {dash.data.appliedRange.endDate} · progress through{" "}
                {dash.data.appliedRange.toDate}
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
            <InvertedRangeHint show={invertedRange} />
            <CrossYearRangeHint show={crossYearRange} />
            <LoneDateHint conflict={loneDateConflict} />
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

/**
 * Actual-only matrix row for the unknown-channel bucket (rows with no
 * Online/Onsite label). No goals exist for that bucket, so the goal and
 * PTG columns show a dash; the share of the corresponding total makes the
 * size of the attribution gap obvious at a glance. Clicking the row opens
 * the drill-down dialog listing the specific CRM records to fix.
 */
function UnknownRow({
  label,
  actual,
  total,
  totalName,
  onOpen,
}: {
  label: string;
  actual: number;
  total: number;
  totalName: string;
  onOpen: () => void;
}) {
  const pct = total > 0 && actual > 0 ? (actual / total) * 100 : null;
  const share = pct == null ? null : pct < 1 ? "<1" : String(Math.round(pct));
  return (
    <tr
      className="group border-b last:border-0 cursor-pointer transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
      data-testid={`row-${label.toLowerCase().replace(/\s+/g, "-")}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`View the ${label.toLowerCase()} records missing a channel label`}
    >
      <td className="py-2 pr-4 font-medium whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5">
          {label}
          <span className="inline-flex items-center text-xs font-normal text-primary opacity-70 transition-opacity group-hover:opacity-100">
            view records
            <ChevronRight className="h-3 w-3" />
          </span>
        </span>
        {share != null && (
          <div className="text-xs text-muted-foreground">
            {share}% of {totalName}
          </div>
        )}
      </td>
      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">–</td>
      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">–</td>
      <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmt(actual)}</td>
      <td className="py-2 pl-3 text-right tabular-nums text-muted-foreground">–</td>
    </tr>
  );
}

/** Keys of the unknown-channel drill-down buckets, derived from the API type. */
type UnknownBucketKey = keyof OwtDashboard["unknownRecords"];
function TrafficMatrix({ data }: { data: OwtDashboard }) {
  const m = data.trafficMatrix;
  const u = m.unknown;
  // Drill-down dialog state: bucket stays set while the dialog animates
  // closed so the content doesn't flash empty mid-transition.
  const [drillBucket, setDrillBucket] = useState<UnknownBucketKey | null>(null);
  const [drillOpen, setDrillOpen] = useState(false);
  const openDrill = (bucket: UnknownBucketKey) => {
    setDrillBucket(bucket);
    setDrillOpen(true);
  };
  // When every row is labeled (or a channel filter zeroes the bucket),
  // online + onsite already equals the totals — hide the empty section.
  const hasUnknown = u.leads > 0 || u.tours > 0 || u.sales > 0;
  const section = (title: string) => (
    <tr className="bg-muted/50">
      <td colSpan={5} className="py-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </td>
    </tr>
  );
  const matrixCsvRow = (
    sectionName: string,
    measure: string,
    cell: { fullSpanGoal: number; toDateGoal: number; actual: number; ptgPercent: number | null },
  ): CsvValue[] => [sectionName, measure, cell.fullSpanGoal, cell.toDateGoal, cell.actual, cell.ptgPercent];
  const downloadTrafficGoals = () =>
    downloadCsv(
      "overview-with-targets-traffic-goals",
      ["Section", "Measure", "Full Span Goal", "To Date Goal", "Actual", "PTG %"],
      [
        matrixCsvRow("Online", "Website Users", m.online.websiteUsers),
        ["Online", "New Website Users", null, null, m.newWebsiteUsers, null],
        matrixCsvRow("Online", "Online Leads", m.online.leads),
        matrixCsvRow("Online", "Online Tours", m.online.tours),
        matrixCsvRow("Online", "Online Sales", m.online.sales),
        matrixCsvRow("Onsite", "Onsite Leads", m.onsite.leads),
        matrixCsvRow("Onsite", "Onsite Tours", m.onsite.tours),
        matrixCsvRow("Onsite", "Onsite Sales", m.onsite.sales),
        // Mirror the on-screen unknown-channel section: actual-only rows, no
        // goals exist for the bucket (goal/PTG cells stay blank).
        ...(hasUnknown
          ? ([
              ["Unknown — no online/onsite label", "Unknown Leads", null, null, u.leads, null],
              ["Unknown — no online/onsite label", "Unknown Tours", null, null, u.tours, null],
              ["Unknown — no online/onsite label", "Unknown Sales", null, null, u.sales, null],
            ] as CsvValue[][])
          : []),
        matrixCsvRow("Total", "Total Leads", m.total.leads),
        matrixCsvRow("Total", "Total Tours", m.total.tours),
      ],
    );
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Traffic Goals — Actual vs Target</CardTitle>
        <DownloadDataButton slug="traffic-goals" onDownload={downloadTrafficGoals} />
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
            {hasUnknown && (
              <>
                {section("Unknown — no online/onsite label")}
                <UnknownRow
                  label="Unknown Leads"
                  actual={u.leads}
                  total={m.total.leads.actual}
                  totalName="total leads"
                  onOpen={() => openDrill("leads")}
                />
                <UnknownRow
                  label="Unknown Tours"
                  actual={u.tours}
                  total={m.total.tours.actual}
                  totalName="total tours"
                  onOpen={() => openDrill("tours")}
                />
                <UnknownRow
                  label="Unknown Sales"
                  actual={u.sales}
                  total={data.kpis.grossSales}
                  totalName="gross sales"
                  onOpen={() => openDrill("sales")}
                />
              </>
            )}
            {section("Total")}
            <MatrixRow label="Total Leads" cell={m.total.leads} />
            <MatrixRow label="Total Tours" cell={m.total.tours} />
          </tbody>
        </table>
        {hasUnknown && (
          <p
            className="mt-3 text-xs text-muted-foreground"
            data-testid="note-unknown-channel"
          >
            Unknown = no Online/Onsite channel label in the CRM — an
            attribution gap worth fixing at the source. Online + Onsite +
            Unknown adds up to Total Leads, Total Tours, and the Gross Sales
            KPI. Goals are not set for the Unknown bucket. Click an Unknown
            row to see the exact records to fix.
          </p>
        )}
        <UnknownRecordsDialog
          bucket={drillBucket}
          open={drillOpen}
          onOpenChange={setDrillOpen}
          data={data}
        />
      </CardContent>
    </Card>
  );
}

const UNKNOWN_BUCKET_META: Record<
  UnknownBucketKey,
  { title: string; noun: string; dateHeader: string }
> = {
  leads: { title: "Unknown Leads", noun: "leads", dateHeader: "Created" },
  tours: { title: "Unknown Tours", noun: "tours", dateHeader: "First tour" },
  sales: { title: "Unknown Sales", noun: "sales", dateHeader: "Contract ratified" },
};
function DivisionTable({ data }: { data: OwtDashboard }) {
  return (
    <SummaryTable
      title="Division Summary"
      labelHeader="Division"
      testId="table-divisions"
      downloadSlug="division-summary"
      downloadFilename="overview-with-targets-division-summary"
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
      downloadSlug="development-summary"
      downloadFilename="overview-with-targets-development-summary"
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

/**
 * Leads/Tours/Sales cell for the summary tables: the count, its share of
 * the grand total, and — only when non-zero — a compact amber note for the
 * portion of the count that carries no Online/Onsite channel label (the
 * same Unknown bucket the traffic matrix shows). With the note, each row
 * reconciles the same way: online + onsite + unknown equals the count.
 */
function CountCell({
  count,
  pctOfTotal,
  unknown,
  metric,
  rowKey,
}: {
  count: number;
  pctOfTotal: number;
  unknown: number;
  metric: "leads" | "tours" | "sales";
  rowKey: string;
}) {
  return (
    <td className="py-1.5 px-2 text-right tabular-nums">
      {fmt(count)}{" "}
      <span className="text-muted-foreground">({pctOfTotal.toFixed(0)}%)</span>
      {unknown > 0 && (
        <div
          className="text-[10px] leading-tight text-amber-600 dark:text-amber-400 whitespace-nowrap"
          title={`${fmt(unknown)} of ${fmt(count)} ${metric} have no Online/Onsite channel label`}
          data-testid={`unknown-${metric}-${rowKey}`}
        >
          {fmt(unknown)} unknown
        </div>
      )}
    </td>
  );
}
function SummaryTable({
  title,
  labelHeader,
  testId,
  rows,
  userTotals,
  downloadSlug,
  downloadFilename,
}: {
  title: string;
  labelHeader: string;
  testId: string;
  rows: SummaryRow[];
  /** Distinct user counts for the footer — summing per-row distinct counts would double-count. */
  userTotals: { newUsers: number; totalUsers: number };
  downloadSlug: string;
  downloadFilename: string;
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

  const hasUnknown = rows.some(
    (r) => r.unknownLeads > 0 || r.unknownTours > 0 || r.unknownSales > 0,
  );

  const displayLabel = (label: string) =>
    label.replace("Esperanza Homes ", "").replace(", LLC", "");

  const downloadTable = () =>
    downloadCsv(
      downloadFilename,
      [
        labelHeader,
        "New Users",
        "Total Users",
        "Leads",
        "Leads % of Total",
        "Unknown-Channel Leads",
        "Tours",
        "Tours % of Total",
        "Unknown-Channel Tours",
        "Sales",
        "Sales % of Total",
        "Unknown-Channel Sales",
        "Sales PTG %",
        "Tours PTG %",
        "Leads PTG %",
        "Traffic PTG %",
        "Online Leads PTG %",
        "Online Tours PTG %",
        "Online Sales PTG %",
        "Onsite Leads PTG %",
        "Onsite Tours PTG %",
        "Onsite Sales PTG %",
      ],
      [
        ...rows.map((r): CsvValue[] => [
          displayLabel(r.label),
          r.newWebsiteUsers,
          r.totalWebsiteUsers,
          r.leads,
          r.leadsPctOfTotal,
          r.unknownLeads,
          r.tours,
          r.toursPctOfTotal,
          r.unknownTours,
          r.sales,
          r.salesPctOfTotal,
          r.unknownSales,
          r.salesPtg,
          r.toursPtg,
          r.leadsPtg,
          r.onlineTrafficPtg,
          r.onlineLeadsPtg,
          r.onlineToursPtg,
          r.onlineSalesPtg,
          r.onsiteLeadsPtg,
          r.onsiteToursPtg,
          r.onsiteSalesPtg,
        ]),
        [
          "Total",
          totals.newUsers,
          totals.totalUsers,
          totals.leads,
          null,
          null,
          totals.tours,
          null,
          null,
          totals.sales,
          null,
          null,
          null, null, null, null, null, null, null, null, null, null,
        ],
      ],
    );

  const PtgCell = ({ v }: { v: number | null }) => (
    <td className={cn("py-1.5 px-2 text-right tabular-nums", ptgColor(v))}>
      {fmtPct(v, 0)}
    </td>
  );

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <DownloadDataButton slug={downloadSlug} onDownload={downloadTable} />
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
                <CountCell
                  count={r.leads}
                  pctOfTotal={r.leadsPctOfTotal}
                  unknown={r.unknownLeads}
                  metric="leads"
                  rowKey={r.key}
                />
                <CountCell
                  count={r.tours}
                  pctOfTotal={r.toursPctOfTotal}
                  unknown={r.unknownTours}
                  metric="tours"
                  rowKey={r.key}
                />
                <CountCell
                  count={r.sales}
                  pctOfTotal={r.salesPctOfTotal}
                  unknown={r.unknownSales}
                  metric="sales"
                  rowKey={r.key}
                />
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
        {hasUnknown && (
          <p
            className="mt-3 text-xs text-muted-foreground"
            data-testid={`note-unknown-${testId}`}
          >
            Amber “n unknown” = that row’s leads, tours, or sales with no
            Online/Onsite channel label in the CRM. Within each row, online +
            onsite + unknown adds up to the counts shown.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RatioChart({
  title,
  rows,
  slug,
}: {
  title: string;
  rows: OwtRatioRow[];
  slug: string;
}) {
  const data = rows.map((r) => ({
    name: r.name
      .replace(/^(Total|Online|Onsite)\s/, "")
      .replace(" to ", " → "),
    Goal: r.goal != null ? +(r.goal * 100).toFixed(1) : 0,
    Actual: +(r.actual * 100).toFixed(1),
    behind: r.ptgPercent != null && r.ptgPercent < 0,
  }));
  const downloadRatioChart = () =>
    downloadCsv(
      `overview-with-targets-${slug}`,
      ["Ratio", "Goal %", "Actual %"],
      data.map((d): CsvValue[] => [d.name, d.Goal, d.Actual]),
    );
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        <DownloadDataButton slug={slug} onDownload={downloadRatioChart} />
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
  const downloadRatioGoals = () =>
    downloadCsv(
      "overview-with-targets-ratio-goals",
      ["Conversion Ratio", "Goal %", "Actual %", "PTG %"],
      ratios.map((r): CsvValue[] => [
        r.name,
        r.goal != null ? +(r.goal * 100).toFixed(1) : null,
        +(r.actual * 100).toFixed(1),
        r.ptgPercent,
      ]),
    );
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Ratio Goals</CardTitle>
          <DownloadDataButton slug="ratio-goals" onDownload={downloadRatioGoals} />
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
        <RatioChart title="Total Ratios" rows={groups.total} slug="total-ratios" />
        <RatioChart title="Online Ratios" rows={groups.online} slug="online-ratios" />
        <RatioChart title="Onsite Ratios" rows={groups.onsite} slug="onsite-ratios" />
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

  const measureLabel =
    YOY_MEASURES.find((m) => m.key === measure)?.label ?? measure;
  // Months before website tracking began come back as null (not 0) for
  // websiteUsers; recharts draws null points as gaps. Explain the gap.
  const noHistoryGap =
    measure === "websiteUsers" &&
    (series?.points.some((p) => p.currentYear === null || p.priorYear === null) ??
      false);
  const gaStartLabel = yoy?.gaHistoryStart
    ? `${MONTHS[Number(yoy.gaHistoryStart.slice(5, 7)) - 1]} ${yoy.gaHistoryStart.slice(0, 4)}`
    : null;
  const downloadYoy = () => {
    if (!yoy || !series) return;
    downloadCsv(
      `overview-with-targets-yoy-${measureLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      ["Month", String(yoy.priorYear), String(yoy.year), "Goal"],
      series.points.map((p): CsvValue[] => [
        MONTHS[p.month - 1],
        p.priorYear,
        p.currentYear,
        p.goal,
      ]),
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Year over Year</CardTitle>
        <div className="flex items-center gap-1.5">
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
          {series && (
            <DownloadDataButton slug="year-over-year" onDownload={downloadYoy} />
          )}
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
          <>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={data} margin={{ left: 8, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => nf.format(v)} width={64} />
              <RTooltip
                formatter={(v) => (v == null ? "No data yet" : nf.format(Number(v)))}
              />
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
          {noHistoryGap && (
            <p
              className="mt-2 text-xs text-muted-foreground"
              data-testid="note-ga-history-gap"
            >
              {gaStartLabel
                ? `Website tracking began ${gaStartLabel} — earlier months show as gaps (no data yet), not zeros.`
                : "No website tracking data yet — months show as gaps until tracking data arrives."}
            </p>
          )}
          </>
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

/**
 * Lists the individual CRM records behind one unknown-bucket matrix cell —
 * the actionable to-do list for the marketing team. Fetched from the
 * drill-down endpoint with the SAME filters and date range as the dashboard,
 * so the list always reconciles with the count on the row that was clicked.
 */
function UnknownRecordsDialog({
  bucket,
  open,
  onOpenChange,
  data,
}: {
  bucket: UnknownBucketKey | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: OwtDashboard;
}) {
  const meta = UNKNOWN_BUCKET_META[bucket ?? "sales"];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl"
        data-testid="dialog-unknown-records"
      >
        <DialogHeader>
          <DialogTitle data-testid="dialog-unknown-records-title">
            {meta.title} — records missing a channel label
          </DialogTitle>
          <DialogDescription>
            These {meta.noun} carry no Online/Onsite label in the CRM. Fixing
            them at the source closes the attribution gap in this dashboard.
          </DialogDescription>
        </DialogHeader>
        {bucket != null && <UnknownRecordsBody bucket={bucket} data={data} />}
      </DialogContent>
    </Dialog>
  );
}

const shortDivision = (s: string) =>
  s.replace("Esperanza Homes ", "").replace(", LLC", "");

/**
 * Dialog body. The record list rides inside the overview response itself,
 * so it is already on the client the moment the row is clicked — no second
 * fetch, no loading state, and the dialog can never disagree with the
 * matrix row that opened it: count and records are one payload built from
 * one server-side data snapshot.
 */
function UnknownRecordsBody({
  bucket,
  data,
}: {
  bucket: UnknownBucketKey;
  data: OwtDashboard;
}) {
  const meta = UNKNOWN_BUCKET_META[bucket];
  const list = data.unknownRecords[bucket];

  return (
    <>
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-unknown-records-summary"
            >
              <span className="font-semibold text-foreground">
                {fmt(list.total)}
              </span>{" "}
              unlabeled {meta.noun} · {data.appliedRange.startDate} →{" "}
              {data.appliedRange.toDate}
            </p>
            {list.records.length === 0 ? (
              <p
                className="py-8 text-center text-sm text-muted-foreground"
                data-testid="text-unknown-records-empty"
              >
                No unlabeled {meta.noun} in this range with the current
                filters.
              </p>
            ) : (
              <div className="max-h-[55vh] overflow-y-auto rounded-md border">
                <table className="w-full text-sm" data-testid="table-unknown-records">
                  <thead className="sticky top-0 bg-background shadow-[0_1px_0_hsl(var(--border))]">
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-2 px-3 font-medium">
                        {bucket === "sales" ? "Deal" : "Contact"}
                      </th>
                      <th className="py-2 px-3 font-medium">Development</th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">
                        {meta.dateHeader}
                      </th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">
                        Channel in CRM
                      </th>
                      <th className="py-2 px-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {list.records.map((r, i) => (
                      <tr
                        key={`${r.crmUrl ?? r.name ?? ""}-${i}`}
                        className="border-t"
                        data-testid={`row-unknown-record-${i}`}
                      >
                        <td className="py-2 px-3">
                          <div className="font-medium">
                            {r.name ?? (
                              <span className="italic text-muted-foreground">
                                (no name)
                              </span>
                            )}
                          </div>
                          {r.email && (
                            <div className="text-xs text-muted-foreground">
                              {r.email}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <div>{r.development ?? "–"}</div>
                          {r.division && (
                            <div className="text-xs text-muted-foreground">
                              {shortDivision(r.division)}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 whitespace-nowrap tabular-nums">
                          {r.date}
                        </td>
                        <td className="py-2 px-3">
                          {r.rawChannel ?? (
                            <span className="italic text-muted-foreground">
                              (blank)
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {r.crmUrl && (
                            <a
                              href={r.crmUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 whitespace-nowrap text-primary hover:underline"
                              data-testid={`link-crm-record-${i}`}
                            >
                              Open in CRM
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {list.truncated && (
              <p
                className="text-xs text-muted-foreground"
                data-testid="text-unknown-records-truncated"
              >
                Showing the first {fmt(list.records.length)} of{" "}
                {fmt(list.total)} records — narrow the date range or filters
                to see the rest.
              </p>
            )}
    </>
  );
}
