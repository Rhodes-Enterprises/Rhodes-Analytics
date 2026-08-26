import { querySnowflake } from "./snowflake";

/**
 * Data layer for the "Overview with Targets" dashboard (migrated from Qlik).
 * Sources: PC_DBT_DB.<schema> dbt models — DM_GOALS, DM_CONTACTS, DM_DEALS,
 * FCT_GOOGLE_ANALYTICS_EVENT_LEVEL, DM_COMPANY_DEVELOPMENT,
 * DM_MARKETING_DASHBOARD_INPUT_GOAL_RATIOS.
 */

// ---------- Small in-memory cache (per-process, TTL) ----------

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; value: unknown }>();

export async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await fn();
  // Evict expired entries, then oldest-first if still over the bound
  // (Map preserves insertion order).
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
  }
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { at: now, value });
  return value;
}

// ---------- Types ----------

export type TargetKind = "proforma" | "business_plan" | "goal" | "waterfall";

export interface DashboardFilters {
  company?: string;
  development?: string;
  cohortQuarter?: string;
  leadSource?: string;
  contactChannel?: string;
  dealChannel?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  toDate: string; // YYYY-MM-DD (elapsed cutoff)
  target: TargetKind;
}

export type MetricKey =
  | "web_traffic"
  | "leads"
  | "online_leads"
  | "onsite_leads"
  | "first_tours"
  | "online_first_tours"
  | "onsite_first_tours"
  | "gross_sales"
  | "online_gross_sales"
  | "onsite_gross_sales";

export const METRICS: MetricKey[] = [
  "web_traffic",
  "leads",
  "online_leads",
  "onsite_leads",
  "first_tours",
  "online_first_tours",
  "onsite_first_tours",
  "gross_sales",
  "online_gross_sales",
  "onsite_gross_sales",
];

const MONTH_ABBR = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

// ---------- Goal type resolution ----------

export async function listGoalTypes(fiscalYear: number): Promise<string[]> {
  return cached(`goalTypes:${fiscalYear}`, async () => {
    const rows = await querySnowflake<{ GOAL_TYPE: string }>(
      "SELECT DISTINCT GOAL_TYPE FROM DM_GOALS WHERE FISCAL_YEAR = ?",
      [fiscalYear],
    );
    return rows.map((r) => r.GOAL_TYPE);
  });
}

/**
 * Resolve the DM_GOALS GOAL_TYPE for a target + metric.
 * - proforma / business_plan: annual plans (`proforma_<m>_year`)
 * - goal: recalculated quarterly (`goal_<m>_q<N>`) — latest quarter <= current
 * - waterfall: recalculated monthly (`waterfall_<m>_<mon>`) — latest month <= current
 */
export function resolveGoalType(
  available: string[],
  target: TargetKind,
  metric: MetricKey,
  asOf: Date,
): string | null {
  const set = new Set(available);
  if (target === "proforma" || target === "business_plan") {
    const name = `${target}_${metric}_year`;
    return set.has(name) ? name : null;
  }
  if (target === "goal") {
    const currentQ = Math.floor(asOf.getMonth() / 3) + 1;
    for (let quarter = currentQ; quarter >= 1; quarter--) {
      const name = `goal_${metric}_q${quarter}`;
      if (set.has(name)) return name;
    }
    return null;
  }
  // waterfall: walk back from the current month to the latest recalc
  const currentM = asOf.getMonth();
  for (let i = 0; i <= 11; i++) {
    const idx = (currentM - i + 12) % 12;
    const name = `waterfall_${metric}_${MONTH_ABBR[idx]}`;
    if (set.has(name)) return name;
    if (idx === 0 && currentM - i <= 0) break;
  }
  return null;
}

// ---------- Filter fragments ----------

interface Frag {
  sql: string;
  binds: (string | number)[];
}

