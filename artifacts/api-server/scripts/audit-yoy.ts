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
 * company, channel, lead source, and cohort quarter, picked dynamically so
 * they never go stale; failure to find a value FAILS the audit rather than
 * silently skipping the scenario).
 *
 * Lead-source and cohort baselines bind with the same asymmetry the API
 * uses: leadSource filters contacts (LEAD_SOURCE_OVERVIEW) AND deals
 * (DEAL_LEAD_SOURCE_OVERVIEW); cohortQuarter filters contacts ONLY; the GA
 * series is never filtered by either. EHI_COHORT_QUARTER equals the
 * contact's create quarter, so under a cohort filter the leads series is a
 * no-op inside the cohort's own months and zero everywhere else — the
 * cross-year cells and the tour-date series are what discriminate, which is
 * why the scenario checks every measure across both years rather than
 * relying on the leads series alone.
 *
 * For each scenario, a handful of monthly points per measure (leads, tours,
 * sales, website users) are checked in BOTH the current and the prior year —
 * the prior-year series is exactly what makes the chart "year over year", so
 * it is audited with the same rigor. Business-plan goal points are also
 * checked against DM_GOALS directly.
 *
 * Months that predate GA history entirely (before the earliest
 * GOOGLE_ANALYTICS_DATE) are a special case: the API reports websiteUsers
 * as null ("no data yet") rather than 0 there, and exposes the cutoff as
 * gaHistoryStart. The audit recomputes that cutoff independently
 * (MIN(GOOGLE_ANALYTICS_DATE) under the same traffic predicate), requires
 * the API's gaHistoryStart to match it exactly, requires null on exactly
 * the pre-history months (all 12 points of both years), and requires plain
 * numbers everywhere else — so neither a hardcoded cutoff date nor a
 * null-everything regression can pass.
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
  /** null = month predates GA history ("no data yet") — websiteUsers only */
  currentYear: number | null;
  priorYear: number | null;
  goal: number;
}

interface YoyResponse {
  year: number;
  priorYear: number;
  /** Earliest GOOGLE_ANALYTICS_DATE (YYYY-MM-DD), or null when GA is empty */
  gaHistoryStart: string | null;
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
  /**
   * Filters contacts (LEAD_SOURCE_OVERVIEW) AND deals
   * (DEAL_LEAD_SOURCE_OVERVIEW); GA has no lead-source dimension.
   */
  leadSource?: string;
  /**
   * Filters contacts only (EHI_COHORT_QUARTER) — the API's dealFilters and
   * gaFilters have no cohort dimension, so the sales and website-user
   * baselines must stay unfiltered under it.
   */
  cohortQuarter?: string;
}

