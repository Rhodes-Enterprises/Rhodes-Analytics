/**
 * Dashboard number regression audit.
 *
 * Compares the API's GET /api/dashboards/overview-with-targets response
 * against independent Snowflake baseline queries with identical filters.
 * The baselines deliberately avoid the DM_COMPANY_DEVELOPMENT attribution
 * join used by the API's data layer — a fan-out in that join once inflated
 * actuals ~1.5x, which is exactly the regression class this audit exists to
 * catch. Where a company filter needs the dimension, the baseline uses a
 * semi-join (IN subquery) that cannot fan out by construction.
 *
 * Besides the default (no query params) view, the audit exercises
 * representative FILTERED requests — a company, a development, a channel,
 * and an explicit date range — because filter-only regressions (a filter
 * bound to the wrong column, a fan-out that triggers only for specific
 * developments) would otherwise slip through. Filter values are picked
 * dynamically from Snowflake (busiest in the current default range) so they
 * don't go stale; failure to find a non-empty value FAILS the audit rather
 * than silently skipping the scenario.
 *
 * Every scenario independently computes the range it expects the API to
 * apply (requested dates, or the server's default quarter) and asserts the
 * response's appliedRange matches it exactly — so an endpoint that ignores
 * date parameters fails the audit instead of being compared against its own
 * wrong range. Baselines are bound to that expected range, never to the
 * response's echo of it.
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

interface DivisionRow {
  division: string;
  leads: number;
  tours: number;
  sales: number;
}

interface DevelopmentRow {
  development: string;
  division: string;
  leads: number;
  tours: number;
  sales: number;
}

interface OverviewResponse {
  appliedRange: { startDate: string; endDate: string; toDate: string; target: string };
  kpis: { grossSales: number };
  trafficMatrix: {
    online: { websiteUsers: { actual: number } };
    total: { leads: { actual: number }; tours: { actual: number } };
  };
  divisions: DivisionRow[];
  developments: DevelopmentRow[];
}

async function fetchOverview(params: Record<string, string>): Promise<OverviewResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}/dashboards/overview-with-targets${qs ? `?${qs}` : ""}`;
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

// ---------- Expected range computation (independent of the API) ----------

/** Same business-day convention the API uses. */
function todayChicago(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date(),
  );
}

/** Default range the API applies with no date params: the current quarter. */
function defaultQuarterRange(): { startDate: string; endDate: string } {
  const today = todayChicago();
  const t = new Date(today + "T00:00:00");
  const q = Math.floor(t.getMonth() / 3);
  const startDate = `${t.getFullYear()}-${String(q * 3 + 1).padStart(2, "0")}-01`;
  const qEnd = new Date(t.getFullYear(), q * 3 + 3, 0);
  const endDate = `${qEnd.getFullYear()}-${String(qEnd.getMonth() + 1).padStart(2, "0")}-${String(qEnd.getDate()).padStart(2, "0")}`;
  return { startDate, endDate };
}

/** Elapsed cutoff: today clamped into [startDate, endDate]. */
function expectedToDate(startDate: string, endDate: string): string {
  const today = todayChicago();
  return today < startDate ? startDate : today > endDate ? endDate : today;
}

// ---------- Baseline filter fragments ----------

// Deduplicated Esperanza company→development mapping, mirroring the API's
// DEV_DIM. Used ONLY inside IN (...) semi-joins so it cannot fan out rows.
const DEV_DIM = `(
  SELECT COMPANY_NAME, DEVELOPMENT_NAME
  FROM DM_COMPANY_DEVELOPMENT
  WHERE COMPANY_NAME ILIKE '%esperanza%'
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY DEVELOPMENT_NAME
    ORDER BY DEVELOPMENT_HAS_GOALS_FLAG DESC NULLS LAST, COMPANY_NAME
  ) = 1
)`;

/**
 * Filters a scenario applies, expressed once and translated into both the
 * API query string and equivalent baseline WHERE fragments per source.
 */
