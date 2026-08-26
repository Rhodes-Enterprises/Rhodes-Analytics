import { querySnowflake } from "./snowflake";

/**
 * Data layer for the "Rhodes Living Leasing" dashboard.
 * Sources: DM_DEALS ('Rhodes Living Pipeline'; LEASE_RATIFIED_DATE /
 * CANCELLATION_DATE) and DM_GOALS (RL_* goal types, daily-distributed).
 *
 * Notes:
 * - Community lives in RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL; the raw data
 *   contains trailing-space variants ("Belterra "), so it is always TRIMmed.
 * - Goals exist for ratified leases only (RL_Leases_Ratified + Online/Onsite
 *   splits); older fiscal years used RL_Leases, which is used as a fallback.
 * - There is no cancellation goal; net leases are compared against the
 *   ratified goal.
 */

// ---------- Small in-memory cache (per-process, TTL) ----------

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await fn();
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

export interface LeasingFilters {
  community?: string;
  channel?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  toDate: string; // YYYY-MM-DD (elapsed cutoff)
}

const RL_PIPELINE = "Rhodes Living Pipeline";

type GoalMetric = "total" | "online" | "onsite";

// ---------- Goal type resolution ----------

async function listGoalTypes(fiscalYear: number): Promise<string[]> {
  return cached(`rlGoalTypes:${fiscalYear}`, async () => {
    const rows = await querySnowflake<{ GOAL_TYPE: string }>(
      "SELECT DISTINCT GOAL_TYPE FROM DM_GOALS WHERE FISCAL_YEAR = ? AND GOAL_TYPE ILIKE 'RL\\_%'",
      [fiscalYear],
    );
    return rows.map((r) => r.GOAL_TYPE);
  });
}

/**
 * Resolve the RL lease goal type per metric. FY2026+ uses RL_Leases_Ratified
 * (+ RL_Online_/RL_Onsite_ splits); FY2025 only had RL_Leases (total).
 */
function resolveLeaseGoalTypes(available: string[]): Map<GoalMetric, string> {
  const set = new Set(available);
  const out = new Map<GoalMetric, string>();
  const pick = (metric: GoalMetric, candidates: string[]) => {
    for (const c of candidates) {
      if (set.has(c)) {
        out.set(metric, c);
        return;
      }
    }
  };
  pick("total", ["RL_Leases_Ratified", "RL_Leases"]);
  pick("online", ["RL_Online_Leases_Ratified"]);
  pick("onsite", ["RL_Onsite_Leases_Ratified"]);
  return out;
}

// ---------- Upstream funnel (traffic → leads → tours → move-ins) ----------

type FunnelStage = "webTraffic" | "leads" | "firstTours" | "moveIns";

/**
 * Goal type candidates per funnel stage/metric, newest naming first.
 * FY2025 only had RL_Leads / RL_Tours (no traffic or move-in goals);
 * FY2026 added RL_Web_Traffic, RL_First_Tours (+channel splits), RL_Move_Ins.
 */
const FUNNEL_GOAL_CANDIDATES: Record<FunnelStage, Record<GoalMetric, string[]>> = {
  webTraffic: { total: ["RL_Web_Traffic"], online: [], onsite: [] },
  leads: {
    total: ["RL_Leads"],
    online: ["RL_Online_Leads"],
    onsite: ["RL_Onsite_Leads"],
  },
  firstTours: {
    total: ["RL_First_Tours", "RL_Tours"],
    online: ["RL_Online_First_Tours"],
    onsite: ["RL_Onsite_First_Tours"],
  },
  moveIns: { total: ["RL_Move_Ins"], online: [], onsite: [] },
};

