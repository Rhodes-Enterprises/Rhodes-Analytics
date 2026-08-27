/**
 * Leasing dashboard number regression audit.
 *
 * Compares the API's GET /api/dashboards/leasing response (kpis, goal
 * matrix, community summary, monthly series) against independent Snowflake
 * baseline queries with identical filters. Baselines are written directly
 * against DM_DEALS ('Rhodes Living Pipeline') and DM_GOALS (RL_* goal
 * types) using their own SQL — not the API's data layer — so a query or
 * aggregation change in the API that shifts the numbers fails the audit.
 *
 * Follows the same approach as audit-dashboard.ts (Overview with Targets):
 * - Besides the default (no query params) view, representative FILTERED
 *   requests are exercised — a community, a channel, and an explicit date
 *   range — with filter values picked dynamically from Snowflake (busiest
 *   in the default range). Missing values FAIL the audit rather than
 *   silently skipping a scenario.
 * - Every scenario independently computes the range the API must apply
 *   (requested dates, or the server's default calendar year) and asserts
 *   the response's appliedRange matches exactly, so an endpoint that
 *   ignores date parameters fails instead of being compared against its
 *   own wrong range. Baselines bind to the expected range, never to the
 *   response's echo of it.
 * - A PRIOR fiscal year scenario (the full previous calendar year)
 *   exercises the RL goal-type fallback: FY2025 only has RL_Leases, while
 *   FY2026+ uses RL_Leases_Ratified. The scenario resolves the goal type
 *   actually present for that year from Snowflake and FAILS LOUDLY when
 *   the prior year has no RL goal data at all — otherwise every goal
 *   check would compare 0 == 0 and pass while covering nothing.
 * - Funnel table baselines: every cell of the funnel totals table
 *   (webTraffic/leads/firstTours/moveIns plus the online/onsite lead and
 *   tour splits) is recomputed with the audit's own SQL — GA session starts
 *   from FCT_GOOGLE_ANALYTICS_EVENT_LEVEL, stage counts from DM_CONTACTS
 *   (stage date columns + the RL community-of-interest lead definition),
 *   and stage goals from DM_GOALS (RL_* stage goal types with the FY2025
 *   RL_Leads/RL_Tours fallback). This is what catches the totals and
 *   monthly queries drifting TOGETHER (wrong date column, dropped filter),
 *   which the chart-vs-table consistency net below cannot see. BOTH
 *   literal channels (Online, Onsite) always get these baselines: the
 *   channel filter swaps in per-channel goal types and blanks the opposite
 *   channel's targets, so funnel-only variants cover whichever literal
 *   channel(s) the busiest-channel scenario does not visit — the busiest
 *   channel can be a third label entirely (e.g. 'Unknown').
 * - Chart-vs-table consistency (funnel trend): the Monthly Trends chart's
 *   per-stage series (web traffic, leads, first tours, move-ins) and the
 *   funnel totals table in the SAME response are fed by different queries,
 *   so every scenario also asserts, per stage, Σ monthly actuals ==
 *   funnel.<stage>.actual and Σ monthly goals == funnel.<stage>.fullSpanGoal
 *   (float tolerance only — both sides aggregate the same data, so the
 *   audit-wide percentage tolerance would mask real drift). The funnel-only
 *   channel variants run this net too, so BOTH Online and Onsite are
 *   exercised even though the full scenarios only visit the busiest channel.
 * - Channel label-drift guards (default view): the audit and the API key
 *   their channel splits on the SAME hardcoded 'Online'/'Onsite' literals,
 *   on TWO different columns — DM_DEALS.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL
 *   for the lease matrix / community columns, and
 *   DM_CONTACTS.ONSITE_ONLINE_SOURCE_CHANNEL for the funnel's online/onsite
 *   lead and first-tour cells. If upstream data relabels either column's
 *   values (e.g. dbt renames 'Online' to 'Digital'), both sides compute 0,
 *   every check passes 0=0, and the dashboard ships zeroed online/onsite
 *   columns with no alarm — the funnel cells are especially exposed because
 *   they are otherwise only consistency-checked within one response, and
 *   their stage TOTALS stay non-zero so the requireFunnelData vacuity guard
 *   never trips. A materially non-zero total (ratified leases, funnel
 *   leads, funnel first tours) whose Online AND Onsite counts are BOTH
 *   zero therefore FAILS, naming the channel column, the expected labels,
 *   and the labels actually present. Quiet windows (total below
 *   AUDIT_CHANNEL_GUARD_MIN_TOTAL) are exempt so day one of a year cannot
 *   false-positive. Mirrors the chLabels guards in audit-dashboard.ts.
 *
 * Run from artifacts/api-server (API server must be running):
 *   pnpm run audit:leasing
 *
 * Env:
 *   AUDIT_API_BASE       base URL of the API (default http://localhost:$PORT/api,
 *                        falling back to port 8080)
 *   AUDIT_TOLERANCE_PCT  allowed relative divergence in percent (default 0.5)
 *   AUDIT_CHANNEL_GUARD_MIN_TOTAL
 *                        minimum total per guarded metric (ratified
 *                        leases, funnel leads, funnel first tours) for the
 *                        channel label-drift guards to judge a window
 *                        (default 10, same knob as audit-dashboard.ts)
 *
 * Exits 0 when all values match within tolerance, 1 otherwise.
 */

import { querySnowflake as rawQuerySnowflake } from "../src/lib/snowflake";
import { fetchJsonWithRetry } from "./lib/fetch-retry";

/**
 * The Snowflake proxy rate-limits per repl (~10 RPS). The audit fires
 * bursts of parallel baseline queries, so serialize them through a small
 * queue so the burst doesn't trip the limit in the first place. Transient
 * failures that still occur — 429s, dropped connections — are retried with
 * backoff inside the shared Snowflake helper (src/lib/snowflake.ts).
 */