interface Scenario {
  name: string;
  filters: ScenarioFilters;
  /**
   * Measures whose baselines must include at least one non-zero point, or
   * the scenario FAILS as vacuous. The scenario-wide all-zero guard is
   * toothless for lead-source/cohort scenarios: their GA (and goal) checks
   * are unfiltered by design and always non-zero, so without this the
   * filtered series could silently compare 0 vs 0 forever (e.g. after a
   * pick-vs-check drift) while appearing covered.
   */
  mustHaveData?: string[];
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
  if (f.cohortQuarter) {
    parts.push("C.EHI_COHORT_QUARTER = ?");
    binds.push(f.cohortQuarter);
  }
  if (f.leadSource) {
    parts.push("C.LEAD_SOURCE_OVERVIEW = ?");
    binds.push(f.leadSource);
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
  if (f.leadSource) {
    parts.push("X.DEAL_LEAD_SOURCE_OVERVIEW = ?");
    binds.push(f.leadSource);
  }
  // cohortQuarter deliberately NOT applied: the API's dealFilters has no
  // cohort dimension, so the sales baselines must stay unfiltered under it.
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
  // GA has no channel, lead-source, or cohort dimension in the dashboard;
  // those filters do not apply (mirrors the API's gaFilters).
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
  // Channel, lead source, and cohort do not filter goals in the API either,
  // so goal baselines stay unfiltered under those scenarios — which also
  // catches the API ever wrongly starting to filter goals by them.
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

function toQueryParams(f: ScenarioFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.company) params.company = f.company;
  if (f.channel) {
    params.contactChannel = f.channel;
    params.dealChannel = f.channel;
  }
  if (f.leadSource) params.leadSource = f.leadSource;
  if (f.cohortQuarter) params.cohortQuarter = f.cohortQuarter;
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

/**
 * Independent baseline for when GA history starts: the earliest
 * GOOGLE_ANALYTICS_DATE among traffic rows, under the SAME shared traffic
 * predicate the API uses. The API must null out websiteUsers months BEFORE
 * this month ("no data yet" instead of a fake zero line) and expose the
 * date as gaHistoryStart — recomputing it here catches a hardcoded or
 * drifted cutoff the moment upstream history changes.
 */
async function fetchGaHistoryStartBaseline(): Promise<string | null> {
  const rows = await querySnowflake<{ D: string | null }>(
    `SELECT MIN(GOOGLE_ANALYTICS_DATE) AS D
     FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
     WHERE ${isGaTrafficSql()}`,
  );
  return rows[0]?.D ?? null;
}

/** Comparable calendar-month index (year*12 + month0) of a YYYY-MM-DD date. */
function monthIndexOf(date: string): number {
  return Number(date.slice(0, 4)) * 12 + (Number(date.slice(5, 7)) - 1);
}

// ---------- Scenario execution ----------

interface Check {
  label: string;
  api: number | null;
  baseline: number;
  /**
   * Month predates GA history: the API must report null ("no data yet"),
   * and the independent baseline must agree there are no rows (0).
   */
  expectNoData?: boolean;
}

async function auditScenario(
  scenario: Scenario,
  months: number[],
  gaHistoryStart: string | null,
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

  // The API's no-history cutoff must be the data-driven earliest GA date —
  // not a hardcoded constant that drifts as upstream history changes.
  if ((yoy.gaHistoryStart ?? null) !== gaHistoryStart) {
    console.error(
      `FAIL gaHistoryStart mismatch: api=${JSON.stringify(yoy.gaHistoryStart)} ` +
        `baseline MIN(GOOGLE_ANALYTICS_DATE)=${JSON.stringify(gaHistoryStart)}`,
    );
    return false;
  }
  const startYm = gaHistoryStart === null ? null : monthIndexOf(gaHistoryStart);
  const preHistory = (yr: number, month: number) =>
    startYm === null || yr * 12 + (month - 1) < startYm;
  // The null pattern is structural, so check ALL 12 points of BOTH years —
  // not just the spot-checked months: websiteUsers must be null on exactly
  // the pre-history months, and every other measure must never be null
  // (their CRM sources predate GA history).
  for (const m of measures) {
    for (const pt of byMeasure.get(m)!) {
      const cells: [number, number | null][] = [
        [yoy.year, pt.currentYear],
        [yoy.priorYear, pt.priorYear],
      ];
      for (const [yr, val] of cells) {
        const expectNull = m === "websiteUsers" && preHistory(yr, pt.month);
        if (expectNull && val !== null) {
          console.error(
            `FAIL ${m} ${yr}-${String(pt.month).padStart(2, "0")}: month predates GA ` +
              `history (${gaHistoryStart}), so the API must report null ("no data ` +
              `yet"), got ${val}`,
          );
          return false;
        }
        if (!expectNull && typeof val !== "number") {
          console.error(
            `FAIL ${m} ${yr}-${String(pt.month).padStart(2, "0")}: expected a number, ` +
              `got ${JSON.stringify(val)} (null is only allowed for pre-history ` +
              `websiteUsers months)`,
          );
          return false;
        }
      }
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
  const baselineNonZeroByMeasure = new Map<string, number>();
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
    let nonZeroBaselines = 0;
    for (const month of months) {
      const pt = points.find((p) => p.month === month)!;
      const currentBaseline = baselineAt(yoy.year, month);
      const priorBaseline = baselineAt(yoy.priorYear, month);
      if (currentBaseline !== 0) nonZeroBaselines++;
      if (priorBaseline !== 0) nonZeroBaselines++;
      checks.push({
        label: `${measure} ${yoy.year}-${String(month).padStart(2, "0")}`,
        api: pt.currentYear,
        baseline: currentBaseline,
        expectNoData: measure === "websiteUsers" && preHistory(yoy.year, month),
      });
      checks.push({
        label: `${measure} ${yoy.priorYear}-${String(month).padStart(2, "0")}`,
        api: pt.priorYear,
        baseline: priorBaseline,
        expectNoData: measure === "websiteUsers" && preHistory(yoy.priorYear, month),
      });
    }
    baselineNonZeroByMeasure.set(measure, nonZeroBaselines);
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
    let ok: boolean;
    let detail: string;
    if (c.expectNoData) {
      // Pre-history month: the API must say "no data yet" (null), and the
      // independent baseline must agree there are no rows at all.
      ok = c.api === null && c.baseline === 0;
      detail = `api=${c.api === null ? "null (no data yet)" : c.api} baseline=${c.baseline} (pre-GA-history month)`;
    } else if (c.api === null) {
      ok = false;
      detail = `api=null baseline=${c.baseline} (null outside the pre-history window)`;
    } else {
      const divergencePct =
        c.baseline === 0
          ? c.api === 0
            ? 0
            : Infinity
          : (Math.abs(c.api - c.baseline) / c.baseline) * 100;
      ok = divergencePct <= TOLERANCE_PCT;
      detail = `api=${c.api} baseline=${c.baseline} divergence=${divergencePct.toFixed(3)}%`;
    }
    // Null cells are "no data", not data — only numeric values (or a
    // non-zero baseline) count toward the vacuity guard.
    if (c.baseline !== 0 || (typeof c.api === "number" && c.api !== 0)) nonZero++;
    console.log(`${ok ? "OK  " : "FAIL"} ${c.label.padEnd(28)} ${detail}`);
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
  // Per-measure vacuity guard: for the series a filter actually binds, all-
  // zero baselines mean the filter check proved nothing (the GA/goal checks
  // keep the scenario-wide guard above happy even then).
  for (const measure of scenario.mustHaveData ?? []) {
    if (!baselineNonZeroByMeasure.get(measure)) {
      console.error(
        `FAIL every ${measure} baseline point is zero — the filtered ${measure} ` +
          "series exercises no data, so this scenario cannot vouch for that filter " +
          "(representative-filter pick drifted from the checked months?)",
      );
      failed = true;
    }
  }
  return !failed;
}

// ---------- Representative filter selection ----------

/**
 * Busiest Esperanza company and channel across the current + prior year, so
 * the filtered scenarios always exercise non-trivial data in both series.
 * Missing values FAIL the audit — a silently skipped scenario is not coverage.
 *
 * The lead source and cohort quarter are ranked over the exact (year, month)
 * grid the scenarios check — YEAR IN (prior, current) AND MONTH IN (checked
 * months) — and the picked value must have data there for EVERY series its
 * filter binds: leads, tours, AND ratified deals for the lead source
 * (DEAL_LEAD_SOURCE_OVERVIEW checked only against zero rows would prove
 * nothing — audit-dashboard.ts rationale, hardened from "prefer" to
 * "require"); leads AND tours for the cohort (tour-date cells are the
 * cross-quarter discriminator). That structurally guarantees at least one
 * non-zero baseline cell per filtered series, which mustHaveData then
 * enforces. When NO value qualifies, the audit FAILS as uncovered instead
 * of reporting success off 0=0 comparisons.
 */
async function pickRepresentativeFilters(
  year: number,
  months: number[],
): Promise<{
  company: string;
  channel: string;
  leadSource: string;
  cohortQuarter: string;
}> {
  const monthPlaceholders = months.map(() => "?").join(", ");
  const gridBinds = [year - 1, year, ...months];
  const [
    companyRows,
    channelRows,
    leadSourceRows,
    tourSourceRows,
    dealSourceRows,
    cohortLeadRows,
    cohortTourRows,
  ] = await Promise.all([
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
      // All lead sources with leads in the checked grid, by volume (not
      // LIMIT 1): the pick below requires one that also has tours and
      // ratified deals there.
      querySnowflake<{ LS: string }>(
        `SELECT C.LEAD_SOURCE_OVERVIEW AS LS, COUNT(*) AS N
         FROM DM_CONTACTS C
         WHERE ${isLeadSql("C")} AND YEAR(C.CONTACT_CREATE_DATE) IN (?, ?)
           AND MONTH(C.CONTACT_CREATE_DATE) IN (${monthPlaceholders})
           AND C.LEAD_SOURCE_OVERVIEW IS NOT NULL
         GROUP BY 1 ORDER BY N DESC`,
        gridBinds,
      ),
      querySnowflake<{ LS: string }>(
        `SELECT DISTINCT C.LEAD_SOURCE_OVERVIEW AS LS
         FROM DM_CONTACTS C
         WHERE ${isLeadSql("C")} AND YEAR(C.EHI_MIN_FIRST_TOUR_DATE) IN (?, ?)
           AND MONTH(C.EHI_MIN_FIRST_TOUR_DATE) IN (${monthPlaceholders})
           AND C.LEAD_SOURCE_OVERVIEW IS NOT NULL`,
        gridBinds,
      ),
      querySnowflake<{ LS: string }>(
        `SELECT DISTINCT X.DEAL_LEAD_SOURCE_OVERVIEW AS LS
         FROM DM_DEALS X
         WHERE ${isSaleSql("X")} AND YEAR(X.CONTRACT_RATIFIED_DATE) IN (?, ?)
           AND MONTH(X.CONTRACT_RATIFIED_DATE) IN (${monthPlaceholders})
           AND X.DEAL_LEAD_SOURCE_OVERVIEW IS NOT NULL`,
        gridBinds,
      ),
      // Cohort = create quarter, so ranking by grid leads picks a cohort
      // whose own months overlap the checks (non-zero no-op cells in its
      // year) while every same-month cell of the OTHER year is zero under
      // the filter — those cross-year cells are what catch a dropped
      // cohort fragment on the create-date series.
      querySnowflake<{ CQ: string }>(
        `SELECT C.EHI_COHORT_QUARTER AS CQ, COUNT(*) AS N
         FROM DM_CONTACTS C
         WHERE ${isLeadSql("C")} AND YEAR(C.CONTACT_CREATE_DATE) IN (?, ?)
           AND MONTH(C.CONTACT_CREATE_DATE) IN (${monthPlaceholders})
           AND C.EHI_COHORT_QUARTER IS NOT NULL
         GROUP BY 1 ORDER BY N DESC`,
        gridBinds,
      ),
      // Cohorts whose contacts also TOURED inside the grid — the tour-date
      // series is the cross-quarter discriminator, so a cohort with no
      // tours there would leave the tours checks comparing 0 vs 0.
      querySnowflake<{ CQ: string }>(
        `SELECT DISTINCT C.EHI_COHORT_QUARTER AS CQ
         FROM DM_CONTACTS C
         WHERE ${isLeadSql("C")} AND YEAR(C.EHI_MIN_FIRST_TOUR_DATE) IN (?, ?)
           AND MONTH(C.EHI_MIN_FIRST_TOUR_DATE) IN (${monthPlaceholders})
           AND C.EHI_COHORT_QUARTER IS NOT NULL`,
        gridBinds,
      ),
    ]);
  const company = companyRows[0]?.COMPANY_NAME;
  const channel = channelRows[0]?.CH;
  // Busiest lead source that has leads AND tours AND ratified deals in the
  // grid; busiest cohort (by grid leads) that also has tours there. A value
  // missing any bound series would leave that series comparing 0 vs 0 —
  // fake coverage — so no qualifying value fails the audit loudly instead.
  const tourSources = new Set(tourSourceRows.map((r) => r.LS));
  const dealSources = new Set(dealSourceRows.map((r) => r.LS));
  const leadSource = leadSourceRows.find(
    (r) => tourSources.has(r.LS) && dealSources.has(r.LS),
  )?.LS;
  const cohortsWithTours = new Set(cohortTourRows.map((r) => r.CQ));
  const cohortQuarter = cohortLeadRows.find((r) => cohortsWithTours.has(r.CQ))?.CQ;
  const missing = [
    !company && "company",
    !channel && "channel",
    !leadSource && "lead source with leads, tours, and ratified deals",
    !cohortQuarter && "cohort quarter with leads and tours",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `No representative ${missing.join("; ")} found for ${year - 1}/${year} ` +
        `(months [${months.join(", ")}]) — cannot exercise the required filtered ` +
        "scenarios with real data on every series the filter binds " +
        "(empty source data or broken dimension)",
    );
  }
  return {
    company: company!,
    channel: channel!,
    leadSource: leadSource!,
    cohortQuarter: cohortQuarter!,
  };
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

  const { company, channel, leadSource, cohortQuarter } =
    await pickRepresentativeFilters(year, months);

  const scenarios: Scenario[] = [
    { name: "default view", filters: {} },
    { name: `company filter (${company})`, filters: { company } },
    { name: `channel filter (${channel})`, filters: { channel } },
    // leadSource must hit DM_CONTACTS.LEAD_SOURCE_OVERVIEW AND
    // DM_DEALS.DEAL_LEAD_SOURCE_OVERVIEW; cohortQuarter must hit contacts
    // ONLY (sales and GA stay unfiltered). The picks guarantee non-zero
    // cells inside the checked grid for every series each filter binds,
    // so mustHaveData holds ALL of those series to it.
    {
      name: `lead-source filter (${leadSource})`,
      filters: { leadSource },
      mustHaveData: ["leads", "tours", "grossSales"],
    },
    {
      name: `cohort-quarter filter (${cohortQuarter})`,
      filters: { cohortQuarter },
      mustHaveData: ["leads", "tours"],
    },
  ];
  console.log(`Scenarios: ${scenarios.map((s) => s.name).join("; ")}`);

  // Independent no-history cutoff (earliest GA traffic date), fetched once
  // and asserted against every scenario's gaHistoryStart and null pattern.
  const gaHistoryStart = await fetchGaHistoryStartBaseline();
  console.log(
    `GA history baseline: earliest traffic date = ${gaHistoryStart ?? "none (GA table empty)"}`,
  );

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
    const ok = await auditScenario(scenario, months, gaHistoryStart);
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