function resolveFunnelGoalTypes(available: string[]): Map<string, string> {
  const set = new Set(available);
  const out = new Map<string, string>();
  for (const stage of Object.keys(FUNNEL_GOAL_CANDIDATES) as FunnelStage[]) {
    for (const metric of ["total", "online", "onsite"] as GoalMetric[]) {
      for (const c of FUNNEL_GOAL_CANDIDATES[stage][metric]) {
        if (set.has(c)) {
          out.set(`${stage}:${metric}`, c);
          break;
        }
      }
    }
  }
  return out;
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
  f: LeasingFilters,
  fiscalYear: number,
  types: string[],
): Promise<GoalRow[]> {
  if (types.length === 0) return [];
  const placeholders = types.map(() => "?").join(",");
  const binds: (string | number)[] = [f.toDate, fiscalYear, ...types, f.startDate, f.endDate];
  let communitySql = "";
  if (f.community) {
    communitySql = " AND DEVELOPMENT_NAME = ?";
    binds.push(f.community);
  }
  const sql = `
    SELECT GOAL_TYPE, COMPANY_NAME, DEVELOPMENT_NAME,
           SUM(GOAL) AS FULL_SPAN,
           SUM(IFF(BUDGET_DATE <= ?, GOAL, 0)) AS TO_DATE
    FROM DM_GOALS
    WHERE FISCAL_YEAR = ?
      AND GOAL_TYPE IN (${placeholders})
      AND BUDGET_DATE BETWEEN ? AND ?${communitySql}
    GROUP BY 1, 2, 3`;
  return cached(`rlGoals:${JSON.stringify([f, fiscalYear, types])}`, () =>
    querySnowflake<GoalRow>(sql, binds),
  );
}

interface LeaseRow {
  COMMUNITY: string | null;
  CHANNEL: string | null;
  N: number;
}

