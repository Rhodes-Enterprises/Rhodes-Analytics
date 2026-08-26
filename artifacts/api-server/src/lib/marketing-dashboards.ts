import { querySnowflake } from "./snowflake";
import {
  cached,
  DEV_DIM,
  listGoalTypes,
  resolveGoalType,
  type DashboardFilters,
  type MetricKey,
  type TargetKind,
} from "./overview-targets";

/**
 * Data layer for the remaining migrated marketing dashboards:
 * Website Traffic, Leads / Tours / Gross Sales (funnel metrics),
 * EHI Goals, and Community List.
 * Reuses the deduped DEV_DIM dimension and runtime goal-type resolution
 * proven correct in overview-targets.ts.
 */

// ---------- shared helpers ----------

function ptg(actual: number, goal: number): number | null {
  if (!goal) return null;
  return (actual / goal - 1) * 100;
}

const n = (v: unknown) => Number(v) || 0;

async function goalTypeFor(
  fiscalYear: number,
  target: TargetKind,
  metric: MetricKey,
  asOf: Date,
): Promise<string | null> {
  const available = await listGoalTypes(fiscalYear);
  return resolveGoalType(available, target, metric, asOf);
}

interface GoalAgg {
  COMPANY_NAME: string | null;
  DEVELOPMENT_NAME: string | null;
  M: number;
  FULL_SPAN: number;
  TO_DATE: number;
}

async function fetchGoalAgg(
  goalType: string | null,
  fiscalYear: number,
  startDate: string,
  endDate: string,
  toDate: string,
  company?: string,
  development?: string,
): Promise<GoalAgg[]> {
  if (!goalType) return [];
  const parts: string[] = [];
  const binds: (string | number)[] = [toDate, fiscalYear, goalType, startDate, endDate];
  if (company) {
    parts.push("AND COMPANY_NAME = ?");
    binds.push(company);
  }
  if (development) {
    parts.push("AND DEVELOPMENT_NAME = ?");
    binds.push(development);
  }
  const sql = `
    SELECT COMPANY_NAME, DEVELOPMENT_NAME, MONTH(BUDGET_DATE) AS M,
           SUM(GOAL) AS FULL_SPAN,
           SUM(IFF(BUDGET_DATE <= ?, GOAL, 0)) AS TO_DATE
    FROM DM_GOALS
    WHERE FISCAL_YEAR = ? AND GOAL_TYPE = ?
      AND BUDGET_DATE BETWEEN ? AND ? ${parts.join(" ")}
    GROUP BY 1, 2, 3`;
  return cached(`mgoalAgg:${JSON.stringify(binds)}`, () =>
    querySnowflake<GoalAgg>(sql, binds),
  );
}

// ---------- Website Traffic ----------