interface ScenarioFilters {
  company?: string;
  development?: string;
  /** Applied as contactChannel AND dealChannel, like the dashboard UI does */
  channel?: string;
  startDate?: string;
  endDate?: string;
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
  if (f.development) {
    parts.push("C.CONTACT_EHI_COMMUNITY_OF_INTEREST = ?");
    binds.push(f.development);
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
  if (f.development) {
    parts.push("X.DEAL_EHI_COMMUNITY_OF_INTEREST = ?");
    binds.push(f.development);
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
  if (f.development) {
    parts.push("MATCHED_DEVELOPMENT_NAME = ?");
    binds.push(f.development);
  }
  // GA has no channel dimension in the dashboard; channel does not apply.
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

function toQueryParams(f: ScenarioFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.company) params.company = f.company;
  if (f.development) params.development = f.development;
  if (f.channel) {
    params.contactChannel = f.channel;
    params.dealChannel = f.channel;
  }
  if (f.startDate) params.startDate = f.startDate;
  if (f.endDate) params.endDate = f.endDate;
  return params;
}

// ---------- Scenario execution ----------

async function auditScenario(scenario: Scenario): Promise<boolean> {
  const f = scenario.filters;
  console.log(`\n=== Scenario: ${scenario.name} ===`);
  const params = toQueryParams(f);
  console.log(
    `Params: ${Object.keys(params).length ? JSON.stringify(params) : "(none — default view)"}`,
  );

  // Compute the range the API MUST apply — requested dates, or the default
  // quarter — before looking at the response, then assert the response
  // honored it. This catches an endpoint that silently ignores date params.
  const defaults = defaultQuarterRange();
  const expStart = f.startDate ?? defaults.startDate;
  const expEnd = f.endDate ?? defaults.endDate;
  const expTo = expectedToDate(expStart, expEnd);

  const overview = await fetchOverview(params);
  const ar = overview.appliedRange;
  console.log(
    `Applied range: ${ar.startDate}..${ar.endDate}, toDate=${ar.toDate}, target=${ar.target}`,
  );

  if (ar.startDate !== expStart || ar.endDate !== expEnd || ar.toDate !== expTo) {
    console.error(
      `FAIL appliedRange mismatch: expected ${expStart}..${expEnd} (toDate=${expTo}), ` +
        `got ${ar.startDate}..${ar.endDate} (toDate=${ar.toDate}) — the API did not honor the requested/default dates`,
    );
    return false;
  }

  const cf = contactFrag(f);
  const df = dealFrag(f);
  const gf = gaFrag(f);

  // Independent baselines — bound to the EXPECTED dates (start..elapsed
  // cutoff), same window the API applies to actuals, no attribution join
  // that could fan out counts.
  const [leads, tours, sales, users] = await Promise.all([
    countScalar(
      `SELECT COUNT(*) AS N FROM DM_CONTACTS C
       WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?${cf.sql}`,
      [expStart, expTo, ...cf.binds],
    ),
    countScalar(
      `SELECT COUNT(*) AS N FROM DM_CONTACTS C
       WHERE C.EHI_LEAD = 1 AND C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?${cf.sql}`,
      [expStart, expTo, ...cf.binds],
    ),
    countScalar(
      `SELECT COUNT(*) AS N FROM DM_DEALS X
       WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
         AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?${df.sql}`,
      [expStart, expTo, ...df.binds],
    ),
    countScalar(
      `SELECT COUNT(DISTINCT USER_PSEUDO_ID) AS N FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE PROPERTY = 'Esperanza Homes' AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?${gf.sql}`,
      [expStart, expTo, ...gf.binds],
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
  return !failed;
}

// ---------- Breakdown table audit (divisions / developments) ----------

interface BreakdownBaselineRow {
  COMPANY_NAME: string;
  DEVELOPMENT_NAME?: string;
  N: number;
}

function divergedPct(api: number, baseline: number): number {
  return baseline === 0
    ? api === 0
      ? 0
      : Infinity
    : (Math.abs(api - baseline) / baseline) * 100;
}

/**
 * Audits the divisions and developments breakdown tables of the DEFAULT view
 * against independent Snowflake baselines grouped the same way the API groups
 * them (via the deduplicated Esperanza dimension, which cannot fan out).
 *
 * Checks, per metric (leads / tours / sales):
 *  1. Every API division row matches a per-company baseline, and every
 *     non-zero baseline company appears in the API rows (mis-attribution or
 *     dropped-company detection).
 *  2. The same for a sample of development rows: every non-zero baseline
 *     (company, development) pair must be present and match.
 *  3. Cross-check: breakdown rows + unattributed remainder must sum to the
 *     headline total (rows not mapped by the dimension have no division row,
 *     so the audit accounts for them explicitly instead of fudging tolerance).
 */
async function auditBreakdowns(
  overview: OverviewResponse,
  expStart: string,
  expTo: string,
): Promise<boolean> {
  console.log(`\n=== Breakdown tables (default view) ===`);

  const metrics = [
    {
      name: "leads",
      headline: overview.trafficMatrix.total.leads.actual,
      byCompanySql: `
        SELECT D.COMPANY_NAME, COUNT(*) AS N
        FROM DM_CONTACTS C
        JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
        GROUP BY 1`,
      byDevSql: `
        SELECT D.COMPANY_NAME, D.DEVELOPMENT_NAME, COUNT(*) AS N
        FROM DM_CONTACTS C
        JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
        GROUP BY 1, 2`,
      unattributedSql: `
        SELECT COUNT(*) AS N
        FROM DM_CONTACTS C
        WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
          AND (C.CONTACT_EHI_COMMUNITY_OF_INTEREST IS NULL
               OR C.CONTACT_EHI_COMMUNITY_OF_INTEREST NOT IN
                  (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM}))`,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.leads) || 0,
    },
    {
      name: "tours",
      headline: overview.trafficMatrix.total.tours.actual,
      byCompanySql: `
        SELECT D.COMPANY_NAME, COUNT(*) AS N
        FROM DM_CONTACTS C
        JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE C.EHI_LEAD = 1 AND C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?
        GROUP BY 1`,
      byDevSql: `
        SELECT D.COMPANY_NAME, D.DEVELOPMENT_NAME, COUNT(*) AS N
        FROM DM_CONTACTS C
        JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE C.EHI_LEAD = 1 AND C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?
        GROUP BY 1, 2`,
      unattributedSql: `
        SELECT COUNT(*) AS N
        FROM DM_CONTACTS C
        WHERE C.EHI_LEAD = 1 AND C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?
          AND (C.CONTACT_EHI_COMMUNITY_OF_INTEREST IS NULL
               OR C.CONTACT_EHI_COMMUNITY_OF_INTEREST NOT IN
                  (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM}))`,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.tours) || 0,
    },
    {
      name: "sales",
      headline: overview.kpis.grossSales,
      byCompanySql: `
        SELECT D.COMPANY_NAME, COUNT(*) AS N
        FROM DM_DEALS X
        JOIN ${DEV_DIM} D ON X.DEAL_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
          AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
        GROUP BY 1`,
      byDevSql: `
        SELECT D.COMPANY_NAME, D.DEVELOPMENT_NAME, COUNT(*) AS N
        FROM DM_DEALS X
        JOIN ${DEV_DIM} D ON X.DEAL_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
          AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
        GROUP BY 1, 2`,
      unattributedSql: `
        SELECT COUNT(*) AS N
        FROM DM_DEALS X
        WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
          AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
          AND (X.DEAL_EHI_COMMUNITY_OF_INTEREST IS NULL
               OR X.DEAL_EHI_COMMUNITY_OF_INTEREST NOT IN
                  (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM}))`,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.sales) || 0,
    },
  ];

  let failed = false;
  const binds = [expStart, expTo];

  for (const m of metrics) {
    const [byCompany, byDev, unattributed] = await Promise.all([
      querySnowflake<BreakdownBaselineRow>(m.byCompanySql, binds),
      querySnowflake<BreakdownBaselineRow>(m.byDevSql, binds),
      countScalar(m.unattributedSql, binds),
    ]);

    // --- 1. Division rows vs per-company baseline (both directions) ---
    const baseByCompany = new Map(byCompany.map((r) => [r.COMPANY_NAME, Number(r.N) || 0]));
    const apiByCompany = new Map(overview.divisions.map((r) => [r.division, m.pick(r)]));
    const companyNames = new Set([...baseByCompany.keys(), ...apiByCompany.keys()]);
    for (const company of [...companyNames].sort()) {
      const api = apiByCompany.get(company) ?? 0;
      const baseline = baseByCompany.get(company) ?? 0;
      if (api === 0 && baseline === 0) continue;
      const d = divergedPct(api, baseline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} division ${m.name.padEnd(6)} ${company.padEnd(30)} api=${api} baseline=${baseline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }

    // --- 2. Development rows vs per-(company, development) baseline ---
    const devKey = (c: string, dv: string) => `${c}\u0000${dv}`;
    const baseByDev = new Map(
      byDev.map((r) => [devKey(r.COMPANY_NAME, r.DEVELOPMENT_NAME!), Number(r.N) || 0]),
    );
    const apiByDev = new Map(
      overview.developments.map((r) => [devKey(r.division, r.development), m.pick(r)]),
    );
    const devKeys = new Set([...baseByDev.keys(), ...apiByDev.keys()]);
    for (const key of [...devKeys].sort()) {
      const api = apiByDev.get(key) ?? 0;
      const baseline = baseByDev.get(key) ?? 0;
      if (api === 0 && baseline === 0) continue;
      const [company, development] = key.split("\u0000");
      const d = divergedPct(api, baseline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} devrow   ${m.name.padEnd(6)} ${`${development} (${company})`.padEnd(45)} api=${api} baseline=${baseline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }

    // --- 3. Cross-check: breakdown sums + unattributed == headline total ---
    const divSum = sumRows(overview.divisions, m.pick);
    const devSum = sumRows(overview.developments, m.pick);
    for (const [label, sum] of [
      ["divisions", divSum],
      ["developments", devSum],
    ] as const) {
      const reconstructed = sum + unattributed;
      const d = divergedPct(reconstructed, m.headline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} sum      ${m.name.padEnd(6)} ${label.padEnd(30)} rows=${sum} +unattributed=${unattributed} => ${reconstructed} headline=${m.headline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }
  }

  return !failed;
}

function sumRows<T>(rows: T[], pick: (r: T) => number): number {
  let total = 0;
  for (const r of rows) total += pick(r);
  return total;
}

// ---------- Representative filter selection ----------

/**
 * Pick representative filter values dynamically: the Esperanza company,
 * development, and channel with the most leads in the given range, so the
 * filtered scenarios always exercise non-trivial data. Missing values make
 * the audit FAIL — a silently skipped scenario is not coverage.
 */
async function pickRepresentativeFilters(
  startDate: string,
  toDate: string,
): Promise<{ company: string; development: string; channel: string }> {
  const [companyRows, devRows, channelRows] = await Promise.all([
    querySnowflake<{ COMPANY_NAME: string }>(
      `SELECT D.COMPANY_NAME, COUNT(*) AS N
       FROM DM_CONTACTS C
       JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
       WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [startDate, toDate],
    ),
    querySnowflake<{ DEVELOPMENT_NAME: string }>(
      `SELECT D.DEVELOPMENT_NAME, COUNT(*) AS N
       FROM DM_CONTACTS C
       JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
       WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [startDate, toDate],
    ),
    querySnowflake<{ CH: string }>(
      `SELECT C.ONSITE_ONLINE_SOURCE_CHANNEL AS CH, COUNT(*) AS N
       FROM DM_CONTACTS C
       WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
         AND C.ONSITE_ONLINE_SOURCE_CHANNEL IS NOT NULL
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [startDate, toDate],
    ),
  ]);
  const company = companyRows[0]?.COMPANY_NAME;
  const development = devRows[0]?.DEVELOPMENT_NAME;
  const channel = channelRows[0]?.CH;
  const missing = [
    !company && "company",
    !development && "development",
    !channel && "channel",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `No representative ${missing.join(", ")} found in ${startDate}..${toDate} — ` +
        "cannot exercise the required filtered scenarios (empty source data or broken dimension)",
    );
  }
  return { company: company!, development: development!, channel: channel! };
}

/**
 * Explicit date-range scenario: January of the current default year when it
 * has fully elapsed (stable results), otherwise a deterministic single-day
 * range on the default quarter's start date. Both differ from the default
 * quarter bounds, so an endpoint that ignores date params fails the
 * appliedRange assertion. Never skipped.
 */
function explicitRangeScenario(defaultStart: string): Scenario {
  const year = defaultStart.slice(0, 4);
  const jan31 = `${year}-01-31`;
  if (todayChicago() > jan31) {
    return {
      name: "explicit date range (January)",
      filters: { startDate: `${year}-01-01`, endDate: jan31 },
    };
  }
  return {
    name: `explicit date range (single day ${defaultStart})`,
    filters: { startDate: defaultStart, endDate: defaultStart },
  };
}

async function main() {
  console.log(
    `Auditing ${API_BASE}/dashboards/overview-with-targets (tolerance ${TOLERANCE_PCT}%)`,
  );

  const { startDate, endDate } = defaultQuarterRange();
  const toDate = expectedToDate(startDate, endDate);
  console.log(`Default range: ${startDate}..${endDate}, toDate=${toDate}`);

  const { company, development, channel } = await pickRepresentativeFilters(
    startDate,
    toDate,
  );

  const scenarios: Scenario[] = [
    { name: "default view", filters: {} },
    { name: `company filter (${company})`, filters: { company } },
    { name: `development filter (${development})`, filters: { development } },
    { name: `channel filter (${channel})`, filters: { channel } },
    explicitRangeScenario(startDate),
  ];
  console.log(`Scenarios: ${scenarios.map((s) => s.name).join("; ")}`);

  let anyFailed = false;
  for (const scenario of scenarios) {
    const ok = await auditScenario(scenario);
    if (!ok) anyFailed = true;
  }

  // Breakdown tables (divisions / developments) — audited on the default
  // view, where every division and development is present.
  const defaultOverview = await fetchOverview({});
  const breakdownsOk = await auditBreakdowns(defaultOverview, startDate, toDate);
  if (!breakdownsOk) anyFailed = true;

  if (anyFailed) {
    console.error(
      "\nAUDIT FAILED: dashboard totals diverge from independent Snowflake baselines " +
        "in at least one scenario. Likely causes: join fan-out in the attribution " +
        "dimension, a filter bound to the wrong column, ignored date parameters, " +
        "changed filters, or stale cached data.",
    );
    process.exit(1);
  }
  console.log("\nAudit passed: all totals within tolerance across all scenarios.");
  process.exit(0);
}

main().catch((err) => {
  console.error("AUDIT ERRORED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
