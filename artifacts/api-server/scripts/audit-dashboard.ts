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
 * The divisions/developments breakdown tables are audited (auditBreakdowns)
 * in the default view AND under the company filter and the explicit date
 * range, with baselines bound to the same filters — so a filter-specific
 * attribution bug (e.g. a company filter that leaks other divisions' rows
 * into the breakdown) fails the audit instead of slipping through.
 *
 * Every scenario independently computes the range it expects the API to
 * apply (requested dates, or the server's default quarter) and asserts the
 * response's appliedRange matches it exactly — so an endpoint that ignores
 * date parameters fails the audit instead of being compared against its own
 * wrong range. Baselines are bound to that expected range, never to the
 * response's echo of it.
 *
 * Headline totals are checked in every scenario: leads, tours, gross sales,
 * total website users, and NEW website users (trafficMatrix.newWebsiteUsers).
 * The two user counts come from the API's overall () grouping-set row —
 * picked via G_COMPANY=1 — which can regress independently of the per-row
 * values, so both get their own scalar GA baselines.
 *
 * The six channel-split cells (trafficMatrix.online/onsite × leads, tours,
 * sales) are audited in every scenario too, each against a baseline that
 * re-counts the same source rows restricted to the channel column the
 * dashboard keys on (ONSITE_ONLINE_SOURCE_CHANNEL for contacts,
 * DEAL_ONSITE_ONLINE_SOURCE_CHANNEL for deals) with the literal 'Online' /
 * 'Onsite' labels. A regression that keys the split off the wrong column or
 * swaps the labels leaves every audited total unchanged, so only these
 * per-cell checks can catch it. Rows with NULL channel legitimately make
 * online + onsite < total, so there is deliberately NO sum-to-total
 * assumption — per-cell baselines only.
 *
 * The breakdown tables (divisions / developments) are audited per row: leads,
 * tours, and sales against CRM-side baselines, and the website-user columns
 * against GA-side baselines recomputed with plain GROUP BYs over
 * MATCHED_COMPANY_NAME / MATCHED_DEVELOPMENT_NAME — catching regressions in
 * the API's single GROUPING SETS query that the headline checks would miss.
 * Distinct-user counts are not additive across rows, so website users get
 * per-row comparisons only, never a sum-to-headline cross-check.
 *
 * The funnel ratios table is audited on the default view: every ratio's
 * actual is recomputed from independent baseline counts (the same no-fan-out
 * query shapes as the headline checks, split by channel where a ratio calls
 * for it), and every ratio's goal is looked up directly in
 * DM_MARKETING_DASHBOARD_INPUT_GOAL_RATIOS by MARKETING_GOAL_NAME_RATIOS.
 * A swapped numerator/denominator, a ratio wired to the wrong actual, a
 * goal name that no longer resolves in the input table, or an input-table
 * goal row the dashboard silently drops all fail the audit.
 *
 * The Community List (GET /api/dashboards/communities) is audited against the
 * raw DM_COMPANY_DEVELOPMENT rows plus plain YTD GROUP BYs: total/selling/
 * hasGoals/isRental counts, per-community flag comparison (the intended
 * per-development semantics are recomputed in JS, not by reusing the API's
 * QUALIFY dedup), the isSelling invariant over the API's own YTD numbers, and
 * a label-domain guard on the flag columns — 'Has Goals'/'Rental' are text
 * labels, not booleans, so a silent upstream relabel would zero every badge
 * on both sides and still "match" without that guard.
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
import { DEV_DIM } from "../src/lib/dev-dim";

// Default to the API server's own local port (same PORT contract the server
// uses; the artifact's configured port is 8080). Override with AUDIT_API_BASE.
const API_BASE =
  process.env.AUDIT_API_BASE ?? `http://localhost:${process.env.PORT ?? "8080"}/api`;
const TOLERANCE_PCT = Number(process.env.AUDIT_TOLERANCE_PCT ?? "0.5");

interface DivisionRow {
  division: string;
  totalWebsiteUsers: number;
  newWebsiteUsers: number;
  leads: number;
  tours: number;
  sales: number;
}

interface DevelopmentRow {
  development: string;
  division: string;
  totalWebsiteUsers: number;
  newWebsiteUsers: number;
  leads: number;
  tours: number;
  sales: number;
}

interface RatioRow {
  name: string;
  group: string;
  goal: number | null;
  actual: number;
  ptgPercent: number | null;
}
interface OverviewResponse {
  appliedRange: { startDate: string; endDate: string; toDate: string; target: string };
  kpis: { grossSales: number };
  trafficMatrix: {
    online: {
      websiteUsers: { actual: number };
      leads: { actual: number };
      tours: { actual: number };
      sales: { actual: number };
    };
    onsite: {
      leads: { actual: number };
      tours: { actual: number };
      sales: { actual: number };
    };
    total: { leads: { actual: number }; tours: { actual: number } };
    /** Headline NEW-users count from the overall () grouping-set row */
    newWebsiteUsers: number;
  };
  divisions: DivisionRow[];
  developments: DevelopmentRow[];
  ratios: RatioRow[];
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
  /**
   * Also audit the divisions/developments breakdown tables under this
   * scenario's filters (baselines bound to the same filters).
   */
  withBreakdowns?: boolean;
  /**
   * Also audit the website-user columns of the breakdown tables (GA-side
   * baselines). Default view only: those baselines bind no filters.
   */
  withGaBreakdowns?: boolean;
  /**
   * Also audit the funnel ratios table (actuals recomputed from baseline
   * counts, goals against the ratio-goal input table). Default view only:
   * those baselines bind no filters.
   */
  withRatios?: boolean;
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

interface ScenarioResult {
  ok: boolean;
  /** false when the API did not honor the requested/default dates */
  rangeOk: boolean;
  overview: OverviewResponse;
  expStart: string;
  expTo: string;
}
async function auditScenario(scenario: Scenario): Promise<ScenarioResult> {
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
    return { ok: false, rangeOk: false, overview, expStart, expTo };
  }

  const cf = contactFrag(f);
  const df = dealFrag(f);
  const gf = gaFrag(f);

  // Independent baselines — bound to the EXPECTED dates (start..elapsed
  // cutoff), same window the API applies to actuals, no attribution join
  // that could fan out counts.
  //
  // The channel variants re-count the same rows restricted to the hardcoded
  // 'Online' / 'Onsite' labels on the channel column the dashboard keys on.
  // Composing with a scenario channel filter (already in cf/df) is correct by
  // construction: a matching label is redundant, a contradicting one yields 0
  // — exactly what the API's cell must show under that filter.
  const countContacts = (
    dateCol: "CONTACT_CREATE_DATE" | "EHI_MIN_FIRST_TOUR_DATE",
    channel?: "Online" | "Onsite",
  ) =>
    countScalar(
      `SELECT COUNT(*) AS N FROM DM_CONTACTS C
       WHERE C.EHI_LEAD = 1 AND C.${dateCol} BETWEEN ? AND ?${cf.sql}${
         channel ? " AND C.ONSITE_ONLINE_SOURCE_CHANNEL = ?" : ""
       }`,
      [expStart, expTo, ...cf.binds, ...(channel ? [channel] : [])],
    );
  const countDeals = (channel?: "Online" | "Onsite") =>
    countScalar(
      `SELECT COUNT(*) AS N FROM DM_DEALS X
       WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
         AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?${df.sql}${
           channel ? " AND X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?" : ""
         }`,
      [expStart, expTo, ...df.binds, ...(channel ? [channel] : [])],
    );

  const [
    leads,
    tours,
    sales,
    users,
    newUsers,
    onlineLeads,
    onsiteLeads,
    onlineTours,
    onsiteTours,
    onlineSales,
    onsiteSales,
  ] = await Promise.all([
    countContacts("CONTACT_CREATE_DATE"),
    countContacts("EHI_MIN_FIRST_TOUR_DATE"),
    countDeals(),
    countScalar(
      `SELECT COUNT(DISTINCT USER_PSEUDO_ID) AS N FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE PROPERTY = 'Esperanza Homes' AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?${gf.sql}`,
      [expStart, expTo, ...gf.binds],
    ),
    // NEW-users headline: same GA source and filters, restricted to first-time
    // users. The API takes this from the overall () grouping-set row (picked
    // via G_COMPANY=1), which can regress independently of the per-row values.
    countScalar(
      `SELECT COUNT(DISTINCT IFF(IS_NEW_USER = 'Yes', USER_PSEUDO_ID, NULL)) AS N
       FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE PROPERTY = 'Esperanza Homes' AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?${gf.sql}`,
      [expStart, expTo, ...gf.binds],
    ),
    countContacts("CONTACT_CREATE_DATE", "Online"),
    countContacts("CONTACT_CREATE_DATE", "Onsite"),
    countContacts("EHI_MIN_FIRST_TOUR_DATE", "Online"),
    countContacts("EHI_MIN_FIRST_TOUR_DATE", "Onsite"),
    countDeals("Online"),
    countDeals("Onsite"),
  ]);

  const tm = overview.trafficMatrix;
  const checks: { name: string; api: number; baseline: number }[] = [
    { name: "leads", api: tm.total.leads.actual, baseline: leads },
    { name: "tours", api: tm.total.tours.actual, baseline: tours },
    { name: "sales", api: overview.kpis.grossSales, baseline: sales },
    { name: "users", api: tm.online.websiteUsers.actual, baseline: users },
    { name: "newUsers", api: tm.newWebsiteUsers, baseline: newUsers },
    // Channel-split cells: a mis-keyed channel column or swapped Online/
    // Onsite labels leaves every total above unchanged — only these
    // per-cell comparisons catch that regression class.
    { name: "onlineLeads", api: tm.online.leads.actual, baseline: onlineLeads },
    { name: "onsiteLeads", api: tm.onsite.leads.actual, baseline: onsiteLeads },
    { name: "onlineTours", api: tm.online.tours.actual, baseline: onlineTours },
    { name: "onsiteTours", api: tm.onsite.tours.actual, baseline: onsiteTours },
    { name: "onlineSales", api: tm.online.sales.actual, baseline: onlineSales },
    { name: "onsiteSales", api: tm.onsite.sales.actual, baseline: onsiteSales },
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
      `${status} ${c.name.padEnd(12)} api=${c.api} baseline=${c.baseline} divergence=${divergencePct.toFixed(3)}%`,
    );
    if (!ok) failed = true;
  }
  return { ok: !failed, rangeOk: true, overview, expStart, expTo };
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
 * Audits the divisions and developments breakdown tables of one scenario's
 * response against independent Snowflake baselines grouped the same way the
 * API groups them (via the deduplicated Esperanza dimension, which cannot
 * fan out). The scenario's filters are bound into every baseline query, so
 * the audit also covers filtered views.
 *
 * Checks, per metric (leads / tours / sales):
 *  1. Every API division row matches a per-company baseline, and every
 *     non-zero baseline company appears in the API rows. Under a company
 *     filter this doubles as leak detection: another division's non-zero
 *     row fails against its zero baseline.
 *  2. The same for development rows: every non-zero baseline
 *     (company, development) pair must be present and match.
 *  3. Cross-check: breakdown rows + unattributed remainder must sum to the
 *     headline total (rows not mapped by the dimension have no division row,
 *     so the audit accounts for them explicitly instead of fudging
 *     tolerance). Under a company filter the remainder is structurally zero
 *     — the filter itself excludes unattributable rows — and the query
 *     verifies that rather than assuming it.
 */
async function auditBreakdowns(
  scenario: Scenario,
  overview: OverviewResponse,
  expStart: string,
  expTo: string,
): Promise<boolean> {
  console.log(`\n=== Breakdown tables (${scenario.name}) ===`);

  // Same filter fragments the headline baselines use (alias C for contacts,
  // X for deals); appended inside each WHERE below, before GROUP BY.
  const cf = contactFrag(scenario.filters);
  const df = dealFrag(scenario.filters);

  const metrics = [
    {
      name: "leads",
      headline: overview.trafficMatrix.total.leads.actual,
      binds: [expStart, expTo, ...cf.binds] as (string | number)[],
      byCompanySql: `
        SELECT D.COMPANY_NAME, COUNT(*) AS N
        FROM DM_CONTACTS C
        JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?${cf.sql}
        GROUP BY 1`,
      byDevSql: `
        SELECT D.COMPANY_NAME, D.DEVELOPMENT_NAME, COUNT(*) AS N
        FROM DM_CONTACTS C
        JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?${cf.sql}
        GROUP BY 1, 2`,
      unattributedSql: `
        SELECT COUNT(*) AS N
        FROM DM_CONTACTS C
        WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
          AND (C.CONTACT_EHI_COMMUNITY_OF_INTEREST IS NULL
               OR C.CONTACT_EHI_COMMUNITY_OF_INTEREST NOT IN
                  (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM}))${cf.sql}`,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.leads) || 0,
    },
    {
      name: "tours",
      headline: overview.trafficMatrix.total.tours.actual,
      binds: [expStart, expTo, ...cf.binds] as (string | number)[],
      byCompanySql: `
        SELECT D.COMPANY_NAME, COUNT(*) AS N
        FROM DM_CONTACTS C
        JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE C.EHI_LEAD = 1 AND C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?${cf.sql}
        GROUP BY 1`,
      byDevSql: `
        SELECT D.COMPANY_NAME, D.DEVELOPMENT_NAME, COUNT(*) AS N
        FROM DM_CONTACTS C
        JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE C.EHI_LEAD = 1 AND C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?${cf.sql}
        GROUP BY 1, 2`,
      unattributedSql: `
        SELECT COUNT(*) AS N
        FROM DM_CONTACTS C
        WHERE C.EHI_LEAD = 1 AND C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?
          AND (C.CONTACT_EHI_COMMUNITY_OF_INTEREST IS NULL
               OR C.CONTACT_EHI_COMMUNITY_OF_INTEREST NOT IN
                  (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM}))${cf.sql}`,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.tours) || 0,
    },
    {
      name: "sales",
      headline: overview.kpis.grossSales,
      binds: [expStart, expTo, ...df.binds] as (string | number)[],
      byCompanySql: `
        SELECT D.COMPANY_NAME, COUNT(*) AS N
        FROM DM_DEALS X
        JOIN ${DEV_DIM} D ON X.DEAL_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
          AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?${df.sql}
        GROUP BY 1`,
      byDevSql: `
        SELECT D.COMPANY_NAME, D.DEVELOPMENT_NAME, COUNT(*) AS N
        FROM DM_DEALS X
        JOIN ${DEV_DIM} D ON X.DEAL_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
        WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
          AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?${df.sql}
        GROUP BY 1, 2`,
      unattributedSql: `
        SELECT COUNT(*) AS N
        FROM DM_DEALS X
        WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
          AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
          AND (X.DEAL_EHI_COMMUNITY_OF_INTEREST IS NULL
               OR X.DEAL_EHI_COMMUNITY_OF_INTEREST NOT IN
                  (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM}))${df.sql}`,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.sales) || 0,
    },
  ];

  let failed = false;

  for (const m of metrics) {
    const [byCompany, byDev, unattributed] = await Promise.all([
      querySnowflake<BreakdownBaselineRow>(m.byCompanySql, m.binds),
      querySnowflake<BreakdownBaselineRow>(m.byDevSql, m.binds),
      countScalar(m.unattributedSql, m.binds),
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

// ---------- Website-user breakdown audit (GA source) ----------

interface GaBaselineRow {
  COMPANY_NAME: string | null;
  DEVELOPMENT_NAME?: string | null;
  TOTAL_USERS: number;
  NEW_USERS: number;
}

/**
 * Mirrors the API's brand test for seeding breakdown rows from GA data
 * (COMPANY_NAME.includes("Esperanza")). GA groups outside the brand are
 * excluded from the dashboard by design, so a baseline-only group failing
 * this test is not a missing row.
 */
function isEsperanzaCompany(name: string): boolean {
  return name.includes("Esperanza");
}

/**
 * Audits the website-user columns (totalWebsiteUsers / newWebsiteUsers) of
 * the divisions and developments tables in the DEFAULT view. These columns
 * come from a different source than leads/tours/sales — one GROUPING SETS
 * query over FCT_GOOGLE_ANALYTICS_EVENT_LEVEL — so a GA-side grouping
 * regression (wrong grouping level picked, aggregation keyed to the wrong
 * column, dropped groups) would slip past the CRM-side checks. Baselines
 * recompute each level independently with a plain GROUP BY over
 * MATCHED_COMPANY_NAME / MATCHED_DEVELOPMENT_NAME and compare per row in
 * both directions: every API row must match its baseline, and every
 * non-zero Esperanza-brand baseline group must appear in the API rows.
 *
 * Deliberately NO sum-to-headline cross-check here: COUNT(DISTINCT
 * USER_PSEUDO_ID) is not additive across companies or developments (the
 * same user can visit several), so row sums legitimately differ from the
 * headline and only per-row comparisons are meaningful.
 */
async function auditWebsiteUserBreakdowns(
  overview: OverviewResponse,
  expStart: string,
  expTo: string,
): Promise<boolean> {
  console.log(`\n=== Breakdown tables: website users (default view) ===`);
  console.log(
    "note: distinct-user counts are not additive across rows — per-row checks only, no sum check",
  );

  const binds = [expStart, expTo];
  const [byCompany, byDev] = await Promise.all([
    querySnowflake<GaBaselineRow>(
      `SELECT MATCHED_COMPANY_NAME AS COMPANY_NAME,
              COUNT(DISTINCT USER_PSEUDO_ID) AS TOTAL_USERS,
              COUNT(DISTINCT IFF(IS_NEW_USER = 'Yes', USER_PSEUDO_ID, NULL)) AS NEW_USERS
       FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE PROPERTY = 'Esperanza Homes' AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?
       GROUP BY 1`,
      binds,
    ),
    querySnowflake<GaBaselineRow>(
      `SELECT MATCHED_COMPANY_NAME AS COMPANY_NAME,
              MATCHED_DEVELOPMENT_NAME AS DEVELOPMENT_NAME,
              COUNT(DISTINCT USER_PSEUDO_ID) AS TOTAL_USERS,
              COUNT(DISTINCT IFF(IS_NEW_USER = 'Yes', USER_PSEUDO_ID, NULL)) AS NEW_USERS
       FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE PROPERTY = 'Esperanza Homes' AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?
       GROUP BY 1, 2`,
      binds,
    ),
  ]);

  const devKey = (c: string, dv: string) => `${c}\u0000${dv}`;

  const measures = [
    {
      name: "totalUsers",
      fromBaseline: (r: GaBaselineRow) => Number(r.TOTAL_USERS) || 0,
      fromApi: (r: DivisionRow | DevelopmentRow) => Number(r.totalWebsiteUsers) || 0,
    },
    {
      name: "newUsers",
      fromBaseline: (r: GaBaselineRow) => Number(r.NEW_USERS) || 0,
      fromApi: (r: DivisionRow | DevelopmentRow) => Number(r.newWebsiteUsers) || 0,
    },
  ];

  let failed = false;

  for (const m of measures) {
    // --- 1. Division rows vs per-company baseline (both directions) ---
    const baseByCompany = new Map<string, number>();
    for (const r of byCompany) {
      if (r.COMPANY_NAME) baseByCompany.set(r.COMPANY_NAME, m.fromBaseline(r));
    }
    const apiByCompany = new Map(
      overview.divisions.map((r) => [r.division, m.fromApi(r)]),
    );
    // Every API division is checked against its baseline (0 when GA has no
    // group for it); baseline-only companies count as missing rows only when
    // the dashboard would seed them (Esperanza brands).
    const companyNames = new Set([
      ...apiByCompany.keys(),
      ...[...baseByCompany.keys()].filter(isEsperanzaCompany),
    ]);
    for (const company of [...companyNames].sort()) {
      const api = apiByCompany.get(company) ?? 0;
      const baseline = baseByCompany.get(company) ?? 0;
      if (api === 0 && baseline === 0) continue;
      const d = divergedPct(api, baseline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} division ${m.name.padEnd(10)} ${company.padEnd(30)} api=${api} baseline=${baseline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }

    // --- 2. Development rows vs per-(company, development) baseline ---
    const baseByDev = new Map<string, number>();
    for (const r of byDev) {
      if (r.COMPANY_NAME && r.DEVELOPMENT_NAME) {
        baseByDev.set(devKey(r.COMPANY_NAME, r.DEVELOPMENT_NAME), m.fromBaseline(r));
      }
    }
    const apiByDev = new Map(
      overview.developments.map((r) => [devKey(r.division, r.development), m.fromApi(r)]),
    );
    const devKeys = new Set([
      ...apiByDev.keys(),
      ...[...baseByDev.keys()].filter((k) => isEsperanzaCompany(k.split("\u0000")[0])),
    ]);
    for (const key of [...devKeys].sort()) {
      const api = apiByDev.get(key) ?? 0;
      const baseline = baseByDev.get(key) ?? 0;
      if (api === 0 && baseline === 0) continue;
      const [company, development] = key.split("\u0000");
      const d = divergedPct(api, baseline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} devrow   ${m.name.padEnd(10)} ${`${development} (${company})`.padEnd(45)} api=${api} baseline=${baseline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }
  }

  return !failed;
}

interface CommunityRow {
  development: string;
  division: string;
  isRental: boolean;
  hasGoals: boolean;
  isSelling: boolean;
  leadsYtd: number;
  toursYtd: number;
  salesYtd: number;
}

interface ChannelCountRow {
  CHANNEL: string | null;
  N: number;
}
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
    {
      name: "default view",
      filters: {},
      withBreakdowns: true,
      withGaBreakdowns: true,
      withRatios: true,
    },
    { name: `company filter (${company})`, filters: { company }, withBreakdowns: true },
    { name: `development filter (${development})`, filters: { development } },
    { name: `channel filter (${channel})`, filters: { channel } },
    { ...explicitRangeScenario(startDate), withBreakdowns: true },
  ];
  console.log(
    `Scenarios: ${scenarios
      .map((s) => `${s.name}${s.withBreakdowns ? " [+breakdowns]" : ""}`)
      .join("; ")}`,
  );

  let anyFailed = false;
  for (const scenario of scenarios) {
    const result = await auditScenario(scenario);
    if (!result.ok) anyFailed = true;
    if (!scenario.withBreakdowns && !scenario.withGaBreakdowns && !scenario.withRatios) {
      continue;
    }
    if (!result.rangeOk) {
      // Baselines would be bound to a range the API never applied; the
      // appliedRange failure above already fails the run.
      console.error(
        `Skipping breakdown/ratio audits for "${scenario.name}" — appliedRange mismatch`,
      );
      continue;
    }
    if (scenario.withBreakdowns) {
      const breakdownsOk = await auditBreakdowns(
        scenario,
        result.overview,
        result.expStart,
        result.expTo,
      );
      if (!breakdownsOk) anyFailed = true;
    }
    // Website-user columns of the same tables — separate GA-side baselines.
    if (scenario.withGaBreakdowns) {
      const gaBreakdownsOk = await auditWebsiteUserBreakdowns(
        result.overview,
        result.expStart,
        result.expTo,
      );
      if (!gaBreakdownsOk) anyFailed = true;
    }
    // Funnel ratios table — actuals recomputed from baseline counts, goals
    // cross-checked against the ratio-goal input table.
    if (scenario.withRatios) {
      const ratiosOk = await auditRatios(result.overview, result.expStart, result.expTo);
      if (!ratiosOk) anyFailed = true;
    }
  }

  // Community List — rows, flags, and selling status vs the raw dimension.
  const communitiesOk = await auditCommunities();
  if (!communitiesOk) anyFailed = true;

  if (anyFailed) {
    console.error(
      "\nAUDIT FAILED: dashboard totals diverge from independent Snowflake baselines " +
        "in at least one scenario. Likely causes: join fan-out in the attribution " +
        "dimension, a filter bound to the wrong column, a GA grouping regression, " +
        "an online/onsite split keyed to the wrong channel column or with swapped " +
        "labels, a mis-wired funnel ratio, a stale ratio-goal name, ignored date " +
        "parameters, changed filters, stale cached data, or mislabeled/hidden " +
        "communities in the Community List.",
    );
    process.exit(1);
  }
  console.log("\nAudit passed: all totals within tolerance across all scenarios.");
  process.exit(0);
}

const GOALS_FLAG_VALUES = new Set(["Has Goals", "No Goals"]);

main().catch((err) => {
  console.error("AUDIT ERRORED:", err instanceof Error ? err.message : err);
  process.exit(1);
});

interface RatioGoalBaselineRow {
  NAME: string;
  VAL: number | null;
}

/**
 * Audits the funnel ratios table of the DEFAULT view.
 *
 * Actuals: every ratio is recomputed from independent baseline counts — the
 * same no-fan-out query shapes the headline checks validate, grouped by
 * ONSITE_ONLINE_SOURCE_CHANNEL so the online/onsite variants come from the
 * data rather than from the API's own channel splits. The expected
 * numerator/denominator wiring below is the dashboard's contract (validated
 * against Qlik during migration); a swapped pair or a ratio fed by the wrong
 * actual diverges by orders of magnitude, far beyond any drift tolerance.
 * Division-by-zero mirrors the API's convention (ratio = 0), so both sides
 * agree when a denominator is legitimately empty.
 *
 * Goals: each ratio's goal must resolve by MARKETING_GOAL_NAME_RATIOS in
 * DM_MARKETING_DASHBOARD_INPUT_GOAL_RATIOS for the audited fiscal year
 * (year of the range start, the API's own convention) and match the API's
 * ratios[].goal. The check is bidirectional: a dashboard ratio whose name
 * no longer resolves (dbt rename), an API goal that is null despite a
 * resolvable table row, an input-table goal row no dashboard ratio consumes
 * (orphan left behind by a rename), and conflicting duplicate table rows
 * all fail. Coverage is also bidirectional — an API ratio this audit does
 * not know, a missing expected ratio, or a duplicate API ratio name fails
 * rather than being skipped.
 */
async function auditRatios(
  overview: OverviewResponse,
  expStart: string,
  expTo: string,
): Promise<boolean> {
  console.log(`\n=== Funnel ratios table (default view) ===`);

  // Fiscal year the API sources ratio goals from: year of the range start.
  const goalYear = Number(expStart.slice(0, 4));
  const binds = [expStart, expTo];

  const [leadRows, tourRows, salesRows, users, goalRows] = await Promise.all([
    querySnowflake<ChannelCountRow>(
      `SELECT C.ONSITE_ONLINE_SOURCE_CHANNEL AS CHANNEL, COUNT(*) AS N
       FROM DM_CONTACTS C
       WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
       GROUP BY 1`,
      binds,
    ),
    querySnowflake<ChannelCountRow>(
      `SELECT C.ONSITE_ONLINE_SOURCE_CHANNEL AS CHANNEL, COUNT(*) AS N
       FROM DM_CONTACTS C
       WHERE C.EHI_LEAD = 1 AND C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?
       GROUP BY 1`,
      binds,
    ),
    querySnowflake<ChannelCountRow>(
      `SELECT X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL AS CHANNEL, COUNT(*) AS N
       FROM DM_DEALS X
       WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
         AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
       GROUP BY 1`,
      binds,
    ),
    countScalar(
      `SELECT COUNT(DISTINCT USER_PSEUDO_ID) AS N FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE PROPERTY = 'Esperanza Homes' AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?`,
      binds,
    ),
    querySnowflake<RatioGoalBaselineRow>(
      `SELECT MARKETING_GOAL_NAME_RATIOS AS NAME, MARKETING_GOAL_RATIOS AS VAL
       FROM DM_MARKETING_DASHBOARD_INPUT_GOAL_RATIOS
       WHERE MARKETING_GOAL_YEAR = ?`,
      [goalYear],
    ),
  ]);

  // Totals include rows with a NULL/other channel, same as the API's chan().
  const chanSum = (rows: ChannelCountRow[], channel?: string) =>
    sumRows(rows, (r) => (!channel || r.CHANNEL === channel ? Number(r.N) || 0 : 0));
  const counts = {
    users,
    leads: chanSum(leadRows),
    onlineLeads: chanSum(leadRows, "Online"),
    onsiteLeads: chanSum(leadRows, "Onsite"),
    tours: chanSum(tourRows),
    onlineTours: chanSum(tourRows, "Online"),
    onsiteTours: chanSum(tourRows, "Onsite"),
    sales: chanSum(salesRows),
    onlineSales: chanSum(salesRows, "Online"),
    onsiteSales: chanSum(salesRows, "Onsite"),
  };
  console.log(`Baseline counts: ${JSON.stringify(counts)}`);

  // Expected wiring of every ratio the dashboard shows (numerator/denominator
  // over the baseline counts). Names must match the API's ratios[].name AND
  // the input table's MARKETING_GOAL_NAME_RATIOS values.
  const spec: { name: string; num: number; den: number }[] = [
    { name: "Total Traffic to Total Lead", num: counts.leads, den: counts.users },
    { name: "Total Lead to Total Tour", num: counts.tours, den: counts.leads },
    { name: "Total Tour to Contract", num: counts.sales, den: counts.tours },
    { name: "Total Lead to Total Sale", num: counts.sales, den: counts.leads },
    { name: "Online Traffic to Online Lead", num: counts.onlineLeads, den: counts.users },
    { name: "Online Lead to Online Tour", num: counts.onlineTours, den: counts.onlineLeads },
    { name: "Online Tour to Online Sale", num: counts.onlineSales, den: counts.onlineTours },
    { name: "Online Sales Contribution", num: counts.onlineSales, den: counts.sales },
    { name: "Onsite Lead to Onsite Tour", num: counts.onsiteTours, den: counts.onsiteLeads },
    { name: "Onsite Tour to Onsite Sale", num: counts.onsiteSales, den: counts.onsiteTours },
  ];
  const specNames = new Set(spec.map((s) => s.name));

  // A ratio's numerator and denominator may each legitimately drift by up to
  // TOLERANCE_PCT between the API's (possibly cached) read and the fresh
  // baselines, so their quotient may drift by up to (1+t)/(1-t)-1 — use the
  // exact compounded bound instead of flagging worst-case drift as mis-wiring.
  // Real wiring bugs diverge by orders of magnitude more than this.
  const t = TOLERANCE_PCT / 100;
  const ratioTolerancePct = ((1 + t) / (1 - t) - 1) * 100;

  let failed = false;

  // --- 0. Structure: no duplicate ratio names in the API response ---
  const apiByName = new Map<string, RatioRow>();
  for (const r of overview.ratios) {
    if (apiByName.has(r.name)) {
      console.error(`FAIL ratio     duplicate name in API response: "${r.name}"`);
      failed = true;
    }
    apiByName.set(r.name, r);
  }

  // --- 1. Coverage in both directions ---
  for (const r of overview.ratios) {
    if (!specNames.has(r.name)) {
      console.error(
        `FAIL ratio     unknown ratio "${r.name}" in API response — audit spec does not cover it; update the audit`,
      );
      failed = true;
    }
  }
  for (const s of spec) {
    if (!apiByName.has(s.name)) {
      console.error(`FAIL ratio     missing from API response: "${s.name}"`);
      failed = true;
    }
  }

  // --- 2. Actuals: recomputed ratio vs ratios[].actual ---
  for (const s of spec) {
    const api = apiByName.get(s.name);
    if (!api) continue; // already failed coverage above
    const expected = s.den ? s.num / s.den : 0;
    const apiActual = Number(api.actual) || 0;
    const d = divergedPct(apiActual, expected);
    const ok = d <= ratioTolerancePct;
    console.log(
      `${ok ? "OK  " : "FAIL"} ratio     ${s.name.padEnd(30)} api=${apiActual.toFixed(6)} baseline=${expected.toFixed(6)} (${s.num}/${s.den}) divergence=${d.toFixed(3)}%`,
    );
    if (!ok) failed = true;
  }

  // --- 3. Goals: forward — every dashboard ratio must resolve and match ---
  const goalTable = new Map<string, number>();
  for (const r of goalRows) {
    if (r.VAL == null) continue; // valueless rows are invisible to the API too
    const existing = goalTable.get(r.NAME);
    if (existing !== undefined && existing !== Number(r.VAL)) {
      console.error(
        `FAIL ratiogoal conflicting duplicate rows for "${r.NAME}" (year ${goalYear}): ${existing} vs ${r.VAL} — goal lookup is ambiguous`,
      );
      failed = true;
    }
    goalTable.set(r.NAME, Number(r.VAL));
  }
  for (const s of spec) {
    const tableGoal = goalTable.get(s.name);
    if (tableGoal === undefined) {
      console.error(
        `FAIL ratiogoal "${s.name}" no longer resolves in DM_MARKETING_DASHBOARD_INPUT_GOAL_RATIOS for year ${goalYear} (renamed or removed upstream?)`,
      );
      failed = true;
      continue;
    }
    const api = apiByName.get(s.name);
    if (!api) continue; // already failed coverage above
    if (api.goal == null) {
      console.error(
        `FAIL ratiogoal ${s.name.padEnd(30)} api=null table=${tableGoal} — API dropped a goal the input table defines`,
      );
      failed = true;
      continue;
    }
    const d = divergedPct(Number(api.goal), tableGoal);
    const ok = d <= TOLERANCE_PCT;
    console.log(
      `${ok ? "OK  " : "FAIL"} ratiogoal ${s.name.padEnd(30)} api=${Number(api.goal)} table=${tableGoal} divergence=${d.toFixed(3)}%`,
    );
    if (!ok) failed = true;
  }

  // --- 4. Goals: reverse — no orphaned input-table rows for the year ---
  for (const name of [...goalTable.keys()].sort()) {
    if (!specNames.has(name)) {
      console.error(
        `FAIL ratiogoal orphaned input-table row "${name}" (year ${goalYear}) — no dashboard ratio consumes it (renamed upstream, or the dashboard is missing a ratio)`,
      );
      failed = true;
    }
  }

  return !failed;
}

const RENTAL_FLAG_VALUES = new Set(["Rental", "For Sale"]);

/** Snowflake-style binary string compare (locale collation would diverge). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Audits GET /dashboards/communities against independent baselines:
 *
 *  0. Label-domain guard: flag columns must only hold the documented labels
 *     ('Has Goals'/'No Goals', 'Rental'/'For Sale', NULL). Both the API and
 *     this audit compare exact labels, so an upstream relabel would silently
 *     turn every badge false on BOTH sides and still agree — this guard is
 *     what makes the flag baselines trustworthy.
 *  1. Row identity: exactly one API row per distinct Esperanza development in
 *     the raw dimension — a missing development is a community hidden
 *     entirely; a duplicate is join fan-out.
 *  2. Counts: total / selling / hasGoals / isRental, compared EXACTLY (the
 *     whole point is catching single-community mistakes, so no % tolerance).
 *  3. Per-community flags: hasGoals (any raw row carries 'Has Goals'),
 *     isRental (flag of the preferred row: goal-carrying rows first, then
 *     COMPANY_NAME — recomputed in JS from raw rows, independent of the
 *     API's QUALIFY dedup), and isSelling (hasGoals or any YTD activity from
 *     plain GROUP BYs with no dimension join).
 *  4. Self-consistency: isSelling === hasGoals || leads+tours+sales > 0 over
 *     the API's OWN row values — catches a hide-rule regression even when
 *     both sides of the cross-source comparison drift together.
 *
 * The endpoint caches per UTC day, so a community whose first-ever YTD
 * activity lands between the cache fill and this audit could transiently
 * flip isSelling; that is vanishingly rare and a rerun clears it.
 */
async function auditCommunities(): Promise<boolean> {
  console.log(`\n=== Community List (/dashboards/communities) ===`);

  // The endpoint defines YTD in UTC (Jan 1 of the current UTC year through
  // the current UTC date); the baseline mirrors that window exactly.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const ytdStart = `${todayUtc.slice(0, 4)}-01-01`;
  console.log(`YTD window: ${ytdStart}..${todayUtc}`);

  const url = `${API_BASE}/dashboards/communities`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`FAIL GET ${url} -> HTTP ${res.status}: ${await res.text()}`);
    return false;
  }
  const body = (await res.json()) as { communities: CommunityRow[] };
  if (!Array.isArray(body.communities)) {
    console.error("FAIL response has no communities array");
    return false;
  }
  const apiRows = body.communities;

  const [dimRows, leadRows, tourRows, saleRows] = await Promise.all([
    querySnowflake<DimRawRow>(
      `SELECT DEVELOPMENT_NAME, COMPANY_NAME,
              DEVELOPMENT_HAS_GOALS_FLAG, RENTAL_COMMUNITY_FLAG
       FROM DM_COMPANY_DEVELOPMENT
       WHERE COMPANY_NAME ILIKE '%esperanza%'`,
    ),
    querySnowflake<{ DEV: string | null; N: number }>(
      `SELECT CONTACT_EHI_COMMUNITY_OF_INTEREST AS DEV, COUNT(*) AS N
       FROM DM_CONTACTS
       WHERE EHI_LEAD = 1 AND CONTACT_CREATE_DATE BETWEEN ? AND ?
       GROUP BY 1`,
      [ytdStart, todayUtc],
    ),
    querySnowflake<{ DEV: string | null; N: number }>(
      `SELECT CONTACT_EHI_COMMUNITY_OF_INTEREST AS DEV, COUNT(*) AS N
       FROM DM_CONTACTS
       WHERE EHI_LEAD = 1 AND EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?
       GROUP BY 1`,
      [ytdStart, todayUtc],
    ),
    querySnowflake<{ DEV: string | null; N: number }>(
      `SELECT DEAL_EHI_COMMUNITY_OF_INTEREST AS DEV, COUNT(*) AS N
       FROM DM_DEALS
       WHERE PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
         AND CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
       GROUP BY 1`,
      [ytdStart, todayUtc],
    ),
  ]);

  if (dimRows.length === 0) {
    console.error(
      "FAIL baseline dimension query returned no Esperanza rows — empty source data or broken dimension",
    );
    return false;
  }

  let failed = false;

  // --- 0. Label-domain guard ---
  const badGoals = new Set<string>();
  const badRental = new Set<string>();
  for (const r of dimRows) {
    const g = r.DEVELOPMENT_HAS_GOALS_FLAG;
    if (g != null && !GOALS_FLAG_VALUES.has(g)) badGoals.add(g);
    const rf = r.RENTAL_COMMUNITY_FLAG;
    if (rf != null && !RENTAL_FLAG_VALUES.has(rf)) badRental.add(rf);
  }
  if (badGoals.size || badRental.size) {
    if (badGoals.size) {
      console.error(
        `FAIL unexpected DEVELOPMENT_HAS_GOALS_FLAG label(s): ${[...badGoals].map((v) => JSON.stringify(v)).join(", ")} — flag comparisons can no longer be trusted`,
      );
    }
    if (badRental.size) {
      console.error(
        `FAIL unexpected RENTAL_COMMUNITY_FLAG label(s): ${[...badRental].map((v) => JSON.stringify(v)).join(", ")} — flag comparisons can no longer be trusted`,
      );
    }
    failed = true;
  } else {
    console.log("OK   flag labels within documented value sets");
  }

  // --- Baseline per development, recomputed in JS from raw rows ---
  const toCountMap = (rows: { DEV: string | null; N: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.DEV) m.set(r.DEV, Number(r.N) || 0);
    return m;
  };
  const leadsBy = toCountMap(leadRows);
  const toursBy = toCountMap(tourRows);
  const salesBy = toCountMap(saleRows);

  const rowsByDev = new Map<string, DimRawRow[]>();
  for (const r of dimRows) {
    const list = rowsByDev.get(r.DEVELOPMENT_NAME);
    if (list) list.push(r);
    else rowsByDev.set(r.DEVELOPMENT_NAME, [r]);
  }
  const baseline = new Map<
    string,
    { hasGoals: boolean; isRental: boolean; isSelling: boolean }
  >();
  for (const [dev, rows] of rowsByDev) {
    const hasGoals = rows.some((r) => r.DEVELOPMENT_HAS_GOALS_FLAG === "Has Goals");
    const preferred = [...rows].sort(
      (a, b) =>
        Number(a.DEVELOPMENT_HAS_GOALS_FLAG !== "Has Goals") -
          Number(b.DEVELOPMENT_HAS_GOALS_FLAG !== "Has Goals") ||
        cmp(a.COMPANY_NAME, b.COMPANY_NAME),
    )[0];
    const hasActivity =
      (leadsBy.get(dev) ?? 0) > 0 ||
      (toursBy.get(dev) ?? 0) > 0 ||
      (salesBy.get(dev) ?? 0) > 0;
    baseline.set(dev, {
      hasGoals,
      isRental: preferred.RENTAL_COMMUNITY_FLAG === "Rental",
      isSelling: hasGoals || hasActivity,
    });
  }

  // --- 1. Row identity (both directions + duplicates) ---
  const apiByDev = new Map<string, CommunityRow>();
  for (const r of apiRows) {
    if (apiByDev.has(r.development)) {
      console.error(
        `FAIL duplicate API row for development "${r.development}" — join fan-out?`,
      );
      failed = true;
    }
    apiByDev.set(r.development, r);
  }
  let identityIssues = 0;
  for (const dev of [...baseline.keys()].sort(cmp)) {
    if (!apiByDev.has(dev)) {
      console.error(
        `FAIL community missing from API response: "${dev}" — hidden from the list entirely`,
      );
      failed = true;
      identityIssues++;
    }
  }
  for (const dev of [...apiByDev.keys()].sort(cmp)) {
    if (!baseline.has(dev)) {
      console.error(`FAIL unexpected API row with no dimension baseline: "${dev}"`);
      failed = true;
      identityIssues++;
    }
  }
  if (!identityIssues) {
    console.log(
      `OK   row identity: API returns exactly the ${baseline.size} baseline developments`,
    );
  }

  // --- 2. Counts (exact — no tolerance) ---
  const countOf = <T>(rows: Iterable<T>, pred: (r: T) => boolean) => {
    let c = 0;
    for (const r of rows) if (pred(r)) c++;
    return c;
  };
  const countChecks = [
    { name: "total", api: apiRows.length, baseline: baseline.size },
    {
      name: "selling",
      api: countOf(apiRows, (r) => r.isSelling === true),
      baseline: countOf(baseline.values(), (b) => b.isSelling),
    },
    {
      name: "hasGoals",
      api: countOf(apiRows, (r) => r.hasGoals === true),
      baseline: countOf(baseline.values(), (b) => b.hasGoals),
    },
    {
      name: "isRental",
      api: countOf(apiRows, (r) => r.isRental === true),
      baseline: countOf(baseline.values(), (b) => b.isRental),
    },
  ];
  for (const c of countChecks) {
    const ok = c.api === c.baseline;
    console.log(
      `${ok ? "OK  " : "FAIL"} count ${c.name.padEnd(9)} api=${c.api} baseline=${c.baseline}`,
    );
    if (!ok) failed = true;
  }

  // --- 3. Per-community flag comparison ---
  let flagMismatches = 0;
  let sharedRows = 0;
  for (const [dev, base] of [...baseline].sort((a, b) => cmp(a[0], b[0]))) {
    const api = apiByDev.get(dev);
    if (!api) continue; // already reported as missing
    sharedRows++;
    for (const flag of ["hasGoals", "isRental", "isSelling"] as const) {
      if (api[flag] !== base[flag]) {
        const note =
          flag === "isSelling" && !api[flag]
            ? " — selling community would be hidden by default"
            : "";
        console.error(
          `FAIL flag ${flag} for "${dev}": api=${api[flag]} baseline=${base[flag]}${note}`,
        );
        flagMismatches++;
        failed = true;
      }
    }
  }
  if (!flagMismatches) {
    console.log(
      `OK   flags hasGoals/isRental/isSelling match baseline on all ${sharedRows} shared rows`,
    );
  }

  // --- 4. isSelling invariant over the API's own values ---
  let invariantViolations = 0;
  for (const r of apiRows) {
    const expected =
      r.hasGoals === true ||
      (Number(r.leadsYtd) || 0) > 0 ||
      (Number(r.toursYtd) || 0) > 0 ||
      (Number(r.salesYtd) || 0) > 0;
    if (r.isSelling !== expected) {
      console.error(
        `FAIL isSelling invariant for "${r.development}": isSelling=${r.isSelling} but ` +
          `hasGoals=${r.hasGoals} leadsYtd=${r.leadsYtd} toursYtd=${r.toursYtd} salesYtd=${r.salesYtd}`,
      );
      invariantViolations++;
      failed = true;
    }
  }
  if (!invariantViolations) {
    console.log(
      `OK   isSelling === hasGoals || leads+tours+sales > 0 holds for all ${apiRows.length} rows`,
    );
  }

  return !failed;
}

interface DimRawRow {
  DEVELOPMENT_NAME: string;
  COMPANY_NAME: string;
  DEVELOPMENT_HAS_GOALS_FLAG: string | null;
  RENTAL_COMMUNITY_FLAG: string | null;
}
