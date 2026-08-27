import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEhiGoals,
  useGetSnowflakeStatus,
  getEhiGoals,
  getGetEhiGoalsQueryKey,
  type GetEhiGoalsParams,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn, downloadData, type CsvValue, type DownloadFormat } from "@/lib/utils";
import {
  Breadcrumb,
  DownloadDataButton,
  LiveStatusBadge,
  RefreshDataButton,
  TargetToggle,
  fmt,
  fmtPct,
  ptgColor,
  ptgBg,
  type TargetValue,
} from "@/components/dashboard-shared";

const CORE_METRICS = ["web_traffic", "leads", "first_tours", "gross_sales"];

export default function EhiGoalsPage() {
  const [target, setTarget] = useState<TargetValue>("goal");

  const params: GetEhiGoalsParams = { target };
  const dash = useGetEhiGoals(params);
  const status = useGetSnowflakeStatus();

  // Force the API to bypass its stale-serve cache and wait for live
  // Snowflake data, then swap the fresh payload in under the same query key
  // so the numbers update in place.
  const queryClient = useQueryClient();
  const refreshNow = async () => {
    const live = await getEhiGoals({ ...params, refresh: true });
    queryClient.setQueryData(getGetEhiGoalsQueryKey(params), live);
  };

  const downloadGoalAttainment = (format: DownloadFormat) => {
    const d = dash.data;
    if (!d) return;
    return downloadData(
      format,
      "ehi-goals-goal-attainment",
      ["Metric", "Resolved Goal Type", "Full-Year Goal", "TD Goal", "Actual", "Attainment %", "PTG %"],
      d.metrics.map((m): CsvValue[] => [
        m.label,
        m.goalType ?? "not issued",
        m.fullYearGoal,
        m.toDateGoal,
        m.actual,
        m.attainmentPct,
        m.ptgPercent,
      ]),
    );
  };

  return (
    <Layout>
      <div className="space-y-6">
        <Breadcrumb page="EHI Goals" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">EHI Goals</h1>
            {dash.data && (
              <p className="text-sm text-muted-foreground mt-1">
                Fiscal year {dash.data.appliedRange.startDate.slice(0, 4)} · progress through{" "}
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
            <TargetToggle target={target} onChange={setTarget} />
          </div>
        </div>

        {dash.isError && (
          <Alert variant="destructive">
            <AlertTitle>Failed to load dashboard data</AlertTitle>
            <AlertDescription>
              {(dash.error as Error)?.message ?? "Snowflake query failed."}
            </AlertDescription>
          </Alert>
        )}

        {dash.isLoading && <Skeleton className="h-96" />}

        {dash.data && (
          <>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-base">Goal Attainment — Full Fiscal Year</CardTitle>
                <DownloadDataButton slug="goal-attainment" onDownload={downloadGoalAttainment} />
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-goal-metrics">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4">Metric</th>
                      <th className="py-2 pr-4">Resolved Goal Type</th>
                      <th className="py-2 pr-4 text-right">Full-Year Goal</th>
                      <th className="py-2 pr-4 text-right">TD Goal</th>
                      <th className="py-2 pr-4 text-right">Actual</th>
                      <th className="py-2 pr-4">Attainment</th>
                      <th className="py-2 text-right">PTG</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dash.data.metrics.map((m) => (
                      <tr key={m.metric} className="border-b last:border-0">
                        <td className="py-2 pr-4 font-medium">{m.label}</td>
                        <td className="py-2 pr-4">
                          {m.goalType ? (
                            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                              {m.goalType}
                            </code>
                          ) : (
                            <span className="text-muted-foreground text-xs">not issued</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-right">{fmt(m.fullYearGoal)}</td>
                        <td className="py-2 pr-4 text-right">{fmt(m.toDateGoal)}</td>
                        <td className="py-2 pr-4 text-right font-semibold">{fmt(m.actual)}</td>
                        <td className="py-2 pr-4 min-w-40">
                          {m.attainmentPct != null ? (
                            <div className="flex items-center gap-2">
                              <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-primary"
                                  style={{ width: `${Math.min(100, m.attainmentPct)}%` }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground w-12 text-right">
                                {m.attainmentPct.toFixed(0)}%
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs">–</span>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <span
                            className={cn(
                              "inline-block rounded px-1.5 py-0.5 font-medium",
                              ptgColor(m.ptgPercent),
                              ptgBg(m.ptgPercent),
                            )}
                          >
                            {fmtPct(m.ptgPercent)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <DivisionMatrix divisions={dash.data.divisions} />
          </>
        )}
      </div>
    </Layout>
  );
}

function DivisionMatrix({
  divisions,
}: {
  divisions: {
    division: string;
    metric: string;
    label: string;
    toDateGoal: number;
    actual: number;
    ptgPercent: number | null;
  }[];
}) {
  const byDivision = new Map<string, Map<string, (typeof divisions)[number]>>();
  for (const row of divisions) {
    if (!byDivision.has(row.division)) byDivision.set(row.division, new Map());
    byDivision.get(row.division)!.set(row.metric, row);
  }
  const labels = new Map(divisions.map((d) => [d.metric, d.label]));

  const downloadDivisionAttainment = (format: DownloadFormat) =>
    downloadData(
      format,
      "ehi-goals-division-attainment",
      [
        "Division",
        ...CORE_METRICS.flatMap((m) => {
          const label = labels.get(m) ?? m;
          return [`${label} Actual`, `${label} TD Goal`, `${label} PTG %`];
        }),
      ],
      [...byDivision.entries()].map(([division, rows]): CsvValue[] => [
        division,
        ...CORE_METRICS.flatMap((m): CsvValue[] => {
          const cell = rows.get(m);
          return cell ? [cell.actual, cell.toDateGoal, cell.ptgPercent] : [null, null, null];
        }),
      ]),
    );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Division Attainment (to date)</CardTitle>
        <DownloadDataButton slug="division-attainment" onDownload={downloadDivisionAttainment} />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="table-division-goals">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-4">Division</th>
              {CORE_METRICS.map((m) => (
                <th key={m} className="py-2 pr-4 text-right">
                  {labels.get(m) ?? m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...byDivision.entries()].map(([division, rows]) => (
              <tr key={division} className="border-b last:border-0">
                <td className="py-2 pr-4 font-medium">{division}</td>
                {CORE_METRICS.map((m) => {
                  const cell = rows.get(m);
                  return (
                    <td key={m} className="py-2 pr-4 text-right">
                      {cell ? (
                        <div>
                          <span className="font-semibold">{fmt(cell.actual)}</span>
                          <span className="text-muted-foreground text-xs">
                            {" "}
                            / {fmt(cell.toDateGoal)}
                          </span>
                          <div className={cn("text-xs font-medium", ptgColor(cell.ptgPercent))}>
                            {fmtPct(cell.ptgPercent)}
                          </div>
                        </div>
                      ) : (
                        "–"
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