let queue: Promise<unknown> = Promise.resolve();
function querySnowflake<T>(sql: string, binds?: (string | number)[]): Promise<T[]> {
  const run = (): Promise<T[]> => rawQuerySnowflake<T>(sql, binds);
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

const API_BASE =
  process.env.AUDIT_API_BASE ?? `http://localhost:${process.env.PORT ?? "8080"}/api`;
const TOLERANCE_PCT = Number(process.env.AUDIT_TOLERANCE_PCT ?? "0.5");

const CHANNEL_GUARD_MIN_TOTAL = Number(
  process.env.AUDIT_CHANNEL_GUARD_MIN_TOTAL ?? "10",
);

const RL_PIPELINE = "Rhodes Living Pipeline";

// ---------- Response shape (only the fields the audit checks) ----------

interface MatrixCell {
  fullSpanGoal: number;
  toDateGoal: number;
  actual: number;
  ptgPercent: number | null;
}

interface FunnelCell {
  fullSpanGoal: number;
  toDateGoal: number;
  actual: number;
}

interface CommunityRow {
  community: string;
  fullSpanGoal: number;
  toDateGoal: number;
  ratified: number;
  onlineRatified: number;
  onsiteRatified: number;
  cancelled: number;
  net: number;
}

interface MonthlyPoint {
  month: number;
  ratified: number;
  cancelled: number;
  net: number;
  goal: number;
  webTraffic: number;
  webTrafficGoal: number;
  leads: number;
  leadsGoal: number;
  firstTours: number;
  firstToursGoal: number;
  moveIns: number;
  moveInsGoal: number;
}

interface LeasingResponse {
  appliedRange: { startDate: string; endDate: string; toDate: string };
  fiscalYear: number;
  kpis: {
    leaseGoal: number;
    leaseTdGoal: number;
    leasesRatified: number;
    leasesCancelled: number;
    netLeases: number;
    ptgVariance: number;
  };
  funnel: {
    webTraffic: FunnelCell;
    leads: FunnelCell;
    onlineLeads: FunnelCell;
    onsiteLeads: FunnelCell;
    firstTours: FunnelCell;
    onlineFirstTours: FunnelCell;
    onsiteFirstTours: FunnelCell;
    moveIns: FunnelCell;
  };
  matrix: {
    total: MatrixCell;
    online: MatrixCell;
    onsite: MatrixCell;
    net: MatrixCell;
  };
  communities: CommunityRow[];
  monthly: MonthlyPoint[];
}

async function fetchLeasing(params: Record<string, string>): Promise<LeasingResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}/dashboards/leasing${qs ? `?${qs}` : ""}`;
  // On a cold cache the API fires its own burst of Snowflake queries, which
  // can trip the per-repl rate limit and surface as a transient 5xx;
  // fetchJsonWithRetry absorbs that (and dropped connections) with backoff.
  return fetchJsonWithRetry<LeasingResponse>(url);
}

// ---------- Expected range computation (independent of the API) ----------

function todayChicago(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date(),
  );
}

/** Default range the API applies with no date params: current calendar year. */
function defaultYearRange(): { startDate: string; endDate: string } {
  const year = todayChicago().slice(0, 4);
  return { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

/** Elapsed cutoff: today clamped into [startDate, endDate]. */
function expectedToDate(startDate: string, endDate: string): string {
  const today = todayChicago();
  return today < startDate ? startDate : today > endDate ? endDate : today;
}

// ---------- Scenarios ----------

interface ScenarioFilters {
  community?: string;
  channel?: string;
  startDate?: string;
  endDate?: string;
}

interface Scenario {
  name: string;
  filters: ScenarioFilters;
  /**
   * Fail the scenario when its fiscal year resolves no RL total goal type
   * or the goals within the range sum to zero. Set on the prior-year
   * scenario, which exists to pin the goal-type fallback: without goal
   * data every goal check compares 0 == 0 and would pass while testing
   * nothing.
   */
  requireGoalData?: boolean;
  /**
   * Run ONLY the funnel table Snowflake baselines and the funnel
   * trend-vs-totals consistency checks, skipping the lease KPI / matrix /
   * community / monthly baselines. Used to guarantee BOTH literal channels
   * (Online, Onsite) get full funnel baseline coverage — the channel filter
   * swaps per-channel goal types and blanks the opposite channel's targets,
   * semantics a consistency check between two API-derived series cannot
   * prove — without doubling the whole audit's query load. Needed because
   * the representative "busiest channel" scenario may land on a third
   * label (e.g. 'Unknown'), leaving both literal channels unvisited.
   */
  funnelOnly?: boolean;
  /**
   * Fail the funnel trend consistency check when every stage sums to zero
   * on both the actuals side and the goals side. Set on scenarios whose
   * data is known non-empty (default view, prior year): all-zero there
   * means the check verified nothing — e.g. the funnel and monthly queries
   * broke in unison or stage goal types silently resolved to none.
   */
  requireFunnelData?: boolean;
  /**
   * Run the channel label-drift guards: fail when a guarded total —
   * ratified leases on the deals side (auditChannelLabels), funnel leads /
   * first tours on the contacts side (auditFunnelChannelLabels) — is
   * materially non-zero but its Online AND Onsite counts are BOTH zero.
   * Set on the default view only: a channel-filtered scenario legitimately
   * zeroes the opposite channel.
   */
  withChannelLabelGuard?: boolean;
}

function toQueryParams(f: ScenarioFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.community) params.community = f.community;
  if (f.channel) params.channel = f.channel;
  if (f.startDate) params.startDate = f.startDate;
  if (f.endDate) params.endDate = f.endDate;
  return params;
}

// ---------- Independent baselines ----------

interface LeaseCounts {
  ratified: number;
  onlineRatified: number;
  onsiteRatified: number;
  cancelled: number;
}

/**
 * Headline lease-count baselines, honoring community/channel filters.
 *
 * ONE conditional-aggregation scan replaces the old four scalar COUNT
 * queries (ratified / online / onsite / cancelled): each COUNT_IF counts
 * exactly the rows the corresponding COUNT(*) query matched — the window
 * flags are the old BETWEEN predicates, the channel conditions the old
 * `DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?` extras. The outer WHERE only
 * drops rows in neither window, which contributed to no count anyway
 * (BETWEEN over a NULL date is NULL, and TRUE OR NULL is TRUE, so no
 * in-window row is lost). When the scenario's channel filter contradicts a
 * channel column (e.g. channel=Onsite makes CH='Online' impossible), that
 * COUNT_IF is structurally zero — matching the old skip-the-query-return-0
 * behavior. Batching matters because the Snowflake proxy rate-limits at
 * ~10 RPS repl-wide, so round trips — not warehouse work — dominate audit
 * wall time. Transient transport failures are retried inside the shared
 * helper (src/lib/snowflake.ts), unchanged.
 */
async function baselineLeaseCounts(
  startDate: string,
  toDate: string,
  f: ScenarioFilters,
): Promise<LeaseCounts> {
  // Bind order follows text order: the subquery SELECT-list window binds
  // come before the WHERE extras.
  const binds: (string | number)[] = [startDate, toDate, startDate, toDate];
  const parts: string[] = [];
  if (f.community) {
    parts.push("TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) = ?");
    binds.push(f.community);
  }
  if (f.channel) {
    parts.push("DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    binds.push(f.channel);
  }
  const extra = parts.length ? ` AND ${parts.join(" AND ")}` : "";
  const rows = await querySnowflake<{
    RATIFIED: number;
    ONLINE_RATIFIED: number;
    ONSITE_RATIFIED: number;
    CANCELLED: number;
  }>(
    `SELECT COUNT_IF(IN_RAT_WINDOW) AS RATIFIED,
            COUNT_IF(IN_RAT_WINDOW AND CH = 'Online') AS ONLINE_RATIFIED,
            COUNT_IF(IN_RAT_WINDOW AND CH = 'Onsite') AS ONSITE_RATIFIED,
            COUNT_IF(IN_CAN_WINDOW) AS CANCELLED
     FROM (
       SELECT LEASE_RATIFIED_DATE BETWEEN ? AND ? AS IN_RAT_WINDOW,
              CANCELLATION_DATE BETWEEN ? AND ? AS IN_CAN_WINDOW,
              DEAL_ONSITE_ONLINE_SOURCE_CHANNEL AS CH
       FROM DM_DEALS
       WHERE PIPELINE_NAME = '${RL_PIPELINE}'${extra}
     )
     WHERE IN_RAT_WINDOW OR IN_CAN_WINDOW`,
    binds,
  );
  const r = rows[0];
  return {
    ratified: Number(r?.RATIFIED) || 0,
    onlineRatified: Number(r?.ONLINE_RATIFIED) || 0,
    onsiteRatified: Number(r?.ONSITE_RATIFIED) || 0,
    cancelled: Number(r?.CANCELLED) || 0,
  };
}

/** RL goal types actually present in DM_GOALS for one fiscal year. */
async function fetchRlGoalTypes(fiscalYear: number): Promise<Set<string>> {
  const rows = await querySnowflake<{ GOAL_TYPE: string }>(
    "SELECT DISTINCT GOAL_TYPE FROM DM_GOALS WHERE FISCAL_YEAR = ? AND GOAL_TYPE ILIKE 'RL\\_%'",
    [fiscalYear],
  );
  return new Set(rows.map((r) => r.GOAL_TYPE));
}
/**
 * Resolve RL lease goal types independently of the API, per the documented
 * data model: FY2026+ uses RL_Leases_Ratified (+ Online/Onsite splits);
 * FY2025 only had RL_Leases as the total.
 */
function resolveGoalTypes(available: Set<string>): {
  total?: string;
  online?: string;
  onsite?: string;
} {
  const first = (...cands: string[]) => cands.find((c) => available.has(c));
  return {
    total: first("RL_Leases_Ratified", "RL_Leases"),
    online: first("RL_Online_Leases_Ratified"),
    onsite: first("RL_Onsite_Leases_Ratified"),
  };
}

/** Goal sums for one goal type, plus the per-month and per-community rollups. */
interface GoalSums {
  fullSpan: number;
  toDate: number;
  /** SUM(GOAL) per MONTH(BUDGET_DATE) over start..end — the monthly-series goal baseline. */
  byMonth: Map<number, number>;
  /** SUM(GOAL)/to-date per DEVELOPMENT_NAME — the community-summary goal baseline. */
  byCommunity: Map<string, { fullSpan: number; toDate: number }>;
}

const EMPTY_GOAL_SUMS: GoalSums = {
  fullSpan: 0,
  toDate: 0,
  byMonth: new Map(),
  byCommunity: new Map(),
};

/**
 * Full-span + to-date goal sums for several goal types in ONE query (the
 * funnel needs up to 6 types per scenario; grouping keeps the audit under
 * the Snowflake proxy rate limit).
 */
async function baselineGoalsByType(
  goalTypes: string[],
  fiscalYear: number,
  startDate: string,
  endDate: string,
  toDate: string,
  community?: string,
): Promise<Map<string, { fullSpan: number; toDate: number }>> {
  if (goalTypes.length === 0) return new Map();
  const placeholders = goalTypes.map(() => "?").join(",");
  const binds: (string | number)[] = [toDate, fiscalYear, ...goalTypes, startDate, endDate];
  let extra = "";
  if (community) {
    extra = " AND DEVELOPMENT_NAME = ?";
    binds.push(community);
  }
  const rows = await querySnowflake<{
    GOAL_TYPE: string;
    FULL_SPAN: number;
    TO_DATE: number;
  }>(
    `SELECT GOAL_TYPE, SUM(GOAL) AS FULL_SPAN,
            SUM(IFF(BUDGET_DATE <= ?, GOAL, 0)) AS TO_DATE
     FROM DM_GOALS
     WHERE FISCAL_YEAR = ? AND GOAL_TYPE IN (${placeholders})
       AND BUDGET_DATE BETWEEN ? AND ?${extra}
     GROUP BY 1`,
    binds,
  );
  return new Map(
    rows.map((r) => [
      r.GOAL_TYPE,
      { fullSpan: Number(r.FULL_SPAN) || 0, toDate: Number(r.TO_DATE) || 0 },
    ]),
  );
}

type FunnelStage = "webTraffic" | "leads" | "firstTours" | "moveIns";
let failures = 0;

function close(a: number, b: number): boolean {
  if (a === b) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return true;
  return (Math.abs(a - b) / denom) * 100 <= TOLERANCE_PCT;
}

function check(label: string, apiValue: number, baseline: number): void {
  if (close(apiValue, baseline)) {
    console.log(`  OK   ${label}: api=${apiValue} baseline=${baseline}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}: api=${apiValue} baseline=${baseline}`);
  }
}

/**
 * Float-precision comparison for consistency checks BETWEEN two fields of
 * the same API response. Unlike close(), no percentage tolerance applies:
 * both sides aggregate identical underlying data, so anything beyond
 * accumulated floating-point rounding (goals are daily-distributed
 * fractions summed in different groupings) is real drift. NaN — e.g. a
 * renamed or missing response field — never passes.
 */
function closeFloat(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 1e-6 + Math.max(Math.abs(a), Math.abs(b)) * 1e-9;
}

function checkFloat(label: string, chartValue: number, tableValue: number): void {
  if (closeFloat(chartValue, tableValue)) {
    console.log(`  OK   ${label}: chart=${chartValue} table=${tableValue}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}: chart=${chartValue} table=${tableValue}`);
  }
}

// ---------- Scenario execution ----------

async function auditScenario(scenario: Scenario): Promise<void> {
  const f = scenario.filters;
  console.log(`\n=== Scenario: ${scenario.name} ===`);
  const params = toQueryParams(f);
  console.log(
    `Params: ${Object.keys(params).length ? JSON.stringify(params) : "(none — default view)"}`,
  );

  const defaults = defaultYearRange();
  const expStart = f.startDate ?? defaults.startDate;
  const expEnd = f.endDate ?? defaults.endDate;
  const expTo = expectedToDate(expStart, expEnd);

  const resp = await fetchLeasing(params);
  const ar = resp.appliedRange;
  console.log(`Applied range: ${ar.startDate}..${ar.endDate}, toDate=${ar.toDate}`);
  if (ar.startDate !== expStart || ar.endDate !== expEnd || ar.toDate !== expTo) {
    failures++;
    console.error(
      `  FAIL appliedRange mismatch: expected ${expStart}..${expEnd} (toDate=${expTo}), ` +
        `got ${ar.startDate}..${ar.endDate} (toDate=${ar.toDate}) — the API did not honor the requested/default dates`,
    );
    return; // baselines against a wrong range would be meaningless
  }

  const fiscalYear = Number(expStart.slice(0, 4));
  if (resp.fiscalYear !== fiscalYear) {
    failures++;
    console.error(`  FAIL fiscalYear: api=${resp.fiscalYear} expected=${fiscalYear}`);
  }

  if (scenario.funnelOnly) {
    const availableGoalTypes = await fetchRlGoalTypes(fiscalYear);
    console.log("-- funnel table (funnel-only variant)");
    await auditFunnel(resp, f, scenario, availableGoalTypes, fiscalYear, expStart, expEnd, expTo);
    console.log("-- funnel trend vs totals");
    auditFunnelTrend(resp, scenario);
    return;
  }

  const availableGoalTypes = await fetchRlGoalTypes(fiscalYear);
  const gt = resolveGoalTypes(availableGoalTypes);
  console.log(
    `Resolved goal types (FY${fiscalYear}): total=${gt.total ?? "(none)"}, ` +
      `online=${gt.online ?? "(none)"}, onsite=${gt.onsite ?? "(none)"}`,
  );

  // Channel-scoped goal semantics (documented dashboard behavior): when a
  // channel filter is applied, "total"/"net" compare against that channel's
  // goal and the opposite channel has no target.
  const effGoalType = (metric: "total" | "online" | "onsite"): string | undefined => {
    if (f.channel === "Online") return metric === "onsite" ? undefined : gt.online;
    if (f.channel === "Onsite") return metric === "online" ? undefined : gt.onsite;
    return gt[metric];
  };

  // ---- Actual counts (bound to the expected range) ----
  const { ratified, cancelled, onlineRatified, onsiteRatified } = await baselineLeaseCounts(
    expStart,
    expTo,
    f,
  );

  // ---- Goals (one grouped query also feeds communities + monthly below) ----
  const goalFor = await baselineGoalsByType(
    [effGoalType("total"), effGoalType("online"), effGoalType("onsite")],
    fiscalYear,
    expStart,
    expEnd,
    expTo,
    f.community,
  );
  const gTotal = goalFor(effGoalType("total"));
  const gOnline = goalFor(effGoalType("online"));
  const gOnsite = goalFor(effGoalType("onsite"));

  // Scenarios that exist to pin goal behavior (the prior-year fallback)
  // must not "pass" by comparing zeros against zeros.
  if (scenario.requireGoalData && (!gt.total || gTotal.fullSpan === 0)) {
    failures++;
    console.error(
      `  FAIL no RL goal data for FY${fiscalYear}: total goal type=` +
        `${gt.total ?? "(none)"}, full-span goal sum=${gTotal.fullSpan} — ` +
        "this scenario pins the prior-year goal fallback, so empty goal data " +
        "means the fallback is NOT being tested (goals missing from DM_GOALS, " +
        "or the audit's prior-year selection needs updating)",
    );
  }

  // ---- KPIs ----
  console.log("-- kpis");
  check("kpis.leaseGoal", resp.kpis.leaseGoal, gTotal.fullSpan);
  check("kpis.leaseTdGoal", resp.kpis.leaseTdGoal, gTotal.toDate);
  check("kpis.leasesRatified", resp.kpis.leasesRatified, ratified);
  check("kpis.leasesCancelled", resp.kpis.leasesCancelled, cancelled);
  check("kpis.netLeases", resp.kpis.netLeases, ratified - cancelled);
  check("kpis.ptgVariance", resp.kpis.ptgVariance, ratified - gTotal.toDate);

  // ---- Goal matrix ----
  console.log("-- matrix");
  const checkCell = (
    name: string,
    cell: MatrixCell,
    goal: { fullSpan: number; toDate: number },
    actual: number,
  ) => {
    check(`matrix.${name}.fullSpanGoal`, cell.fullSpanGoal, goal.fullSpan);
    check(`matrix.${name}.toDateGoal`, cell.toDateGoal, goal.toDate);
    check(`matrix.${name}.actual`, cell.actual, actual);
  };
  checkCell("total", resp.matrix.total, gTotal, ratified);
  checkCell("online", resp.matrix.online, gOnline, onlineRatified);
  checkCell("onsite", resp.matrix.onsite, gOnsite, onsiteRatified);
  checkCell("net", resp.matrix.net, gTotal, ratified - cancelled);

  // ---- Channel label-drift guards ----
  if (scenario.withChannelLabelGuard) {
    console.log("-- channel label-drift guards");
    await auditChannelLabels(ratified, onlineRatified, onsiteRatified, expStart, expTo, f);
    await auditFunnelChannelLabels(expStart, expTo, f);
  }

  // ---- Community summary ----
  console.log("-- communities");
  await auditCommunities(resp, f, expStart, expTo, gTotal.byCommunity);

  // ---- Monthly series ----
  console.log("-- monthly");
  await auditMonthly(resp, f, expStart, expTo, gTotal.byMonth);

  // ---- Funnel table vs Snowflake baselines ----
  console.log("-- funnel table");
  await auditFunnel(resp, f, scenario, availableGoalTypes, fiscalYear, expStart, expEnd, expTo);

  // ---- Funnel trend vs totals (chart-vs-table consistency) ----
  console.log("-- funnel trend vs totals");
  auditFunnelTrend(resp, scenario);
}

/**
 * Shared judgment for one channel label-drift guard (mirrors the chLabels
 * guards in audit-dashboard.ts).
 *
 * The audit's channel counts and the API's channel split hardcode the same
 * 'Online'/'Onsite' literals. If upstream data relabels a channel column's
 * values (e.g. dbt renames 'Online' to 'Digital'), BOTH sides compute 0,
 * every check passes 0=0, and the leasing dashboard ships zeroed
 * online/onsite columns with no alarm. A materially non-zero total whose
 * two channel counts are BOTH zero is that signature: unlabeled rows
 * legitimately make online + onsite < total, but at volume they never take
 * both to exactly zero. Totals below CHANNEL_GUARD_MIN_TOTAL are treated as
 * too quiet to judge (e.g. day one of a year) and cannot false-positive.
 */
async function judgeChannelLabels(g: {
  /** Check name suffix: printed as chLabels:<metric>. */
  metric: string;
  /** What one counted row is, plural, for the messages. */
  noun: string;
  total: number;
  online: number;
  onsite: number;
  /** Channel column the dashboard keys this metric's split on. */
  column: string;
  /** Where the 'Online'/'Onsite' literals live (API and audit sides). */
  literalSites: string;
  /** Audited window, e.g. "2026-01-01..2026-08-26". */
  window: string;
  /** Labels actually present (COALESCE(col,'(null)') GROUP BY), on demand. */
  labelsPresent: () => Promise<string>;
}): Promise<void> {
  const name = `chLabels:${g.metric}`;
  if (g.total < CHANNEL_GUARD_MIN_TOTAL) {
    console.log(
      `  OK   ${name}: total=${g.total} < ${CHANNEL_GUARD_MIN_TOTAL} — window too quiet to judge label drift`,
    );
    return;
  }
  if (g.online > 0 || g.onsite > 0) {
    console.log(
      `  OK   ${name}: 'Online'/'Onsite' labels present (online=${g.online} onsite=${g.onsite} of ${g.total})`,
    );
    return;
  }
  const present = await g.labelsPresent();
  failures++;
  console.error(
    `  FAIL ${name}: ${g.total} ${g.noun} in ${g.window} but ZERO match 'Online' and ` +
      `ZERO match 'Onsite' on ${g.column} — the expected channel labels are missing ` +
      `from the data; labels present: ${present}. The leasing dashboard's channel ` +
      `split AND this audit both hardcode 'Online'/'Onsite' (${g.literalSites}), so ` +
      `the dashboard's online/onsite cells for this metric read 0 and every check ` +
      `passes 0=0. If upstream renamed the channel values, update those literals to ` +
      `the new labels.`,
  );
}

