import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronRight, RefreshCw } from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
} from "recharts";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLeasingDashboard,
  useGetLeasingFilters,
  useGetSnowflakeStatus,
  getLeasingDashboard,
  getGetLeasingDashboardQueryKey,
  type LeasingDashboard,
  type GetLeasingDashboardParams,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { useCommittedDateRange } from "@/hooks/use-committed-date";
import { serverDefaultRange } from "@/lib/date-defaults";
import {
  CrossYearRangeHint,
  DownloadDataButton,
  InvertedRangeHint,
  LiveStatusBadge,
  LoneDateHint,
  RefreshDataButton,
  appliedRangeInfo,
  filterDisplayValue,
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
  cn,
  downloadData,
  type CsvValue,
  type DownloadFormat,
  type DownloadInfo,
} from "@/lib/utils";

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

const ALL = "__all__";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** One CSV row for a goal/funnel matrix line, matching the on-screen columns. */
function matrixCsvRow(
  label: string,
  cell: { fullSpanGoal: number; toDateGoal: number; actual: number; ptgPercent: number | null },
): CsvValue[] {
  return [label, cell.fullSpanGoal, cell.toDateGoal, cell.actual, cell.ptgPercent];
}
export default function LeasingPage() {
  const [community, setCommunity] = useState<string>(ALL);
  const [channel, setChannel] = useState<string>(ALL);
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  // Only complete, plausible dates reach the API; while a date is half-typed,
  // the end date is before the start date, the range crosses calendar years
  // (the API rejects mixed-year ranges — goals are set per year), or a lone
  // date would invert against this page's default range (the current year —
  // which a same-year lone date never does; passed for parity with the
  // quarter-defaulted pages), the previously applied range stays in effect
  // (no 400 flashes or misleading all-zero metrics mid-edit).
  const {
    startDate: appliedStartDate,
    endDate: appliedEndDate,
    invertedRange,
    crossYearRange,
    loneDateConflict,
  } = useCommittedDateRange(startDate, endDate, { defaultRange: "year" });

  const params: GetLeasingDashboardParams = {
    ...(community !== ALL && { community }),
    ...(channel !== ALL && { channel }),
    ...(appliedStartDate && { startDate: appliedStartDate }),
    ...(appliedEndDate && { endDate: appliedEndDate }),
  };

  const filters = useGetLeasingFilters();
  const dash = useGetLeasingDashboard(params);

  // Force the API to bypass its stale-serve cache and wait for live
  // Snowflake data, then swap the fresh payload in under the same query key
  // so the numbers update in place.
  const queryClient = useQueryClient();
  const refreshNow = async () => {
    const live = await getLeasingDashboard({ ...params, refresh: true });
    queryClient.setQueryData(getGetLeasingDashboardQueryKey(params), live);
  };
  const status = useGetSnowflakeStatus();

  const setQuarter = () => {
    // Same quarter math as the API's buildFilters default (shared helper —
    // keeps this button and the lone-date guard in lockstep).
    const { start, end } = serverDefaultRange("quarter");
    setStartDate(start);
    setEndDate(end);
  };
  const resetRange = () => {
    setStartDate("");
    setEndDate("");
  };

  // Provenance for the Excel Info sheet, shared by every download on this
  // page. The applied range comes from the server response — the range
  // actually queried, defaults included.
  const downloadInfo: DownloadInfo = {
    page: "Rhodes Living Leasing",
    filters: [
      { label: "Community", value: filterDisplayValue(community) },
      { label: "Channel", value: filterDisplayValue(channel) },
      ...(dash.data ? appliedRangeInfo(dash.data.appliedRange) : []),
    ],
    dataAsOf: dash.data?.dataAsOf,
  };

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
            Rhodes Living Leasing
          </span>
        </nav>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Rhodes Living Leasing
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
              dataAsOf={dash.data?.dataAsOf}
              refreshing={dash.data?.refreshing}
            />
          </div>
          <RefreshDataButton onRefresh={refreshNow} />
        </div>

        {/* Filter bar */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
              <FilterSelect
                label="Community"
                value={community}
                onChange={setCommunity}
                options={filters.data?.communities ?? []}
                testId="select-community"
              />
              <FilterSelect
                label="Channel"
                value={channel}
                onChange={setChannel}
                options={filters.data?.channels ?? []}
                testId="select-channel"
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
              <Button size="sm" variant="ghost" onClick={resetRange} data-testid="button-ytd">
                Current Year (default)
              </Button>
              <Button size="sm" variant="outline" onClick={setQuarter} data-testid="button-quarter">
                Current Quarter
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCommunity(ALL);
                  setChannel(ALL);
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
            <FunnelMatrix data={dash.data} downloadInfo={downloadInfo} />
            <GoalMatrix data={dash.data} downloadInfo={downloadInfo} />
            <CommunityTable data={dash.data} downloadInfo={downloadInfo} />
            <CommunityFunnelTable data={dash.data} />
            <MonthlyChart data={dash.data} downloadInfo={downloadInfo} />
          </>
        )}
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

