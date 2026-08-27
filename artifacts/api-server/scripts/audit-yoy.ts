/**
 * Year-over-year chart regression audit.
 *
 * Compares GET /api/dashboards/overview-with-targets/yoy against independent
 * Snowflake baseline queries. The YoY data layer uses the same
 * DM_COMPANY_DEVELOPMENT attribution join (DEV_DIM) that once fanned out
 * actual counts ~1.5x; these baselines deliberately avoid that join. Where a
 * company filter needs the dimension, the baseline uses an IN (...) semi-join
 * that cannot fan out by construction.
 *
 * Scenarios: the default view (no params) plus filtered views (busiest
 * company and channel, picked dynamically so they never go stale; failure to
 * find a value FAILS the audit rather than silently skipping the scenario).
 *
 * For each scenario, a handful of monthly points per measure (leads, tours,
 * sales, website users) are checked in BOTH the current and the prior year —
 * the prior-year series is exactly what makes the chart "year over year", so
 * it is audited with the same rigor. Business-plan goal points are also
 * checked against DM_GOALS directly.
 *
 * The websiteUsers baselines filter on the same shared GA property constant
 * the API uses (GA_PROPERTY_NAME in src/lib/business-defs.ts), so a renamed
 * analytics property upstream would zero
 * both sides and every point would pass 0=0 while the chart ships zeroed
 * traffic. The run therefore starts with the shared GA property label-drift
 * guard (ga-property-guard.ts, same guard audit-dashboard.ts runs) over the
 * current year to date: GA rows existing with ZERO matching an expected
 * PROPERTY value fail the audit, naming the property values actually
 * present; windows with total GA users below
 * AUDIT_GA_PROPERTY_GUARD_MIN_TOTAL are too quiet to judge and exempt.
 *
 * Run from artifacts/api-server (API server must be running):
 *   pnpm run audit:yoy
 *
 * Env:
 *   AUDIT_API_BASE       base URL of the API (default http://localhost:$PORT/api,
 *                        falling back to port 8080)
 *   AUDIT_TOLERANCE_PCT  allowed relative divergence in percent (default 0.5)
 *   AUDIT_GA_PROPERTY_GUARD_MIN_TOTAL
 *                        minimum total GA users (across all properties) for
 *                        the GA property label-drift guard to judge the
 *                        window (default 10)
 *
 * Exits 0 when all checked points match within tolerance, 1 otherwise.
 */

import { querySnowflake } from "../src/lib/snowflake";
import { DEV_DIM } from "../src/lib/dev-dim";
import { auditGaPropertyLabels } from "./ga-property-guard";
import { fetchJsonWithRetry } from "./lib/fetch-retry";
import { isGaTrafficSql, isLeadSql, isSaleSql } from "../src/lib/business-defs";

const API_BASE =
  process.env.AUDIT_API_BASE ?? `http://localhost:${process.env.PORT ?? "8080"}/api`;
const TOLERANCE_PCT = Number(process.env.AUDIT_TOLERANCE_PCT ?? "0.5");

interface YoyPoint {
  month: number;
  currentYear: number;
  priorYear: number;
  goal: number;
}

interface YoyResponse {
  year: number;
  priorYear: number;
  measures: { measure: string; points: YoyPoint[] }[];
}

