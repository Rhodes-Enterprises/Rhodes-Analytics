/**
 * Dashboard number regression audit.
 *
 * Compares the API's default GET /api/dashboards/overview-with-targets
 * response against independent Snowflake baseline queries with identical
 * filters. The baselines deliberately avoid the DM_COMPANY_DEVELOPMENT
 * attribution join used by the API's data layer — a fan-out in that join
 * once inflated actuals ~1.5x, which is exactly the regression class this
 * audit exists to catch.
 *
 * Run from artifacts/api-server (API server must be running):
 *   pnpm run audit:dashboard
 *
 * Env:
 *   AUDIT_API_BASE       base URL of the API (default http://localhost:$PORT/api,
 *                        falling back to port 8080)
 *   AUDIT_TOLERANCE_PCT  allowed relative divergence in percent (default 0.5)
 *
 * Exits 0 when all totals match within tolerance, 1 otherwise.
 */

import { querySnowflake } from "../src/lib/snowflake";

// Default to the API server's own local port (same PORT contract the server
// uses; the artifact's configured port is 8080). Override with AUDIT_API_BASE.
const API_BASE =
  process.env.AUDIT_API_BASE ?? `http://localhost:${process.env.PORT ?? "8080"}/api`;
const TOLERANCE_PCT = Number(process.env.AUDIT_TOLERANCE_PCT ?? "0.5");

interface OverviewResponse {
  appliedRange: { startDate: string; endDate: string; toDate: string; target: string };
  kpis: { grossSales: number };
  trafficMatrix: {
    online: { websiteUsers: { actual: number } };
    total: { leads: { actual: number }; tours: { actual: number } };
  };
}

async function fetchOverview(): Promise<OverviewResponse> {
  const url = `${API_BASE}/dashboards/overview-with-targets`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed with HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as OverviewResponse;
}

async function countScalar(sql: string, binds: (string | number)[]): Promise<number> {
  const rows = await querySnowflake<{ N: number }>(sql, binds);
  return Number(rows[0]?.N) || 0;
}

async function main() {
  console.log(`Auditing ${API_BASE}/dashboards/overview-with-targets (tolerance ${TOLERANCE_PCT}%)`);
  const overview = await fetchOverview();
  const { startDate, endDate, toDate, target } = overview.appliedRange;
  console.log(`Applied range: ${startDate}..${endDate}, toDate=${toDate}, target=${target}`);

  // Independent baselines — same date filters the API applies to actuals
  // (start..toDate), no attribution join that could fan out counts.
  const [leads, tours, sales, users] = await Promise.all([
    countScalar(
      `SELECT COUNT(*) AS N FROM DM_CONTACTS
       WHERE EHI_LEAD = 1 AND CONTACT_CREATE_DATE BETWEEN ? AND ?`,
      [startDate, toDate],
    ),
    countScalar(
      `SELECT COUNT(*) AS N FROM DM_CONTACTS
       WHERE EHI_LEAD = 1 AND EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?`,
      [startDate, toDate],
    ),
    countScalar(
      `SELECT COUNT(*) AS N FROM DM_DEALS
       WHERE PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
         AND CONTRACT_RATIFIED_DATE BETWEEN ? AND ?`,
      [startDate, toDate],
    ),
    countScalar(
      `SELECT COUNT(DISTINCT USER_PSEUDO_ID) AS N FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE PROPERTY = 'Esperanza Homes' AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?`,
      [startDate, toDate],
    ),
  ]);

  const checks: { name: string; api: number; baseline: number }[] = [
    { name: "leads", api: overview.trafficMatrix.total.leads.actual, baseline: leads },
    { name: "tours", api: overview.trafficMatrix.total.tours.actual, baseline: tours },
    { name: "sales", api: overview.kpis.grossSales, baseline: sales },
    { name: "users", api: overview.trafficMatrix.online.websiteUsers.actual, baseline: users },
  ];

  let failed = false;
  for (const c of checks) {
    const divergencePct =
      c.baseline === 0
        ? c.api === 0
          ? 0
          : Infinity
        : (Math.abs(c.api - c.baseline) / c.baseline) * 100;
    const ok = divergencePct <= TOLERANCE_PCT;
    const status = ok ? "OK  " : "FAIL";
    console.log(
      `${status} ${c.name.padEnd(6)} api=${c.api} baseline=${c.baseline} divergence=${divergencePct.toFixed(3)}%`,
    );
    if (!ok) failed = true;
  }

  if (failed) {
    console.error(
      "\nAUDIT FAILED: dashboard totals diverge from independent Snowflake baselines. " +
        "Likely causes: join fan-out in the attribution dimension, changed filters, or stale cached data.",
    );
    process.exit(1);
  }
  console.log("\nAudit passed: all totals within tolerance.");
  process.exit(0);
}

main().catch((err) => {
  console.error("AUDIT ERRORED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