export async function getWebsiteTraffic(f: DashboardFilters) {
  const fiscalYear = new Date(f.startDate + "T00:00:00").getFullYear();
  const asOf = new Date(f.toDate + "T00:00:00");

  const gaWhere: string[] = [];
  const gaBinds: (string | number)[] = [];
  if (f.company) {
    gaWhere.push("AND MATCHED_COMPANY_NAME = ?");
    gaBinds.push(f.company);
  }
  if (f.development) {
    gaWhere.push("AND MATCHED_DEVELOPMENT_NAME = ?");
    gaBinds.push(f.development);
  }
  const scope = gaWhere.join(" ");

  const base = `FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
    WHERE PROPERTY = 'Esperanza Homes'
      AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ? ${scope}`;
  const rangeBinds = [f.startDate, f.toDate, ...gaBinds];

  const goalType = await goalTypeFor(fiscalYear, f.target, "web_traffic", asOf);

  const [kpiRows, monthlyRows, channelRows, deviceRows, devRows, goals] =
    await Promise.all([
      cached(`wt:kpis:${JSON.stringify(rangeBinds)}`, () =>
        querySnowflake<{
          TOTAL_USERS: number;
          NEW_USERS: number;
          SESSIONS: number;
          ENGAGED_SESSIONS: number;
          PAGE_VIEWS: number;
        }>(
          `SELECT COUNT(DISTINCT USER_PSEUDO_ID) AS TOTAL_USERS,
                  COUNT(DISTINCT IFF(IS_NEW_USER = 'Yes', USER_PSEUDO_ID, NULL)) AS NEW_USERS,
                  COUNT(DISTINCT SESSION_ID) AS SESSIONS,
                  COUNT(DISTINCT IFF(PARAM_SESSION_ENGAGED = 1, SESSION_ID, NULL)) AS ENGAGED_SESSIONS,
                  COUNT_IF(IS_PAGE_VIEW = 'Yes') AS PAGE_VIEWS
           ${base}`,
          rangeBinds,
        ),
      ),
      cached(`wt:monthly:${JSON.stringify(rangeBinds)}`, () =>
        querySnowflake<{ M: number; USERS: number; NEW_USERS: number; SESSIONS: number }>(
          `SELECT MONTH(GOOGLE_ANALYTICS_DATE) AS M,
                  COUNT(DISTINCT USER_PSEUDO_ID) AS USERS,
                  COUNT(DISTINCT IFF(IS_NEW_USER = 'Yes', USER_PSEUDO_ID, NULL)) AS NEW_USERS,
                  COUNT(DISTINCT SESSION_ID) AS SESSIONS
           ${base}
           GROUP BY 1 ORDER BY 1`,
          rangeBinds,
        ),
      ),
      cached(`wt:channels:${JSON.stringify(rangeBinds)}`, () =>
        querySnowflake<{ NAME: string | null; USERS: number; SESSIONS: number }>(
          `SELECT FIRST_USER_DEFAULT_CHANNEL_GROUP AS NAME,
                  COUNT(DISTINCT USER_PSEUDO_ID) AS USERS,
                  COUNT(DISTINCT SESSION_ID) AS SESSIONS
           ${base}
           GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
          rangeBinds,
        ),
      ),
      cached(`wt:devices:${JSON.stringify(rangeBinds)}`, () =>
        querySnowflake<{ NAME: string | null; USERS: number }>(
          `SELECT DEVICE_CATEGORY AS NAME, COUNT(DISTINCT USER_PSEUDO_ID) AS USERS
           ${base}
           GROUP BY 1 ORDER BY 2 DESC`,
          rangeBinds,
        ),
      ),
      cached(`wt:devs:${JSON.stringify(rangeBinds)}`, () =>
        querySnowflake<{
          DEVELOPMENT: string | null;
          DIVISION: string | null;
          USERS: number;
          NEW_USERS: number;
          SESSIONS: number;
        }>(
          `SELECT MATCHED_DEVELOPMENT_NAME AS DEVELOPMENT,
                  MATCHED_COMPANY_NAME AS DIVISION,
                  COUNT(DISTINCT USER_PSEUDO_ID) AS USERS,
                  COUNT(DISTINCT IFF(IS_NEW_USER = 'Yes', USER_PSEUDO_ID, NULL)) AS NEW_USERS,
                  COUNT(DISTINCT SESSION_ID) AS SESSIONS
           ${base}
             AND MATCHED_DEVELOPMENT_NAME IS NOT NULL
           GROUP BY 1, 2 ORDER BY 3 DESC`,
          rangeBinds,
        ),
      ),
      fetchGoalAgg(goalType, fiscalYear, f.startDate, f.endDate, f.toDate, f.company, f.development),
    ]);

  const k = kpiRows[0];
  const totalUsers = n(k?.TOTAL_USERS);
  const sessions = n(k?.SESSIONS);
  const fullSpanGoal = goals.reduce((t, r) => t + n(r.FULL_SPAN), 0);
  const toDateGoal = goals.reduce((t, r) => t + n(r.TO_DATE), 0);

  return {
    kpis: {
      totalUsers,
      newUsers: n(k?.NEW_USERS),
      sessions,
      engagedSessions: n(k?.ENGAGED_SESSIONS),
      pageViews: n(k?.PAGE_VIEWS),
      engagementRate: sessions ? (n(k?.ENGAGED_SESSIONS) / sessions) * 100 : 0,
      fullSpanGoal,
      toDateGoal,
      ptgPercent: ptg(totalUsers, toDateGoal),
    },
    monthly: monthlyRows.map((r) => ({
      month: n(r.M),
      users: n(r.USERS),
      newUsers: n(r.NEW_USERS),
      sessions: n(r.SESSIONS),
    })),
    channels: channelRows.map((r) => ({
      name: r.NAME ?? "Unknown",
      users: n(r.USERS),
      sessions: n(r.SESSIONS),
    })),
    devices: deviceRows.map((r) => ({ name: r.NAME ?? "Unknown", users: n(r.USERS) })),
    developments: devRows.map((r) => ({
      development: r.DEVELOPMENT ?? "Unattributed",
      division: r.DIVISION ?? "",
      users: n(r.USERS),
      newUsers: n(r.NEW_USERS),
      sessions: n(r.SESSIONS),
    })),
  };
}

// ---------- Funnel metric (Leads / Tours / Gross Sales) ----------

export type FunnelMetric = "leads" | "tours" | "gross-sales";

const FUNNEL_CONFIG: Record<
  FunnelMetric,
  {
    totalMetric: MetricKey;
    onlineMetric: MetricKey;
    onsiteMetric: MetricKey;
  }
> = {
  leads: { totalMetric: "leads", onlineMetric: "online_leads", onsiteMetric: "onsite_leads" },
  tours: {
    totalMetric: "first_tours",
    onlineMetric: "online_first_tours",
    onsiteMetric: "onsite_first_tours",
  },
  "gross-sales": {
    totalMetric: "gross_sales",
    onlineMetric: "online_gross_sales",
    onsiteMetric: "onsite_gross_sales",
  },
};

interface FunnelRow {
  COMPANY_NAME: string | null;
  DEVELOPMENT_NAME: string | null;
  CHANNEL: string | null;
  SOURCE: string | null;
  M: number;
  N: number;
}

async function fetchFunnelActuals(metric: FunnelMetric, f: DashboardFilters): Promise<FunnelRow[]> {
  const extra: string[] = [];
  if (f.company) extra.push("AND D.COMPANY_NAME = ?");
  let sql: string;
  if (metric === "gross-sales") {
    if (f.development) extra.push("AND X.DEAL_EHI_COMMUNITY_OF_INTEREST = ?");
    sql = `
      SELECT D.COMPANY_NAME, D.DEVELOPMENT_NAME,
             X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL AS CHANNEL,
             X.DEAL_LEAD_SOURCE_OVERVIEW AS SOURCE,
             MONTH(X.CONTRACT_RATIFIED_DATE) AS M,
             COUNT(*) AS N
      FROM DM_DEALS X
      LEFT JOIN ${DEV_DIM} D
        ON X.DEAL_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
      WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
        AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ? ${extra.join(" ")}
      GROUP BY 1, 2, 3, 4, 5`;
  } else {
    const dateCol = metric === "leads" ? "CONTACT_CREATE_DATE" : "EHI_MIN_FIRST_TOUR_DATE";
    if (f.development) extra.push("AND C.CONTACT_EHI_COMMUNITY_OF_INTEREST = ?");
    sql = `
      SELECT D.COMPANY_NAME, D.DEVELOPMENT_NAME,
             C.ONSITE_ONLINE_SOURCE_CHANNEL AS CHANNEL,
             C.LEAD_SOURCE_OVERVIEW AS SOURCE,
             MONTH(C.${dateCol}) AS M,
             COUNT(*) AS N
      FROM DM_CONTACTS C
      LEFT JOIN ${DEV_DIM} D
        ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
      WHERE C.EHI_LEAD = 1
        AND C.${dateCol} BETWEEN ? AND ? ${extra.join(" ")}
      GROUP BY 1, 2, 3, 4, 5`;
  }
  // Extra clauses follow the BETWEEN in push order: company, then development.
  const binds: (string | number)[] = [f.startDate, f.toDate];
  if (f.company) binds.push(f.company);
  if (f.development) binds.push(f.development);
  return cached(`funnel:${metric}:${JSON.stringify(f)}`, () =>
    querySnowflake<FunnelRow>(sql, binds),
  );
}

export async function getFunnelMetric(metric: FunnelMetric, f: DashboardFilters) {
  const fiscalYear = new Date(f.startDate + "T00:00:00").getFullYear();
  const asOf = new Date(f.toDate + "T00:00:00");
  const cfg = FUNNEL_CONFIG[metric];

  const [totalType, onlineType, onsiteType] = await Promise.all([
    goalTypeFor(fiscalYear, f.target, cfg.totalMetric, asOf),
    goalTypeFor(fiscalYear, f.target, cfg.onlineMetric, asOf),
    goalTypeFor(fiscalYear, f.target, cfg.onsiteMetric, asOf),
  ]);

  const [rows, totalGoals, onlineGoals, onsiteGoals] = await Promise.all([
    fetchFunnelActuals(metric, f),
    fetchGoalAgg(totalType, fiscalYear, f.startDate, f.endDate, f.toDate, f.company, f.development),
    fetchGoalAgg(onlineType, fiscalYear, f.startDate, f.endDate, f.toDate, f.company, f.development),
    fetchGoalAgg(onsiteType, fiscalYear, f.startDate, f.endDate, f.toDate, f.company, f.development),
  ]);

  const sum = (filter?: (r: FunnelRow) => boolean) =>
    rows.reduce((t, r) => (!filter || filter(r) ? t + n(r.N) : t), 0);

  const total = sum();
  const online = sum((r) => r.CHANNEL === "Online");
  const onsite = sum((r) => r.CHANNEL === "Onsite");
  const fullSpanGoal = totalGoals.reduce((t, r) => t + n(r.FULL_SPAN), 0);
  const toDateGoal = totalGoals.reduce((t, r) => t + n(r.TO_DATE), 0);
  const goalSum = (
    goals: GoalAgg[],
    kind: "FULL_SPAN" | "TO_DATE",
    company?: string,
    development?: string,
  ) =>
    goals.reduce(
      (t, r) =>
        (!company || r.COMPANY_NAME === company) &&
        (!development || r.DEVELOPMENT_NAME === development)
          ? t + n(r[kind])
          : t,
      0,
    );

  // Monthly trend with monthly goal line (from the resolved total goal type)
  const goalByMonth = new Map<number, number>();
  for (const g of totalGoals) {
    goalByMonth.set(n(g.M), (goalByMonth.get(n(g.M)) ?? 0) + n(g.FULL_SPAN));
  }
  const startM = new Date(f.startDate + "T00:00:00").getMonth() + 1;
  const endM = new Date(f.endDate + "T00:00:00").getMonth() + 1;
  const monthly = [];
  for (let m = startM; m <= endM; m++) {
    monthly.push({
      month: m,
      total: sum((r) => n(r.M) === m),
      online: sum((r) => n(r.M) === m && r.CHANNEL === "Online"),
      onsite: sum((r) => n(r.M) === m && r.CHANNEL === "Onsite"),
      goal: goalByMonth.get(m) ?? 0,
    });
  }

  // Lead source breakdown
  const bySource = new Map<string, number>();
  for (const r of rows) {
    const key = r.SOURCE ?? "Unknown";
    bySource.set(key, (bySource.get(key) ?? 0) + n(r.N));
  }
  const sources = [...bySource.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // Division / development tables
  const companies = new Set<string>();
  for (const r of rows) if (r.COMPANY_NAME) companies.add(r.COMPANY_NAME);
  for (const g of totalGoals) if (g.COMPANY_NAME) companies.add(g.COMPANY_NAME);
  const divisions = [...companies].sort().map((company) => {
    const cTotal = sum((r) => r.COMPANY_NAME === company);
    const td = goalSum(totalGoals, "TO_DATE", company);
    return {
      division: company,
      total: cTotal,
      online: sum((r) => r.COMPANY_NAME === company && r.CHANNEL === "Online"),
      onsite: sum((r) => r.COMPANY_NAME === company && r.CHANNEL === "Onsite"),
      toDateGoal: td,
      ptgPercent: ptg(cTotal, td),
    };
  });

  const pairs = new Map<string, { company: string; development: string }>();
  const addPair = (c: string | null, d: string | null) => {
    if (c && d) pairs.set(`${c}\u0000${d}`, { company: c, development: d });
  };
  for (const r of rows) addPair(r.COMPANY_NAME, r.DEVELOPMENT_NAME);
  for (const g of totalGoals) addPair(g.COMPANY_NAME, g.DEVELOPMENT_NAME);
  const developments = [...pairs.values()]
    .sort(
      (a, b) =>
        a.company.localeCompare(b.company) || a.development.localeCompare(b.development),
    )
    .map(({ company, development }) => {
      const dTotal = sum(
        (r) => r.COMPANY_NAME === company && r.DEVELOPMENT_NAME === development,
      );
      const td = goalSum(totalGoals, "TO_DATE", company, development);
      return {
        development,
        division: company,
        total: dTotal,
        online: sum(
          (r) =>
            r.COMPANY_NAME === company &&
            r.DEVELOPMENT_NAME === development &&
            r.CHANNEL === "Online",
        ),
        onsite: sum(
          (r) =>
            r.COMPANY_NAME === company &&
            r.DEVELOPMENT_NAME === development &&
            r.CHANNEL === "Onsite",
        ),
        toDateGoal: td,
        ptgPercent: ptg(dTotal, td),
      };
    });

  return {
    metric,
    kpis: {
      total,
      online,
      onsite,
      fullSpanGoal,
      toDateGoal,
      ptgPercent: ptg(total, toDateGoal),
      onlineToDateGoal: goalSum(onlineGoals, "TO_DATE"),
      onlinePtgPercent: ptg(online, goalSum(onlineGoals, "TO_DATE")),
      onsiteToDateGoal: goalSum(onsiteGoals, "TO_DATE"),
      onsitePtgPercent: ptg(onsite, goalSum(onsiteGoals, "TO_DATE")),
    },
    monthly,
    sources,
    divisions,
    developments,
  };
}

// ---------- EHI Goals ----------

const GOAL_METRIC_LABELS: Record<MetricKey, string> = {
  web_traffic: "Website Traffic",
  leads: "Total Leads",
  online_leads: "Online Leads",
  onsite_leads: "Onsite Leads",
  first_tours: "Total First Tours",
  online_first_tours: "Online First Tours",
  onsite_first_tours: "Onsite First Tours",
  gross_sales: "Gross Sales",
  online_gross_sales: "Online Gross Sales",
  onsite_gross_sales: "Onsite Gross Sales",
};

const GOAL_METRICS: MetricKey[] = Object.keys(GOAL_METRIC_LABELS) as MetricKey[];

export async function getEhiGoals(f: DashboardFilters) {
  const fiscalYear = new Date(f.startDate + "T00:00:00").getFullYear();
  const asOf = new Date(f.toDate + "T00:00:00");
  const available = await listGoalTypes(fiscalYear);

  const typeByMetric = new Map<MetricKey, string>();
  for (const m of GOAL_METRICS) {
    const gt = resolveGoalType(available, f.target, m, asOf);
    if (gt) typeByMetric.set(m, gt);
  }
  const types = [...new Set(typeByMetric.values())];

  const goalRows =
    types.length === 0
      ? []
      : await cached(`ehiGoals:${fiscalYear}:${JSON.stringify([types, f])}`, () =>
          querySnowflake<{
            GOAL_TYPE: string;
            COMPANY_NAME: string | null;
            FULL_SPAN: number;
            TO_DATE: number;
          }>(
            `SELECT GOAL_TYPE, COMPANY_NAME,
                    SUM(GOAL) AS FULL_SPAN,
                    SUM(IFF(BUDGET_DATE <= ?, GOAL, 0)) AS TO_DATE
             FROM DM_GOALS
             WHERE FISCAL_YEAR = ? AND GOAL_TYPE IN (${types.map(() => "?").join(",")})
               AND BUDGET_DATE BETWEEN ? AND ?
             GROUP BY 1, 2`,
            [f.toDate, fiscalYear, ...types, f.startDate, f.endDate],
          ),
        );

  // Actuals for the same window (start → toDate)
  const [contactRows, dealRows, gaRows] = await Promise.all([
    cached(`ehiActs:contacts:${f.startDate}:${f.toDate}`, () =>
      querySnowflake<{ KIND: string; CHANNEL: string | null; COMPANY_NAME: string | null; N: number }>(
        `SELECT 'leads' AS KIND, C.ONSITE_ONLINE_SOURCE_CHANNEL AS CHANNEL,
                D.COMPANY_NAME, COUNT(*) AS N
         FROM DM_CONTACTS C
         LEFT JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
         WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
         GROUP BY 1, 2, 3
         UNION ALL
         SELECT 'tours', C.ONSITE_ONLINE_SOURCE_CHANNEL, D.COMPANY_NAME, COUNT(*)
         FROM DM_CONTACTS C
         LEFT JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
         WHERE C.EHI_LEAD = 1 AND C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?
         GROUP BY 1, 2, 3`,
        [f.startDate, f.toDate, f.startDate, f.toDate],
      ),
    ),
    cached(`ehiActs:deals:${f.startDate}:${f.toDate}`, () =>
      querySnowflake<{ CHANNEL: string | null; COMPANY_NAME: string | null; N: number }>(
        `SELECT X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL AS CHANNEL, D.COMPANY_NAME, COUNT(*) AS N
         FROM DM_DEALS X
         LEFT JOIN ${DEV_DIM} D ON X.DEAL_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
         WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
           AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
         GROUP BY 1, 2`,
        [f.startDate, f.toDate],
      ),
    ),
    cached(`ehiActs:ga:${f.startDate}:${f.toDate}`, () =>
      querySnowflake<{ COMPANY_NAME: string | null; G_COMPANY: number; USERS: number }>(
        `SELECT MATCHED_COMPANY_NAME AS COMPANY_NAME,
                GROUPING(MATCHED_COMPANY_NAME) AS G_COMPANY,
                COUNT(DISTINCT USER_PSEUDO_ID) AS USERS
         FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
         WHERE PROPERTY = 'Esperanza Homes' AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?
         GROUP BY GROUPING SETS ((), (MATCHED_COMPANY_NAME))`,
        [f.startDate, f.toDate],
      ),
    ),
  ]);

  const actualFor = (metric: MetricKey, company?: string): number => {
    const match = (kind: string, channel?: string) =>
      contactRows.reduce(
        (t, r) =>
          r.KIND === kind &&
          (!channel || r.CHANNEL === channel) &&
          (!company || r.COMPANY_NAME === company)
            ? t + n(r.N)
            : t,
        0,
      );
    const deals = (channel?: string) =>
      dealRows.reduce(
        (t, r) =>
          (!channel || r.CHANNEL === channel) && (!company || r.COMPANY_NAME === company)
            ? t + n(r.N)
            : t,
        0,
      );
    switch (metric) {
      case "web_traffic": {
        const row = company
          ? gaRows.find((r) => n(r.G_COMPANY) === 0 && r.COMPANY_NAME === company)
          : gaRows.find((r) => n(r.G_COMPANY) === 1);
        return n(row?.USERS);
      }
      case "leads":
        return match("leads");
      case "online_leads":
        return match("leads", "Online");
      case "onsite_leads":
        return match("leads", "Onsite");
      case "first_tours":
        return match("tours");
      case "online_first_tours":
        return match("tours", "Online");
      case "onsite_first_tours":
        return match("tours", "Onsite");
      case "gross_sales":
        return deals();
      case "online_gross_sales":
        return deals("Online");
      case "onsite_gross_sales":
        return deals("Onsite");
    }
  };

  const goalFor = (metric: MetricKey, kind: "FULL_SPAN" | "TO_DATE", company?: string) => {
    const gt = typeByMetric.get(metric);
    if (!gt) return 0;
    return goalRows.reduce(
      (t, r) =>
        r.GOAL_TYPE === gt && (!company || r.COMPANY_NAME === company)
          ? t + n(r[kind])
          : t,
      0,
    );
  };

  const metrics = GOAL_METRICS.map((metric) => {
    const actual = actualFor(metric);
    const toDateGoal = goalFor(metric, "TO_DATE");
    const fullYearGoal = goalFor(metric, "FULL_SPAN");
    return {
      metric,
      label: GOAL_METRIC_LABELS[metric],
      goalType: typeByMetric.get(metric) ?? null,
      fullYearGoal,
      toDateGoal,
      actual,
      attainmentPct: fullYearGoal ? (actual / fullYearGoal) * 100 : null,
      ptgPercent: ptg(actual, toDateGoal),
    };
  });

  const companies = new Set<string>();
  for (const r of goalRows) if (r.COMPANY_NAME) companies.add(r.COMPANY_NAME);
  const coreMetrics: MetricKey[] = ["web_traffic", "leads", "first_tours", "gross_sales"];
  const divisions = [...companies].sort().flatMap((company) =>
    coreMetrics.map((metric) => {
      const actual = actualFor(metric, company);
      const toDateGoal = goalFor(metric, "TO_DATE", company);
      return {
        division: company,
        metric,
        label: GOAL_METRIC_LABELS[metric],
        toDateGoal,
        actual,
        ptgPercent: ptg(actual, toDateGoal),
      };
    }),
  );

  return { metrics, divisions };
}

// ---------- Community List ----------

export async function getCommunityList() {
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const today = new Date().toISOString().slice(0, 10);
  return cached(`communities:${today}`, async () => {
    const rows = await querySnowflake<{
      DEVELOPMENT_NAME: string;
      COMPANY_NAME: string;
      CITY: string | null;
      STATE: string | null;
      POSTAL_CODE: string | null;
      RENTAL_COMMUNITY_FLAG: string | null;
      DEVELOPMENT_HAS_GOALS_FLAG: string | null;
      LEADS_YTD: number;
      TOURS_YTD: number;
      SALES_YTD: number;
    }>(
      `WITH DIM AS (
         SELECT COMPANY_NAME, DEVELOPMENT_NAME, CITY, STATE, POSTAL_CODE,
                RENTAL_COMMUNITY_FLAG, DEVELOPMENT_HAS_GOALS_FLAG
         FROM DM_COMPANY_DEVELOPMENT
         WHERE COMPANY_NAME ILIKE '%esperanza%'
         QUALIFY ROW_NUMBER() OVER (
           PARTITION BY DEVELOPMENT_NAME
           ORDER BY DEVELOPMENT_HAS_GOALS_FLAG DESC NULLS LAST, COMPANY_NAME
         ) = 1
       ),
       L AS (
         SELECT CONTACT_EHI_COMMUNITY_OF_INTEREST AS DEV, COUNT(*) AS LEADS
         FROM DM_CONTACTS
         WHERE EHI_LEAD = 1 AND CONTACT_CREATE_DATE BETWEEN ? AND ?
         GROUP BY 1
       ),
       T AS (
         SELECT CONTACT_EHI_COMMUNITY_OF_INTEREST AS DEV, COUNT(*) AS TOURS
         FROM DM_CONTACTS
         WHERE EHI_LEAD = 1 AND EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?
         GROUP BY 1
       ),
       S AS (
         SELECT DEAL_EHI_COMMUNITY_OF_INTEREST AS DEV, COUNT(*) AS SALES
         FROM DM_DEALS
         WHERE PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
           AND CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
         GROUP BY 1
       )
       SELECT DIM.DEVELOPMENT_NAME, DIM.COMPANY_NAME, DIM.CITY, DIM.STATE, DIM.POSTAL_CODE,
              DIM.RENTAL_COMMUNITY_FLAG, DIM.DEVELOPMENT_HAS_GOALS_FLAG,
              COALESCE(L.LEADS, 0) AS LEADS_YTD,
              COALESCE(T.TOURS, 0) AS TOURS_YTD,
              COALESCE(S.SALES, 0) AS SALES_YTD
       FROM DIM
       LEFT JOIN L ON L.DEV = DIM.DEVELOPMENT_NAME
       LEFT JOIN T ON T.DEV = DIM.DEVELOPMENT_NAME
       LEFT JOIN S ON S.DEV = DIM.DEVELOPMENT_NAME
       ORDER BY DIM.COMPANY_NAME, DIM.DEVELOPMENT_NAME`,
      [yearStart, today, yearStart, today, yearStart, today],
    );
    return {
      communities: rows.map((r) => ({
        development: r.DEVELOPMENT_NAME,
        division: r.COMPANY_NAME,
        city: r.CITY ?? "",
        state: r.STATE ?? "",
        postalCode: r.POSTAL_CODE ?? "",
        isRental: r.RENTAL_COMMUNITY_FLAG === "Yes" || r.RENTAL_COMMUNITY_FLAG === "TRUE",
        hasGoals:
          r.DEVELOPMENT_HAS_GOALS_FLAG === "Yes" || r.DEVELOPMENT_HAS_GOALS_FLAG === "TRUE",
        leadsYtd: n(r.LEADS_YTD),
        toursYtd: n(r.TOURS_YTD),
        salesYtd: n(r.SALES_YTD),
      })),
    };
  });
}