type FunnelCellName = keyof LeasingResponse["funnel"];
/**
 * Deals-side guard: the ratified-lease channel split
 * (DM_DEALS.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL). Reuses the online/onsite
 * lease-count baselines the scenario already computed via
 * baselineLeaseCounts, so the labels probe runs only on failure.
 */
async function auditChannelLabels(
  total: number,
  online: number,
  onsite: number,
  startDate: string,
  toDate: string,
  f: ScenarioFilters,
): Promise<void> {
  await judgeChannelLabels({
    metric: "ratified",
    noun: "ratified leases",
    total,
    online,
    onsite,
    column: "DM_DEALS.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL",
    literalSites:
      "r.CHANNEL === ... over fetchLeaseCounts rows in src/lib/leasing.ts; " +
      "the channel COUNT_IFs in baselineLeaseCounts/auditCommunities here",
    window: `${startDate}..${toDate}`,
    labelsPresent: async () => {
      // Fetch the labels actually present so the failure names the fix.
      const binds: (string | number)[] = [startDate, toDate];
      let extra = "";
      if (f.community) {
        extra = " AND TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) = ?";
        binds.push(f.community);
      }
      const labelRows = await querySnowflake<{ LABEL: string; N: number }>(
        `SELECT COALESCE(DEAL_ONSITE_ONLINE_SOURCE_CHANNEL, '(null)') AS LABEL, COUNT(*) AS N
         FROM DM_DEALS
         WHERE PIPELINE_NAME = '${RL_PIPELINE}' AND LEASE_RATIFIED_DATE BETWEEN ? AND ?${extra}
         GROUP BY 1 ORDER BY N DESC`,
        binds,
      );
      return (
        labelRows.map((r) => `'${r.LABEL}' (${Number(r.N) || 0})`).join(", ") || "(no rows)"
      );
    },
  });
}