function KpiRow({ data }: { data: LeasingDashboard }) {
  const { kpis } = data;
  const items = [
    { label: "Lease Goal", value: fmt(kpis.leaseGoal) },
    { label: "Lease TD Goal", value: fmt(kpis.leaseTdGoal) },
    { label: "Leases Ratified", value: fmt(kpis.leasesRatified) },
    { label: "Leases Cancelled", value: fmt(kpis.leasesCancelled) },
    { label: "Net Leases", value: fmt(kpis.netLeases) },
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
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
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
 * Actual-only funnel row for the unknown-channel bucket (leads/first tours
 * with no Online/Onsite label in the CRM). No goals exist for that bucket,
 * so the goal and PTG columns show a dash; the share of the stage total
 * makes the size of the attribution gap obvious and lets Online + Onsite +
 * Unknown visibly add up to the stage total. Rendered only while the
 * bucket is non-empty — same presentation as the Overview's unknown rows.
 */
function UnknownFunnelRow({
  label,
  actual,
  total,
  totalName,
}: {
  label: string;
  actual: number;
  total: number;
  totalName: string;
}) {
  const pct = total > 0 && actual > 0 ? (actual / total) * 100 : null;
  const share = pct == null ? null : pct < 1 ? "<1" : String(Math.round(pct));
  return (
    <tr
      className="border-b last:border-0"
      data-testid={`row-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <td className="py-2 pr-4 font-medium whitespace-nowrap">
        {label}
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
function GoalMatrix({
  data,
  downloadInfo,
}: {
  data: LeasingDashboard;
  downloadInfo: DownloadInfo;
}) {
  const m = data.matrix;
  const downloadLeaseGoals = (format: DownloadFormat) =>
    downloadData(
      format,
      "leasing-lease-goals",
      ["Measure", "Full Span Goal", "To Date Goal", "Actual", "PTG %"],
      [
        matrixCsvRow("Leases Ratified", m.total),
        matrixCsvRow("Online Leases Ratified", m.online),
        matrixCsvRow("Onsite Leases Ratified", m.onsite),
        matrixCsvRow("Net Leases", m.net),
      ],
      undefined,
      downloadInfo,
    );
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">
          Lease Goals — Actual vs Target
        </CardTitle>
        <DownloadDataButton slug="lease-goals" onDownload={downloadLeaseGoals} />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="table-lease-matrix">
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
            <MatrixRow label="Leases Ratified" cell={m.total} />
            <MatrixRow label="Online Leases Ratified" cell={m.online} />
            <MatrixRow label="Onsite Leases Ratified" cell={m.onsite} />
            <MatrixRow
              label="Net Leases"
              cell={m.net}
              sub="Ratified − cancelled, vs the ratified goal"
            />
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function FunnelMatrix({
  data,
  downloadInfo,
}: {
  data: LeasingDashboard;
  downloadInfo: DownloadInfo;
}) {
  const fu = data.funnel;
  const u = fu.unknown;
  const downloadFunnel = (format: DownloadFormat) =>
    downloadData(
      format,
      "leasing-funnel",
      ["Stage", "Full Span Goal", "To Date Goal", "Actual", "PTG %"],
      [
        matrixCsvRow("Web Traffic", fu.webTraffic),
        matrixCsvRow("Leads", fu.leads),
        matrixCsvRow("Online Leads", fu.onlineLeads),
        matrixCsvRow("Onsite Leads", fu.onsiteLeads),
        // Mirror the on-screen unknown-channel rows: actual only — no
        // goals exist for the bucket, so goal/PTG cells stay blank.
        ...(u.leads > 0
          ? [["Unknown Leads", null, null, u.leads, null] as CsvValue[]]
          : []),
        matrixCsvRow("First Tours", fu.firstTours),
        matrixCsvRow("Online First Tours", fu.onlineFirstTours),
        matrixCsvRow("Onsite First Tours", fu.onsiteFirstTours),
        ...(u.firstTours > 0
          ? [["Unknown First Tours", null, null, u.firstTours, null] as CsvValue[]]
          : []),
        matrixCsvRow("Move-Ins", fu.moveIns),
      ],
      undefined,
      downloadInfo,
    );
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">
          Leasing Funnel — Actual vs Target
        </CardTitle>
        <DownloadDataButton slug="leasing-funnel" onDownload={downloadFunnel} />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="table-funnel-matrix">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="py-2 pr-4 text-left font-medium">Stage</th>
              <th className="py-2 px-3 text-right font-medium">Full Span Goal</th>
              <th className="py-2 px-3 text-right font-medium">To Date Goal</th>
              <th className="py-2 px-3 text-right font-medium">Actual</th>
              <th className="py-2 pl-3 text-right font-medium">PTG %</th>
            </tr>
          </thead>
          <tbody>
            <MatrixRow
              label="Web Traffic"
              cell={fu.webTraffic}
              sub="Sessions on the Rhodes Living site (site-wide, no channel split)"
            />
            <MatrixRow label="Leads" cell={fu.leads} />
            <MatrixRow label="Online Leads" cell={fu.onlineLeads} />
            <MatrixRow label="Onsite Leads" cell={fu.onsiteLeads} />
            {u.leads > 0 && (
              <UnknownFunnelRow
                label="Unknown Leads"
                actual={u.leads}
                total={fu.leads.actual}
                totalName="leads"
              />
            )}
            <MatrixRow label="First Tours" cell={fu.firstTours} />
            <MatrixRow label="Online First Tours" cell={fu.onlineFirstTours} />
            <MatrixRow label="Onsite First Tours" cell={fu.onsiteFirstTours} />
            {u.firstTours > 0 && (
              <UnknownFunnelRow
                label="Unknown First Tours"
                actual={u.firstTours}
                total={fu.firstTours.actual}
                totalName="first tours"
              />
            )}
            <MatrixRow
              label="Move-Ins"
              cell={fu.moveIns}
              sub="First move-in date per contact (no channel-split goal)"
            />
          </tbody>
        </table>
        {(u.leads > 0 || u.firstTours > 0) && (
          <p
            className="mt-3 text-xs text-muted-foreground"
            data-testid="note-unknown-channel-funnel"
          >
            Unknown = no Online/Onsite channel label in the CRM — an
            attribution gap worth fixing at the source. Online + Onsite +
            Unknown adds up to the Leads and First Tours totals. Goals are
            not set for the Unknown bucket.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CommunityTable({
  data,
  downloadInfo,
}: {
  data: LeasingDashboard;
  downloadInfo: DownloadInfo;
}) {
  const rows = data.communities;
  const totals = useMemo(() => {
    const sum = (pick: (r: (typeof rows)[number]) => number) =>
      rows.reduce((t, r) => t + pick(r), 0);
    return {
      fullSpanGoal: sum((r) => r.fullSpanGoal),
      toDateGoal: sum((r) => r.toDateGoal),
      ratified: sum((r) => r.ratified),
      onlineRatified: sum((r) => r.onlineRatified),
      onsiteRatified: sum((r) => r.onsiteRatified),
      cancelled: sum((r) => r.cancelled),
      net: sum((r) => r.net),
    };
  }, [rows]);

  const downloadCommunitySummary = (format: DownloadFormat) =>
    downloadData(
      format,
      "leasing-community-summary",
      ["Community", "Lease Goal", "TD Goal", "Ratified", "Online", "Onsite", "Cancelled", "Net", "PTG %"],
      [
        ...rows.map((r): CsvValue[] => [
          r.community,
          r.fullSpanGoal,
          r.toDateGoal,
          r.ratified,
          r.onlineRatified,
          r.onsiteRatified,
          r.cancelled,
          r.net,
          r.ptgPercent,
        ]),
        [
          "Total",
          totals.fullSpanGoal,
          totals.toDateGoal,
          totals.ratified,
          totals.onlineRatified,
          totals.onsiteRatified,
          totals.cancelled,
          totals.net,
          null,
        ],
      ],
      undefined,
      downloadInfo,
    );

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Community Summary</CardTitle>
        <DownloadDataButton slug="community-summary" onDownload={downloadCommunitySummary} />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm" data-testid="table-communities">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="py-2 pr-3 text-left font-medium">Community</th>
              <th className="py-2 px-2 text-right font-medium">Lease Goal</th>
              <th className="py-2 px-2 text-right font-medium">TD Goal</th>
              <th className="py-2 px-2 text-right font-medium">Ratified</th>
              <th className="py-2 px-2 text-right font-medium">Online</th>
              <th className="py-2 px-2 text-right font-medium">Onsite</th>
              <th className="py-2 px-2 text-right font-medium">Cancelled</th>
              <th className="py-2 px-2 text-right font-medium">Net</th>
              <th className="py-2 px-2 text-right font-medium">PTG %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.community} className="border-b last:border-0">
                <td className="py-1.5 pr-3 font-medium whitespace-nowrap">
                  {r.community}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(r.fullSpanGoal)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(r.toDateGoal)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums font-semibold">{fmt(r.ratified)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(r.onlineRatified)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(r.onsiteRatified)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(r.cancelled)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums font-semibold">{fmt(r.net)}</td>
                <td className={cn("py-1.5 px-2 text-right tabular-nums font-semibold", ptgColor(r.ptgPercent))}>
                  {fmtPct(r.ptgPercent, 0)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t font-semibold">
              <td className="py-2 pr-3">Total</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.fullSpanGoal)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.toDateGoal)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.ratified)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.onlineRatified)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.onsiteRatified)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.cancelled)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.net)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </CardContent>
    </Card>
  );
}

function FunnelStageCells({
  cell,
}: {
  cell: { toDateGoal: number; actual: number; ptgPercent: number | null };
}) {
  return (
    <>
      <td className="py-1.5 px-2 text-right tabular-nums border-l">
        {fmt(cell.toDateGoal)}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums font-semibold">
        {fmt(cell.actual)}
      </td>
      <td
        className={cn(
          "py-1.5 px-2 text-right tabular-nums font-semibold",
          ptgColor(cell.ptgPercent),
        )}
      >
        {fmtPct(cell.ptgPercent, 0)}
      </td>
    </>
  );
}
type MonthlyPoint = LeasingDashboard["monthly"][number];

const TREND_STAGES = [
  { key: "leases", label: "Leases" },
  { key: "webTraffic", label: "Web Traffic" },
  { key: "leads", label: "Leads" },
  { key: "firstTours", label: "First Tours" },
  { key: "moveIns", label: "Move-Ins" },
] as const;
type TrendStageKey = (typeof TREND_STAGES)[number]["key"];

const STAGE_SERIES: Record<
  Exclude<TrendStageKey, "leases">,
  (p: MonthlyPoint) => { actual: number; goal: number }
> = {
  webTraffic: (p) => ({ actual: p.webTraffic, goal: p.webTrafficGoal }),
  leads: (p) => ({ actual: p.leads, goal: p.leadsGoal }),
  firstTours: (p) => ({ actual: p.firstTours, goal: p.firstToursGoal }),
  moveIns: (p) => ({ actual: p.moveIns, goal: p.moveInsGoal }),
};

function MonthlyChart({
  data,
  downloadInfo,
}: {
  data: LeasingDashboard;
  downloadInfo: DownloadInfo;
}) {
  const [stage, setStage] = useState<TrendStageKey>("leases");
  const stageLabel = TREND_STAGES.find((s) => s.key === stage)?.label ?? "";

  const leaseData = data.monthly.map((p) => ({
    month: MONTHS[p.month - 1],
    Ratified: p.ratified,
    Cancelled: p.cancelled,
    Net: p.net,
    Goal: +p.goal.toFixed(1),
  }));
  const stageData =
    stage === "leases"
      ? []
      : data.monthly.map((p) => {
          const { actual, goal } = STAGE_SERIES[stage](p);
          return {
            month: MONTHS[p.month - 1],
            Actual: actual,
            Goal: +goal.toFixed(1),
          };
        });
  // A stage with no matching RL_* goal (older years, channel filters) comes
  // back as all-zero goals — drop the line rather than plot a flat zero.
  const hasStageGoal = stageData.some((p) => p.Goal !== 0);

  const downloadTrends = (format: DownloadFormat) => {
    const stageSlug = stageLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    // The stage toggle decides which series the file holds — record it.
    const trendsInfo: DownloadInfo = {
      ...downloadInfo,
      filters: [
        ...(downloadInfo.filters ?? []),
        { label: "Trend stage", value: stageLabel },
      ],
    };
    if (stage === "leases") {
      return downloadData(
        format,
        `leasing-monthly-trends-${stageSlug}`,
        ["Month", "Ratified", "Cancelled", "Net", "Goal"],
        leaseData.map((p): CsvValue[] => [p.month, p.Ratified, p.Cancelled, p.Net, p.Goal]),
        undefined,
        trendsInfo,
      );
    } else {
      // Match the on-screen chart: the goal series is dropped when no goal
      // exists for this stage/year/filter combination.
      return downloadData(
        format,
        `leasing-monthly-trends-${stageSlug}`,
        hasStageGoal ? ["Month", "Actual", "Goal"] : ["Month", "Actual"],
        stageData.map((p): CsvValue[] =>
          hasStageGoal ? [p.month, p.Actual, p.Goal] : [p.month, p.Actual],
        ),
        undefined,
        trendsInfo,
      );
    }
  };

  return (
    <Card data-testid="card-monthly-trends">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            Monthly Trends — {data.fiscalYear}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-1">
            {TREND_STAGES.map((s) => (
              <Button
                key={s.key}
                size="sm"
                variant={stage === s.key ? "default" : "outline"}
                onClick={() => setStage(s.key)}
                data-testid={`button-trend-${s.key}`}
              >
                {s.label}
              </Button>
            ))}
            <DownloadDataButton
              slug="monthly-trends"
              onDownload={downloadTrends}
              className="ml-1"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          {stage === "leases" ? (
            <ComposedChart data={leaseData} margin={{ left: 8, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => nf.format(v)} width={48} />
              <RTooltip formatter={(v: number) => nf.format(v)} />
              <Legend />
              <Bar dataKey="Ratified" fill="#005473" barSize={18} radius={2} />
              <Bar dataKey="Cancelled" fill="#dc2626" barSize={18} radius={2} />
              <Line type="monotone" dataKey="Net" stroke="#457537" strokeWidth={2} dot={false} />
              <Line
                type="monotone"
                dataKey="Goal"
                stroke="#A69211"
                strokeDasharray="5 4"
                strokeWidth={1.5}
                dot={false}
              />
            </ComposedChart>
          ) : (
            <ComposedChart data={stageData} margin={{ left: 8, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => nf.format(v)} width={56} />
              <RTooltip formatter={(v: number) => nf.format(v)} />
              <Legend />
              <Bar dataKey="Actual" fill="#005473" barSize={18} radius={2} />
              {hasStageGoal && (
                <Line
                  type="monotone"
                  dataKey="Goal"
                  stroke="#A69211"
                  strokeDasharray="5 4"
                  strokeWidth={1.5}
                  dot={false}
                />
              )}
            </ComposedChart>
          )}
        </ResponsiveContainer>
        {stage !== "leases" && !hasStageGoal && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="text-no-stage-goal">
            No {stageLabel.toLowerCase()} goal exists for this year/filter combination.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

/**
 * Per-community upstream funnel: which community is behind on leads and
 * tours, not just leases. Web traffic is GA sessions matched to the
 * community (only mapped communities have a number; the rest show a dash).
 */
function DashStageCells() {
  return (
    <>
      <td className="py-1.5 px-2 text-right text-muted-foreground border-l">–</td>
      <td className="py-1.5 px-2 text-right text-muted-foreground">–</td>
      <td className="py-1.5 px-2 text-right text-muted-foreground">–</td>
    </>
  );
}
function CommunityFunnelTable({ data }: { data: LeasingDashboard }) {
  const rows = data.communities;
  const totals = useMemo(() => {
    const sum = (pick: (r: (typeof rows)[number]) => number) =>
      rows.reduce((t, r) => t + pick(r), 0);
    const mapped = rows
      .map((r) => r.webTraffic)
      .filter((c): c is NonNullable<typeof c> => c != null);
    return {
      webTdGoal: mapped.length
        ? mapped.reduce((t, c) => t + c.toDateGoal, 0)
        : null,
      webTraffic: mapped.length
        ? mapped.reduce((t, c) => t + c.actual, 0)
        : null,
      leadsTdGoal: sum((r) => r.leads.toDateGoal),
      leads: sum((r) => r.leads.actual),
      toursTdGoal: sum((r) => r.firstTours.toDateGoal),
      tours: sum((r) => r.firstTours.actual),
      moveInsTdGoal: sum((r) => r.moveIns.toDateGoal),
      moveIns: sum((r) => r.moveIns.actual),
    };
  }, [rows]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Community Funnel — Traffic, Leads, Tours & Move-Ins
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table
          className="w-full text-xs sm:text-sm"
          data-testid="table-community-funnel"
        >
          <thead>
            <tr className="text-muted-foreground">
              <th rowSpan={2} className="py-2 pr-3 text-left font-medium align-bottom">
                Community
              </th>
              <th colSpan={3} className="pt-2 pb-1 px-2 text-center font-medium border-l">
                Web Traffic
              </th>
              <th colSpan={3} className="pt-2 pb-1 px-2 text-center font-medium border-l">
                Leads
              </th>
              <th colSpan={3} className="pt-2 pb-1 px-2 text-center font-medium border-l">
                First Tours
              </th>
              <th colSpan={3} className="pt-2 pb-1 px-2 text-center font-medium border-l">
                Move-Ins
              </th>
            </tr>
            <tr className="border-b text-muted-foreground">
              <th className="py-1 px-2 text-right font-medium border-l">TD Goal</th>
              <th className="py-1 px-2 text-right font-medium">Actual</th>
              <th className="py-1 px-2 text-right font-medium">PTG %</th>
              <th className="py-1 px-2 text-right font-medium border-l">TD Goal</th>
              <th className="py-1 px-2 text-right font-medium">Actual</th>
              <th className="py-1 px-2 text-right font-medium">PTG %</th>
              <th className="py-1 px-2 text-right font-medium border-l">TD Goal</th>
              <th className="py-1 px-2 text-right font-medium">Actual</th>
              <th className="py-1 px-2 text-right font-medium">PTG %</th>
              <th className="py-1 px-2 text-right font-medium border-l">TD Goal</th>
              <th className="py-1 px-2 text-right font-medium">Actual</th>
              <th className="py-1 px-2 text-right font-medium">PTG %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.community} className="border-b last:border-0">
                <td className="py-1.5 pr-3 font-medium whitespace-nowrap">
                  {r.community}
                </td>
                {r.webTraffic ? (
                  <FunnelStageCells cell={r.webTraffic} />
                ) : (
                  <DashStageCells />
                )}
                <FunnelStageCells cell={r.leads} />
                <FunnelStageCells cell={r.firstTours} />
                <FunnelStageCells cell={r.moveIns} />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t font-semibold">
              <td className="py-2 pr-3">Total</td>
              <td className="py-2 px-2 text-right tabular-nums border-l">
                {fmt(totals.webTdGoal)}
              </td>
              <td className="py-2 px-2 text-right tabular-nums">
                {fmt(totals.webTraffic)}
              </td>
              <td />
              <td className="py-2 px-2 text-right tabular-nums border-l">
                {fmt(totals.leadsTdGoal)}
              </td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.leads)}</td>
              <td />
              <td className="py-2 px-2 text-right tabular-nums border-l">
                {fmt(totals.toursTdGoal)}
              </td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.tours)}</td>
              <td />
              <td className="py-2 px-2 text-right tabular-nums border-l">
                {fmt(totals.moveInsTdGoal)}
              </td>
              <td className="py-2 px-2 text-right tabular-nums">{fmt(totals.moveIns)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <p className="text-xs text-muted-foreground mt-2">
          Web traffic compares GA sessions matched to a community against its
          web-traffic goal — “–” means GA has no development mapping for it.
          Leads, tours and move-ins count
          contacts attributed to a community; unattributed contacts appear only
          in the funnel totals above.
        </p>
      </CardContent>
    </Card>
  );
}