/**
 * Deduplicated company/development dimension for attribution joins.
 * DM_COMPANY_DEVELOPMENT holds one row per (company, development) across ALL
 * brands, and the same development name can exist under many companies (e.g.
 * "VDL Lots" under 7 divisions, "Las Brisas" under 3 brands). Joining the raw
 * table on DEVELOPMENT_NAME fans out actual counts (~1.5x inflation observed).
 * Restrict to Esperanza companies and force one row per development name.
 */
export const DEV_DIM = `(
  SELECT COMPANY_NAME, DEVELOPMENT_NAME
  FROM DM_COMPANY_DEVELOPMENT
  WHERE COMPANY_NAME ILIKE '%esperanza%'
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY DEVELOPMENT_NAME
    ORDER BY DEVELOPMENT_HAS_GOALS_FLAG DESC NULLS LAST, COMPANY_NAME
  ) = 1
)`;

function contactFilters(f: DashboardFilters, alias = "C", dev = "D"): Frag {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (f.company) {
    parts.push(`${dev}.COMPANY_NAME = ?`);
    binds.push(f.company);
  }
  if (f.development) {
    parts.push(`${alias}.CONTACT_EHI_COMMUNITY_OF_INTEREST = ?`);
    binds.push(f.development);
  }
  if (f.cohortQuarter) {
    parts.push(`${alias}.EHI_COHORT_QUARTER = ?`);
    binds.push(f.cohortQuarter);
  }
  if (f.leadSource) {
    parts.push(`${alias}.LEAD_SOURCE_OVERVIEW = ?`);
    binds.push(f.leadSource);
  }
  if (f.contactChannel) {
    parts.push(`${alias}.ONSITE_ONLINE_SOURCE_CHANNEL = ?`);
    binds.push(f.contactChannel);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

function dealFilters(f: DashboardFilters, alias = "X", dev = "D"): Frag {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (f.company) {
    parts.push(`${dev}.COMPANY_NAME = ?`);
    binds.push(f.company);
  }
  if (f.development) {
    parts.push(`${alias}.DEAL_EHI_COMMUNITY_OF_INTEREST = ?`);
    binds.push(f.development);
  }
  if (f.leadSource) {
    parts.push(`${alias}.DEAL_LEAD_SOURCE_OVERVIEW = ?`);
    binds.push(f.leadSource);
  }
  if (f.dealChannel) {
    parts.push(`${alias}.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?`);
    binds.push(f.dealChannel);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

function gaFilters(f: DashboardFilters): Frag {
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
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

function goalFilters(f: DashboardFilters): Frag {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (f.company) {
    parts.push("COMPANY_NAME = ?");
    binds.push(f.company);
  }
  if (f.development) {
    parts.push("DEVELOPMENT_NAME = ?");
    binds.push(f.development);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

// ---------- Queries ----------

interface GoalRow {
  GOAL_TYPE: string;
  COMPANY_NAME: string;
  DEVELOPMENT_NAME: string | null;
  FULL_SPAN: number;
  TO_DATE: number;
}

async function fetchGoals(
  f: DashboardFilters,
  fiscalYear: number,
  goalTypeByMetric: Map<MetricKey, string>,
): Promise<GoalRow[]> {
  const types = [...new Set(goalTypeByMetric.values())];
  if (types.length === 0) return [];
  const gf = goalFilters(f);
  const placeholders = types.map(() => "?").join(",");
  const sql = `
    SELECT GOAL_TYPE, COMPANY_NAME, DEVELOPMENT_NAME,
           SUM(GOAL) AS FULL_SPAN,
           SUM(IFF(BUDGET_DATE <= ?, GOAL, 0)) AS TO_DATE
    FROM DM_GOALS
    WHERE FISCAL_YEAR = ?
      AND GOAL_TYPE IN (${placeholders})
      AND BUDGET_DATE BETWEEN ? AND ?${gf.sql}
    GROUP BY 1, 2, 3`;
  return cached(
    `goals:${JSON.stringify([f, fiscalYear, types])}`,
    () =>
      querySnowflake<GoalRow>(sql, [
        f.toDate,
        fiscalYear,
        ...types,
        f.startDate,
        f.endDate,
        ...gf.binds,
      ]),
  );
}

interface ActualRow {
  COMPANY_NAME: string | null;
  DEVELOPMENT_NAME: string | null;
  CHANNEL: string | null;
  N: number;
}

async function fetchLeadActuals(f: DashboardFilters, dateCol: string): Promise<ActualRow[]> {
  const cf = contactFilters(f);
  const sql = `
    SELECT D.COMPANY_NAME AS COMPANY_NAME,
           D.DEVELOPMENT_NAME AS DEVELOPMENT_NAME,
           C.ONSITE_ONLINE_SOURCE_CHANNEL AS CHANNEL,
           COUNT(*) AS N
    FROM DM_CONTACTS C
    LEFT JOIN ${DEV_DIM} D
      ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
    WHERE C.EHI_LEAD = 1
      AND C.${dateCol} BETWEEN ? AND ?${cf.sql}
    GROUP BY 1, 2, 3`;
  return cached(`leadActuals:${dateCol}:${JSON.stringify(f)}`, () =>
    querySnowflake<ActualRow>(sql, [f.startDate, f.toDate, ...cf.binds]),
  );
}

async function fetchSalesActuals(f: DashboardFilters): Promise<ActualRow[]> {
  const df = dealFilters(f);
  const sql = `
    SELECT D.COMPANY_NAME AS COMPANY_NAME,
           D.DEVELOPMENT_NAME AS DEVELOPMENT_NAME,
           X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL AS CHANNEL,
           COUNT(*) AS N
    FROM DM_DEALS X
    LEFT JOIN ${DEV_DIM} D
      ON X.DEAL_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
    WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
      AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?${df.sql}
    GROUP BY 1, 2, 3`;
  return cached(`salesActuals:${JSON.stringify(f)}`, () =>
    querySnowflake<ActualRow>(sql, [f.startDate, f.toDate, ...df.binds]),
  );
}

interface UsersRow {
  COMPANY_NAME: string | null;
  DEVELOPMENT_NAME: string | null;
  /** 1 when the row is aggregated over all companies */
  G_COMPANY: number;
  /** 1 when the row is aggregated over all developments */
  G_DEV: number;
  TOTAL_USERS: number;
  NEW_USERS: number;
}

async function fetchWebsiteUsers(f: DashboardFilters): Promise<UsersRow[]> {
  const gf = gaFilters(f);
  const sql = `
    SELECT MATCHED_COMPANY_NAME AS COMPANY_NAME,
           MATCHED_DEVELOPMENT_NAME AS DEVELOPMENT_NAME,
           GROUPING(MATCHED_COMPANY_NAME) AS G_COMPANY,
           GROUPING(MATCHED_DEVELOPMENT_NAME) AS G_DEV,
           COUNT(DISTINCT USER_PSEUDO_ID) AS TOTAL_USERS,
           COUNT(DISTINCT IFF(IS_NEW_USER = 'Yes', USER_PSEUDO_ID, NULL)) AS NEW_USERS
    FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
    WHERE PROPERTY = 'Esperanza Homes'
      AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?${gf.sql}
    GROUP BY GROUPING SETS (
      (),
      (MATCHED_COMPANY_NAME),
      (MATCHED_COMPANY_NAME, MATCHED_DEVELOPMENT_NAME)
    )`;
  return cached(`gaUsers:${JSON.stringify(f)}`, () =>
    querySnowflake<UsersRow>(sql, [f.startDate, f.toDate, ...gf.binds]),
  );
}

interface RatioGoalRow {
  MARKETING_GOAL_NAME_RATIOS: string;
  MARKETING_GOAL_RATIOS: number | null;
}

async function fetchRatioGoals(year: number): Promise<Map<string, number>> {
  const rows = await cached(`ratioGoals:${year}`, () =>
    querySnowflake<RatioGoalRow>(
      `SELECT MARKETING_GOAL_NAME_RATIOS, MARKETING_GOAL_RATIOS
       FROM DM_MARKETING_DASHBOARD_INPUT_GOAL_RATIOS
       WHERE MARKETING_GOAL_YEAR = ?`,
      [year],
    ),
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.MARKETING_GOAL_RATIOS != null) {
      map.set(r.MARKETING_GOAL_NAME_RATIOS, r.MARKETING_GOAL_RATIOS);
    }
  }
  return map;
}

// ---------- Aggregation helpers ----------

function sumBy<T>(rows: T[], pick: (r: T) => number, filter?: (r: T) => boolean): number {
  let total = 0;
  for (const r of rows) if (!filter || filter(r)) total += pick(r);
  return total;
}

function ptg(actual: number, goal: number): number | null {
  if (!goal) return null;
  return (actual / goal - 1) * 100;
}

// ---------- Filter options ----------

export async function getFilterOptions() {
  return cached("filterOptions", async () => {
    const [companies, developments, cohorts, sources, channels] = await Promise.all([
      querySnowflake<{ COMPANY_NAME: string }>(
        `SELECT DISTINCT COMPANY_NAME FROM DM_COMPANY_DEVELOPMENT
         WHERE COMPANY_NAME ILIKE '%esperanza%' ORDER BY 1`,
      ),
      querySnowflake<{ COMPANY_NAME: string; DEVELOPMENT_NAME: string }>(
        `SELECT DISTINCT COMPANY_NAME, DEVELOPMENT_NAME FROM DM_COMPANY_DEVELOPMENT
         WHERE COMPANY_NAME ILIKE '%esperanza%' ORDER BY 1, 2`,
      ),
      querySnowflake<{ CQ: string }>(
        `SELECT DISTINCT EHI_COHORT_QUARTER AS CQ FROM DM_CONTACTS
         WHERE EHI_COHORT_QUARTER IS NOT NULL ORDER BY 1 DESC`,
      ),
      querySnowflake<{ L: string }>(
        `SELECT LEAD_SOURCE_OVERVIEW AS L FROM DM_CONTACTS
         WHERE EHI_LEAD = 1 AND LEAD_SOURCE_OVERVIEW IS NOT NULL
         GROUP BY 1 ORDER BY COUNT(*) DESC`,
      ),
      querySnowflake<{ CH: string }>(
        `SELECT DISTINCT ONSITE_ONLINE_SOURCE_CHANNEL AS CH FROM DM_CONTACTS
         WHERE ONSITE_ONLINE_SOURCE_CHANNEL IS NOT NULL ORDER BY 1`,
      ),
    ]);
    return {
      companies: companies.map((r) => r.COMPANY_NAME),
      developments: developments.map((r) => ({
        company: r.COMPANY_NAME,
        development: r.DEVELOPMENT_NAME,
      })),
      cohortQuarters: cohorts.map((r) => r.CQ),
      leadSources: sources.map((r) => r.L),
      channels: channels.map((r) => r.CH),
    };
  });
}

// ---------- Main dashboard payload ----------

export async function getOverviewWithTargets(f: DashboardFilters) {
  const fiscalYear = new Date(f.startDate + "T00:00:00").getFullYear();
  const asOf = new Date(f.toDate + "T00:00:00");

  const available = await listGoalTypes(fiscalYear);
  const goalTypeByMetric = new Map<MetricKey, string>();
  for (const metric of METRICS) {
    const gt = resolveGoalType(available, f.target, metric, asOf);
    if (gt) goalTypeByMetric.set(metric, gt);
  }

  const [goals, leads, tours, sales, users, ratioGoals] = await Promise.all([
    fetchGoals(f, fiscalYear, goalTypeByMetric),
    fetchLeadActuals(f, "CONTACT_CREATE_DATE"),
    fetchLeadActuals(f, "EHI_MIN_FIRST_TOUR_DATE"),
    fetchSalesActuals(f),
    fetchWebsiteUsers(f),
    fetchRatioGoals(fiscalYear),
  ]);

  // Goal lookups
  const goalTotal = (
    metric: MetricKey,
    kind: "FULL_SPAN" | "TO_DATE",
    company?: string,
    development?: string,
  ) => {
    const gt = goalTypeByMetric.get(metric);
    if (!gt) return 0;
    return sumBy(
      goals,
      (r) => Number(r[kind]) || 0,
      (r) =>
        r.GOAL_TYPE === gt &&
        (!company || r.COMPANY_NAME === company) &&
        (!development || r.DEVELOPMENT_NAME === development),
    );
  };

  const chan = (
    rows: ActualRow[],
    channel?: string,
    company?: string,
    development?: string,
  ) =>
    sumBy(
      rows,
      (r) => Number(r.N) || 0,
      (r) =>
        (!channel || r.CHANNEL === channel) &&
        (!company || r.COMPANY_NAME === company) &&
        (!development || r.DEVELOPMENT_NAME === development),
    );

  // Distinct-count rows come at three grouping levels; pick the right one.
  const overallUsers = users.find((r) => Number(r.G_COMPANY) === 1);
  const companyUsers = users.filter(
    (r) => Number(r.G_COMPANY) === 0 && Number(r.G_DEV) === 1,
  );
  const devUsers = users.filter((r) => Number(r.G_DEV) === 0);
  const totalUsers = Number(overallUsers?.TOTAL_USERS) || 0;
  const newUsers = Number(overallUsers?.NEW_USERS) || 0;

  const actuals = {
    websiteUsers: totalUsers,
    newWebsiteUsers: newUsers,
    leads: chan(leads),
    onlineLeads: chan(leads, "Online"),
    onsiteLeads: chan(leads, "Onsite"),
    tours: chan(tours),
    onlineTours: chan(tours, "Online"),
    onsiteTours: chan(tours, "Onsite"),
    sales: chan(sales),
    onlineSales: chan(sales, "Online"),
    onsiteSales: chan(sales, "Onsite"),
  };

  // KPI row (gross sales vs target)
  const salesGoal = goalTotal("gross_sales", "FULL_SPAN");
  const salesTdGoal = goalTotal("gross_sales", "TO_DATE");
  const kpis = {
    salesGoal,
    salesTdGoal,
    grossSales: actuals.sales,
    ptgVariance: actuals.sales - salesTdGoal,
    ptgPercent: ptg(actuals.sales, salesTdGoal),
  };

  // Traffic goals matrix
  const cell = (metric: MetricKey, actual: number) => ({
    fullSpanGoal: goalTotal(metric, "FULL_SPAN"),
    toDateGoal: goalTotal(metric, "TO_DATE"),
    actual,
    ptgPercent: ptg(actual, goalTotal(metric, "TO_DATE")),
  });
  const trafficMatrix = {
    online: {
      websiteUsers: cell("web_traffic", actuals.websiteUsers),
      leads: cell("online_leads", actuals.onlineLeads),
      tours: cell("online_first_tours", actuals.onlineTours),
      sales: cell("online_gross_sales", actuals.onlineSales),
    },
    onsite: {
      leads: cell("onsite_leads", actuals.onsiteLeads),
      tours: cell("onsite_first_tours", actuals.onsiteTours),
      sales: cell("onsite_gross_sales", actuals.onsiteSales),
    },
    total: {
      leads: cell("leads", actuals.leads),
      tours: cell("first_tours", actuals.tours),
    },
    newWebsiteUsers: newUsers,
  };

  // Division summary
  const companies = new Set<string>();
  for (const r of goals) if (r.COMPANY_NAME) companies.add(r.COMPANY_NAME);
  for (const r of companyUsers) if (r.COMPANY_NAME?.includes("Esperanza")) companies.add(r.COMPANY_NAME);
  // Also seed from actuals: a company with leads/tours/sales but no goals
  // and no GA rows must still appear (its COMPANY_NAME comes from the
  // Esperanza-only attribution dimension, so no brand filter needed).
  for (const rows of [leads, tours, sales]) {
    for (const r of rows) if (r.COMPANY_NAME) companies.add(r.COMPANY_NAME);
  }
  const divisions = [...companies].sort().map((company) => {
    const uRow = companyUsers.filter((r) => r.COMPANY_NAME === company);
    const cTotalUsers = sumBy(uRow, (r) => Number(r.TOTAL_USERS) || 0);
    const cNewUsers = sumBy(uRow, (r) => Number(r.NEW_USERS) || 0);
    const cLeads = chan(leads, undefined, company);
    const cTours = chan(tours, undefined, company);
    const cSales = chan(sales, undefined, company);
    const p = (metric: MetricKey, actual: number) =>
      ptg(actual, goalTotal(metric, "TO_DATE", company));
    return {
      division: company,
      newWebsiteUsers: cNewUsers,
      totalWebsiteUsers: cTotalUsers,
      leads: cLeads,
      leadsPctOfTotal: actuals.leads ? (cLeads / actuals.leads) * 100 : 0,
      tours: cTours,
      toursPctOfTotal: actuals.tours ? (cTours / actuals.tours) * 100 : 0,
      sales: cSales,
      salesPctOfTotal: actuals.sales ? (cSales / actuals.sales) * 100 : 0,
      salesPtg: p("gross_sales", cSales),
      toursPtg: p("first_tours", cTours),
      leadsPtg: p("leads", cLeads),
      onlineTrafficPtg: p("web_traffic", cTotalUsers),
      onlineLeadsPtg: p("online_leads", chan(leads, "Online", company)),
      onlineToursPtg: p("online_first_tours", chan(tours, "Online", company)),
      onlineSalesPtg: p("online_gross_sales", chan(sales, "Online", company)),
      onsiteLeadsPtg: p("onsite_leads", chan(leads, "Onsite", company)),
      onsiteToursPtg: p("onsite_first_tours", chan(tours, "Onsite", company)),
      onsiteSalesPtg: p("onsite_gross_sales", chan(sales, "Onsite", company)),
    };
  });

  // Development summary — one row per (company, development) pair; the same
  // development name may exist under different divisions, so key on the pair.
  const devPairs = new Map<string, { company: string; development: string }>();
  const addPair = (company: string | null, development: string | null) => {
    if (!company || !development) return;
    devPairs.set(`${company}\u0000${development}`, { company, development });
  };
  for (const r of goals) addPair(r.COMPANY_NAME, r.DEVELOPMENT_NAME);
  for (const r of devUsers) {
    if (r.COMPANY_NAME?.includes("Esperanza")) addPair(r.COMPANY_NAME, r.DEVELOPMENT_NAME);
  }
  // Also seed from actuals so developments with leads/tours/sales but no
  // goals and no GA rows still get a row (previously dropped silently).
  for (const rows of [leads, tours, sales]) {
    for (const r of rows) addPair(r.COMPANY_NAME, r.DEVELOPMENT_NAME);
  }
  const developments = [...devPairs.values()]
    .sort(
      (a, b) =>
        a.company.localeCompare(b.company) ||
        a.development.localeCompare(b.development),
    )
    .map(({ company, development }) => {
      const uRow = devUsers.filter(
        (r) => r.COMPANY_NAME === company && r.DEVELOPMENT_NAME === development,
      );
      const dTotalUsers = sumBy(uRow, (r) => Number(r.TOTAL_USERS) || 0);
      const dNewUsers = sumBy(uRow, (r) => Number(r.NEW_USERS) || 0);
      const dLeads = chan(leads, undefined, company, development);
      const dTours = chan(tours, undefined, company, development);
      const dSales = chan(sales, undefined, company, development);
      const p = (metric: MetricKey, actual: number) =>
        ptg(actual, goalTotal(metric, "TO_DATE", company, development));
      return {
        development,
        division: company,
        newWebsiteUsers: dNewUsers,
        totalWebsiteUsers: dTotalUsers,
        leads: dLeads,
        leadsPctOfTotal: actuals.leads ? (dLeads / actuals.leads) * 100 : 0,
        tours: dTours,
        toursPctOfTotal: actuals.tours ? (dTours / actuals.tours) * 100 : 0,
        sales: dSales,
        salesPctOfTotal: actuals.sales ? (dSales / actuals.sales) * 100 : 0,
        salesPtg: p("gross_sales", dSales),
        toursPtg: p("first_tours", dTours),
        leadsPtg: p("leads", dLeads),
        onlineTrafficPtg: p("web_traffic", dTotalUsers),
        onlineLeadsPtg: p("online_leads", chan(leads, "Online", company, development)),
        onlineToursPtg: p("online_first_tours", chan(tours, "Online", company, development)),
        onlineSalesPtg: p("online_gross_sales", chan(sales, "Online", company, development)),
        onsiteLeadsPtg: p("onsite_leads", chan(leads, "Onsite", company, development)),
        onsiteToursPtg: p("onsite_first_tours", chan(tours, "Onsite", company, development)),
        onsiteSalesPtg: p("onsite_gross_sales", chan(sales, "Onsite", company, development)),
      };
    });

  // Ratio goals table + charts
  const safeDiv = (a: number, b: number) => (b ? a / b : 0);
  const ratioDefs: { name: string; group: "total" | "online" | "onsite"; actual: number }[] = [
    { name: "Total Traffic to Total Lead", group: "total", actual: safeDiv(actuals.leads, actuals.websiteUsers) },
    { name: "Total Lead to Total Tour", group: "total", actual: safeDiv(actuals.tours, actuals.leads) },
    { name: "Total Tour to Contract", group: "total", actual: safeDiv(actuals.sales, actuals.tours) },
    { name: "Total Lead to Total Sale", group: "total", actual: safeDiv(actuals.sales, actuals.leads) },
    { name: "Online Traffic to Online Lead", group: "online", actual: safeDiv(actuals.onlineLeads, actuals.websiteUsers) },
    { name: "Online Lead to Online Tour", group: "online", actual: safeDiv(actuals.onlineTours, actuals.onlineLeads) },
    { name: "Online Tour to Online Sale", group: "online", actual: safeDiv(actuals.onlineSales, actuals.onlineTours) },
    { name: "Online Sales Contribution", group: "online", actual: safeDiv(actuals.onlineSales, actuals.sales) },
    { name: "Onsite Lead to Onsite Tour", group: "onsite", actual: safeDiv(actuals.onsiteTours, actuals.onsiteLeads) },
    { name: "Onsite Tour to Onsite Sale", group: "onsite", actual: safeDiv(actuals.onsiteSales, actuals.onsiteTours) },
  ];
  const ratios = ratioDefs.map((r) => {
    const goal = ratioGoals.get(r.name) ?? null;
    return {
      name: r.name,
      group: r.group,
      goal,
      actual: r.actual,
      ptgPercent: goal ? (r.actual / goal - 1) * 100 : null,
    };
  });

  return { filters: f, kpis, trafficMatrix, divisions, developments, ratios, actuals };
}

// ---------- Year-over-year chart ----------

export async function getYearOverYear(f: DashboardFilters) {
  const year = new Date(f.toDate + "T00:00:00").getFullYear();
  const prior = year - 1;
  const cf = contactFilters(f);
  const df = dealFilters(f);
  const gaf = gaFilters(f);
  const gf = goalFilters(f);

  const monthly = async <T extends { Y: number; M: number; N: number }>(
    sql: string,
    binds: (string | number)[],
  ) =>
    cached(`yoy:${sql}:${JSON.stringify(binds)}`, () =>
      querySnowflake<T>(sql, binds),
    );

  const [usersRows, leadRows, tourRows, salesRows, goalRows] = await Promise.all([
    monthly(
      `SELECT YEAR(GOOGLE_ANALYTICS_DATE) Y, MONTH(GOOGLE_ANALYTICS_DATE) M,
              COUNT(DISTINCT USER_PSEUDO_ID) N
       FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE PROPERTY = 'Esperanza Homes'
         AND YEAR(GOOGLE_ANALYTICS_DATE) IN (?, ?)${gaf.sql}
       GROUP BY 1, 2`,
      [prior, year, ...gaf.binds],
    ),
    monthly(
      `SELECT YEAR(C.CONTACT_CREATE_DATE) Y, MONTH(C.CONTACT_CREATE_DATE) M, COUNT(*) N
       FROM DM_CONTACTS C
       LEFT JOIN ${DEV_DIM} D
         ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
       WHERE C.EHI_LEAD = 1 AND YEAR(C.CONTACT_CREATE_DATE) IN (?, ?)${cf.sql}
       GROUP BY 1, 2`,
      [prior, year, ...cf.binds],
    ),
    monthly(
      `SELECT YEAR(C.EHI_MIN_FIRST_TOUR_DATE) Y, MONTH(C.EHI_MIN_FIRST_TOUR_DATE) M, COUNT(*) N
       FROM DM_CONTACTS C
       LEFT JOIN ${DEV_DIM} D
         ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
       WHERE C.EHI_LEAD = 1 AND YEAR(C.EHI_MIN_FIRST_TOUR_DATE) IN (?, ?)${cf.sql}
       GROUP BY 1, 2`,
      [prior, year, ...cf.binds],
    ),
    monthly(
      `SELECT YEAR(X.CONTRACT_RATIFIED_DATE) Y, MONTH(X.CONTRACT_RATIFIED_DATE) M, COUNT(*) N
       FROM DM_DEALS X
       LEFT JOIN ${DEV_DIM} D
         ON X.DEAL_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
       WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
         AND YEAR(X.CONTRACT_RATIFIED_DATE) IN (?, ?)${df.sql}
       GROUP BY 1, 2`,
      [prior, year, ...df.binds],
    ),
    monthly(
      `SELECT FISCAL_YEAR Y, MONTH(BUDGET_DATE) M, GOAL_TYPE GT, SUM(GOAL) N
       FROM DM_GOALS
       WHERE FISCAL_YEAR = ?
         AND GOAL_TYPE IN ('business_plan_web_traffic_year','business_plan_leads_year',
                           'business_plan_first_tours_year','business_plan_gross_sales_year')${gf.sql}
       GROUP BY 1, 2, 3`,
      [year, ...gf.binds],
    ) as Promise<{ Y: number; M: number; GT: string; N: number }[]>,
  ]);

  const goalTypeForMeasure: Record<string, string> = {
    websiteUsers: "business_plan_web_traffic_year",
    leads: "business_plan_leads_year",
    tours: "business_plan_first_tours_year",
    grossSales: "business_plan_gross_sales_year",
  };
  const sets: Record<string, { Y: number; M: number; N: number }[]> = {
    websiteUsers: usersRows,
    leads: leadRows,
    tours: tourRows,
    grossSales: salesRows,
  };

  const measures = Object.keys(sets).map((measure) => {
    const rows = sets[measure];
    const gt = goalTypeForMeasure[measure];
    const points = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const pick = (yr: number) =>
        rows
          .filter((r) => Number(r.Y) === yr && Number(r.M) === m)
          .reduce((total, r) => total + (Number(r.N) || 0), 0);
      const goal = (goalRows as { Y: number; M: number; GT: string; N: number }[])
        .filter((r) => r.GT === gt && Number(r.M) === m)
        .reduce((total, r) => total + (Number(r.N) || 0), 0);
      return {
        month: m,
        currentYear: pick(year),
        priorYear: pick(prior),
        goal,
      };
    });
    return { measure, points };
  });

  return { year, priorYear: prior, measures };
}