/**
 * Contacts-side guard: the funnel's Online/Onsite lead and first-tour cells
 * key on a DIFFERENT column than the lease matrix —
 * DM_CONTACTS.ONSITE_ONLINE_SOURCE_CHANNEL (funnel.onlineLeads/onsiteLeads/
 * onlineFirstTours/onsiteFirstTours split fetchContactStageCounts rows via
 * r.CHANNEL === 'Online'/'Onsite' in src/lib/leasing.ts) — so the
 * deals-side guard above cannot catch a relabel here. Those funnel cells
 * are otherwise only consistency-checked (chart vs table within ONE
 * response): a contacts-side relabel zeroes both sides in unison and
 * passes 0=0, while the stage TOTALS stay non-zero so requireFunnelData
 * does not trip either. This guard is that blind spot's detection net.
 *
 * One COALESCE(col,'(null)') GROUP BY probe per stage doubles as count
 * source and diagnostics: total = Σ all labels, online/onsite = the
 * expected labels' rows, and the label list feeds the failure message
 * directly. Row definitions mirror fetchContactStageCounts: leads =
 * contacts created in range with a real RL community of interest; first
 * tours = contacts whose first RL tour date falls in range.
 */
async function auditFunnelChannelLabels(
  startDate: string,
  toDate: string,
  f: ScenarioFilters,
): Promise<void> {
  const stages = [
    {
      metric: "funnelLeads",
      noun: "funnel leads",
      dateExpr: "X.CONTACT_CREATE_DATE",
      stageWhere:
        " AND X.RL_COMMUNITY_OF_INTEREST IS NOT NULL" +
        " AND TRIM(X.RL_COMMUNITY_OF_INTEREST) NOT IN ('', '(No Value)')",
    },
    {
      metric: "funnelFirstTours",
      noun: "funnel first tours",
      dateExpr: "X.RL_MIN_FIRST_TOUR_DATE",
      stageWhere: "",
    },
  ];
  for (const s of stages) {
    const binds: (string | number)[] = [startDate, toDate];
    let extra = s.stageWhere;
    if (f.community) {
      extra += " AND TRIM(X.RL_COMMUNITY_OF_INTEREST) = ?";
      binds.push(f.community);
    }
    const rows = await querySnowflake<{ LABEL: string; N: number }>(
      `SELECT COALESCE(X.ONSITE_ONLINE_SOURCE_CHANNEL, '(null)') AS LABEL, COUNT(*) AS N
       FROM DM_CONTACTS X
       WHERE ${s.dateExpr} BETWEEN ? AND ?${extra}
       GROUP BY 1 ORDER BY N DESC`,
      binds,
    );
    const labelCount = (label: string) =>
      rows.filter((r) => r.LABEL === label).reduce((t, r) => t + (Number(r.N) || 0), 0);
    await judgeChannelLabels({
      metric: s.metric,
      noun: s.noun,
      total: rows.reduce((t, r) => t + (Number(r.N) || 0), 0),
      online: labelCount("Online"),
      onsite: labelCount("Onsite"),
      column: "DM_CONTACTS.ONSITE_ONLINE_SOURCE_CHANNEL",
      literalSites:
        "r.CHANNEL === ... over fetchContactStageCounts rows in src/lib/leasing.ts; " +
        "labelCount() here",
      window: `${startDate}..${toDate}`,
      labelsPresent: async () =>
        rows.map((r) => `'${r.LABEL}' (${Number(r.N) || 0})`).join(", ") || "(no rows)",
    });
  }
}
/**
 * Community summary baseline: ONE grouped conditional-aggregation scan
 * replaces the old four per-source dealByCommunity queries (ratified /
 * cancelled / online / onsite). Each COUNT_IF counts exactly the rows the
 * corresponding COUNT(*) GROUP BY query matched, and a community appears
 * as a group IFF it has a ratified or cancelled deal in range — the same
 * membership the old bRat ∪ bCan union produced (COUNT_IFs over channels
 * the scenario filter contradicts are structurally zero, matching the old
 * skip-to-empty-map). Goals arrive precomputed from the shared DM_GOALS
 * grouped query. The union of communities (goals ∪ ratified ∪ cancelled,
 * excluding "(No Value)") must match exactly — a missing or extra
 * community row is a failure, not just a value mismatch.
 */