/** Count RL deals by community/channel over a date column within the range. */
async function fetchLeaseCounts(
  f: LeasingFilters,
  dateCol: "LEASE_RATIFIED_DATE" | "CANCELLATION_DATE",
): Promise<LeaseRow[]> {
  const binds: (string | number)[] = [f.startDate, f.toDate];
  const parts: string[] = [];
  if (f.community) {
    parts.push("TRIM(X.RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) = ?");
    binds.push(f.community);
  }
  if (f.channel) {
    parts.push("X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    binds.push(f.channel);
  }
  const extra = parts.length ? ` AND ${parts.join(" AND ")}` : "";
  const sql = `
    SELECT TRIM(X.RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) AS COMMUNITY,
           X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL AS CHANNEL,
           COUNT(*) AS N
    FROM DM_DEALS X
    WHERE X.PIPELINE_NAME = '${RL_PIPELINE}'
      AND X.${dateCol} BETWEEN ? AND ?${extra}
    GROUP BY 1, 2`;
  return cached(`rlLeases:${dateCol}:${JSON.stringify(f)}`, () =>
    querySnowflake<LeaseRow>(sql, binds),
  );
}

/** Count RL web sessions (GA session starts for the Rhodes Living property). */
async function fetchTrafficCount(f: LeasingFilters): Promise<number> {
  const binds: (string | number)[] = [f.startDate, f.toDate];
  let communitySql = "";
  if (f.community) {
    communitySql = " AND MATCHED_DEVELOPMENT_NAME = ?";
    binds.push(f.community);
  }
  const sql = `
    SELECT COUNT(*) AS N
    FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
    WHERE PROPERTY = 'Rhodes Living'
      AND IS_SESSION_START = 'Yes'
      AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?${communitySql}`;
  return cached(`rlTraffic:${JSON.stringify(f)}`, async () => {
    const rows = await querySnowflake<{ N: number }>(sql, binds);
    return Number(rows[0]?.N) || 0;
  });
}

/**
 * Count RL contacts by community/channel for a funnel stage.
 * - leads: contacts created in range with an RL community of interest
 * - firstTours: contacts whose first RL tour date falls in range
 * - moveIns: contacts whose first RL move-in date falls in range
 */
async function fetchContactStageCounts(
  f: LeasingFilters,
  stage: "leads" | "firstTours" | "moveIns",
): Promise<LeaseRow[]> {
  const dateExpr = {
    leads: "X.CONTACT_CREATE_DATE",
    firstTours: "X.RL_MIN_FIRST_TOUR_DATE",
    moveIns: "TO_DATE(X.RL_MIN_MOVE_IN_DATE)",
  }[stage];
  const binds: (string | number)[] = [f.startDate, f.toDate];
  const parts: string[] = [];
  if (stage === "leads") {
    // A lead is a contact with an RL community of interest.
    parts.push(
      "X.RL_COMMUNITY_OF_INTEREST IS NOT NULL AND TRIM(X.RL_COMMUNITY_OF_INTEREST) NOT IN ('', '(No Value)')",
    );
  }
  if (f.community) {
    parts.push("TRIM(X.RL_COMMUNITY_OF_INTEREST) = ?");
    binds.push(f.community);
  }
  if (f.channel) {
    parts.push("X.ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    binds.push(f.channel);
  }
  const extra = parts.length ? ` AND ${parts.join(" AND ")}` : "";
  const sql = `
    SELECT TRIM(X.RL_COMMUNITY_OF_INTEREST) AS COMMUNITY,
           X.ONSITE_ONLINE_SOURCE_CHANNEL AS CHANNEL,
           COUNT(*) AS N
    FROM DM_CONTACTS X
    WHERE ${dateExpr} BETWEEN ? AND ?${extra}
    GROUP BY 1, 2`;
  return cached(`rlFunnel:${stage}:${JSON.stringify(f)}`, () =>
    querySnowflake<LeaseRow>(sql, binds),
  );
}

interface MonthlyRow {
  M: number;
  N: number;
}

/** Monthly actuals honor the requested range: startDate → toDate (elapsed). */
async function fetchMonthly(
  f: LeasingFilters,
  dateCol: "LEASE_RATIFIED_DATE" | "CANCELLATION_DATE",
): Promise<MonthlyRow[]> {
  const binds: (string | number)[] = [f.startDate, f.toDate];
  const parts: string[] = [];
  if (f.community) {
    parts.push("TRIM(X.RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) = ?");
    binds.push(f.community);
  }
  if (f.channel) {
    parts.push("X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    binds.push(f.channel);
  }
  const extra = parts.length ? ` AND ${parts.join(" AND ")}` : "";
  const sql = `
    SELECT MONTH(X.${dateCol}) AS M, COUNT(*) AS N
    FROM DM_DEALS X
    WHERE X.PIPELINE_NAME = '${RL_PIPELINE}'
      AND X.${dateCol} BETWEEN ? AND ?${extra}
    GROUP BY 1`;
  return cached(`rlMonthly:${dateCol}:${JSON.stringify(f)}`, () =>
    querySnowflake<MonthlyRow>(sql, binds),
  );
}

/** Monthly goals cover the full requested span: startDate → endDate. */
async function fetchMonthlyGoal(
  f: LeasingFilters,
  fiscalYear: number,
  goalType: string | undefined,
): Promise<MonthlyRow[]> {
  if (!goalType) return [];
  const binds: (string | number)[] = [fiscalYear, goalType, f.startDate, f.endDate];
  let communitySql = "";
  if (f.community) {
    communitySql = " AND DEVELOPMENT_NAME = ?";
    binds.push(f.community);
  }
  const sql = `
    SELECT MONTH(BUDGET_DATE) AS M, SUM(GOAL) AS N
    FROM DM_GOALS
    WHERE FISCAL_YEAR = ? AND GOAL_TYPE = ?
      AND BUDGET_DATE BETWEEN ? AND ?${communitySql}
    GROUP BY 1`;
  return cached(
    `rlMonthlyGoal:${fiscalYear}:${goalType}:${f.startDate}:${f.endDate}:${f.community ?? ""}`,
    () => querySnowflake<MonthlyRow>(sql, binds),
  );
}

// ---------- Helpers ----------

function ptg(actual: number, goal: number): number | null {
  if (!goal) return null;
  return (actual / goal - 1) * 100;
}

function sumRows(
  rows: LeaseRow[],
  filter?: (r: LeaseRow) => boolean,
): number {
  let total = 0;
  for (const r of rows) if (!filter || filter(r)) total += Number(r.N) || 0;
  return total;
}

// ---------- Filter options ----------

export async function getLeasingFilterOptions() {
  return cached("rlFilterOptions", async () => {
    const [dealCommunities, goalCommunities, channels] = await Promise.all([
      querySnowflake<{ C: string }>(
        `SELECT DISTINCT TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) AS C
         FROM DM_DEALS
         WHERE PIPELINE_NAME = '${RL_PIPELINE}'
           AND RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL IS NOT NULL
           AND TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) NOT IN ('', '(No Value)')`,
      ),
      querySnowflake<{ C: string }>(
        `SELECT DISTINCT DEVELOPMENT_NAME AS C
         FROM DM_GOALS
         WHERE GOAL_TYPE ILIKE 'RL\\_%' AND DEVELOPMENT_NAME IS NOT NULL`,
      ),
      querySnowflake<{ CH: string }>(
        `SELECT DISTINCT DEAL_ONSITE_ONLINE_SOURCE_CHANNEL AS CH
         FROM DM_DEALS
         WHERE PIPELINE_NAME = '${RL_PIPELINE}'
           AND DEAL_ONSITE_ONLINE_SOURCE_CHANNEL IS NOT NULL
         ORDER BY 1`,
      ),
    ]);
    // Union of communities that have deals and communities that have goals.
    const communities = [
      ...new Set([
        ...dealCommunities.map((r) => r.C),
        ...goalCommunities.map((r) => r.C),
      ]),
    ].sort();
    return {
      communities,
      channels: channels.map((r) => r.CH),
    };
  });
}

// ---------- Main dashboard payload ----------

export async function getLeasingDashboard(f: LeasingFilters) {
  const fiscalYear = new Date(f.startDate + "T00:00:00").getFullYear();

  const available = await listGoalTypes(fiscalYear);
  const goalTypeByMetric = resolveLeaseGoalTypes(available);
  const funnelGoalTypes = resolveFunnelGoalTypes(available);
  const types = [
    ...new Set([...goalTypeByMetric.values(), ...funnelGoalTypes.values()]),
  ];

  // When a channel filter is applied, every displayed target must share the
  // actuals' scope: "total"/"net" compare against that channel's goal, and
  // the opposite channel has no target (null PTG) rather than an
  // all-channel goal against a zero actual.
  const effectiveMetric = (metric: GoalMetric): GoalMetric | null => {
    if (f.channel === "Online") return metric === "onsite" ? null : "online";
    if (f.channel === "Onsite") return metric === "online" ? null : "onsite";
    return metric;
  };
  const trendGoalType = (() => {
    const m = effectiveMetric("total");
    return m ? goalTypeByMetric.get(m) : undefined;
  })();

  const [
    goals,
    ratified,
    cancelled,
    monthlyRatified,
    monthlyCancelled,
    monthlyGoal,
    traffic,
    leadRows,
    tourRows,
    moveInRows,
  ] = await Promise.all([
    fetchGoals(f, fiscalYear, types),
    fetchLeaseCounts(f, "LEASE_RATIFIED_DATE"),
    fetchLeaseCounts(f, "CANCELLATION_DATE"),
    fetchMonthly(f, "LEASE_RATIFIED_DATE"),
    fetchMonthly(f, "CANCELLATION_DATE"),
    fetchMonthlyGoal(f, fiscalYear, trendGoalType),
    fetchTrafficCount(f),
    fetchContactStageCounts(f, "leads"),
    fetchContactStageCounts(f, "firstTours"),
    fetchContactStageCounts(f, "moveIns"),
  ]);

  const goalTotal = (
    metric: GoalMetric,
    kind: "FULL_SPAN" | "TO_DATE",
    community?: string,
  ) => {
    const eff = effectiveMetric(metric);
    const gt = eff ? goalTypeByMetric.get(eff) : undefined;
    if (!gt) return 0;
    let total = 0;
    for (const r of goals) {
      if (r.GOAL_TYPE !== gt) continue;
      if (community && r.DEVELOPMENT_NAME !== community) continue;
      total += Number(r[kind]) || 0;
    }
    return total;
  };

  const actuals = {
    ratified: sumRows(ratified),
    onlineRatified: sumRows(ratified, (r) => r.CHANNEL === "Online"),
    onsiteRatified: sumRows(ratified, (r) => r.CHANNEL === "Onsite"),
    cancelled: sumRows(cancelled),
    net: sumRows(ratified) - sumRows(cancelled),
  };

  // KPI row
  const leaseGoal = goalTotal("total", "FULL_SPAN");
  const leaseTdGoal = goalTotal("total", "TO_DATE");
  const kpis = {
    leaseGoal,
    leaseTdGoal,
    leasesRatified: actuals.ratified,
    leasesCancelled: actuals.cancelled,
    netLeases: actuals.net,
    ptgVariance: actuals.ratified - leaseTdGoal,
    ptgPercent: ptg(actuals.ratified, leaseTdGoal),
  };

  // Upstream funnel — actuals vs the RL_* stage goals. Stages without a
  // channel-split goal (traffic, move-ins) show a null target when a channel
  // filter is applied rather than comparing against an all-channel goal.
  const funnelGoalTotal = (
    stage: FunnelStage,
    metric: GoalMetric,
    kind: "FULL_SPAN" | "TO_DATE",
  ) => {
    const eff = effectiveMetric(metric);
    const gt = eff ? funnelGoalTypes.get(`${stage}:${eff}`) : undefined;
    if (!gt) return 0;
    let total = 0;
    for (const r of goals) {
      if (r.GOAL_TYPE === gt) total += Number(r[kind]) || 0;
    }
    return total;
  };
  const funnelCell = (stage: FunnelStage, metric: GoalMetric, actual: number) => {
    const toDateGoal = funnelGoalTotal(stage, metric, "TO_DATE");
    return {
      fullSpanGoal: funnelGoalTotal(stage, metric, "FULL_SPAN"),
      toDateGoal,
      actual,
      ptgPercent: ptg(actual, toDateGoal),
    };
  };
  const funnel = {
    webTraffic: funnelCell("webTraffic", "total", traffic),
    leads: funnelCell("leads", "total", sumRows(leadRows)),
    onlineLeads: funnelCell(
      "leads",
      "online",
      sumRows(leadRows, (r) => r.CHANNEL === "Online"),
    ),
    onsiteLeads: funnelCell(
      "leads",
      "onsite",
      sumRows(leadRows, (r) => r.CHANNEL === "Onsite"),
    ),
    firstTours: funnelCell("firstTours", "total", sumRows(tourRows)),
    onlineFirstTours: funnelCell(
      "firstTours",
      "online",
      sumRows(tourRows, (r) => r.CHANNEL === "Online"),
    ),
    onsiteFirstTours: funnelCell(
      "firstTours",
      "onsite",
      sumRows(tourRows, (r) => r.CHANNEL === "Onsite"),
    ),
    moveIns: funnelCell("moveIns", "total", sumRows(moveInRows)),
  };

  // Goal matrix (ratified vs targets by channel; net vs the ratified goal)
  const cell = (metric: GoalMetric, actual: number) => ({
    fullSpanGoal: goalTotal(metric, "FULL_SPAN"),
    toDateGoal: goalTotal(metric, "TO_DATE"),
    actual,
    ptgPercent: ptg(actual, goalTotal(metric, "TO_DATE")),
  });
  const matrix = {
    total: cell("total", actuals.ratified),
    online: cell("online", actuals.onlineRatified),
    onsite: cell("onsite", actuals.onsiteRatified),
    net: cell("total", actuals.net),
  };

  // Community summary — union of communities present in goals or actuals.
  const names = new Set<string>();
  for (const r of goals) if (r.DEVELOPMENT_NAME) names.add(r.DEVELOPMENT_NAME);
  for (const r of ratified) if (r.COMMUNITY) names.add(r.COMMUNITY);
  for (const r of cancelled) if (r.COMMUNITY) names.add(r.COMMUNITY);
  names.delete("(No Value)");
  const communities = [...names].sort().map((community) => {
    const cRatified = sumRows(ratified, (r) => r.COMMUNITY === community);
    const cCancelled = sumRows(cancelled, (r) => r.COMMUNITY === community);
    const tdGoal = goalTotal("total", "TO_DATE", community);
    return {
      community,
      fullSpanGoal: goalTotal("total", "FULL_SPAN", community),
      toDateGoal: tdGoal,
      ratified: cRatified,
      onlineRatified: sumRows(
        ratified,
        (r) => r.COMMUNITY === community && r.CHANNEL === "Online",
      ),
      onsiteRatified: sumRows(
        ratified,
        (r) => r.COMMUNITY === community && r.CHANNEL === "Onsite",
      ),
      cancelled: cCancelled,
      net: cRatified - cCancelled,
      ptgPercent: ptg(cRatified, tdGoal),
    };
  });

  // Monthly trend across the fiscal year (unfiltered by the date range so the
  // chart always shows the full year context).
  const byMonth = (rows: MonthlyRow[], m: number) =>
    rows
      .filter((r) => Number(r.M) === m)
      .reduce((t, r) => t + (Number(r.N) || 0), 0);
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const rat = byMonth(monthlyRatified, m);
    const can = byMonth(monthlyCancelled, m);
    return {
      month: m,
      ratified: rat,
      cancelled: can,
      net: rat - can,
      goal: byMonth(monthlyGoal, m),
    };
  });

  return {
    filters: f,
    fiscalYear,
    goalTypes: Object.fromEntries(goalTypeByMetric),
    kpis,
    funnel,
    matrix,
    communities,
    monthly,
  };
}