async function fetchYoy(params: Record<string, string>): Promise<YoyResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}/dashboards/overview-with-targets/yoy${qs ? `?${qs}` : ""}`;
  // Transport hiccups (dropped connection, transient 5xx while the server's
  // own Snowflake burst warms up) are retried; real 4xx failures are not.
  return fetchJsonWithRetry<YoyResponse>(url);
}

/** Same business-day convention the API uses. */
function todayChicago(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date(),
  );
}

// ---------- Baseline filter fragments (no fan-out-capable joins) ----------

// The deduplicated Esperanza company→development mapping (DEV_DIM) is
// imported from the API's own definition (src/lib/dev-dim.ts) so the audit
// can never silently drift from what the dashboard actually runs. The
// audit's independence lives in HOW the mapping is used here: ONLY inside
// IN (...) semi-joins, which cannot fan out rows the way the API's
// LEFT JOINs could.

interface ScenarioFilters {
  company?: string;
  /** Applied as contactChannel AND dealChannel, like the dashboard UI does */
  channel?: string;
}

interface Scenario {
  name: string;
  filters: ScenarioFilters;
}

interface Frag {
  sql: string;
  binds: (string | number)[];
}

/** Baseline fragments for DM_CONTACTS (alias C). */
function contactFrag(f: ScenarioFilters): Frag {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (f.company) {
    parts.push(
      `C.CONTACT_EHI_COMMUNITY_OF_INTEREST IN (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM} WHERE COMPANY_NAME = ?)`,
    );
    binds.push(f.company);
  }
  if (f.channel) {
    parts.push("C.ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    binds.push(f.channel);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

/** Baseline fragments for DM_DEALS (alias X). */
function dealFrag(f: ScenarioFilters): Frag {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (f.company) {
    parts.push(
      `X.DEAL_EHI_COMMUNITY_OF_INTEREST IN (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM} WHERE COMPANY_NAME = ?)`,
    );
    binds.push(f.company);
  }
  if (f.channel) {
    parts.push("X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    binds.push(f.channel);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

/** Baseline fragments for FCT_GOOGLE_ANALYTICS_EVENT_LEVEL. */
function gaFrag(f: ScenarioFilters): Frag {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (f.company) {
    parts.push("MATCHED_COMPANY_NAME = ?");
    binds.push(f.company);
  }
  // GA has no channel dimension in the dashboard; channel does not apply.
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

/** Baseline fragment for DM_GOALS. */
function goalFrag(f: ScenarioFilters): Frag {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (f.company) {
    parts.push("COMPANY_NAME = ?");
    binds.push(f.company);
  }
  // Channel does not filter goals in the API either.
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

function toQueryParams(f: ScenarioFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.company) params.company = f.company;
  if (f.channel) {
    params.contactChannel = f.channel;
    params.dealChannel = f.channel;
  }
  return params;
}

// ---------- Baseline monthly counts ----------

/**
 * Per-measure baseline SQL, grouped by (year, month) so ONE query returns
 * every checked point of both years for that measure. Each (year, month)
 * group holds exactly the COUNT the old one-scalar-per-point query
 * computed — a group with no matching rows is simply absent, which the
 * caller reads as 0, exactly like the old scalar COUNT over zero rows.
 * (DISTINCT-user counts are per group, i.e. per month — same as before.)
 * Batching matters because the Snowflake proxy rate-limits at ~10 RPS
 * repl-wide and the audits run their queries sequentially, so round trips
 * — not warehouse work — dominate audit wall time. Transient transport
 * failures — 429s, dropped connections — are retried with backoff inside
 * the shared Snowflake helper (src/lib/snowflake.ts); a query that still
 * fails is a real error and must fail the audit.
 */
function baselineGroupedSql(
  measure: string,
  frag: Frag,
  years: number[],
  months: number[],
): { sql: string; binds: (string | number)[] } {
  const yearsIn = years.map(() => "?").join(", ");
  const monthsIn = months.map(() => "?").join(", ");
  const grouped = (dateExpr: string, from: string, where: string, countExpr = "COUNT(*)") => ({
    sql: `SELECT YEAR(${dateExpr}) AS Y, MONTH(${dateExpr}) AS M, ${countExpr} AS N
          FROM ${from}
          WHERE ${where}
            AND YEAR(${dateExpr}) IN (${yearsIn})
            AND MONTH(${dateExpr}) IN (${monthsIn})${frag.sql}
          GROUP BY 1, 2`,
    binds: [...years, ...months, ...frag.binds] as (string | number)[],
  });
  switch (measure) {
    case "leads":
      return grouped("C.CONTACT_CREATE_DATE", "DM_CONTACTS C", isLeadSql("C"));
    case "tours":
      return grouped("C.EHI_MIN_FIRST_TOUR_DATE", "DM_CONTACTS C", isLeadSql("C"));
    case "grossSales":
      return grouped("X.CONTRACT_RATIFIED_DATE", "DM_DEALS X", isSaleSql("X"));
    case "websiteUsers":
      return grouped(
        "GOOGLE_ANALYTICS_DATE",
        "FCT_GOOGLE_ANALYTICS_EVENT_LEVEL",
        isGaTrafficSql(),
        "COUNT(DISTINCT USER_PSEUDO_ID)",
      );
    default:
      throw new Error(`Unknown measure ${measure}`);
  }
}

const GOAL_TYPE_FOR_MEASURE: Record<string, string> = {
  websiteUsers: "business_plan_web_traffic_year",
  leads: "business_plan_leads_year",
  tours: "business_plan_first_tours_year",
  grossSales: "business_plan_gross_sales_year",
};

// ---------- Scenario execution ----------

interface Check {
  label: string;
  api: number;
  baseline: number;
}

async function auditScenario(
  scenario: Scenario,
  months: number[],
): Promise<boolean> {
  const f = scenario.filters;
  console.log(`\n=== Scenario: ${scenario.name} ===`);
  const params = toQueryParams(f);
  console.log(
    `Params: ${Object.keys(params).length ? JSON.stringify(params) : "(none — default view)"}`,
  );

  const yoy = await fetchYoy(params);

  // The endpoint must report the current business year and the year before it
  // — otherwise every "year" comparison below would be against wrong years.
  const expectedYear = Number(todayChicago().slice(0, 4));
  if (yoy.year !== expectedYear || yoy.priorYear !== expectedYear - 1) {
    console.error(
      `FAIL year mismatch: expected year=${expectedYear} priorYear=${expectedYear - 1}, ` +
        `got year=${yoy.year} priorYear=${yoy.priorYear}`,
    );
    return false;
  }

  const measures = ["websiteUsers", "leads", "tours", "grossSales"] as const;
  const byMeasure = new Map(yoy.measures.map((m) => [m.measure, m.points]));
  for (const m of measures) {
    const points = byMeasure.get(m);
    if (!points || points.length !== 12) {
      console.error(`FAIL measure ${m} missing or does not have 12 monthly points`);
      return false;
    }
  }

  const cf = contactFrag(f);
  const df = dealFrag(f);
  const gaf = gaFrag(f);
  const gf = goalFrag(f);
  const fragFor: Record<string, Frag> = {
    leads: cf,
    tours: cf,
    grossSales: df,
    websiteUsers: gaf,
  };

  // Sequential on purpose (the Snowflake proxy rate-limits at 10 RPS), but
  // batched: ONE grouped query per measure covers both years × all checked
  // months — the same per-point COUNT values as before, in a fraction of
  // the round trips. A missing (year, month) group reads as 0, exactly
  // like the old scalar COUNT over zero rows.
  const checks: Check[] = [];
  for (const measure of measures) {
    const points = byMeasure.get(measure)!;
    const { sql, binds } = baselineGroupedSql(
      measure,
      fragFor[measure],
      [yoy.priorYear, yoy.year],
      months,
    );
    const rows = await querySnowflake<{ Y: number; M: number; N: number }>(sql, binds);
    const byYearMonth = new Map(
      rows.map((r) => [`${Number(r.Y)}-${Number(r.M)}`, Number(r.N) || 0]),
    );
    const baselineAt = (year: number, month: number) =>
      byYearMonth.get(`${year}-${month}`) ?? 0;
    for (const month of months) {
      const pt = points.find((p) => p.month === month)!;
      checks.push({
        label: `${measure} ${yoy.year}-${String(month).padStart(2, "0")}`,
        api: pt.currentYear,
        baseline: baselineAt(yoy.year, month),
      });
      checks.push({
        label: `${measure} ${yoy.priorYear}-${String(month).padStart(2, "0")}`,
        api: pt.priorYear,
        baseline: baselineAt(yoy.priorYear, month),
      });
    }
  }

  // Goal points: business-plan annual goals from DM_GOALS, current year
  // only. ONE query grouped by (goal type, month) replaces the per-point
  // SUM scalars — same SUM(GOAL) per cell; a missing group (or an all-NULL
  // sum) reads as 0, as before.
  const goalTypes = measures.map((m) => GOAL_TYPE_FOR_MEASURE[m]);
  const goalRows = await querySnowflake<{ GT: string; M: number; N: number | null }>(
    `SELECT GOAL_TYPE AS GT, MONTH(BUDGET_DATE) AS M, SUM(GOAL) AS N
     FROM DM_GOALS
     WHERE FISCAL_YEAR = ? AND GOAL_TYPE IN (${goalTypes.map(() => "?").join(", ")})
       AND MONTH(BUDGET_DATE) IN (${months.map(() => "?").join(", ")})${gf.sql}
     GROUP BY 1, 2`,
    [yoy.year, ...goalTypes, ...months, ...gf.binds],
  );
  const goalAt = new Map(
    goalRows.map((r) => [`${r.GT}\u0000${Number(r.M)}`, Number(r.N) || 0]),
  );
  for (const measure of measures) {
    const points = byMeasure.get(measure)!;
    const gt = GOAL_TYPE_FOR_MEASURE[measure];
    for (const month of months) {
      const pt = points.find((p) => p.month === month)!;
      checks.push({
        label: `${measure} goal ${yoy.year}-${String(month).padStart(2, "0")}`,
        api: pt.goal,
        baseline: goalAt.get(`${gt}\u0000${month}`) ?? 0,
      });
    }
  }

  checks.sort((a, b) => a.label.localeCompare(b.label));
  let failed = false;
  let nonZero = 0;
  for (const c of checks) {
    const divergencePct =
      c.baseline === 0
        ? c.api === 0
          ? 0
          : Infinity
        : (Math.abs(c.api - c.baseline) / c.baseline) * 100;
    const ok = divergencePct <= TOLERANCE_PCT;
    if (c.baseline !== 0 || c.api !== 0) nonZero++;
    console.log(
      `${ok ? "OK  " : "FAIL"} ${c.label.padEnd(28)} api=${c.api} baseline=${c.baseline} divergence=${divergencePct.toFixed(3)}%`,
    );
    if (!ok) failed = true;
  }
  // A scenario where every checked point is 0 on both sides proves nothing —
  // fail loudly instead of pretending it was covered.
  if (nonZero === 0) {
    console.error(
      "FAIL all checked points are zero on both sides — scenario exercises no data",
    );
    return false;
  }
  return !failed;
}

// ---------- Representative filter selection ----------

/**
 * Busiest Esperanza company and channel across the current + prior year, so
 * the filtered scenarios always exercise non-trivial data in both series.
 * Missing values FAIL the audit — a silently skipped scenario is not coverage.
 */
async function pickRepresentativeFilters(
  year: number,
): Promise<{ company: string; channel: string }> {
  const [companyRows, channelRows] = await Promise.all([
    querySnowflake<{ COMPANY_NAME: string }>(
      `SELECT D.COMPANY_NAME, COUNT(*) AS N
       FROM DM_CONTACTS C
       JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
       WHERE ${isLeadSql("C")} AND YEAR(C.CONTACT_CREATE_DATE) IN (?, ?)
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [year - 1, year],
    ),
    querySnowflake<{ CH: string }>(
      `SELECT C.ONSITE_ONLINE_SOURCE_CHANNEL AS CH, COUNT(*) AS N
       FROM DM_CONTACTS C
       WHERE ${isLeadSql("C")} AND YEAR(C.CONTACT_CREATE_DATE) IN (?, ?)
         AND C.ONSITE_ONLINE_SOURCE_CHANNEL IS NOT NULL
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [year - 1, year],
    ),
  ]);
  const company = companyRows[0]?.COMPANY_NAME;
  const channel = channelRows[0]?.CH;
  const missing = [!company && "company", !channel && "channel"].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `No representative ${missing.join(", ")} found for ${year - 1}/${year} — ` +
        "cannot exercise the required filtered scenarios (empty source data or broken dimension)",
    );
  }
  return { company: company!, channel: channel! };
}

/**
 * Months to spot-check: the three most recent fully-elapsed months of the
 * current year (stable — no mid-month movement between the API call and the
 * baseline), or January when the year has just started.
 */
function monthsToCheck(): number[] {
  const today = todayChicago();
  const currentMonth = Number(today.slice(5, 7));
  const lastFull = currentMonth - 1;
  if (lastFull < 1) return [1];
  const start = Math.max(1, lastFull - 2);
  return Array.from({ length: lastFull - start + 1 }, (_, i) => start + i);
}

async function main() {
  console.log(
    `Auditing ${API_BASE}/dashboards/overview-with-targets/yoy (tolerance ${TOLERANCE_PCT}%)`,
  );
  const year = Number(todayChicago().slice(0, 4));
  const months = monthsToCheck();
  console.log(`Checking months [${months.join(", ")}] for years ${year - 1} and ${year}`);

  const { company, channel } = await pickRepresentativeFilters(year);

  const scenarios: Scenario[] = [
    { name: "default view", filters: {} },
    { name: `company filter (${company})`, filters: { company } },
    { name: `channel filter (${channel})`, filters: { channel } },
  ];
  console.log(`Scenarios: ${scenarios.map((s) => s.name).join("; ")}`);

  let anyFailed = false;

  // GA property label-drift guard over the current year to date: the
  // websiteUsers baselines below hardcode the same PROPERTY literal the API
  // uses, so a renamed property would zero both sides and every monthly
  // point would pass 0=0. The shared guard fails loudly instead.
  console.log(`\n=== GA property label-drift guard (${year}-01-01..${todayChicago()}) ===`);
  if (!(await auditGaPropertyLabels(`${year}-01-01`, todayChicago()))) {
    anyFailed = true;
  }
  for (const scenario of scenarios) {
    const ok = await auditScenario(scenario, months);
    if (!ok) anyFailed = true;
  }

  if (anyFailed) {
    console.error(
      "\nAUDIT FAILED: YoY chart points diverge from independent Snowflake baselines " +
        "in at least one scenario. Likely causes: join fan-out in the attribution " +
        "dimension, a filter bound to the wrong column, wrong year selection, " +
        "upstream renaming of the GA PROPERTY values (see any gaProperty guard " +
        "failure above), or stale cached data.",
    );
    process.exit(1);
  }
  console.log("\nAudit passed: all checked YoY points within tolerance across all scenarios.");
  process.exit(0);
}

main().catch((err) => {
  console.error("AUDIT ERRORED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