async function auditCommunities(
  resp: LeasingResponse,
  f: ScenarioFilters,
  startDate: string,
  toDate: string,
  bGoals: Map<string, { fullSpan: number; toDate: number }>,
): Promise<void> {
  // Bind order follows text order: subquery SELECT-list window binds, then
  // the WHERE extras.
  const binds: (string | number)[] = [startDate, toDate, startDate, toDate];
  const parts: string[] = [];
  if (f.community) {
    parts.push("TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) = ?");
    binds.push(f.community);
  }
  if (f.channel) {
    parts.push("DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    binds.push(f.channel);
  }
  const extra = parts.length ? ` AND ${parts.join(" AND ")}` : "";
  const rows = await querySnowflake<{
    C: string | null;
    RAT: number;
    RAT_ONLINE: number;
    RAT_ONSITE: number;
    CAN: number;
  }>(
    `SELECT C,
            COUNT_IF(IN_RAT_WINDOW) AS RAT,
            COUNT_IF(IN_RAT_WINDOW AND CH = 'Online') AS RAT_ONLINE,
            COUNT_IF(IN_RAT_WINDOW AND CH = 'Onsite') AS RAT_ONSITE,
            COUNT_IF(IN_CAN_WINDOW) AS CAN
     FROM (
       SELECT TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) AS C,
              LEASE_RATIFIED_DATE BETWEEN ? AND ? AS IN_RAT_WINDOW,
              CANCELLATION_DATE BETWEEN ? AND ? AS IN_CAN_WINDOW,
              DEAL_ONSITE_ONLINE_SOURCE_CHANNEL AS CH
       FROM DM_DEALS
       WHERE PIPELINE_NAME = '${RL_PIPELINE}'${extra}
     )
     WHERE IN_RAT_WINDOW OR IN_CAN_WINDOW
     GROUP BY 1`,
    binds,
  );
  const bRat = new Map<string, number>();
  const bCan = new Map<string, number>();
  const bOnline = new Map<string, number>();
  const bOnsite = new Map<string, number>();
  for (const r of rows) {
    if (!r.C) continue;
    bRat.set(r.C, Number(r.RAT) || 0);
    bCan.set(r.C, Number(r.CAN) || 0);
    bOnline.set(r.C, Number(r.RAT_ONLINE) || 0);
    bOnsite.set(r.C, Number(r.RAT_ONSITE) || 0);
  }

  const expected = new Set<string>([...bRat.keys(), ...bGoals.keys()]);
  expected.delete("(No Value)");

  const apiByName = new Map(resp.communities.map((c) => [c.community, c]));
  const expectedNames = [...expected].sort();
  const apiNames = resp.communities.map((c) => c.community).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(apiNames)) {
    failures++;
    const missing = expectedNames.filter((n) => !apiByName.has(n));
    const extra = apiNames.filter((n) => !expected.has(n));
    console.error(
      `  FAIL community set mismatch — missing from API: [${missing.join(", ")}], unexpected in API: [${extra.join(", ")}]`,
    );
  } else {
    console.log(`  OK   community set (${expectedNames.length} communities)`);
  }

  for (const name of expectedNames) {
    const row = apiByName.get(name);
    if (!row) continue; // already reported by the set check
    const rat = bRat.get(name) ?? 0;
    const can = bCan.get(name) ?? 0;
    const goal = bGoals.get(name) ?? { fullSpan: 0, toDate: 0 };
    check(`community[${name}].ratified`, row.ratified, rat);
    check(`community[${name}].onlineRatified`, row.onlineRatified, bOnline.get(name) ?? 0);
    check(`community[${name}].onsiteRatified`, row.onsiteRatified, bOnsite.get(name) ?? 0);
    check(`community[${name}].cancelled`, row.cancelled, can);
    check(`community[${name}].net`, row.net, rat - can);
    check(`community[${name}].fullSpanGoal`, row.fullSpanGoal, goal.fullSpan);
    check(`community[${name}].toDateGoal`, row.toDateGoal, goal.toDate);
  }
}

/**
 * Monthly series baseline: actuals over start..toDate, goals over
 * start..end. The ratified and cancelled series group by DIFFERENT date
 * columns (a deal ratified in March and cancelled in May belongs to both
 * series in different months), so they can't share one GROUP BY — instead
 * ONE round trip runs both legs via UNION ALL, each leg literally the old
 * per-column query tagged with its KIND. Goals arrive precomputed
 * (per-month sums from the shared DM_GOALS grouped query).
 */
async function auditMonthly(
  resp: LeasingResponse,
  f: ScenarioFilters,
  startDate: string,
  toDate: string,
  mGoal: Map<number, number>,
): Promise<void> {
  const legBinds: (string | number)[] = [startDate, toDate];
  const parts: string[] = [];
  if (f.community) {
    parts.push("TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) = ?");
    legBinds.push(f.community);
  }
  if (f.channel) {
    parts.push("DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    legBinds.push(f.channel);
  }
  const extra = parts.length ? ` AND ${parts.join(" AND ")}` : "";
  const leg = (kind: string, dateCol: string) =>
    `SELECT '${kind}' AS KIND, MONTH(${dateCol}) AS M, COUNT(*) AS N
     FROM DM_DEALS
     WHERE PIPELINE_NAME = '${RL_PIPELINE}' AND ${dateCol} BETWEEN ? AND ?${extra}
     GROUP BY 1, 2`;
  const rows = await querySnowflake<{ KIND: string; M: number; N: number }>(
    `${leg("RAT", "LEASE_RATIFIED_DATE")}
     UNION ALL
     ${leg("CAN", "CANCELLATION_DATE")}`,
    [...legBinds, ...legBinds],
  );
  const mRat = new Map<number, number>();
  const mCan = new Map<number, number>();
  for (const r of rows) {
    (r.KIND === "RAT" ? mRat : mCan).set(Number(r.M), Number(r.N) || 0);
  }

  if (resp.monthly.length !== 12) {
    failures++;
    console.error(`  FAIL monthly series length: api=${resp.monthly.length} expected=12`);
    return;
  }
  for (const point of resp.monthly) {
    const m = point.month;
    const rat = mRat.get(m) ?? 0;
    const can = mCan.get(m) ?? 0;
    check(`monthly[${m}].ratified`, point.ratified, rat);
    check(`monthly[${m}].cancelled`, point.cancelled, can);
    check(`monthly[${m}].net`, point.net, rat - can);
    check(`monthly[${m}].goal`, point.goal, mGoal.get(m) ?? 0);
  }
}

// ---------- Funnel trend vs totals (chart-vs-table consistency) ----------

const TREND_STAGES = [
  { stage: "webTraffic", actualField: "webTraffic", goalField: "webTrafficGoal" },
  { stage: "leads", actualField: "leads", goalField: "leadsGoal" },
  { stage: "firstTours", actualField: "firstTours", goalField: "firstToursGoal" },
  { stage: "moveIns", actualField: "moveIns", goalField: "moveInsGoal" },
] as const;

/**
 * The Monthly Trends chart's per-stage series and the funnel totals table
 * shown on the same page are fed by DIFFERENT queries (fetchMonthlyTraffic /
 * fetchMonthlyContactStage / fetchMonthlyGoals vs fetchTrafficCount /
 * fetchContactStageCounts / fetchGoals). Nothing upstream forces them to
 * agree, so assert within the SAME response, per stage:
 *   Σ monthly actuals == funnel.<stage>.actual       (both cover start..toDate)
 *   Σ monthly goals   == funnel.<stage>.fullSpanGoal (both cover start..endDate)
 * A missing monthly field or funnel cell fails loudly: Number(undefined) is
 * NaN, and NaN never passes checkFloat.
 */
function auditFunnelTrend(resp: LeasingResponse, scenario: Scenario): void {
  if (!resp.funnel || !Array.isArray(resp.monthly)) {
    failures++;
    console.error(
      "  FAIL response is missing the funnel totals or the monthly series — " +
        "the chart-vs-table consistency check cannot run",
    );
    return;
  }
  const sumField = (field: keyof MonthlyPoint): number =>
    resp.monthly.reduce((t, p) => t + Number(p[field]), 0);

  let maxActual = 0;
  let maxGoal = 0;
  for (const { stage, actualField, goalField } of TREND_STAGES) {
    const cell = resp.funnel[stage];
    if (!cell) {
      failures++;
      console.error(`  FAIL funnel.${stage} missing from the response`);
      continue;
    }
    const actualSum = sumField(actualField);
    const goalSum = sumField(goalField);
    const tableActual = Number(cell.actual);
    const tableGoal = Number(cell.fullSpanGoal);
    checkFloat(
      `trend[${stage}] Σ monthly.${actualField} vs funnel.${stage}.actual`,
      actualSum,
      tableActual,
    );
    checkFloat(
      `trend[${stage}] Σ monthly.${goalField} vs funnel.${stage}.fullSpanGoal`,
      goalSum,
      tableGoal,
    );
    maxActual = Math.max(maxActual, Math.abs(actualSum), Math.abs(tableActual) || 0);
    maxGoal = Math.max(maxGoal, Math.abs(goalSum), Math.abs(tableGoal) || 0);
  }

  // All-zero on both sides of every stage would "pass" while proving
  // nothing. On scenarios whose data is known non-empty (default view and
  // the prior year: FY2025 has web sessions, leads, and RL_Leads/RL_Tours
  // goals), that outcome means the funnel and monthly queries broke in
  // unison or the stage goal types silently resolved to none — fail loudly.
  if (scenario.requireFunnelData) {
    if (maxActual === 0) {
      failures++;
      console.error(
        "  FAIL every funnel stage has zero actuals on both the chart and " +
          "table sides — this scenario's data is known non-empty, so the " +
          "consistency check verified nothing (funnel/monthly actual " +
          "queries both empty or both broken)",
      );
    }
    if (maxGoal === 0) {
      failures++;
      console.error(
        "  FAIL every funnel stage has zero goals on both the chart and " +
          "table sides — this fiscal year has RL stage goals in DM_GOALS " +
          "(FY2025: RL_Leads/RL_Tours; FY2026+: all stages), so the stage " +
          "goal-type resolution is silently matching nothing",
      );
    }
  }
}

// ---------- Representative filter selection ----------

/**
 * Pick the community and channel with the most ratified RL leases in the
 * default range so the filtered scenarios always exercise non-trivial data.
 * Missing values make the audit FAIL — a silently skipped scenario is not
 * coverage.
 */
async function pickRepresentativeFilters(
  startDate: string,
  toDate: string,
): Promise<{ community: string; channel: string }> {
  const [communityRows, channelRows] = await Promise.all([
    querySnowflake<{ C: string }>(
      `SELECT TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) AS C, COUNT(*) AS N
       FROM DM_DEALS
       WHERE PIPELINE_NAME = '${RL_PIPELINE}'
         AND LEASE_RATIFIED_DATE BETWEEN ? AND ?
         AND RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL IS NOT NULL
         AND TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) NOT IN ('', '(No Value)')
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [startDate, toDate],
    ),
    querySnowflake<{ CH: string }>(
      `SELECT DEAL_ONSITE_ONLINE_SOURCE_CHANNEL AS CH, COUNT(*) AS N
       FROM DM_DEALS
       WHERE PIPELINE_NAME = '${RL_PIPELINE}'
         AND LEASE_RATIFIED_DATE BETWEEN ? AND ?
         AND DEAL_ONSITE_ONLINE_SOURCE_CHANNEL IS NOT NULL
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [startDate, toDate],
    ),
  ]);
  const community = communityRows[0]?.C;
  const channel = channelRows[0]?.CH;
  const missing = [!community && "community", !channel && "channel"].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `No representative ${missing.join(", ")} found in ${startDate}..${toDate} — ` +
        "cannot exercise the required filtered scenarios (empty source data or broken filters)",
    );
  }
  return { community: community!, channel: channel! };
}

/**
 * Explicit date-range scenario: January of the default year when it has
 * fully elapsed (stable results), otherwise a deterministic single-day
 * range on January 1st. Both differ from the default full-year bounds, so
 * an endpoint that ignores date params fails the appliedRange assertion.
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
  console.log(`Auditing ${API_BASE}/dashboards/leasing (tolerance ${TOLERANCE_PCT}%)`);

  const { startDate, endDate } = defaultYearRange();
  const toDate = expectedToDate(startDate, endDate);
  console.log(`Default range: ${startDate}..${endDate}, toDate=${toDate}`);

  const { community, channel } = await pickRepresentativeFilters(startDate, toDate);

  const priorYear = Number(startDate.slice(0, 4)) - 1;
  const scenarios: Scenario[] = [
    {
      name: "default view",
      filters: {},
      requireFunnelData: true,
      withChannelLabelGuard: true,
    },
    { name: `community filter (${community})`, filters: { community } },
    { name: `channel filter (${channel})`, filters: { channel } },
    explicitRangeScenario(startDate),
    {
      name: `prior fiscal year (${priorYear}) — RL goal-type fallback`,
      filters: {
        startDate: `${priorYear}-01-01`,
        endDate: `${priorYear}-12-31`,
      },
      requireGoalData: true,
      requireFunnelData: true,
    },
  ];

  // The funnel checks must cover BOTH literal channels: a channel filter
  // swaps in per-channel stage goal types (RL_Online_Leads, ...) and blanks
  // the opposite channel's targets, so a regression can hit one channel
  // only — and the "busiest channel" scenario may land on a third label
  // (e.g. 'Unknown'), visiting neither. Add funnel-only variants (full
  // funnel Snowflake baselines + trend consistency) for whichever literal
  // channels the scenarios above miss.
  for (const ch of ["Online", "Onsite"]) {
    if (!scenarios.some((s) => s.filters.channel === ch)) {
      scenarios.push({
        name: `channel filter (${ch}) — funnel baselines + trend consistency`,
        filters: { channel: ch },
        funnelOnly: true,
      });
    }
  }
  console.log(`Scenarios: ${scenarios.map((s) => s.name).join("; ")}`);

  for (const scenario of scenarios) {
    await auditScenario(scenario);
  }

  if (failures > 0) {
    console.error(
      `\nAUDIT FAILED: ${failures} check(s) diverge from independent Snowflake ` +
        "baselines or internal consistency. Likely causes: a filter bound to " +
        "the wrong column, missing TRIM on community, wrong goal-type " +
        "resolution, ignored date parameters, stale cached data, relabeled " +
        "channel values (see any chLabels failure above), the monthly " +
        "trend queries drifting from the funnel totals queries, or a funnel " +
        "stage query drifting from its GA/DM_CONTACTS/DM_GOALS definition " +
        "(wrong stage date column, dropped lead definition, or broken " +
        "channel goal semantics).",
    );
    process.exit(1);
  }
  console.log("\nAudit passed: all values match independent baselines across all scenarios.");
  process.exit(0);
}


/**
 * Contact-stage actual baseline from DM_CONTACTS, split by channel:
 * - leads: contacts CREATED in range that have an RL community of interest
 *   (non-null, not '' or '(No Value)')
 * - firstTours: first RL tour date in range (no lead-definition filter)
 * - moveIns: first RL move-in date in range (timestamp column, so TO_DATE
 *   brings the comparison to day precision like the dashboard)
 * total sums ALL channel groups (including contacts with no channel label);
 * online/onsite are the 'Online'/'Onsite' groups only.
 */
async function baselineContactStage(
  stage: "leads" | "firstTours" | "moveIns",
  startDate: string,
  toDate: string,
  f: ScenarioFilters,
): Promise<{ total: number; online: number; onsite: number }> {
  const dateExpr = {
    leads: "CONTACT_CREATE_DATE",
    firstTours: "RL_MIN_FIRST_TOUR_DATE",
    moveIns: "TO_DATE(RL_MIN_MOVE_IN_DATE)",
  }[stage];
  const binds: (string | number)[] = [startDate, toDate];
  const parts: string[] = [];
  if (stage === "leads") {
    parts.push(
      "RL_COMMUNITY_OF_INTEREST IS NOT NULL AND TRIM(RL_COMMUNITY_OF_INTEREST) NOT IN ('', '(No Value)')",
    );
  }
  if (f.community) {
    parts.push("TRIM(RL_COMMUNITY_OF_INTEREST) = ?");
    binds.push(f.community);
  }
  if (f.channel) {
    parts.push("ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    binds.push(f.channel);
  }
  const extra = parts.length ? ` AND ${parts.join(" AND ")}` : "";
  const rows = await querySnowflake<{ CH: string | null; N: number }>(
    `SELECT ONSITE_ONLINE_SOURCE_CHANNEL AS CH, COUNT(*) AS N
     FROM DM_CONTACTS
     WHERE ${dateExpr} BETWEEN ? AND ?${extra}
     GROUP BY 1`,
    binds,
  );
  let total = 0;
  let online = 0;
  let onsite = 0;
  for (const r of rows) {
    const n = Number(r.N) || 0;
    total += n;
    if (r.CH === "Online") online += n;
    else if (r.CH === "Onsite") onsite += n;
  }
  return { total, online, onsite };
}

/**
 * Web-traffic actual baseline: GA session starts for the Rhodes Living web
 * property. The GA source has no online/onsite channel column, so a channel
 * filter must NOT change this number — only community and dates apply.
 */
async function baselineTraffic(
  startDate: string,
  toDate: string,
  community?: string,
): Promise<number> {
  const binds: (string | number)[] = [startDate, toDate];
  let extra = "";
  if (community) {
    extra = " AND MATCHED_DEVELOPMENT_NAME = ?";
    binds.push(community);
  }
  return countScalar(
    `SELECT COUNT(*) AS N
     FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
     WHERE PROPERTY = 'Rhodes Living'
       AND IS_SESSION_START = 'Yes'
       AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?${extra}`,
    binds,
  );
}

/**
 * RL funnel-stage goal types per the documented data model, newest naming
 * first. FY2025 only had RL_Leads / RL_Tours (no traffic or move-in goals,
 * no channel splits); FY2026 added RL_Web_Traffic, RL_First_Tours
 * (+ RL_Online_/RL_Onsite_ splits for leads and tours) and RL_Move_Ins.
 * Deliberately restated here rather than imported from the API's data layer
 * so a silent change to the API's candidate lists diverges loudly.
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

/**
 * Compare every funnel-table cell (actual, fullSpanGoal, toDateGoal) against
 * independent Snowflake baselines. The chart-vs-table net (auditFunnelTrend)
 * only proves the monthly series and the table AGREE; if their queries
 * drifted together — a wrong date column or a dropped filter applied to
 * both — the page would show wrong numbers and still pass. These baselines
 * recompute the cells from the sources directly.
 *
 * Channel-filter goal semantics (documented dashboard behavior) are
 * mirrored: a channel filter swaps each cell's goal to that channel's goal
 * type, the OPPOSITE channel's cells get no target (goal 0 on both sides,
 * actual 0 because the stage rows are filtered to the selected channel),
 * and stages without channel-split goals (traffic, move-ins) lose their
 * target too. Traffic ACTUALS ignore the channel filter entirely — the GA
 * source has no channel column.
 */
async function auditFunnel(
  resp: LeasingResponse,
  f: ScenarioFilters,
  scenario: Scenario,
  availableGoalTypes: Set<string>,
  fiscalYear: number,
  startDate: string,
  endDate: string,
  toDate: string,
): Promise<void> {
  if (!resp.funnel) {
    failures++;
    console.error("  FAIL response is missing the funnel table — funnel baselines cannot run");
    return;
  }

  // Mirror of the dashboard's channel-scoped goal rule: under a channel
  // filter, "total" cells compare against that channel's goal and the
  // opposite channel's cells have no goal at all.
  const effMetric = (metric: GoalMetric): GoalMetric | null => {
    if (f.channel === "Online") return metric === "onsite" ? null : "online";
    if (f.channel === "Onsite") return metric === "online" ? null : "onsite";
    return metric;
  };
  const cellGoalType = (stage: FunnelStage, metric: GoalMetric): string | undefined => {
    const eff = effMetric(metric);
    return eff ? resolveFunnelGoalType(availableGoalTypes, stage, eff) : undefined;
  };

  const typeByCell = new Map<FunnelCellName, string | undefined>(
    FUNNEL_CELLS.map((c) => [c.name, cellGoalType(c.stage, c.metric)]),
  );
  const uniqueTypes = [
    ...new Set([...typeByCell.values()].filter((t): t is string => Boolean(t))),
  ];
  console.log(
    `Resolved funnel goal types (FY${fiscalYear}): ` +
      (uniqueTypes.length ? uniqueTypes.join(", ") : "(none)"),
  );

  const [goalSums, traffic, leads, tours, moveIns] = await Promise.all([
    baselineGoalsByType(uniqueTypes, fiscalYear, startDate, endDate, toDate, f.community),
    baselineTraffic(startDate, toDate, f.community),
    baselineContactStage("leads", startDate, toDate, f),
    baselineContactStage("firstTours", startDate, toDate, f),
    baselineContactStage("moveIns", startDate, toDate, f),
  ]);

  const actualByCell: Record<FunnelCellName, number> = {
    webTraffic: traffic,
    leads: leads.total,
    onlineLeads: leads.online,
    onsiteLeads: leads.onsite,
    firstTours: tours.total,
    onlineFirstTours: tours.online,
    onsiteFirstTours: tours.onsite,
    moveIns: moveIns.total,
  };

  for (const c of FUNNEL_CELLS) {
    const cell = resp.funnel[c.name];
    if (!cell) {
      failures++;
      console.error(`  FAIL funnel.${c.name} missing from the response`);
      continue;
    }
    const gtName = typeByCell.get(c.name);
    const goal = (gtName && goalSums.get(gtName)) || { fullSpan: 0, toDate: 0 };
    check(`funnel.${c.name}.actual`, cell.actual, actualByCell[c.name]);
    check(`funnel.${c.name}.fullSpanGoal`, cell.fullSpanGoal, goal.fullSpan);
    check(`funnel.${c.name}.toDateGoal`, cell.toDateGoal, goal.toDate);
  }

  // The prior-year scenario exists to pin the FY2025 goal-type fallback,
  // which for the funnel means RL_Leads and RL_Tours must resolve and sum
  // to something. Without that guard, losing the fallback would make both
  // the API and the baseline show 0 goals and every check would "pass"
  // while testing nothing.
  if (scenario.requireGoalData) {
    for (const stage of ["leads", "firstTours"] as const) {
      const gtName = cellGoalType(stage, "total");
      const sum = (gtName && goalSums.get(gtName)?.fullSpan) || 0;
      if (!gtName || sum === 0) {
        failures++;
        console.error(
          `  FAIL no ${stage} goal data for FY${fiscalYear}: resolved goal type=` +
            `${gtName ?? "(none)"}, full-span sum=${sum} — this scenario pins the ` +
            "prior-year funnel goal fallback (RL_Leads/RL_Tours), so empty goal " +
            "data means the fallback is NOT being tested (goals missing from " +
            "DM_GOALS, or the audit's candidate lists need updating)",
        );
      }
    }
  }
}

function resolveFunnelGoalType(
  available: Set<string>,
  stage: FunnelStage,
  metric: GoalMetric,
): string | undefined {
  return FUNNEL_GOAL_CANDIDATES[stage][metric].find((c) => available.has(c));
}

/** Every cell of the funnel totals table and which stage/metric goal it shows. */
const FUNNEL_CELLS: { name: FunnelCellName; stage: FunnelStage; metric: GoalMetric }[] = [
  { name: "webTraffic", stage: "webTraffic", metric: "total" },
  { name: "leads", stage: "leads", metric: "total" },
  { name: "onlineLeads", stage: "leads", metric: "online" },
  { name: "onsiteLeads", stage: "leads", metric: "onsite" },
  { name: "firstTours", stage: "firstTours", metric: "total" },
  { name: "onlineFirstTours", stage: "firstTours", metric: "online" },
  { name: "onsiteFirstTours", stage: "firstTours", metric: "onsite" },
  { name: "moveIns", stage: "moveIns", metric: "total" },
];

type GoalMetric = "total" | "online" | "onsite";
